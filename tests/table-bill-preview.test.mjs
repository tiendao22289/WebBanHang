import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
const previewSource = page.slice(page.indexOf('  const [billPreviewTableId,'), page.indexOf('  const [quickAddOpen,'));
const completeSource = page.slice(page.indexOf('  async function completeTable('), page.indexOf('  // Bước 2: đóng bàn trên máy chủ'));
const settleSource = page.slice(page.indexOf('  async function settleTable('), page.indexOf('  // Lấy hoặc sinh mã Bill Code'));

test('preview belongs to its table and cannot appear on the next table', () => {
  let previewId = null;
  let reset;
  function render(table) {
    return vm.runInNewContext(`(() => { ${previewSource}
      return { showBillPreview, setShowBillPreview }; })()`, {
      selectedTable: table,
      useState: () => [previewId, value => { previewId = value; }],
      useEffect: callback => { reset = callback; },
    });
  }
  render({ id: 'table-1' }).setShowBillPreview(true);
  assert.equal(render({ id: 'table-1' }).showBillPreview, true);
  assert.equal(render({ id: 'table-2' }).showBillPreview, false);
  reset();
  assert.equal(render({ id: 'table-1' }).showBillPreview, false);
  assert.equal(render(null).showBillPreview, false);
});

// Một lần thanh toán với máy chủ giả trả (status, body): complete / settle chạy như trên trang Bàn.
function harness(status, body) {
  const box = { previewOpen: true, selectedTable: { id: 'table-1' }, proof: null, proofs: [], sent: null, done: 0 };
  const context = {
    completingTablesRef: { current: new Set() }, setPayingHostId: () => {},
    getFreshPaymentSnapshot: async () => ({ bills: [{ id: 'bill-1' }], total: 100000, unpricedItems: [], groupTableIds: ['table-1'] }),
    transactionCode: 'HD1', setPayProof: value => { box.proof = value; box.proofs.push(value); }, setConfirmPayment: () => {},
    fetchWithTimeout: async (url, options) => { box.sent = options.body; return new Response(JSON.stringify(body), { status }); },
    FormData, Response, Event: class {}, window: { dispatchEvent: () => {} }, console: { error() {} },
    setShowBillPreview: value => { box.previewOpen = value; },
    setSelectedTable: value => { box.selectedTable = value; },
    fetchTables: async () => {}, Swal: { fire: () => {} }, formatPrice: String, promptFixUnpricedItems: () => false,
  };
  box.complete = vm.runInNewContext(`(${completeSource.trim()})`, context);
  box.settle = vm.runInNewContext(`(${settleSource.trim()})`, context);
  context.settleTable = box.settle;
  return box;
}
const OUTCOMES = [[200, { ok: true, photoSaved: true }, true], [409, { reason: 'amount_changed', total: 120000 }, false], [500, { error: 'x' }, false]];

test('transfer settlement closes preview only after the photo is taken and the payment succeeds', async () => {
  for (const [status, body, success] of OUTCOMES) {
    const t = harness(status, body);
    // Bước 1: kiểm tra bill rồi mở camera — chưa đóng gì.
    assert.equal(await t.complete({ id: 'table-1' }, 'transfer', false, 100000, 'acc-1', { onDone: () => { t.done += 1; } }), true);
    assert.equal(t.previewOpen, true);
    assert.equal(t.sent, null, 'nothing is sent before the photo');
    assert.equal(t.proof.paymentMethod, 'transfer');

    // Bước 2: chụp xong → máy chủ đóng bàn cùng ảnh.
    await t.settle(t.proof, { blob: new Blob(['jpg'], { type: 'image/jpeg' }) });
    assert.deepEqual([t.sent.get('action'), t.sent.get('order_ids'), t.sent.get('amount'), t.sent.get('method')], ['table_pay', 'bill-1', '100000', 'transfer']);
    assert.equal(t.sent.get('image').size, 3);
    assert.deepEqual([t.sent.get('account_id'), t.sent.get('transaction_code')], ['acc-1', 'HD1']);
    assert.equal(t.previewOpen, !success);
    assert.equal(t.selectedTable === null, success);
    assert.equal(t.done, success ? 1 : 0);
    assert.equal(t.proof, null, 'camera closes either way');
  }
});

test('cash closes the table right away with no photo (the owner dropped the cash photo)', async () => {
  for (const [status, body, success] of OUTCOMES) {
    const t = harness(status, body);
    assert.equal(await t.complete({ id: 'table-1' }, 'cash', false, 100000, null, { given: 100000, onDone: () => { t.done += 1; } }), true);
    assert.deepEqual([t.sent.get('action'), t.sent.get('method'), t.sent.get('amount')], ['table_pay', 'cash', '100000']);
    assert.deepEqual([t.sent.get('image'), t.sent.get('skip_reason')], [null, null], 'no photo and no "no photo" reason');
    assert.ok(t.proofs.every(p => p === null), 'the camera never opens');
    assert.equal(t.previewOpen, !success);
    assert.equal(t.done, success ? 1 : 0);
  }
});
