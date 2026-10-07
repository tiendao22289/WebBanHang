import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getCachedOrderTableIds } from '../src/lib/tableOrderRefresh.mjs';

const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
const cancelSource = page.slice(page.indexOf('  async function cancelSingleBill('), page.indexOf('  async function moveBillToTable('));
const moveSource = page.slice(page.indexOf('  async function moveBillToTable('), page.indexOf('  async function getOrGenerateBillCode('));

function harness(source) {
  const calls = [];
  const context = {
    OPEN_BILL_STATUSES: ['pending', 'preparing', 'completed'],
    cancelStamp: () => ({}),
    fetchTables: async ids => { calls.push(`refresh:${ids?.join(',') || 'all'}`); },
    getCachedOrderTableIds,
    ordersStateRef: { current: { 'table-1': [{ id: 'order-1', table_id: 'table-1' }] } },
    Swal: { fire: () => calls.push('error') },
    supabase: { from(name) {
      const query = {
        update: () => { calls.push(`${name}.update`); return query; },
        eq: () => query,
        in: (column, values) => {
          if (column === 'status') calls.push(`statuses:${values.join(',')}`);
          return query;
        },
        select: async () => ({ data: [{ id: 'updated', table_id: 'table-1' }], error: null }),
      };
      return query;
    } },
  };
  return { run: vm.runInNewContext(`(${source.trim()})`, context), calls };
}

test('cancelling one bill never releases a possibly unpaid table group', async () => {
  const { run, calls } = harness(cancelSource);
  assert.equal(await run('order-1'), true);
  assert.deepEqual(calls, ['orders.update', 'statuses:pending,preparing,completed', 'refresh:table-1']);
});

test('moving a bill occupies its destination before changing the order', async () => {
  const { run, calls } = harness(moveSource);
  assert.equal(await run('order-1', { id: 'table-2', status: 'available' }), true);
  assert.deepEqual(calls, ['tables.update', 'orders.update', 'statuses:pending,preparing,completed', 'refresh:table-1,table-2']);
});
