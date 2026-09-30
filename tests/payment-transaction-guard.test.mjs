import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/paymentTransactionGuard.js', import.meta.url), 'utf8');
const { transactionMatchesOpenBill } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const bills = [
  { id: '49', order_items: [{ quantity: 1, unit_price: 2104000 }] },
  { id: '48', order_items: [{ quantity: 1, unit_price: 480000 }] },
];

test('a transaction only settles the complete current merged bill', () => {
  assert.equal(transactionMatchesOpenBill({ order_ids: '48,49', total_amount: 2584000 }, bills), true);
  assert.equal(transactionMatchesOpenBill({ order_ids: '49', total_amount: 2104000 }, bills), false);
  assert.equal(transactionMatchesOpenBill({ order_ids: '48,49', total_amount: 2104000 }, bills), false);
  assert.equal(transactionMatchesOpenBill({ order_ids: '48,49', total_amount: 2584000 }, [...bills, { id: 'new', order_items: [] }]), false);
});
