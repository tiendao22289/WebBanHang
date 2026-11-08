import test from 'node:test';
import assert from 'node:assert/strict';
import { missingBills, notePriceAlert, priceAlert, priceAlertText, purchasePrices, usualPrice } from '../src/lib/notesChecks.mjs';
import { notesDayData, notesRangeData, notesReportMessages } from '../src/lib/notesReport.mjs';

const note = (id, at, items, extra = {}) => ({ id, staff_id: 's1', note_type: 'expense', created_at: at, staff: { full_name: 'Thy' },
  content: JSON.stringify({ type: 'structured_expense', input_amount: 0, note: '', items }), amount: extra.amount || 0, debt: 0, paid_debt: 0 });
const oc = price => ({ name: 'Ốc hương', qty: '2 ký', price, paymentStatus: 'full' });
// Mua ốc hương 4 lần trước ngày 23/10: 230k, 240k, 250k, 240k → giá thường 240k.
const history = [
  note('a', '2026-10-15T01:00:00Z', [oc('230k')]), note('b', '2026-10-17T01:00:00Z', [oc('240k')]),
  note('c', '2026-10-19T01:00:00Z', [{ ...oc('250k'), name: 'oc HUONG' }]), note('d', '2026-10-21T01:00:00Z', [oc('240k')]),
];
const BEFORE = Date.parse('2026-10-23T01:00:00Z');

test('usual price = median of the last purchases of the same item (accents and case ignored)', () => {
  const prices = purchasePrices(history);
  assert.equal(usualPrice(prices, 'Ốc Hương', { before: BEFORE }), 240000);
  assert.equal(usualPrice(prices, 'Ốc hương', { before: Date.parse('2026-10-16T01:00:00Z') }), null, 'one earlier purchase is not enough');
  assert.equal(usualPrice(prices, 'Ốc hương', { before: Date.parse('2026-12-30T01:00:00Z') }), null, 'purchases older than 45 days do not count');
  assert.equal(usualPrice(prices, 'Sò điệp', { before: BEFORE }), null, 'never bought before');
});

test('15% or more above the usual price is flagged; less is not', () => {
  const prices = purchasePrices(history);
  assert.deepEqual(priceAlert(oc('276k'), prices, { before: BEFORE }), { price: 276000, usual: 240000, pct: 15 });
  assert.equal(priceAlert(oc('270k'), prices, { before: BEFORE }), null, '12% is normal day-to-day change');
  assert.equal(priceAlert(oc('200k'), prices, { before: BEFORE }), null, 'cheaper is fine');
  assert.equal(priceAlertText(priceAlert(oc('300k'), prices, { before: BEFORE })), 'Giá cao hơn thường 25% (thường 240.000đ)');
});

test('vegetable / spice lump sums and "Khác" lines are never compared', () => {
  const notes = [1, 2, 3].map(d => note(`r${d}`, `2026-10-1${d}T01:00:00Z`, [
    { name: 'Tiền rau', preset: true, price: '50k' }, { name: 'Xăng xe', price: '50k', category: 'xang' }]));
  const prices = purchasePrices(notes);
  assert.equal(priceAlert({ name: 'Tiền rau', preset: true, price: '200k' }, prices, { before: BEFORE }), null);
  assert.equal(priceAlert({ name: 'Xăng xe', price: '200k', category: 'xang' }, prices, { before: BEFORE }), null);
});

test('a saved note is compared with notes written before it, not with itself or later ones', () => {
  const today = note('t', '2026-10-23T01:00:00Z', [oc('300k')]);
  const later = note('z', '2026-10-25T01:00:00Z', [oc('300k')]);
  const prices = purchasePrices([...history, today, later]);
  assert.equal(notePriceAlert(today, prices)(oc('300k')).pct, 25);
  assert.equal(notePriceAlert(history[0], prices)(oc('230k')), null, 'the first purchases have nothing to compare with');
});

test('which lines need a bill: priced ốc lines only, not rau / gia vị lump sums, Khác or unpriced lines', () => {
  const lines = [oc('240k'), { name: 'Tiền rau', preset: true, price: '50k' }, { name: 'Xăng xe', price: '50k', category: 'xang' }, { name: 'Ốc hương', price: '' }];
  assert.deepEqual(missingBills(lines).map(i => i.price), ['240k']);
  assert.deepEqual(missingBills(undefined), []);
});

test('the owner sees the high price in the Zalo report and in /thongke', () => {
  const range = { start: new Date('2026-10-22T17:00:00Z'), end: new Date('2026-10-23T17:00:00Z') };
  const today = note('t', '2026-10-23T01:00:00Z', [oc('300k'), { name: 'Mực', qty: '1', price: '200k' }], { amount: 800000 });
  const allNotes = [...history, today];
  const text = notesReportMessages({ date: '2026-10-23', dayNotes: [today], allNotes, payments: [], range }).join('\n');
  assert.match(text, /• Ốc hương 2 ký × 300k = 600\.000đ — trả đủ\n {2}⚠ Giá cao hơn thường 25% \(thường 240\.000đ\)/);
  const day = notesDayData({ date: '2026-10-23', dayNotes: [today], allNotes, payments: [], range });
  assert.deepEqual(day.notes[0].items.map(i => i.warnings), [['Giá cao hơn thường 25% (thường 240.000đ)'], []]);
  assert.equal(day.summary.warnings, 1);
  assert.equal(notesRangeData({ allNotes, payments: [], range }).summary.warnings, 1);
});

test('lines bought without a seller bill show the reason to the owner', () => {
  const range = { start: new Date('2026-10-22T17:00:00Z'), end: new Date('2026-10-23T17:00:00Z') };
  const today = note('t', '2026-10-23T01:00:00Z', [{ ...oc('240k'), no_bill: 'mối quen không viết bill' }], { amount: 480000 });
  const text = notesReportMessages({ date: '2026-10-23', dayNotes: [today], allNotes: [...history, today], payments: [], range }).join('\n');
  assert.match(text, /⚠ Không có bill: mối quen không viết bill/);
  const day = notesDayData({ date: '2026-10-23', dayNotes: [today], allNotes: [...history, today], payments: [], range });
  assert.deepEqual(day.notes[0].items[0].warnings, ['Không có bill: mối quen không viết bill']);
  assert.equal(day.summary.warnings, 1);
  assert.deepEqual(missingBills([oc('240k'), { ...oc('240k'), no_bill: 'x' }, { ...oc('240k'), bill_photo: 'p' }, { name: 'Tiền rau', preset: true, price: '50k' }]).length, 1);
});

test('/thongke gets each line\'s bill photo (and old scale photos) so the owner can open them', () => {
  const range = { start: new Date('2026-10-22T17:00:00Z'), end: new Date('2026-10-23T17:00:00Z') };
  const today = note('t', '2026-10-23T01:00:00Z', [
    { ...oc('240k'), bill_photo: '2026-10/notebill-a.jpg', bill_from: 'gallery' },
    { name: 'Sò điệp', qty: '3', price: '90k', bill_photo: '2026-10/notebill-a.jpg' },
    { name: 'Mực', qty: '1', price: '200k', no_bill: 'mối quen' },
  ], { amount: 950000 });
  const day = notesDayData({ date: '2026-10-23', dayNotes: [today], allNotes: [today], payments: [], range });
  assert.deepEqual(day.notes[0].items.map(i => [i.name, i.bill || null, i.billFrom || null]),
    [['Ốc hương', '2026-10/notebill-a.jpg', 'gallery'], ['Sò điệp', '2026-10/notebill-a.jpg', null], ['Mực', null, null]]);
  assert.equal(day.notes[0].photos, undefined, 'no scale photo on this note');
  const old = { ...today, content: JSON.stringify({ ...JSON.parse(today.content), photos: ['2026-10/note-x.jpg', 42] }) };
  assert.deepEqual(notesDayData({ date: '2026-10-23', dayNotes: [old], allNotes: [old], payments: [], range }).notes[0].photos, ['2026-10/note-x.jpg']);
});
