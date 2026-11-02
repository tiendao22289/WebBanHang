import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenPath, canSeeReviews, normalizeRole, roleLabel } from '../src/lib/staffRoles.mjs';

test('quản lý mở thêm Thực đơn và Sổ tay, không vào tab của chủ quán', () => {
  for (const p of ['/admin/tables', '/admin/qr', '/admin/payroll', '/admin/menu', '/admin/notes']) assert.ok(canOpenPath('manager', p), p);
  for (const p of ['/admin/stats', '/admin/customers', '/admin/settings', '/admin/finance', '/admin/vouchers', '/admin/logs']) assert.ok(!canOpenPath('manager', p), p);
});

test('nhân viên giữ nguyên quyền cũ, admin mở hết', () => {
  assert.ok(canOpenPath('staff', '/admin/tables'));
  assert.ok(!canOpenPath('staff', '/admin/menu'));
  assert.ok(!canOpenPath('staff', '/admin/menuabc'));
  assert.ok(canOpenPath('admin', '/admin/settings'));
});

test('vai trò lạ coi như nhân viên; Đánh giá cho admin và quản lý', () => {
  assert.equal(normalizeRole('owner'), 'staff');
  assert.equal(roleLabel('manager'), '🧑‍💼 Quản lý');
  assert.ok(canSeeReviews('manager') && canSeeReviews('admin') && !canSeeReviews('staff'));
});
