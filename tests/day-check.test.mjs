import test from 'node:test';
import assert from 'node:assert/strict';
import { dayCheck, dayCheckLines } from '../src/lib/dayCheck.mjs';
import { lossData } from '../src/lib/dailyInsights.mjs';

const D = '2026-10-24';

test('the nightly check lists only what needs a look: missing bills, transfer photos, closes without a photo, cancels, Sổ tay', () => {
  const ledger = [
    { order_id: 'a', table_number: '1', paid_at: '2026-10-24T12:00:00Z', amount: 300000, payment_method: 'transfer', transfer_image_path: 'a.jpg' },
    { order_id: 'b', table_number: '2', paid_at: '2026-10-24T12:30:00Z', amount: 200000, payment_method: 'transfer', transfer_image_path: null },
    { order_id: 'c', table_number: '3', paid_at: '2026-10-24T13:00:00Z', amount: 150000, payment_method: 'cash', photo_skip_reason: 'Máy hỏng camera', photo_by: 'Lan' },
    { order_id: 'd', table_number: '4', paid_at: '2026-10-24T13:10:00Z', amount: 90000, payment_method: 'transfer', transfer_image_path: null, photo_skip_reason: 'Khách vội' },
  ];
  const paper = [{ id: 'p', table_label: 'Bàn 9', received_at: '2026-10-24T14:00:00Z', amount: 50000, payment_method: 'transfer', transfer_image_path: null }];
  const loss = lossData({ printed: new Map([['x', [[{ id: 'i', name: 'Tôm', quantity: 1, unit_price: 80000 }]]]]),
    cancelled: [{ id: 'x', table_number: 7, cancelled_at: '2026-10-24T14:05:00Z', cancelled_by_name: 'Lan', total_amount: 80000 }] });
  const check = dayCheck({ date: D, ledger, paper, loss,
    unrecorded: [{ tableNumber: 5, paidAt: '2026-10-24T15:00:00Z', amount: 120000, paymentMethod: 'cash' }],
    recovered: [{ tableNumber: 6, paidAt: '2026-10-24T15:30:00Z', amount: 60000, paymentMethod: 'cash' }],
    notes: [{ createdAt: '2026-10-24T02:00:00Z', staffName: 'Thy', cost: 500000, mismatch: 20000, lineWarnings: [], suspicious: [] },
      { createdAt: '2026-10-24T03:00:00Z', staffName: 'Thy', cost: 100000, mismatch: 0, lineWarnings: [], suspicious: [] }] });
  const byKey = Object.fromEntries(check.issues.map(i => [i.key, i]));
  assert.deepEqual(Object.keys(byKey), ['unrecorded', 'recovered', 'ck_no_photo', 'no_photo', 'cancelled', 'notes']);
  assert.deepEqual([byKey.ck_no_photo.count, byKey.ck_no_photo.amount], [2, 250000], 'bill b + the paper bill; d is listed under no photo instead');
  assert.deepEqual(byKey.no_photo.rows.map(r => [r.table, r.reason, r.by]), [['3', 'Máy hỏng camera', 'Lan'], ['4', 'Khách vội', null]]);
  assert.equal(byKey.cancelled.amount, 80000);
  assert.equal(byKey.notes.count, 1);
  assert.match(byKey.notes.rows[0].problems[0], /lệch 20\.000đ/);
  assert.equal(byKey.recovered.level, 'info');
  assert.equal(check.problems, 5, 'a recovered bill is only for information');
  assert.equal(check.ok, false);
  assert.deepEqual(check.bills, { count: 5, amount: 790000 });

  const lines = dayCheckLines(check);
  assert.equal(lines[0], '🤖 Máy tự kiểm tra: 5 việc cần xem');
  assert.ok(lines.includes('• Bill chuyển khoản chưa có ảnh: 2 (250.000đ)'));
});

test('a clean day is ok; photos older than the 3 months kept are not asked for', () => {
  const ok = dayCheck({ date: D, ledger: [{ order_id: 'a', amount: 100000, payment_method: 'cash', cash_image_path: 'c.jpg' }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(dayCheckLines(ok), ['🤖 Máy tự kiểm tra: ✓ không có gì bất thường']);
  const old = dayCheck({ date: D, keepPhotosFrom: '2026-11-01', ledger: [{ order_id: 'a', amount: 100000, payment_method: 'transfer', transfer_image_path: null }] });
  assert.equal(old.ok, true);
  assert.deepEqual(dayCheckLines(null), []);
});
