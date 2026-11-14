import test from 'node:test';
import assert from 'node:assert/strict';
import { notesAudit } from '../src/lib/notesAudit.mjs';

const STAFF = '11111111-2222-4333-8444-555555555555';
const note = (id, at, fields, data) => ({ id, staff_id: STAFF, note_type: 'expense', created_at: at, amount: 0, debt: 0, paid_debt: 0,
  content: JSON.stringify({ type: 'structured_expense', items: [], ...data }), ...fields });
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';

test('a clean set of notes shows no problems, and the month tiles equal the straight sums', () => {
  const notes = [
    note(A, '2026-11-01T03:00:00Z', { amount: 300000, debt: 200000 }, { input_amount: 500000, items: [
      { name: 'Ốc hương', price: '300k', qty: '1', paymentStatus: 'full' }, { name: 'Mực', price: '200k', qty: '1', paymentStatus: 'debt', paid_amount: 50000 }] }),
    note(B, '2026-11-02T03:00:00Z', { amount: 100000 }, { input_amount: 0, carried_in: [{ from_note_id: A, amount: 150000 }], items: [{ name: 'Hàu', price: '100k', qty: '1' }] }),
  ];
  const a = JSON.parse(notes[0].content); a.carried_out = [{ to_note_id: B, amount: 150000 }]; notes[0].content = JSON.stringify(a);
  notes[0].paid_debt = 50000;
  const payments = [{ id: 'p1', note_id: A, item_index: 1, amount: 50000, paid_at: '2026-11-03T03:00:00Z', paid_from_note_id: B }];
  const r = notesAudit({ notes, payments, months: ['2026-11'] });
  assert.deepEqual(r.summary, ['Không thấy lệch']);
  assert.equal(r.months[0].tiles.tienHang, 600000);
  assert.equal(r.months[0].direct.tienHangSoThuChi, 600000);
  assert.equal(r.months[0].tiles.chuDua, 500000);
  assert.equal(r.months[0].tiles.conNo, 150000);
  assert.ok(!JSON.stringify(r).includes('Ốc hương'), 'no note content in the output (public logs)');
  assert.ok(!JSON.stringify(r).includes(STAFF), 'staff only as NV-xxxx');
});

test('each kind of mismatch is reported', () => {
  const notes = [
    // Tổng phiếu lệch dòng hàng; trả nợ quá; paid_debt nhỏ hơn sổ trả nợ.
    note(A, '2026-11-01T03:00:00Z', { amount: 999000, debt: 100000, paid_debt: 0 }, { input_amount: 100000, items: [
      { name: 'Mực', price: '100k', qty: '1', paymentStatus: 'debt', paid_amount: 150000, payment_logs: [{ amount: 150000, from_note_id: null }] }],
      returned_logs: [{ amount: 50000 }], carried_out: [{ to_note_id: B, amount: 70000 }] }),
    // Nhận 50.000 nhưng phiếu A ghi chuyển 70.000; phiếu không có tiền giao mà bỏ tiền trả nợ.
    note(B, '2026-11-02T03:00:00Z', { amount: 0 }, { carried_in: [{ from_note_id: A, amount: 50000 }], short_settled: [{ from_note_id: C, amount: 30000 }] }),
    note(C, '2026-11-02T05:00:00Z', {}, { offset_out: [] }),
    { id: 'dddddddd-0000-4000-8000-000000000004', staff_id: STAFF, note_type: 'stock', created_at: '2026-11-02T06:00:00Z', amount: 20000, debt: 0, paid_debt: 0, content: 'thiếu đá' },
  ];
  const payments = [
    { id: 'p1', note_id: A, item_index: 0, amount: 150000, paid_at: '2026-11-03T03:00:00Z', paid_from_note_id: null },
    { id: 'p2', note_id: 'eeeeeeee-0000-4000-8000-000000000009', item_index: null, amount: 10000, paid_at: '2026-11-03T03:00:00Z', paid_from_note_id: null },
  ];
  const r = notesAudit({ notes, payments, months: ['2026-11'] });
  assert.equal(r.totalsMismatch.length, 1);
  assert.equal(r.overPaidLines.length, 1);
  assert.ok(r.paidDebtMismatch.length >= 1);
  assert.equal(r.orphanPayments.length, 1);
  assert.equal(r.leftoverOverUsed.length, 1, 'returned + carried out > what was left');
  assert.equal(r.carryMismatch.length, 1);
  assert.equal(r.offsetMismatch.length, 1, 'B says C covered 30.000, C has no offset_out');
  assert.equal(r.costedOtherTypes.length, 1);
  assert.ok(r.summary.length >= 7);
});
