import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
const previewSource = page.slice(page.indexOf('  const [billPreviewTableId,'), page.indexOf('  const [quickAddOpen,'));
const completeSource = page.slice(page.indexOf('  async function completeTable('), page.indexOf('  // Lấy hoặc sinh mã Bill Code'));

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
  test(`${method} settlement closes preview only after successful payment`, async () => {
    for (const success of [true, false]) {
      let previewOpen = true;
      let selectedTable = { id: 'table-1' };
      const run = vm.runInNewContext(`(${completeSource.trim()})`, {
        completingTablesRef: { current: new Set() }, setPayingHostId: () => {},
        getFreshPaymentSnapshot: async () => ({ bills: [{ id: 'bill-1' }], total: 100000,
          unpricedItems: [], groupTableIds: ['table-1'] }),
        currentStaff: null, transactionCode: null,
        supabase: { rpc: async () => ({ data: { success }, error: null }) },
        setShowBillPreview: value => { previewOpen = value; },
        setSelectedTable: value => { selectedTable = value; },
        fetchTables: async () => {}, Swal: { fire: () => {} },
      });
      assert.equal(await run({ id: 'table-1' }, method, false, 100000), success);
      assert.equal(previewOpen, !success);
      assert.equal(selectedTable === null, success);
    }
  });
}
