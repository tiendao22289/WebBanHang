export const LOG_PAGE_SIZE = 50;
export const LOG_SOURCES = ['paid', 'cancelled', 'opened'];

export function mergeLogPage(streams, offsets) {
  const candidates = LOG_SOURCES.flatMap(source => (streams[source] || []).map(entry => ({ ...entry, source })));
  candidates.sort((a, b) => new Date(b.at) - new Date(a.at) || b.id.localeCompare(a.id));
  const entries = candidates.slice(0, LOG_PAGE_SIZE);
  const nextOffsets = { ...offsets };
  for (const entry of entries) nextOffsets[entry.source]++;
  return {
    entries,
    nextOffsets,
    hasMore: candidates.length > LOG_PAGE_SIZE || LOG_SOURCES.some(source => streams[source]?.length === LOG_PAGE_SIZE),
  };
}

export function billLog(order, table, source, tableIds = []) {
  return {
    id: `${source}:${order.id}`,
    tableId: order.table_id,
    tableNumber: order.table_number ?? table?.table_number ?? '?',
    tableIds,
    at: source === 'paid' ? order.paid_at || order.created_at : order.cancelled_at || order.created_at,
    actor: (source === 'paid' ? order.paid_by_name : order.cancelled_by_name) || '',
    customer: order.customer_name || '',
    billCode: order.bill_code || '',
    paymentMethod: order.payment_method || '',
    total: Number(order.total_amount || 0),
    items: (order.order_items || []).map(item => ({
      id: item.id, name: item.menu_item?.name || item.item_name || 'Món đã xoá',
      quantity: item.quantity, unitPrice: item.unit_price,
      note: (item.item_options || []).map(option => option.choice).join(' · ') || item.note || '',
      addedBy: item.added_by_name || '', isGift: !!item.is_gift,
    })),
  };
}
