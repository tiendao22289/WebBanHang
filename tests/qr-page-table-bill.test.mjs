import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { qrTableLabel } from '../src/lib/qrTableLabel.mjs';

// Trang Mã QR (/admin/qr), 2026-11-10: chủ quán bỏ tab "Bill giấy" — tên bàn và ảnh tờ bill ghi ngay trong khung
// "Tạo mã QR tuỳ chỉnh". Ảnh vẫn bắt buộc: chưa có ảnh thì bấm ghi tiền là mở camera như trước.
const page = readFileSync(new URL('../src/app/admin/qr/page.jsx', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = page.indexOf(from), end = page.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `page section ${from}`);
  return page.slice(start, end);
};
const cashSource = slice('  const handleCashPayment = ', '  const saveCash = async');
const confirmSource = slice('  const handleConfirmManual = ', '  // Ảnh bill chụp sẵn đi kèm');
const transferSource = slice('  const saveTransfer = async', '  // Gọn cho điện thoại');

function qrPage(state = {}) {
  const env = { camera: [], saved: [], posts: [], cleared: 0, status: null };
  const context = {
    amount: '', tableLabel: '', billPhoto: null, saving: false, transactionCode: 'QRAB1234', activeQr: null, ...state,
    qrTableLabel, Number, parseInt, String,
    openCamera: shot => env.camera.push(shot),
    saveShot: (shot, blob, kind) => env.saved.push({ shot, blob, kind }),
    postQrPayment: async (fields, images) => { env.posts.push({ fields, images }); return { ok: true, photoSaved: true }; },
    setPaymentStatus: s => { env.status = s; }, clearForm: () => { env.cleared += 1; },
    Swal: { fire() {} },
  };
  const api = vm.runInNewContext(`${cashSource}\n${confirmSource}\n${transferSource}\n({ handleCashPayment, handleConfirmManual, saveTransfer })`, context);
  return { ...api, env, context };
}

test('cash with the bill already photographed in the box is saved at once with that photo and the table', () => {
  const h = qrPage({ amount: '280.000', tableLabel: '12', billPhoto: { blob: 'bill-photo' } });
  h.handleCashPayment();
  assert.deepEqual(h.env.camera, [], 'no second photo');
  assert.deepEqual(JSON.parse(JSON.stringify(h.env.saved)), [{ shot: { method: 'cash', amount: 280000, table: 'Bàn 12' }, blob: 'bill-photo', kind: 'bill' }]);
});

test('cash without a photo still opens the camera first — nothing is recorded until the bill is photographed', () => {
  const h = qrPage({ amount: '150.000', tableLabel: 'Mang về' });
  h.handleCashPayment();
  assert.deepEqual(h.env.saved, []);
  assert.deepEqual(JSON.parse(JSON.stringify(h.env.camera)), [{ method: 'cash', amount: 150000, table: 'Mang về' }]);
  const empty = qrPage({ amount: '', billPhoto: { blob: 'x' } });
  empty.handleCashPayment();
  assert.deepEqual([empty.env.saved.length, empty.env.camera.length], [0, 0], 'no amount, nothing happens');
  const busy = qrPage({ amount: '150.000', billPhoto: { blob: 'x' }, saving: true });
  busy.handleCashPayment();
  assert.equal(busy.env.saved.length, 0, 'a second tap while saving does nothing');
});

test('a transfer always opens the camera on confirm; the bill photo from the box goes along with the customer screen', async () => {
  const activeQr = { code: 'QRAB1234', amount: 350000, account: { id: 'acc' }, table: 'Bàn 5' };
  const h = qrPage({ activeQr, billPhoto: { blob: 'bill-photo' } });
  h.handleConfirmManual();
  assert.deepEqual(JSON.parse(JSON.stringify(h.env.camera)), [{ method: 'transfer', amount: 350000, table: 'Bàn 5' }], 'camera opens even with a bill photo');

  await h.saveTransfer('screen', 'ck');
  const [sent] = h.env.posts;
  assert.deepEqual(JSON.parse(JSON.stringify(sent.fields)), { action: 'qr_confirm', code: 'QRAB1234', amount: 350000, account_id: 'acc', kind: 'ck', table_label: 'Bàn 5' });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.images)), { image: ['screen', 'ck'], bill_image: ['bill-photo', 'bill'] });
  assert.deepEqual([h.env.status, h.env.cleared], ['completed', 1], 'the box is emptied for the next customer');

  // Chọn "Tờ bill" trong camera: ảnh mới là ảnh bill, không gửi thêm ảnh chụp sẵn.
  await h.saveTransfer('new-bill', 'bill');
  assert.deepEqual(JSON.parse(JSON.stringify(h.env.posts[1].images)), { image: ['new-bill', 'bill'] });
  const plain = qrPage({ activeQr: { ...activeQr, table: null } });
  await plain.saveTransfer('screen', 'ck');
  assert.deepEqual(JSON.parse(JSON.stringify([plain.env.posts[0].images, plain.env.posts[0].fields.table_label])), [{ image: ['screen', 'ck'] }, '']);
});

test('the Bill giấy tab is gone: the QR box has the table and bill photo, and old links open the QR page', () => {
  assert.ok(!page.includes('ReceiptsPanel') && !page.includes('tab=bill') && !page.includes('role="tablist"'), 'no Bill giấy tab on the QR page');
  assert.ok(page.includes('aria-label="Tên bàn"') && page.includes('Chụp bill'), 'table box and bill photo button in the QR box');
  assert.ok(!existsSync(new URL('../src/app/admin/receipts/ReceiptsPanel.js', import.meta.url)));
  const oldPage = readFileSync(new URL('../src/app/admin/receipts/page.js', import.meta.url), 'utf8');
  assert.match(oldPage, /redirect\('\/admin\/qr'\)/);
  const nav = readFileSync(new URL('../src/app/admin/layout.js', import.meta.url), 'utf8');
  assert.match(nav, /href: '\/admin\/qr', label: 'Mã QR'/);
});
