import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRange, notesSummary } from '../src/lib/notesSummary.mjs';

// Tình huống đã đo trên DEV: P0 nợ cũ 30/09, P1 22/10 (có hàng nợ), P2 23/10 lấy tiền trả nợ P1.
const row = (name, qty, price, extra = {}) => ({ name, qty, price, paymentStatus: 'full', ...extra });
const notes = [
  { id: 'p0', note_type: 'expense', created_at: '2026-09-30T02:00:00Z', amount: 0, debt: 200000, paid_debt: 0,
    content: JSON.stringify({ type: 'structured_expense', items: [row('Mực', '2kg', '100k', { paymentStatus: 'debt', creditor: 'Chị Hoa' })] }) },
  { id: 'p1', note_type: 'expense', created_at: '2026-10-22T01:00:00Z', amount: 500000, debt: 270000, paid_debt: 270000,
    content: JSON.stringify({ type: 'structured_expense', input_amount: 1000000, items: [row('Ốc hương', '2kg', '220k'), row('Sò điệp', '3kg', '90k', { creditor: 'Chị Lan', paid_amount: 270000 }), row('Tiền rau', '', '60k')] }) },
  { id: 'p2', note_type: 'expense', created_at: '2026-10-23T01:05:00Z', amount: 490000, debt: 0, paid_debt: 0,
    content: JSON.stringify({ type: 'structured_expense', input_amount: 800000, items: [row('Bia', '1', '340k'), row('Nghêu', '5kg', '30k')] }) },
];
const payments = [{ note_id: 'p1', amount: 270000, paid_at: '2026-10-23T01:05:30Z', paid_from_note_id: 'p2' }];

test('a debt paid on the 23rd counts on the 23rd, and the till balance of each day is right', () => {
  const d22 = notesSummary(notes, payments, filterRange('22', '10', '2026'));
  assert.deepEqual([d22.given, d22.goods, d22.cash, d22.debtPaid, d22.giveBack], [1000000, 770000, 500000, 0, 500000]);
  assert.equal(d22.debtLeft, 470000, 'end of the 22nd: Lan 270k + Hoa 200k still owed');

  const d23 = notesSummary(notes, payments, filterRange('23', '10', '2026'));
  assert.deepEqual([d23.given, d23.goods, d23.cash, d23.debtPaid, d23.giveBack], [800000, 490000, 760000, 270000, 40000]);
  assert.equal(d23.debtLeft, 200000, 'Hoa from September is still owed');
});

test('the month and all-time views include old debt, listed per creditor', () => {
  const month = notesSummary(notes, payments, filterRange('', '10', '2026'));
  assert.equal(month.debtLeft, 200000, 'debt from last month is not hidden');
  const all = notesSummary(notes, payments, null);
  assert.deepEqual([all.given, all.goods, all.cash, all.debtLeft], [1800000, 1460000, 1260000, 200000]);
  assert.deepEqual(all.creditors, { 'Chị Hoa': 200000 });
});

test('payments made before payment records existed are counted on the note day', () => {
  const legacy = [{ ...notes[1], id: 'old', paid_debt: 100000 }];
  const s = notesSummary(legacy, [], filterRange('22', '10', '2026'));
  assert.deepEqual([s.debtPaid, s.cash, s.debtLeft], [100000, 600000, 170000]);
});
