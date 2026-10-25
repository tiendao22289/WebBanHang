import test from 'node:test';
import assert from 'node:assert/strict';
import { ZALO_TEXT_LIMIT, notesReportMessages } from '../src/lib/notesReport.mjs';

const range = { start: new Date('2026-10-22T17:00:00Z'), end: new Date('2026-10-23T17:00:00Z') };
const note = (id, at, items, extra = {}) => ({ id, staff_id: 's1', note_type: 'expense', created_at: at, staff: { full_name: 'Thy' },
  content: JSON.stringify({ type: 'structured_expense', input_amount: extra.given || 0, note: extra.note || '', items, history: extra.history || [] }),
  amount: extra.amount, debt: extra.debt || 0, paid_debt: extra.paidDebt || 0 });
const all = msgs => msgs.join('\n');

test('each line says whether it was paid, owed to whom, paid back, and what is left', () => {
  const day = note('n1', '2026-10-23T01:15:00Z', [
    { name: 'Ốc hương', qty: '2 ký', price: '220k', paymentStatus: 'full' },
    { name: 'Sò điệp', qty: '3 ký', price: '90k', paymentStatus: 'debt', creditor: 'Chị Lan', paid_amount: 100000 },
    { name: 'Mực', qty: '2 ký', price: '200k', paymentStatus: 'debt', creditor: 'Anh Tư', debtAmount: '150.000' },
    { name: 'Tiền rau', qty: '', price: '' },
  ], { given: 1000000, amount: 690000, debt: 420000, paidDebt: 100000, note: 'chợ sáng',
    history: [{ ts: '09:40 23/10/2026', by: 'Thy', changes: '✏️ Sửa Mực: giá 180k → 200k' }, { ts: '09:00 22/10/2026', by: 'Thy', changes: 'cũ' }] });
  const text = all(notesReportMessages({ date: '2026-10-23', dayNotes: [day], allNotes: [day], payments: [], range }));
  assert.match(text, /🛒 Sổ tay · T6 23\/10\/2026 · 1 phiếu/);
  assert.match(text, /Chủ đưa: 1\.000\.000đ/);
  assert.match(text, /Tiền hàng: 1\.110\.000đ \(trả ngay 690\.000đ, nợ mới 420\.000đ\)/);
  assert.match(text, /• Ốc hương 2 ký × 220k = 440\.000đ — trả đủ/);
  assert.match(text, /• Sò điệp 3 ký × 90k = 270\.000đ — nợ Chị Lan 270\.000đ, đã trả 100\.000đ, còn 170\.000đ/);
  assert.match(text, /• Mực 2 ký × 200k = 400\.000đ — trả ngay 250\.000đ, nợ Anh Tư 150\.000đ/);
  assert.doesNotMatch(text, /Tiền rau/, 'empty template lines are skipped');
  assert.match(text, /Chủ đưa 1\.000\.000đ − đã chi 690\.000đ = dư 310\.000đ \(trả lại chủ\)/);
  assert.match(text, /✎ 09:40 Thy: ✏️ Sửa Mực: giá 180k → 200k/);
  assert.doesNotMatch(text, /cũ$/m, 'edits from other days are not repeated');
  assert.match(text, /📋 Còn nợ:\n• Chị Lan: 170\.000đ — Sò điệp 170\.000đ \(23\/10\)\n• Anh Tư: 150\.000đ — Mực 150\.000đ \(23\/10\)/, 'biggest debt first');
});

test('debt payments, edits to older notes and deleted notes of the day are listed', () => {
  const old = note('old', '2026-10-20T01:00:00Z', [{ name: 'Sò điệp', qty: '3 ký', price: '90k', paymentStatus: 'debt', creditor: 'Chị Lan', paid_amount: 270000 }],
    { amount: 0, debt: 270000, paidDebt: 270000, history: [
      { ts: '10:05 23/10/2026', by: 'Thy', changes: '✏️ Sửa Sò điệp: SL 2 ký → 3 ký' },
      { ts: '10:30 23/10/2026', by: 'Thy', changes: '💰 Khấu trừ 270.000 đ' }] });
  const today = note('new', '2026-10-23T03:00:00Z', [{ name: 'Bia', qty: '1', price: '340k' }], { given: 800000, amount: 340000 });
  const payments = [{ note_id: 'old', item_index: 0, amount: 270000, paid_at: '2026-10-23T03:30:00Z', paid_from_note_id: 'new', created_by_name: 'Thy' }];
  const deleted = [{ changed_at: '2026-10-23T05:00:00Z', staff_id: 'admin', old_row: { created_at: '2026-10-21T02:00:00Z', staff_id: 's1', amount: 500000, debt: 0 } }];
  const text = all(notesReportMessages({ date: '2026-10-23', dayNotes: [today], allNotes: [old, today], payments, deleted,
    staffNames: { s1: 'Thy', admin: 'Chủ quán' }, range }));
  assert.match(text, /→ Tiền hàng 340\.000đ · trả ngay 340\.000đ · trả nợ cũ 270\.000đ/);
  assert.match(text, /Chủ đưa 800\.000đ − đã chi 610\.000đ = dư 190\.000đ/);
  assert.match(text, /💰 Trả nợ trong ngày:\n• 10:30 270\.000đ cho Sò điệp \(Chị Lan\) — phiếu 20\/10 — lấy từ tiền đi chợ · Thy/);
  assert.match(text, /• Phiếu 20\/10 \(Thy\) — 10:05 Thy: ✏️ Sửa Sò điệp: SL 2 ký → 3 ký/);
  assert.doesNotMatch(text, /Phiếu 20\/10 \(Thy\) — 10:30/, 'debt payments are listed once, not as edits');
  assert.match(text, /• 12:00 XOÁ phiếu 21\/10 của Thy \(500\.000đ\) — người xoá: Chủ quán/);
});

test('a note whose saved total does not match its lines is flagged', () => {
  const wrong = note('n2', '2026-10-23T02:00:00Z', [{ name: 'Mực', qty: '1,5kg', price: '200k' }], { amount: 3000000 });
  assert.match(all(notesReportMessages({ date: '2026-10-23', dayNotes: [wrong], allNotes: [wrong], payments: [], range })),
    /⚠ Phiếu lệch tiền: tổng ghi 3\.000\.000đ nhưng các món cộng lại 300\.000đ/);
});

test('long days are split into several Zalo messages under the limit; empty days say so', () => {
  const many = Array.from({ length: 30 }, (_, i) => note(`m${i}`, `2026-10-23T0${i % 9}:00:00Z`,
    Array.from({ length: 6 }, (_, j) => ({ name: `Hàng số ${j} của phiếu ${i}`, qty: '2 ký', price: '150k' })), { amount: 1800000 }));
  const msgs = notesReportMessages({ date: '2026-10-23', dayNotes: many, allNotes: many, payments: [], range });
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.length <= ZALO_TEXT_LIMIT, `message length ${m.length}`);
  assert.match(msgs[0], /Tiền hàng: 54\.000\.000đ/);
  assert.match(all(notesReportMessages({ date: '2026-10-23', dayNotes: [], allNotes: [], payments: [], range })), /Không có phiếu Sổ tay nào ghi trong ngày/);
});

test('Sổ tay of a day and of a week come as data for the stats page', async () => {
  const { notesDayData, notesRangeData } = await import('../src/lib/notesReport.mjs');
  const day = note('n1', '2026-10-23T01:15:00Z', [
    { name: 'Ốc hương', qty: '2 ký', price: '220k', paymentStatus: 'full' },
    { name: 'Sò điệp', qty: '3 ký', price: '90k', paymentStatus: 'debt', creditor: 'Chị Lan', paid_amount: 100000 },
  ], { given: 1000000, amount: 440000, debt: 270000 });
  const d = notesDayData({ date: '2026-10-23', dayNotes: [day], allNotes: [day], payments: [], range });
  assert.deepEqual([d.summary.count, d.summary.goods, d.summary.newDebt], [1, 710000, 270000]);
  assert.deepEqual([d.notes[0].who, d.notes[0].given, d.notes[0].left], ['Thy', 1000000, 560000], 'given 1.000.000 − paid 440.000 = 560.000 back');
  assert.deepEqual(d.notes[0].items.map(i => [i.name, i.total, i.owed, i.left, i.creditor]), [['Ốc hương', 440000, 0, 0, ''], ['Sò điệp', 270000, 270000, 170000, 'Chị Lan']]);
  assert.deepEqual(d.owed.map(o => [o.who, o.total]), [['Chị Lan', 170000]]);
  const w = notesRangeData({ allNotes: [day], payments: [], range });
  assert.deepEqual([w.summary.count, w.byStaff[0].who, w.top[0].name], [1, 'Thy', 'Ốc hương']);
});
