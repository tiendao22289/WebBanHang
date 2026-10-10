export const OPEN_TABLE_ORDER_SELECT = `
  id, table_id, status, total_amount, customer_name, customer_phone, customer_note,
  delivery_address, created_at, created_by_name,
  order_items (
    id, quantity, unit_price, item_options, note, is_gift, menu_item_id, item_name, added_by_name,
    menu_item:menu_items (name, price, image_url, category_id)
  ),
  print_jobs (id, status, created_at, printer_id, error_message, filter_category_ids, only_item_ids, order_ids)
`;

export function readOpenTableOrders(supabase, tableIds = null) {
  let query = supabase.from('orders').select(OPEN_TABLE_ORDER_SELECT);
  // orders.table_id has a foreign key to tables: non-null means a valid table.
  // Full reads no longer depend on downloading all table UUIDs first.
  query = tableIds === null ? query.not('table_id', 'is', null) : query.in('table_id', tableIds);
  return query.in('status', ['pending', 'preparing', 'completed'])
    .order('created_at', { ascending: false });
}

export function withCachedMenuOptions(orders, menuItems) {
  const menuById = new Map((menuItems || []).map(item => [item.id, item]));
  return (orders || []).map(order => ({
    ...order,
    order_items: (order.order_items || []).map(item => ({
      ...item,
      menu_item: item.menu_item ? {
        ...item.menu_item,
        options: menuById.get(item.menu_item_id)?.options || [],
      } : null,
    })),
  }));
}

export function getCachedOrderTableIds(ordersByTable, orderIds) {
  const bills = Object.values(ordersByTable).flat();
  const ids = new Set();
  for (const orderId of orderIds) {
    const bill = bills.find(order => order.id === orderId);
    if (!bill?.table_id) return null;
    ids.add(bill.table_id);
  }
  return ids.size ? [...ids] : null;
}

// A slow full read must not overwrite a newer scoped read (and vice versa).
export function createTableOrderReadGuard() {
  let version = 0;
  let fullVersion = 0;
  const tableVersions = new Map();
  return {
    begin(tableIds = null) {
      const current = ++version;
      if (tableIds === null) fullVersion = current;
      else for (const id of tableIds) tableVersions.set(id, current);
      return (previous, data) => {
        const candidates = tableIds === null
          ? new Set([...Object.keys(previous), ...(data || []).map(order => order.table_id)])
          : new Set(tableIds);
        const eligible = [...candidates].filter(id => Math.max(fullVersion, tableVersions.get(id) || 0) === current);
        return mergeTableOrders(previous, data, eligible);
      };
    },
  };
}

// Resolve DELETE payloads (often primary-key only) from the visible bill cache.
export function getTableOrderChangeScope(kind, payload, ordersByTable) {
  const tableIds = new Set();
  const orderIds = new Set();
  const rows = [payload.old, payload.new].filter(Boolean);
  const bills = Object.values(ordersByTable).flat();
  if (kind === 'tables') {
    for (const row of rows) {
      if (row.id) tableIds.add(row.id);
      if (row.merged_with) tableIds.add(row.merged_with);
    }
  } else if (kind === 'orders') {
    for (const row of rows) {
      if (row.table_id) tableIds.add(row.table_id);
      const cached = bills.find(bill => bill.id === row.id);
      if (cached?.table_id) tableIds.add(cached.table_id);
    }
  } else if (kind === 'order_items') {
    for (const row of rows) {
      if (row.order_id) orderIds.add(row.order_id);
      const cached = bills.find(bill => bill.order_items?.some(item => item.id === row.id));
      if (cached?.table_id) tableIds.add(cached.table_id);
    }
    for (const orderId of [...orderIds]) {
      const cached = bills.find(bill => bill.id === orderId);
      if (cached?.table_id) {
        tableIds.add(cached.table_id);
        orderIds.delete(orderId);
      }
    }
  }
  return {
    tableIds: [...tableIds], orderIds: [...orderIds],
    full: tableIds.size === 0 && orderIds.size === 0,
    tables: kind === 'tables',
  };
}

// Include both sides of a merge/unmerge; retain deleted table IDs to clear bills.
export function expandTableRefreshScope(tableIds, tables, previousTables = []) {
  const ids = new Set(tableIds);
  let changed;
  do {
    changed = false;
    for (const table of [...tables, ...previousTables]) {
      if (table.merged_with && (ids.has(table.id) || ids.has(table.merged_with))) {
        for (const id of [table.id, table.merged_with]) {
          if (!ids.has(id)) { ids.add(id); changed = true; }
        }
      }
    }
  } while (changed);
  return [...ids];
}

export function mergeTableOrders(previous, data, tableIds = null) {
  const next = tableIds === null ? {} : { ...previous };
  // An empty response still clears a table whose last bill was paid/deleted.
  for (const id of tableIds || []) next[id] = [];
  for (const order of data || []) {
    if (tableIds !== null && !tableIds.includes(order.table_id)) continue;
    (next[order.table_id] ||= []).push(order);
  }
  return next;
}

// Accumulate every affected table; serialize reads without losing events received
// while the previous request is running. A full read subsumes a scoped read.
export function createTableOrderRefresh(execute, {
  delayMs = 500, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let pending = null;
  let timer = null;
  let running = false;
  let disposed = false;
  function arm() {
    if (disposed || running || timer !== null || !pending) return;
    timer = setTimer(async () => {
      timer = null;
      if (disposed) return;
      const batch = pending;
      pending = null;
      running = true;
      try { await execute(batch); }
      finally { running = false; arm(); }
    }, delayMs);
  }
  return {
    schedule(scope) {
      if (disposed) return;
      pending ||= { tableIds: new Set(), orderIds: new Set(), full: false, tables: false };
      for (const id of scope.tableIds || []) pending.tableIds.add(id);
      for (const id of scope.orderIds || []) pending.orderIds.add(id);
      pending.full ||= scope.full;
      pending.tables ||= scope.tables;
      arm();
    },
    dispose() {
      disposed = true;
      pending = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
