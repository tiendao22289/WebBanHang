import test from 'node:test';
import assert from 'node:assert/strict';
import { handoverTotals } from '../src/lib/notesDebts.mjs';
import { filterRange, inRange } from '../src/lib/notesSummary.mjs';
import { noteCash, notesDayData, notesReportMessages } from '../src/lib/notesReport.mjs';

test('"Còn phải đưa chủ" is worked out per person: one buyer\'s top-up does not cancel another buyer\'s leftover', () => {
  const h = handoverTotals([{ staff_id: 'A', left: 300000 }, { staff_id: 'A', left: 50000 }], [{ staff_id: 'B', short: 100000 }, { staff_id: 'A', short: 20000 }]);
  assert.deepEqual(h, { held: 350000, short: 120000, toOwner: 330000, owes: 100000 });
  assert.deepEqual(handoverTotals([], []), { held: 0, short: 0, toOwner: 0, owes: 0 });
});

test('the day / month filter uses Vietnam time, whatever the phone\'s time zone', () => {
  // 23/10 00:30 giờ VN = 22/10 17:30 UTC → thuộc ngày 23.
  const d23 = filterRange('23', '10', '2026');
  assert.equal(d23.start.toISOString(), '2026-10-22T17:00:00.000Z');
  assert.equal(d23.end.toISOString(), '2026-10-23T17:00:00.000Z');
  assert.ok(inRange('2026-10-22T17:30:00Z', d23));
  assert.ok(!inRange('2026-10-22T16:59:00Z', d23));
  const nov = filterRange('', '11', '2026');
  assert.deepEqual([nov.start.toISOString(), nov.end.toISOString()], ['2026-10-31T17:00:00.000Z', '2026-11-30T17:00:00.000Z']);
  // Chỉ chọn ngày: tháng / năm hiện tại theo giờ VN (31/10 20:00 UTC = 01/11 03:00 VN).
  const onlyDay = filterRange('5', '', '', Date.parse('2026-10-31T20:00:00Z'));
  assert.equal(onlyDay.start.toISOString(), '2026-11-04T17:00:00.000Z');
  assert.equal(filterRange('', '', ''), null);
  assert.ok(inRange('2020-01-01T00:00:00Z', null));
});

const trip = (id, at, extra) => ({ id, staff_id: 's1', note_type: 'expense', created_at: at, staff: { full_name: 'Thy' }, amount: 300000, debt: 0, paid_debt: 0,
  content: JSON.stringify({ type: 'structured_expense', input_amount: 500000, items: [{ name: 'Ốc hương', qty: '1', price: '300k', paymentStatus: 'full' }], ...extra }) });
const range = { start: new Date('2026-11-01T17:00:00Z'), end: new Date('2026-11-02T17:00:00Z') };

test('a note\'s leftover in the report counts what was already handed back or moved to a later note', () => {
  const plain = trip('n1', '2026-11-02T02:00:00Z', {});
  assert.equal(noteCash(plain).left, 200000);
  const handed = trip('n2', '2026-11-02T03:00:00Z', { returned_logs: [{ amount: 150000 }], carried_out: [{ to_note_id: 'x', amount: 50000 }] });
  assert.deepEqual([noteCash(handed).balance, noteCash(handed).left], [200000, 0]);
  const short = { ...trip('n3', '2026-11-02T04:00:00Z', { short_settled: [{ from_note_id: 'n1', amount: 30000 }] }), amount: 600000 };
  assert.deepEqual([noteCash(short).balance, noteCash(short).left], [-100000, -70000], 'top-up 100k, 30k already made up');
  const noMoney = { ...trip('n4', '2026-11-02T05:00:00Z', {}), content: JSON.stringify({ type: 'structured_expense', items: [] }) };
  assert.equal(noteCash(noMoney).left, null);

  const notes = [plain, handed, short];
  const data = notesDayData({ date: '2026-11-02', dayNotes: notes, allNotes: notes, payments: [], range });
  assert.deepEqual(data.notes.map(n => [n.balance, n.left]), [[200000, 200000], [200000, 0], [-100000, -70000]]);
  const text = notesReportMessages({ date: '2026-11-02', dayNotes: notes, allNotes: notes, payments: [], range }).join('\n');
  assert.match(text, /dư 200\.000đ \(trả lại chủ\)/);
  assert.match(text, /dư 200\.000đ · đã trả chủ 150\.000đ · chuyển phiếu sau 50\.000đ · hết dư/);
  assert.match(text, /thiếu 100\.000đ \(người đi chợ bỏ thêm\) · đã bù 30\.000đ · còn 70\.000đ chưa bù/);
});

test('looking at an old day shows the leftover and the debts as they were at the end of that day', () => {
  const n1 = { id: 'n1', staff_id: 's1', note_type: 'expense', created_at: '2026-11-02T02:00:00Z', staff: { full_name: 'Thy' }, amount: 300000, debt: 200000, paid_debt: 200000,
    content: JSON.stringify({ type: 'structured_expense', input_amount: 500000, returned_logs: [{ amount: 200000, ts: '09:00 03/11/2026' }], items: [
      { name: 'Ốc hương', qty: '1', price: '300k', paymentStatus: 'full' },
      { name: 'Mực', qty: '1', price: '200k', paymentStatus: 'debt', creditor: 'Chị Lan', paid_amount: 200000, payment_logs: [{ amount: 200000 }] }] }) };
  const payments = [{ note_id: 'n1', item_index: 1, amount: 200000, paid_at: '2026-11-03T02:00:00Z', paid_from_note_id: null }];
  const day2 = { start: new Date('2026-11-01T17:00:00Z'), end: new Date('2026-11-02T17:00:00Z') };
  const day3 = { start: new Date('2026-11-02T17:00:00Z'), end: new Date('2026-11-03T17:00:00Z') };

  const old = notesDayData({ date: '2026-11-02', dayNotes: [n1], allNotes: [n1], payments, range: day2 });
  assert.equal(old.notes[0].left, 200000, 'handed back on the 3rd → still held at the end of the 2nd');
  assert.deepEqual(old.owed.map(o => [o.who, o.total]), [['Chị Lan', 200000]], 'paid on the 3rd → still owed at the end of the 2nd');
  assert.match(notesReportMessages({ date: '2026-11-02', dayNotes: [n1], allNotes: [n1], payments, range: day2 }).join('\n'), /Chị Lan: 200\.000đ/);

  const next = notesDayData({ date: '2026-11-03', dayNotes: [], allNotes: [n1], payments, range: day3 });
  assert.deepEqual(next.owed, []);
  assert.equal(noteCash(n1, payments, day3.end.getTime()).left, 0);
  assert.equal(noteCash(n1, payments).left, 0, 'today: everything counted');
});
