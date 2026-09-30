import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/tableGroupOrders.js', import.meta.url), 'utf8');
const { getTableGroupOrders, OPEN_BILL_STATUSES } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('completed kitchen orders remain in the unpaid table bill', () => {
  assert.deepEqual(OPEN_BILL_STATUSES, ['pending', 'preparing', 'completed']);
  assert.equal(OPEN_BILL_STATUSES.includes('paid'), false);
  assert.equal(OPEN_BILL_STATUSES.includes('cancelled'), false);
});

test('host and satellite cards show the full merged bill, including the satellite amount', () => {
  const tables = [{ id: '49', merged_with: null }, { id: '48', merged_with: '49' }];
  const orders = {
    '49': [{ id: 'host', order_items: [{ quantity: 1, unit_price: 2104000 }] }],
    '48': [{ id: 'satellite', order_items: [{ quantity: 1, unit_price: 480000 }] }],
  };
  for (const table of tables) {
    const group = getTableGroupOrders(table, tables, orders);
    assert.deepEqual(group.map(order => order.id), ['host', 'satellite']);
    assert.equal(group.flatMap(order => order.order_items)
      .reduce((sum, item) => sum + item.quantity * item.unit_price, 0), 2584000);
  }
});

test('an unmerged table keeps only its own orders', () => {
  const tables = [{ id: '48', merged_with: null }, { id: '49', merged_with: null }];
  const orders = { '48': [{ id: 'a' }], '49': [{ id: 'b' }] };
  assert.deepEqual(getTableGroupOrders(tables[0], tables, orders).map(o => o.id), ['a']);
});
