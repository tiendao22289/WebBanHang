import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getCachedOrderTableIds } from '../src/lib/tableOrderRefresh.mjs';

const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
const cancelSource = page.slice(page.indexOf('  async function cancelSingleBill('), page.indexOf('  // Bàn cũ hết bill sau khi chuyển'));
const moveSource = page.slice(page.indexOf('  async function moveBillsToTable('), page.indexOf('  // Chuyển bàn: bàn có nhiều bill'));
const releaseSource = page.slice(page.indexOf('  async function releaseTableGroupIfEmpty('), page.indexOf('  async function moveBillsToTable('));

function harness(source) {
  const calls = [];
  const context = {
    OPEN_BILL_STATUSES: ['pending', 'preparing', 'completed'],
    cancelStamp: () => ({}),
    fetchTables: async ids => { calls.push(`refresh:${ids?.join(',') || 'all'}`); },
    getCachedOrderTableIds,
    ordersStateRef: { current: { 'table-1': [{ id: 'order-1', table_id: 'table-1' }, { id: 'order-2', table_id: 'table-1' }] } },
    tablesStateRef: { current: [{ id: 'table-1', occupied_at: '2026-10-18T05:00:00.000Z' }] },
    luckyStatusLastRef: { current: 1 },
    releaseTableGroupIfEmpty: async (id, keep) => { calls.push(`release:${id}:${keep}`); },
    staffApiHeaders: headers => headers,
    fetch: async (url, init) => {
      calls.push(`${url}:${init.body}`);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    Swal: { fire: () => calls.push('error') },
    supabase: { from(name) {
      const query = {
        update: values => {
          calls.push(`${name}.update`);
          if (values.occupied_at) calls.push(`occupied_at:${values.occupied_at}`);
          return query;
        },
        eq: () => query,
        in: (column, values) => {
          if (column === 'status') calls.push(`statuses:${values.join(',')}`);
          if (column === 'id') { calls.push(`ids:${values.join(',')}`); query.ids = values; }
          return query;
        },
        select: async () => ({ data: (query.ids || ['updated']).map(id => ({ id, table_id: 'table-1' })), error: null }),
      };
      return query;
    } },
  };
  return { run: vm.runInNewContext(`(${source.trim()})`, context), calls };
}

test('several bills move to another table in one update, each carrying its wheel spins', async () => {
  const { run, calls } = harness(moveSource);
  assert.equal(await run(['order-1', 'order-2'], { id: 'table-2', status: 'occupied' }), true);
  assert.deepEqual(calls, ['orders.update', 'ids:order-1,order-2', 'statuses:pending,preparing,completed',
    '/api/admin/lucky-move-table:{"orderId":"order-1","sourceTableIds":["table-1"],"targetTableId":"table-2"}',
    '/api/admin/lucky-move-table:{"orderId":"order-2","sourceTableIds":["table-1"],"targetTableId":"table-2"}',
    'release:table-1:table-2', 'refresh:table-1,table-2']);
});

test('cancelling one bill never releases a possibly unpaid table group', async () => {
  const { run, calls } = harness(cancelSource);
  assert.equal(await run('order-1'), true);
  assert.deepEqual(calls, ['orders.update', 'statuses:pending,preparing,completed', 'refresh:table-1']);
});

test('moving a bill occupies its destination before changing the order', async () => {
  const { run, calls } = harness(moveSource);
  assert.equal(await run(['order-1'], { id: 'table-2', status: 'available' }), true);
  assert.deepEqual(calls, ['tables.update', 'occupied_at:2026-10-18T05:00:00.000Z', 'orders.update',
    'ids:order-1', 'statuses:pending,preparing,completed',
    '/api/admin/lucky-move-table:{"orderId":"order-1","sourceTableIds":["table-1"],"targetTableId":"table-2"}',
    'release:table-1:table-2', 'refresh:table-1,table-2']);
});

function releaseHarness({ tables, orders, lateOrder = false }) {
  const state = { tables: structuredClone(tables), orders: structuredClone(orders) };
  let orderReads = 0;
  const supabase = { from(name) {
    let op = 'read', values, conditions = [], single = false;
    const q = {
      select: () => q,
      eq: (k, v) => { conditions.push(r => r[k] === v); return q; },
      in: (k, vs) => { conditions.push(r => vs.includes(r[k])); return q; },
      or: expr => {
        const host = expr.match(/id\.eq\.([^,]+)/)[1];
        conditions.push(r => r.id === host || r.merged_with === host);
        return q;
      },
      limit: () => q,
      maybeSingle: () => { single = true; return q; },
      update: v => { op = 'update'; values = v; return q; },
      then(resolve) {
        if (name === 'orders' && op === 'read' && ++orderReads === 2 && lateOrder) {
          state.orders.push({ id: 'late', table_id: 'table-4', status: 'pending' });
        }
        const rows = state[name].filter(r => conditions.every(c => c(r)));
        if (op === 'update') rows.forEach(r => Object.assign(r, values));
        resolve({ data: single ? rows[0] ?? null : structuredClone(rows), error: null });
      },
    };
    return q;
  } };
  const run = vm.runInNewContext(`(${releaseSource.trim()})`, {
    supabase, OPEN_BILL_STATUSES: ['pending', 'preparing', 'completed'], console: { error() {} },
  });
  return { run, state };
}

const seated = '2026-10-18T05:00:00.000Z';

test('moving the last bill away frees the old table', async () => {
  const h = releaseHarness({
    tables: [{ id: 'table-4', status: 'occupied', occupied_at: seated, merged_with: null }],
    orders: [{ id: 'moved', table_id: 'table-5', status: 'pending' }],
  });
  await h.run('table-4', 'table-5');
  assert.deepEqual(h.state.tables[0], { id: 'table-4', status: 'available', occupied_at: null, merged_with: null });
});

test('the old table stays open while another bill is still on it', async () => {
  const h = releaseHarness({
    tables: [{ id: 'table-4', status: 'occupied', occupied_at: seated, merged_with: null }],
    orders: [{ id: 'other', table_id: 'table-4', status: 'pending' }],
  });
  await h.run('table-4', 'table-5');
  assert.equal(h.state.tables[0].status, 'occupied');
});

test('a merged group keeps open when its partner table still has a bill, or the bill moved inside it', async () => {
  const tables = [
    { id: 'table-4', status: 'occupied', occupied_at: seated, merged_with: null },
    { id: 'table-6', status: 'occupied', occupied_at: seated, merged_with: 'table-4' },
  ];
  const withBill = releaseHarness({ tables, orders: [{ id: 'other', table_id: 'table-6', status: 'pending' }] });
  await withBill.run('table-4', 'table-5');
  assert.ok(withBill.state.tables.every(t => t.status === 'occupied'));
  const inside = releaseHarness({ tables, orders: [] });
  await inside.run('table-4', 'table-6');
  assert.ok(inside.state.tables.every(t => t.status === 'occupied'));
});

test('a bill arriving while the table is freed reopens it with the original seat time', async () => {
  const h = releaseHarness({
    tables: [{ id: 'table-4', status: 'occupied', occupied_at: seated, merged_with: null }],
    orders: [], lateOrder: true,
  });
  await h.run('table-4', 'table-5');
  assert.deepEqual(h.state.tables[0], { id: 'table-4', status: 'occupied', occupied_at: seated, merged_with: null });
});
