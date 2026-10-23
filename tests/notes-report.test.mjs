import test from 'node:test';
import assert from 'node:assert/strict';
import { ZALO_TEXT_LIMIT, notesReportMessages } from '../src/lib/notesReport.mjs';

const range = { start: new Date('2026-10-22T17:00:00Z'), end: new Date('2026-10-23T17:00:00Z') };
const note = (id, at, items, extra = {}) => ({ id, note_type: 'expense', created_at: at, staff: { full_name: 'Thy' },
  content: JSON.stringify({ type: 'structured_expense', input_amount: extra.given || 0, note: extra.note || '', items }), amount: extra.amount, debt: extra.debt || 0, paid_debt: 0 });

test('the Sổ tay message lists each note, its lines, totals and who is owed', () => {
  const day = note('n1', '2026-10-23T01:15:00Z', [
    { name: 'Ốc hương', qty: '2 ký', price: '220k', paymentStatus: 'full' },
    { name: 'Sò điệp', qty: '3 ký', price: '90k', paymentStatus: 'debt', creditor: 'Chị Lan' },
    { name: 'Mực', qty: '1,5kg', price: '200k', paymentStatus: 'full' },
  ], { given: 1000000, amount: 740000, debt: 270000, note: 'chợ sáng' });
  const [msg] = notesReportMessages({ date: '2026-10-23', dayNotes: [day], allNotes: [day], payments: [], range });
  assert.match(msg, /🛒 Sổ tay · T6 23\/10\/2026 \(1 phiếu\)/);
  assert.match(msg, /1\. 08:15 · Thy · chủ đưa 1\.000\.000đ/);
  assert.match(msg, /• Mực 1,5kg × 200k = 300\.000đ/);
  assert.match(msg, /• Sò điệp 3 ký × 90k = 270\.000đ \(nợ Chị Lan\)/);
  assert.match(msg, /Tiền hàng 1\.010\.000đ · trả 740\.000đ · nợ 270\.000đ · trả lại chủ 260\.000đ/);
  assert.match(msg, /Ghi chú: chợ sáng/);
  assert.match(msg, /Còn nợ \(tất cả\): 270\.000đ — Chị Lan 270\.000đ/);
  assert.doesNotMatch(msg, /lệch tiền/);
});

test('a note whose saved total does not match its lines is flagged', () => {
  const wrong = note('n2', '2026-10-23T02:00:00Z', [{ name: 'Mực', qty: '1,5kg', price: '200k' }], { amount: 3000000 });
  const [msg] = notesReportMessages({ date: '2026-10-23', dayNotes: [wrong], allNotes: [wrong], payments: [], range });
  assert.match(msg, /⚠ Phiếu lệch tiền: các dòng cộng lại 300\.000đ/);
});

test('long days are split into several Zalo messages under the limit; empty days say so', () => {
  const many = Array.from({ length: 30 }, (_, i) => note(`m${i}`, `2026-10-23T0${i % 9}:00:00Z`,
    Array.from({ length: 6 }, (_, j) => ({ name: `Hàng số ${j} của phiếu ${i}`, qty: '2 ký', price: '150k' })), { amount: 1800000 }));
  const msgs = notesReportMessages({ date: '2026-10-23', dayNotes: many, allNotes: many, payments: [], range });
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.length <= ZALO_TEXT_LIMIT, `message length ${m.length}`);
  assert.match(msgs.at(-1), /Tổng: tiền hàng 54\.000\.000đ/);
  assert.match(notesReportMessages({ date: '2026-10-23', dayNotes: [], allNotes: [], payments: [], range })[0], /Không có phiếu Sổ tay nào/);
});
