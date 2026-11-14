import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardOffWarning, qrSetupProblem } from '../src/lib/qrCardProblems.mjs';

const tablesPage = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
const settingsPage = readFileSync(new URL('../src/app/admin/settings/page.js', import.meta.url), 'utf8');

test('the table page names the real reason a transfer QR cannot be made', () => {
  // 01/11: thẻ hiển thị bị tắt → prepare_stats_payment báo lỗi này, trang Bàn lại bảo "kiểm tra mạng".
  const cardOff = qrSetupProblem({ code: 'P0001', message: 'Chua co the A dang hoat dong' });
  assert.equal(cardOff.title, 'Thẻ ngân hàng đang tắt');
  assert.match(cardOff.text, /Cài đặt → 💳 Thanh toán/);
  assert.match(cardOff.text, /▶ Bật/);
  for (const message of ['Khong co tai khoan nhan tien phu hop; khong doi sang the A', 'Khong co tai khoan nhan tien phu hop',
    'Tai khoan QR khong con hoat dong. Vui long kiem tra lai.']) {
    assert.equal(qrSetupProblem(new Error(message)).title, 'Chưa có thẻ nhận tiền', message);
  }
  for (const message of ['Bill da thay doi. Vui long dong bo lai truoc khi tao QR.', 'Nhom ban da thay doi', 'Khong tim thay ban']) {
    assert.equal(qrSetupProblem(new Error(message)).title, 'Bàn vừa thay đổi', message);
  }
  for (const error of [new TypeError('Failed to fetch'), { code: '42501', message: 'permission denied' }, null, undefined]) {
    assert.deepEqual(qrSetupProblem(error), { title: 'Chưa thể tạo QR', text: 'Không đọc được đầy đủ bill. Vui lòng kiểm tra mạng rồi thử lại.' });
  }
});

test('staff never read about the hidden cards on the table page', () => {
  for (const message of ['Chua co the A dang hoat dong', 'Khong co tai khoan nhan tien phu hop', 'Bill da thay doi', 'offline']) {
    const { title, text } = qrSetupProblem(new Error(message));
    assert.doesNotMatch(`${title} ${text}`, /ẩn|phụ|thống kê|thẻ A/i, message);
  }
});

test('turning off the last card a QR needs asks first; other switches do not', () => {
  const visible = { id: 'A', is_visible: true, is_active: true };
  const hidden = { id: 'B', is_visible: false, is_active: true };
  const hiddenOff = { id: 'C', is_visible: false, is_active: false };
  assert.match(cardOffWarning(visible, [visible, hidden, hiddenOff]), /trang Bàn KHÔNG tạo được mã QR/);
  assert.match(cardOffWarning(hidden, [visible, hidden, hiddenOff]), /thẻ ẩn cuối cùng/);
  // Còn thẻ cùng loại đang bật → không hỏi.
  assert.equal(cardOffWarning(visible, [visible, { id: 'A2', is_visible: true, is_active: true }, hidden]), null);
  assert.equal(cardOffWarning(hidden, [visible, hidden, { ...hiddenOff, is_active: true }]), null);
  // Bật lại thẻ đang tắt → không hỏi.
  assert.equal(cardOffWarning({ ...visible, is_active: false }, [hidden]), null);
  assert.equal(cardOffWarning(hiddenOff, [visible, hidden, hiddenOff]), null);
});

test('both pages use the helpers', () => {
  const open = tablesPage.slice(tablesPage.indexOf('  async function openPaymentModal('), tablesPage.indexOf('  async function recordBankPayment('));
  assert.match(open, /const problem = qrSetupProblem\(error\);\s+Swal\.fire\(problem\.title, problem\.text, 'error'\);/);
  assert.doesNotMatch(open, /'Chưa thể tạo QR'/);
  const toggle = settingsPage.slice(settingsPage.indexOf('  async function toggleActive('), settingsPage.indexOf('  async function deleteAccount('));
  assert.match(toggle, /const warning = cardOffWarning\(acc, secretAccounts\);\s+if \(warning && !window\.confirm\(warning\)\) return;/);
  assert.ok(toggle.indexOf('window.confirm') < toggle.indexOf(".from('bank_accounts')"), 'asks before writing');
});
