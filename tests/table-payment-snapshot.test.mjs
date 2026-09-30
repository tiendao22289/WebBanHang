import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('  async function getFreshPaymentSnapshot('), page.indexOf('  async function cancelTableGroup('));
const cancelSource = page.slice(page.indexOf('  async function cancelTableGroup('), page.indexOf('  async function getOrGenerateBillCode('));

function harness(tableRows, tableError = null) {
  const seen = { orderIds: null };
  const orderRows = [
    { id: 'host-order', order_items: [{ quantity: 1, unit_price: 2104000 }] },
    { id: 'child-order', order_items: [{ quantity: 1, unit_price: 480000 }] },
  ];
  const context = {
    collectUnpricedItems: () => [],
    supabase: {
      from(name) {
        if (name === 'tables') return { select: async () => ({ data: tableRows, error: tableError }) };
        const query = {
          select: () => query,
          in(column, ids) { if (column === 'table_id') seen.orderIds = ids; return query; },
          order: async () => ({ data: orderRows.filter((_, i) => seen.orderIds.includes(i ? '48' : '49')), error: null }),
        };
        return query;
      },
    },
  };
  return { run: vm.runInNewContext(`(${source.trim()})`, context), seen };
}

test('payment reads the live merged group and charges both tables', async () => {
  const h = harness([{ id: '49', merged_with: null }, { id: '48', merged_with: '49' }]);
  const result = await h.run({ id: '48', merged_with: null }); // stale card
  assert.deepEqual([...result.groupTableIds], ['49', '48']);
  assert.equal(result.total, 2584000);
  assert.equal(result.bills.length, 2);
});

test('table lookup failure stops payment before reading an incomplete bill', async () => {
  const h = harness(null, { message: 'network failure' });
  await assert.rejects(h.run({ id: '49' }));
  assert.equal(h.seen.orderIds, null);
});

test('cancelling a merged table covers both host and satellite before clearing the UI', async () => {
  const seen = [];
  const context = {
    getFreshPaymentSnapshot: async () => ({ groupTableIds: ['49', '48'] }),
    cancelStamp: () => ({}), fetchTables: () => seen.push('refresh'),
    console, Swal: { fire: () => seen.push('error') },
    supabase: { from(name) {
      const query = {
        update: () => query,
        in(column, values) { if (column === 'table_id' || column === 'id') seen.push([name, [...values]]); return query; },
        then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
      };
      return query;
    } },
  };
  const cancel = vm.runInNewContext(`(${cancelSource.trim()})`, context);
  assert.equal(await cancel({ id: '48' }), true);
  assert.deepEqual(seen, [['orders', ['49', '48']], ['tables', ['49', '48']], 'refresh']);
});
