import test from 'node:test';
import assert from 'node:assert/strict';
import { allOpenDebts, allocateToDebts, debtKey, openDebtLines } from '../src/lib/notesDebts.mjs';

const note = (id, at, items, extra = {}) => ({ id, created_at: at, staff: { full_name: 'Thy' }, debt: extra.debt || 0, paid_debt: extra.paid || 0,
  content: items ? JSON.stringify({ type: 'structured_expense', items }) : 'ghi chú' });

test('open debts list every unpaid line, oldest note first, with partial payments', () => {
  const notes = [
    note('b', '2026-10-22T01:00:00Z', [{ name: 'Sò điệp', qty: '3', price: '90k', paymentStatus: 'debt', creditor: 'Chị Lan', paid_amount: 70000 }, { name: 'Ốc', price: '50k' }]),
    note('a', '2026-10-20T01:00:00Z', [{ name: 'Mực', qty: '2', price: '100k', paymentStatus: 'debt', creditor: 'Chị Hoa', debtAmount: '150.000' }]),
    note('c', '2026-10-21T01:00:00Z', null, { debt: 80000, paid: 30000 }),
    note('d', '2026-10-19T01:00:00Z', [{ name: 'Hàu', price: '40k', paymentStatus: 'full', paid_amount: 40000, debtAmount: '' }]),
  ];
  assert.deepEqual(allOpenDebts(notes).map(l => [debtKey(l), l.creditor, l.name, l.left]), [
    ['a:0', 'Chị Hoa', 'Mực', 150000],
    ['c:note', '', 'Nợ của phiếu', 50000],
    ['b:0', 'Chị Lan', 'Sò điệp', 200000],
  ]);
  assert.deepEqual(openDebtLines(notes[3]), [], 'a line paid off in full is no longer listed');
});

test('surplus goes to the debts the owner ticked first, then the oldest ones', () => {
  const lines = [{ note_id: 'a', item_index: 0, left: 150000 }, { note_id: 'c', item_index: null, left: 50000 }, { note_id: 'b', item_index: 0, left: 200000 }];
  assert.deepEqual(allocateToDebts(250000, lines), { 'a:0': 150000, 'c:note': 50000, 'b:0': 50000 });
  assert.deepEqual(allocateToDebts(250000, lines, ['b:0']), { 'b:0': 200000, 'a:0': 50000 });
  assert.deepEqual(allocateToDebts(0, lines), {});
});

test('leftover money of earlier trips is what is still held after spending, paying debts and handing back', async () => {
  const { noteLeftover, openLeftovers, fundDebtPayments } = await import('../src/lib/notesDebts.mjs');
  const trip = (id, at, given, amount, returned = []) => ({ id, note_type: 'expense', created_at: at, amount, staff: { full_name: 'Thy' },
    content: JSON.stringify({ type: 'structured_expense', input_amount: given, items: [], returned_logs: returned }) });
  const notes = [trip('t1', '2026-10-23T02:00:00Z', 1000000, 740000), trip('t2', '2026-10-24T02:00:00Z', 500000, 400000, [{ amount: 100000 }]),
    trip('old', '2026-10-03T02:00:00Z', 5000000, 4935000)];
  const payments = [{ paid_from_note_id: 't1', amount: 60000 }];
  assert.equal(noteLeftover(notes[0], payments), 200000, '1.000.000 − 740.000 − 60.000 used for debt');
  assert.equal(noteLeftover(notes[1], payments), 0, 'already handed back');
  assert.deepEqual(openLeftovers(notes, payments, '2026-10-23').map(l => [l.note_id, l.left]), [['t1', 200000]], 'trips before the book started are ignored');
  assert.deepEqual(fundDebtPayments([{ key: 'a:0', amount: 150000 }, { key: 'b:1', amount: 120000 }], [{ id: 't1', left: 200000 }]),
    [{ key: 'a:0', amount: 150000, from_note_id: 't1' }, { key: 'b:1', amount: 50000, from_note_id: 't1' }, { key: 'b:1', amount: 70000, from_note_id: null }]);
});
