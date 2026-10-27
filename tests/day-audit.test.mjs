import test from 'node:test';
import assert from 'node:assert/strict';
import { dayAudit, staffTag } from '../src/lib/dayAudit.mjs';
import { dayCheck } from '../src/lib/dayCheck.mjs';
import { lossData } from '../src/lib/dailyInsights.mjs';

const D = '2026-10-26';

test('the day audit lists what needs a look with times and tables, never customer or staff names (public workflow log)', () => {
  const ledger = [
    { order_id: 'a', table_number: '2', paid_at: '2026-10-26T12:00:00Z', amount: 200000, payment_method: 'transfer', transfer_image_path: null, customer_name: 'Chị Hoa' },
    { order_id: 'b', table_number: '3', paid_at: '2026-10-26T12:30:00Z', amount: 150000, payment_method: 'cash', photo_skip_reason: 'Máy lỗi camera', photo_by: 'Lan' },
  ];
  const loss = lossData({ cancelled: [{ id: 'x', table_number: 7, cancelled_at: '2026-10-26T13:00:00Z', cancelled_by_name: 'Lan', total_amount: 80000 }] });
  const notes = [{ createdAt: '2026-10-26T02:00:00Z', staffName: 'Thy', cost: 500000, mismatch: 20000, lineWarnings: [], suspicious: [] }];
  const check = dayCheck({ date: D, ledger, paper: [{ amount: 50000, payment_method: 'cash', image_path: 'p.jpg' }], loss, notes,
    unrecorded: [{ tableNumber: 5, paidAt: '2026-10-26T14:00:00Z', amount: 90000, paymentMethod: 'cash' }] });
  const staff = {
    people: [{ id: 'aaaa1111-0000-4000-8000-000000000001', name: 'Thy', spans: [{ in: '2026-10-26T09:58:00Z', out: null }], hours: 6.5, flags: { late: 12, leftEarly: 0 }, open: true, forgot: false, waitMinutes: 0 }],
    alerts: [{ id: 'bbbb2222-0000-4000-8000-000000000002', name: 'Lan', items: [{ text: 'không dùng wifi quán', count: 2 }] }],
    pending: [], fixes: [{ id: 'aaaa1111-0000-4000-8000-000000000001', name: 'Thy', reason: 'quên ra ca' }], outside: [],
  };
  const audit = dayAudit({ date: D, check, ledger, paper: [{ amount: 50000 }], staff, notes, deletedNotes: 1, loss,
    openOrders: [{ table: 9, created_at: '2026-10-26T15:10:00Z', total_amount: 120000, status: 'pending' }] });

  const text = JSON.stringify(audit);
  for (const name of ['Chị Hoa', 'Lan', 'Thy']) assert.ok(!text.includes(name), `no "${name}" in a public log`);
  assert.deepEqual(audit.money, { bills: 2, amount: 350000, cash: { count: 1, amount: 150000 }, transfer: { count: 1, amount: 200000 }, paper: { count: 1, amount: 50000 } });
  assert.deepEqual(audit.bills.unrecorded, [{ table: 5, at: '21:00', amount: 90000, method: 'cash' }], 'times in VN');
  assert.deepEqual(audit.bills.leftOpen, [{ table: 9, since: '22:10', amount: 120000, status: 'pending' }]);
  assert.deepEqual(audit.photos.transferNoPhoto, [{ table: '2', at: '19:00', amount: 200000 }]);
  assert.deepEqual(audit.photos.closedWithoutPhoto, [{ table: '3', at: '19:30', amount: 150000, method: 'cash', reason: 'Máy lỗi camera' }]);
  assert.deepEqual(audit.loss.cancelled, [{ table: 7, at: '20:00', amount: 80000, printed: 0 }]);
  assert.deepEqual(audit.staff.people, [{ staff: staffTag('aaaa1111-0000-4000-8000-000000000001'), spans: ['16:58–chưa ra ca'], hours: 6.5, late: 12, leftEarly: 0, open: true, forgot: false, waitMinutes: 0 }]);
  assert.equal(audit.staff.people[0].staff, 'NV-aaaa');
  assert.deepEqual(audit.staff.scanAlerts, [{ staff: 'NV-bbbb', items: [{ text: 'không dùng wifi quán', count: 2 }] }]);
  assert.equal(audit.staff.fixesWaiting, 1);
  assert.deepEqual(audit.notes, { count: 1, amount: 500000, deleted: 1, problems: [{ at: '09:00', cost: 500000, problems: ['lệch 20.000đ so với các dòng hàng'] }] });
  assert.deepEqual(audit.todo, [
    'Bill đã thu mà sổ chưa có: 1', 'Bill trong ngày còn mở (chưa thu / chưa huỷ): 1', 'Bill chuyển khoản chưa có ảnh: 1',
    'Đóng bàn không ảnh (có lý do): 1', 'Bill bị huỷ: 1', 'Nhân viên chưa ra ca: 1', 'Nhân viên đi trễ: 1',
    'Nhân viên có lần quét bị cảnh báo / chặn: 1', 'Phiếu Sổ tay lệch / giá đáng ngờ: 1', 'Phiếu Sổ tay bị xoá: 1',
  ]);
});

test('a quiet day has nothing to look at', () => {
  const audit = dayAudit({ date: D, check: dayCheck({ date: D }), staff: { people: [], alerts: [], pending: [], fixes: [], outside: [] } });
  assert.deepEqual(audit.todo, []);
  assert.equal(audit.money.bills, 0);
});
