import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { qrTableLabel } from '../src/lib/qrTableLabel.mjs';

// Trang Mã QR (/admin/qr), 2026-11-10: chủ quán bỏ tab "Bill giấy" — tên bàn ghi ngay trong khung "Tạo mã QR tuỳ
// chỉnh". Ảnh vẫn bắt buộc: bấm ghi tiền là mở camera (chủ quán bỏ nút "Chụp bill" riêng cùng ngày vì thừa).
const page = readFileSync(new URL('../src/app/admin/qr/page.jsx', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = page.indexOf(from), end = page.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `page section ${from}`);
  return page.slice(start, end);
};
const cashSource = slice('  const handleCashPayment = ', '  const saveCash = async');
const confirmSource = slice('  const handleConfirmManual = ', '  const saveTransfer = async');
const transferSource = slice('  const saveTransfer = async', '  // Gọn cho điện thoại');

function qrPage(state = {}) {
  const env = { camera: [], posts: [], cleared: 0, status: null };
  const context = {
    amount: '', tableLabel: '', saving: false, transactionCode: 'QRAB1234', activeQr: null, ...state,
    qrTableLabel, Number, parseInt, String,
    openCamera: shot => env.camera.push(shot),
    postQrPayment: async (fields, images) => { env.posts.push({ fields, images }); return { ok: true, photoSaved: true }; },
    setPaymentStatus: s => { env.status = s; }, clearForm: () => { env.cleared += 1; },
    Swal: { fire() {} },
  };
  const api = vm.runInNewContext(`${cashSource}\n${confirmSource}\n${transferSource}\n({ handleCashPayment, handleConfirmManual, saveTransfer })`, context);
  return { ...api, env, context };
}
const plain = v => JSON.parse(JSON.stringify(v));

test('cash opens the camera for the bill and carries the table typed in the box', () => {
  const h = qrPage({ amount: '280.000', tableLabel: '12' });
  h.handleCashPayment();
  assert.deepEqual(plain(h.env.camera), [{ method: 'cash', amount: 280000, table: 'Bàn 12' }]);
  const away = qrPage({ amount: '150.000', tableLabel: 'Mang về' });
  away.handleCashPayment();
  assert.deepEqual(plain(away.env.camera), [{ method: 'cash', amount: 150000, table: 'Mang về' }]);
  const empty = qrPage({ amount: '' });
  empty.handleCashPayment();
  assert.equal(empty.env.camera.length, 0, 'no amount, nothing happens');
  const busy = qrPage({ amount: '150.000', saving: true });
  busy.handleCashPayment();
  assert.equal(busy.env.camera.length, 0, 'a second tap while saving does nothing');
});

test('a transfer opens the camera on confirm and sends the one photo with the table', async () => {
  const activeQr = { code: 'QRAB1234', amount: 350000, account: { id: 'acc' }, table: 'Bàn 5' };
  const h = qrPage({ activeQr });
  h.handleConfirmManual();
  assert.deepEqual(plain(h.env.camera), [{ method: 'transfer', amount: 350000, table: 'Bàn 5' }]);
  await h.saveTransfer('screen', 'ck');
  const [sent] = h.env.posts;
  assert.deepEqual(plain(sent.fields), { action: 'qr_confirm', code: 'QRAB1234', amount: 350000, account_id: 'acc', kind: 'ck', table_label: 'Bàn 5' });
  assert.deepEqual(plain(sent.images), { image: ['screen', 'ck'] });
  assert.deepEqual([h.env.status, h.env.cleared], ['completed', 1], 'the box is emptied for the next customer');
  const noTable = qrPage({ activeQr: { ...activeQr, table: null } });
  await noTable.saveTransfer('bill', 'bill');
  assert.deepEqual(plain([noTable.env.posts[0].images, noTable.env.posts[0].fields.table_label]), [{ image: ['bill', 'bill'] }, '']);
});

test('the Bill giấy tab is gone: the QR box has the table field, no separate bill button, and old links open the QR page', () => {
  assert.ok(!page.includes('ReceiptsPanel') && !page.includes('tab=bill') && !page.includes('role="tablist"'), 'no Bill giấy tab on the QR page');
  assert.ok(page.includes('aria-label="Tên bàn"'), 'table box in the QR box');
  assert.ok(!page.includes("method: 'bill'") && !page.includes('/> Chụp bill') && !page.includes('bill_image'), 'no separate bill photo button');
  assert.ok(!existsSync(new URL('../src/app/admin/receipts/ReceiptsPanel.js', import.meta.url)));
  const oldPage = readFileSync(new URL('../src/app/admin/receipts/page.js', import.meta.url), 'utf8');
  assert.match(oldPage, /redirect\('\/admin\/qr'\)/);
  const nav = readFileSync(new URL('../src/app/admin/layout.js', import.meta.url), 'utf8');
  assert.match(nav, /href: '\/admin\/qr', label: 'Mã QR'/);
});
