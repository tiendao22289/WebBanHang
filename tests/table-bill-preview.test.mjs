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

for (const method of ['cash', 'transfer']) {
  test(`${method} settlement closes preview only after the photo is taken and the payment succeeds`, async () => {
    for (const [status, body, success] of [[200, { ok: true, photoSaved: true }, true], [409, { reason: 'amount_changed', total: 120000 }, false], [500, { error: 'x' }, false]]) {
      let previewOpen = true;
      let selectedTable = { id: 'table-1' };
      let proof = null;
      let sent = null;
      let done = 0;
      const context = {
        completingTablesRef: { current: new Set() }, setPayingHostId: () => {},
        getFreshPaymentSnapshot: async () => ({ bills: [{ id: 'bill-1' }], total: 100000, unpricedItems: [], groupTableIds: ['table-1'] }),
        transactionCode: 'HD1', setPayProof: value => { proof = value; }, setConfirmPayment: () => {},
        fetchWithTimeout: async (url, options) => { sent = options.body; return new Response(JSON.stringify(body), { status }); },
        FormData, Response, Event: class {}, window: { dispatchEvent: () => {} }, console: { error() {} },
        setShowBillPreview: value => { previewOpen = value; },
        setSelectedTable: value => { selectedTable = value; },
        fetchTables: async () => {}, Swal: { fire: () => {} }, formatPrice: String, promptFixUnpricedItems: () => false,
      };
      const complete = vm.runInNewContext(`(${completeSource.trim()})`, context);
      const settle = vm.runInNewContext(`(${settleSource.trim()})`, context);

      // Bước 1: kiểm tra bill rồi mở camera — chưa đóng gì.
      assert.equal(await complete({ id: 'table-1' }, method, false, 100000, method === 'transfer' ? 'acc-1' : null, { onDone: () => { done += 1; } }), true);
      assert.equal(previewOpen, true);
      assert.equal(sent, null, 'nothing is sent before the photo');
      assert.equal(proof.paymentMethod, method);

      // Bước 2: chụp xong → máy chủ đóng bàn cùng ảnh.
      const opened = proof;
      await settle(opened, { blob: new Blob(['jpg'], { type: 'image/jpeg' }) });
      assert.deepEqual([sent.get('action'), sent.get('order_ids'), sent.get('amount'), sent.get('method')], ['table_pay', 'bill-1', '100000', method]);
      assert.equal(sent.get('image').size, 3);
      if (method === 'transfer') assert.deepEqual([sent.get('account_id'), sent.get('transaction_code')], ['acc-1', 'HD1']);
      assert.equal(previewOpen, !success);
      assert.equal(selectedTable === null, success);
      assert.equal(done, success ? 1 : 0);
      assert.equal(proof, null, 'camera closes either way');
    }
  });
}
