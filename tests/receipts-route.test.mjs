import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as finance from '../src/lib/ownerFinance.mjs';

const source = readFileSync(new URL('../src/app/api/admin/receipts/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

function fakeDb(state) {
  return { from(table) {
    let op = 'read', values, conditions = [], single = false, maybe = false;
    const q = {
      select() { return q; },
      eq(k, v) { conditions.push(r => r[k] === v); return q; },
      in(k, vs) { conditions.push(r => vs.includes(r[k])); return q; },
      order() { return q; },
      insert(v) { op = 'insert'; values = v; return q; },
      update(v) { op = 'update'; values = v; return q; },
      delete() { op = 'delete'; return q; },
      single() { single = true; return q; },
      maybeSingle() { maybe = true; return q; },
      then(ok, ko) { return new Promise(run).then(ok, ko); },
    };
    function run(resolve) {
      state[table] ||= [];
      let rows = state[table].filter(r => conditions.every(c => c(r)));
      if (op === 'insert') {
        const row = { id: `00000000-0000-0000-0000-${String(state[table].length + 1).padStart(12, '0')}`, ...values };
        state[table].push(row);
        return resolve({ data: single ? row : [row], error: null });
      }
      if (op === 'update') { rows.forEach(r => Object.assign(r, values)); return resolve({ data: rows, error: null }); }
      if (op === 'delete') { const ids = new Set(rows); state[table] = state[table].filter(r => !ids.has(r)); return resolve({ data: null, error: null }); }
      resolve({ data: structuredClone(maybe ? rows[0] ?? null : rows), error: null });
    }
    return q;
  } };
}

const STAFF = '00000000-0000-0000-0000-00000000aaaa';
const OTHER = '00000000-0000-0000-0000-00000000bbbb';
const ACC = '00000000-0000-0000-0000-0000000000aa';
const image = (type = 'image/jpeg', size = 120000) => ({ type, size, arrayBuffer: async () => new ArrayBuffer(8) });

function load({ state, role = 'staff', userId = STAFF, code = 200 }) {
  const uploads = [], removed = [];
  const api = vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse: { json: (body, init = {}) => ({ status: init.status || 200, body }) },
    ...finance, Number, Math, String, Promise, Date, JSON, console: { error() {} },
    getStaffSession: async () => code === 200 ? { code, user: { id: userId, full_name: 'Thu ngân', role } } : { code },
    statusDatabase: () => fakeDb(state),
    receiptImageProblem: file => !file || !file.size ? 'Thiếu ảnh.' : (file.type.startsWith('image/') ? (file.size > 2097152 ? 'Ảnh quá lớn (tối đa 2MB).' : null) : 'Ảnh phải là JPG, PNG hoặc WebP.'),
    uploadReceiptImage: async (_db, file, kind) => { const p = `2026-10/${kind}-${uploads.length + 1}.jpg`; uploads.push(p); return p; },
    removeReceiptImages: async (_db, paths) => { removed.push(...paths.filter(Boolean)); },
    signReceiptImages: async (_db, paths) => Object.fromEntries(paths.filter(Boolean).map(p => [p, `signed:${p}`])),
    purgeOldReceiptImages: async () => {},
  });
  return { api, uploads, removed };
}
const plain = res => JSON.parse(JSON.stringify(res));
const post = async (api, fields) => plain(await api.POST({ formData: async () => ({ get: k => fields[k] ?? null }) }));
const get = async api => plain(await api.GET({}));
const today = finance.vnDate(Date.now());
const base = () => ({ finance_manual_receipts: [], finance_revenue_ledger: [], bank_accounts: [
  { id: ACC, bank_name: 'MB', account_name: 'B', account_number: '123456', is_active: true, sort_order: 1 },
  { id: '00000000-0000-0000-0000-0000000000cc', bank_name: 'Cũ', is_active: false, sort_order: 2 }] });

test('a cashier saves a paper bill only with a photo and a total, and picks the card for transfers', async () => {
  const state = base();
  const { api, uploads } = load({ state });
  for (const [fields, message] of [
    [{ action: 'create_paper', amount: '350000', method: 'cash' }, 'Chụp ảnh tờ bill giấy trước khi lưu.'],
    [{ action: 'create_paper', amount: '0', method: 'cash', image: image() }, 'Nhập số tiền tổng của bill.'],
    [{ action: 'create_paper', amount: '350000', method: 'card', image: image() }, 'Chọn tiền mặt hay chuyển khoản.'],
    [{ action: 'create_paper', amount: '350000', method: 'transfer', image: image() }, 'Chọn thẻ nhận tiền.'],
    [{ action: 'create_paper', amount: '350000', method: 'transfer', account_id: '00000000-0000-0000-0000-0000000000cc', image: image() }, 'Thẻ nhận tiền không hợp lệ.'],
    [{ action: 'create_paper', amount: '350000', method: 'cash', image: image('application/pdf') }, 'Ảnh phải là JPG, PNG hoặc WebP.'],
  ]) {
    const res = await post(api, fields);
    assert.deepEqual([res.status, res.body.error], [400, message], JSON.stringify(fields));
  }
  assert.equal(state.finance_manual_receipts.length, 0);
  assert.equal(uploads.length, 0, 'nothing is stored for a refused bill');

  let res = await post(api, { action: 'create_paper', amount: '350.000', method: 'cash', table_label: ' Bàn 5 ', image: image() });
  assert.equal(res.status, 200);
  res = await post(api, { action: 'create_paper', amount: '420000', method: 'transfer', account_id: ACC, image: image(), transfer_image: image() });
  assert.equal(res.status, 200);
  const [cash, transfer] = plain(state.finance_manual_receipts);
  assert.deepEqual([cash.amount, cash.payment_method, cash.account_id, cash.table_label, cash.business_date, cash.created_by_id, !!cash.image_path, cash.transfer_image_path],
    [350000, 'cash', null, 'Bàn 5', today, STAFF, true, null]);
  assert.deepEqual([transfer.payment_method, transfer.account_id, !!transfer.transfer_image_path], ['transfer', ACC, true]);

  const list = await get(api);
  assert.deepEqual(list.body.paperBills.map(b => [b.amount, b.mine, !!b.imageUrl]), [[350000, true, true], [420000, true, true]]);
  assert.deepEqual(list.body.accounts.map(a => a.id), [ACC], 'only active cards can be chosen');
});

test('staff delete only their own paper bills from today; admin can delete any', async () => {
  const state = base();
  state.finance_manual_receipts.push(
    { id: '00000000-0000-0000-0000-000000000101', business_date: today, created_by_id: STAFF, image_path: 'a.jpg', amount: 1, payment_method: 'cash' },
    { id: '00000000-0000-0000-0000-000000000102', business_date: today, created_by_id: OTHER, image_path: 'b.jpg', amount: 1, payment_method: 'cash' },
    { id: '00000000-0000-0000-0000-000000000103', business_date: '2026-10-23', created_by_id: STAFF, image_path: 'c.jpg', amount: 1, payment_method: 'cash' });
  const staff = load({ state });
  assert.equal((await post(staff.api, { action: 'delete_paper', id: '00000000-0000-0000-0000-000000000102' })).status, 403);
  if (today !== '2026-10-23') assert.equal((await post(staff.api, { action: 'delete_paper', id: '00000000-0000-0000-0000-000000000103' })).status, 403);
  assert.equal((await post(staff.api, { action: 'delete_paper', id: '00000000-0000-0000-0000-000000000101' })).status, 200);
  assert.deepEqual(staff.removed, ['a.jpg'], 'its photo is removed too');
  const admin = load({ state, role: 'admin', userId: OTHER });
  assert.equal((await post(admin.api, { action: 'delete_paper', id: '00000000-0000-0000-0000-000000000103' })).status, 200);
  assert.equal(state.finance_manual_receipts.length, 1);
});

test('a transfer screenshot is attached to a transfer bill, replacing the old one, and only for today when staff', async () => {
  const state = base();
  state.finance_revenue_ledger.push(
    { order_id: '00000000-0000-0000-0000-000000000201', business_date: today, payment_method: 'transfer', transfer_image_path: 'old.jpg', amount: 1 },
    { order_id: '00000000-0000-0000-0000-000000000202', business_date: today, payment_method: 'cash', amount: 1 },
    { order_id: '00000000-0000-0000-0000-000000000203', business_date: '2000-01-01', payment_method: 'transfer', amount: 1 });
  const staff = load({ state });
  let res = await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000201', image: image() });
  assert.equal(res.status, 200);
  assert.deepEqual([state.finance_revenue_ledger[0].transfer_image_path, state.finance_revenue_ledger[0].transfer_image_by], ['2026-10/ck-1.jpg', 'Thu ngân']);
  assert.deepEqual(staff.removed, ['old.jpg']);
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000202', image: image() })).status, 404, 'cash bills take no screenshot');
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000203', image: image() })).status, 403);
  assert.equal((await post(load({ state, role: 'admin' }).api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000203', image: image() })).status, 200);
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000201' })).status, 400, 'needs an image');
  const list = await get(staff.api);
  assert.deepEqual(list.body.transferBills.map(b => b.orderId), ['00000000-0000-0000-0000-000000000201'], 'today transfer bills only');
});

test('signed-out users cannot use the paper bill page', async () => {
  const { api } = load({ state: base(), code: 401 });
  assert.equal((await get(api)).status, 401);
  assert.equal((await post(api, { action: 'create_paper' })).status, 401);
});

test('paper bills count in revenue, cash, transfer and per card', () => {
  const s = finance.summarizeMonth({ month: '2026-10', today: '2026-10-23', startDate: '2026-10-23',
    revenue: [{ business_date: '2026-10-23', amount: 100000, payment_method: 'cash' }],
    paperBills: [
      { business_date: '2026-10-23', amount: 350000, payment_method: 'cash' },
      { business_date: '2026-10-23', amount: 420000, payment_method: 'transfer', account_id: 'B' }],
  });
  const d = s.days[0];
  assert.deepEqual([d.revenue, d.bills, d.paperBills, d.paperRevenue, d.cash, d.transfer, d.byAccount.B],
    [870000, 1, 2, 770000, 450000, 420000, 420000]);
  assert.deepEqual([s.totals.paperBills, s.totals.paperRevenue], [2, 770000]);
});

test('right after "Đã nhận tiền" one customer-phone photo is attached to every transfer bill of the table', async () => {
  const state = base();
  const ids = ['00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000303'];
  state.finance_revenue_ledger.push(
    { order_id: ids[0], business_date: today, payment_method: 'transfer', transfer_image_path: 'old.jpg', amount: 1 },
    { order_id: ids[1], business_date: today, payment_method: 'transfer', amount: 1 },
    { order_id: ids[2], business_date: '2000-01-01', payment_method: 'transfer', amount: 1 });
  const staff = load({ state });
  const res = await post(staff.api, { action: 'attach_transfer', order_ids: ids.join(','), image: image() });
  assert.deepEqual([res.status, res.body.bills], [200, 2], 'staff: today bills only');
  const rows = plain(state.finance_revenue_ledger);
  assert.deepEqual(rows.map(r => r.transfer_image_path ?? null), ['2026-10/ck-1.jpg', '2026-10/ck-1.jpg', null]);
  assert.deepEqual(staff.removed, ['old.jpg']);
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_ids: 'x,y', image: image() })).status, 400);
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_ids: '00000000-0000-0000-0000-000000000999', image: image() })).status, 404);
  assert.equal(staff.uploads.length, 1, 'nothing uploaded for refused requests');
});

test('the QR page adds a bill photo and a transfer screenshot to the paper bill the database wrote', async () => {
  const state = base();
  const CASH = 'cash:00000000-0000-4000-8000-0000000000c1';
  state.finance_manual_receipts.push(
    { id: '00000000-0000-0000-0000-000000000401', source: 'qr:QRAB1234', business_date: today, payment_method: 'transfer', amount: 350000, image_path: null, created_by_name: 'Trang Mã QR' },
    { id: '00000000-0000-0000-0000-000000000402', source: CASH, business_date: today, payment_method: 'cash', amount: 120000, image_path: null },
    { id: '00000000-0000-0000-0000-000000000403', source: 'qr:OLDDAY01', business_date: '2000-01-01', payment_method: 'transfer', amount: 1, image_path: null });
  const staff = load({ state });
  let res = await post(staff.api, { action: 'attach_bill', source: 'qr:QRAB1234', image: image() });
  assert.equal(res.status, 200);
  res = await post(staff.api, { action: 'attach_transfer', source: 'qr:QRAB1234', image: image() });
  assert.equal(res.status, 200);
  assert.deepEqual([state.finance_manual_receipts[0].image_path, state.finance_manual_receipts[0].transfer_image_path],
    ['2026-10/bill-1.jpg', '2026-10/ck-2.jpg']);
  assert.equal((await post(staff.api, { action: 'attach_bill', source: CASH, image: image() })).status, 200);
  assert.equal(state.finance_manual_receipts[1].image_path, '2026-10/bill-3.jpg');
  assert.equal((await post(staff.api, { action: 'attach_transfer', source: CASH, image: image() })).status, 404, 'cash takes no screenshot');

  // Chụp lại: ảnh cũ bị thay và xoá.
  assert.equal((await post(staff.api, { action: 'attach_bill', receipt_id: '00000000-0000-0000-0000-000000000401', image: image() })).status, 200);
  assert.equal(state.finance_manual_receipts[0].image_path, '2026-10/bill-4.jpg');
  assert.deepEqual(staff.removed, ['2026-10/bill-1.jpg']);

  assert.equal((await post(staff.api, { action: 'attach_bill', source: 'qr:OLDDAY01', image: image() })).status, 403, 'staff: today only');
  assert.equal((await post(load({ state, role: 'admin' }).api, { action: 'attach_bill', source: 'qr:OLDDAY01', image: image() })).status, 200);
  assert.equal((await post(staff.api, { action: 'attach_bill', source: 'qr:NOTFOUND', image: image() })).status, 404);
  for (const source of ['qr:../x', 'qr:', 'order:1', 'cash:abc'])
    assert.equal((await post(staff.api, { action: 'attach_bill', source, image: image() })).status, 400, source);
  assert.equal((await post(staff.api, { action: 'attach_bill', source: 'qr:QRAB1234' })).status, 400, 'needs an image');
  assert.equal(staff.uploads.length, 4, 'nothing uploaded for refused requests');
});

test('paper bills from the QR page show on the paper bill page with who took them and no photo yet', async () => {
  const state = base();
  state.finance_manual_receipts.push({ id: '00000000-0000-0000-0000-000000000501', source: 'qr:QRAB1234', business_date: today,
    received_at: new Date().toISOString(), payment_method: 'transfer', account_id: ACC, amount: 350000, image_path: null, created_by_name: 'Trang Mã QR' });
  const list = await get(load({ state }).api);
  assert.deepEqual(list.body.paperBills.map(b => [b.amount, b.createdByName, b.imageUrl, b.mine]), [[350000, 'Trang Mã QR', null, false]]);
});
