import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as finance from '../src/lib/ownerFinance.mjs';

const source = readFileSync(new URL('../src/app/api/admin/receipts/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

function fakeDb(state) {
  return { rpc: async (name, args) => { (state.rpcCalls ||= []).push([name, args]); return state.rpc[name](args, state); }, from(table) {
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

test('a saved paper bill can only be deleted by the owner, not even by the staff who entered it today', async () => {
  const state = base();
  state.finance_manual_receipts.push(
    { id: '00000000-0000-0000-0000-000000000101', business_date: today, created_by_id: STAFF, image_path: 'a.jpg', amount: 1, payment_method: 'cash' },
    { id: '00000000-0000-0000-0000-000000000102', business_date: today, created_by_id: OTHER, image_path: 'b.jpg', amount: 1, payment_method: 'cash' },
    { id: '00000000-0000-0000-0000-000000000103', business_date: '2026-10-23', created_by_id: STAFF, image_path: 'c.jpg', amount: 1, payment_method: 'cash' });
  const staff = load({ state });
  for (const id of ['101', '102', '103']) {
    const res = await post(staff.api, { action: 'delete_paper', id: `00000000-0000-0000-0000-000000000${id}` });
    assert.equal(res.status, 403, `staff cannot delete bill ${id}`);
  }
  assert.equal(state.finance_manual_receipts.length, 3);
  const admin = load({ state, role: 'admin', userId: OTHER });
  assert.equal((await post(admin.api, { action: 'delete_paper', id: '00000000-0000-0000-0000-000000000101' })).status, 200);
  assert.deepEqual(admin.removed, ['a.jpg'], 'its photo is removed too');
  assert.equal((await post(admin.api, { action: 'delete_paper', id: '00000000-0000-0000-0000-000000000103' })).status, 200);
  assert.equal(state.finance_manual_receipts.length, 1);
});

test('staff add a missing transfer screenshot to today bills; only the owner replaces one or adds to older days', async () => {
  const state = base();
  state.finance_revenue_ledger.push(
    { order_id: '00000000-0000-0000-0000-000000000201', business_date: today, payment_method: 'transfer', transfer_image_path: 'old.jpg', amount: 1 },
    { order_id: '00000000-0000-0000-0000-000000000202', business_date: today, payment_method: 'cash', amount: 1 },
    { order_id: '00000000-0000-0000-0000-000000000203', business_date: '2000-01-01', payment_method: 'transfer', amount: 1 },
    { order_id: '00000000-0000-0000-0000-000000000204', business_date: today, payment_method: 'transfer', transfer_image_path: null, amount: 1 });
  const staff = load({ state });
  let res = await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000201', image: image() });
  assert.equal(res.status, 403, 'staff cannot replace a saved screenshot');
  assert.equal(state.finance_revenue_ledger[0].transfer_image_path, 'old.jpg');
  res = await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000204', image: image() });
  assert.equal(res.status, 200);
  assert.deepEqual([state.finance_revenue_ledger[3].transfer_image_path, state.finance_revenue_ledger[3].transfer_image_by], ['2026-10/ck-1.jpg', 'Thu ngân']);
  const owner = load({ state, role: 'admin' });
  assert.equal((await post(owner.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000201', image: image() })).status, 200);
  assert.deepEqual(owner.removed, ['old.jpg'], 'the owner replaces it and the old file goes');
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000202', image: image() })).status, 404, 'cash bills take no screenshot');
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000203', image: image() })).status, 403);
  assert.equal((await post(load({ state, role: 'admin' }).api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000203', image: image() })).status, 200);
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_id: '00000000-0000-0000-0000-000000000201' })).status, 400, 'needs an image');
  const list = await get(staff.api);
  assert.deepEqual(list.body.transferBills.map(b => b.orderId).sort(), ['00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000204'], 'today transfer bills only');
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
  assert.deepEqual([res.status, res.body.bills], [200, 1], 'staff: today bills that have no screenshot yet');
  const rows = plain(state.finance_revenue_ledger);
  assert.deepEqual(rows.map(r => r.transfer_image_path ?? null), ['old.jpg', '2026-10/ck-1.jpg', null]);
  assert.deepEqual(staff.removed, [], 'a saved screenshot stays');
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_ids: 'x,y', image: image() })).status, 400);
  assert.equal((await post(staff.api, { action: 'attach_transfer', order_ids: '00000000-0000-0000-0000-000000000999', image: image() })).status, 404);
  assert.equal(staff.uploads.length, 1, 'nothing uploaded for refused requests');
});

test('the owner re-takes the screenshot of a grouped "Bill đã thu" row: every bill of that checkout gets it, the shared old file goes once', async () => {
  const state = base();
  const ids = ['00000000-0000-0000-0000-000000000311', '00000000-0000-0000-0000-000000000312', '00000000-0000-0000-0000-000000000313'];
  for (const id of ids) state.finance_revenue_ledger.push({ order_id: id, business_date: '2026-10-27', payment_method: 'transfer', transfer_image_path: 'ban6.jpg', amount: 1 });
  state.finance_revenue_ledger.push({ order_id: '00000000-0000-0000-0000-000000000314', business_date: '2026-10-27', payment_method: 'transfer', transfer_image_path: 'ban9.jpg', amount: 1 });
  const owner = load({ state, role: 'admin' });
  const res = await post(owner.api, { action: 'attach_transfer', order_ids: ids.join(','), image: image() });
  assert.deepEqual([res.status, res.body.bills], [200, 3]);
  assert.deepEqual(plain(state.finance_revenue_ledger).map(r => r.transfer_image_path), ['2026-10/ck-1.jpg', '2026-10/ck-1.jpg', '2026-10/ck-1.jpg', 'ban9.jpg'], 'another table keeps its photo');
  assert.deepEqual(owner.removed, ['ban6.jpg']);
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

  // Chụp lại: nhân viên không thay được ảnh đã lưu; chủ quán thay thì ảnh cũ bị xoá.
  assert.equal((await post(staff.api, { action: 'attach_bill', receipt_id: '00000000-0000-0000-0000-000000000401', image: image() })).status, 403);
  assert.equal(state.finance_manual_receipts[0].image_path, '2026-10/bill-1.jpg');
  const owner = load({ state, role: 'admin' });
  assert.equal((await post(owner.api, { action: 'attach_bill', receipt_id: '00000000-0000-0000-0000-000000000401', image: image() })).status, 200);
  assert.deepEqual(owner.removed, ['2026-10/bill-1.jpg']);

  assert.equal((await post(staff.api, { action: 'attach_bill', source: 'qr:OLDDAY01', image: image() })).status, 403, 'staff: today only');
  assert.equal((await post(load({ state, role: 'admin' }).api, { action: 'attach_bill', source: 'qr:OLDDAY01', image: image() })).status, 200);
  assert.equal((await post(staff.api, { action: 'attach_bill', source: 'qr:NOTFOUND', image: image() })).status, 404);
  for (const source of ['qr:../x', 'qr:', 'order:1', 'cash:abc'])
    assert.equal((await post(staff.api, { action: 'attach_bill', source, image: image() })).status, 400, source);
  assert.equal((await post(staff.api, { action: 'attach_bill', source: 'qr:QRAB1234' })).status, 400, 'needs an image');
  assert.equal(staff.uploads.length, 3, 'nothing uploaded for refused requests (incl. the refused re-take)');
});

test('paper bills from the QR page show on the paper bill page with who took them and no photo yet', async () => {
  const state = base();
  state.finance_manual_receipts.push({ id: '00000000-0000-0000-0000-000000000501', source: 'qr:QRAB1234', business_date: today,
    received_at: new Date().toISOString(), payment_method: 'transfer', account_id: ACC, amount: 350000, image_path: null, created_by_name: 'Trang Mã QR' });
  const list = await get(load({ state }).api);
  assert.deepEqual(list.body.paperBills.map(b => [b.amount, b.createdByName, b.imageUrl, b.mine]), [[350000, 'Trang Mã QR', null, false]]);
});

// Như DB thật: hàm SQL đổi trạng thái → trigger capture_qr_page_receipt ghi 1 bill giấy.
const qrDb = (overrides = {}) => ({ ...base(), rpc: {
  confirm_custom_qr_payment: ({ p_code, p_expected_amount, p_account_id }, state) => {
    if (p_code === 'QRWRONG1') return { data: null, error: { code: 'P0001', message: 'Mã QR, số tiền hoặc tài khoản không khớp' } };
    if (p_code === 'QRCRASH1') return { data: null, error: { code: '42703', message: 'record "tx" has no field "id"' } };
    const already = state.finance_manual_receipts.some(r => r.source === `qr:${p_code}`);
    if (!already && p_code !== 'QRNOROW1') state.finance_manual_receipts.push({ id: `00000000-0000-0000-0000-00000000060${state.finance_manual_receipts.length}`,
      source: `qr:${p_code}`, business_date: today, payment_method: 'transfer', account_id: p_account_id, amount: p_expected_amount, created_by_name: 'Trang Mã QR' });
    return { data: { success: true, already_completed: already }, error: null };
  },
  record_custom_cash_receipt: ({ p_id, p_amount }, state) => {
    if (!state.finance_manual_receipts.some(r => r.source === `cash:${p_id}`)) state.finance_manual_receipts.push({ id: '00000000-0000-0000-0000-000000000700',
      source: `cash:${p_id}`, business_date: today, payment_method: 'cash', amount: p_amount, created_by_name: 'Trang Mã QR' });
    return { data: { success: true, receipt_id: p_id, amount: p_amount }, error: null };
  },
  ...overrides } });
const confirmQr = (api, fields = {}) => post(api, { action: 'qr_confirm', code: 'QRAB1234', amount: '350000', account_id: ACC, kind: 'ck', image: image(), ...fields });

test('the QR page only confirms a transfer together with a photo of the customer screen or the bill', async () => {
  const state = qrDb();
  const staff = load({ state });
  let res = await confirmQr(staff.api, { image: undefined });
  assert.deepEqual([res.status, res.body.error], [400, 'Chụp tờ bill hoặc màn hình điện thoại khách trước khi xác nhận.']);
  assert.equal(state.rpcCalls, undefined, 'no photo → money not confirmed');

  res = await confirmQr(staff.api);
  assert.deepEqual([res.status, res.body.photoSaved, res.body.alreadyDone], [200, true, false]);
  assert.deepEqual(plain(state.rpcCalls), [['confirm_custom_qr_payment', { p_code: 'QRAB1234', p_expected_amount: 350000, p_account_id: ACC }]]);
  const row = state.finance_manual_receipts[0];
  assert.deepEqual([row.transfer_image_path, row.image_path, row.created_by_name], ['2026-10/ck-1.jpg', undefined, 'Trang Mã QR · Thu ngân']);

  // Bấm lại (mạng chập chờn) bằng ảnh tờ bill: không ghi tiền lần 2, ảnh được thêm vào cùng bill.
  res = await confirmQr(staff.api, { kind: 'bill' });
  assert.deepEqual([res.status, res.body.alreadyDone], [200, true]);
  assert.equal(state.finance_manual_receipts.length, 1);
  assert.equal(row.image_path, '2026-10/bill-2.jpg');
  // Chụp lại màn hình khách: ảnh cũ bị thay và xoá.
  await confirmQr(staff.api);
  assert.equal(row.transfer_image_path, '2026-10/ck-3.jpg');
  assert.deepEqual(staff.removed, ['2026-10/ck-1.jpg']);
});

test('a refused QR confirmation keeps no photo and shows the database reason', async () => {
  const state = qrDb();
  const staff = load({ state });
  let res = await confirmQr(staff.api, { code: 'QRWRONG1' });
  assert.deepEqual([res.status, res.body.error], [400, 'Mã QR, số tiền hoặc tài khoản không khớp']);
  res = await confirmQr(staff.api, { code: 'QRCRASH1' });
  assert.deepEqual([res.status, res.body.error], [400, 'Chưa ghi được tiền, thử lại.'], 'technical errors stay hidden');
  assert.deepEqual(staff.removed, ['2026-10/ck-1.jpg', '2026-10/ck-2.jpg'], 'uploaded photos are removed');
  for (const fields of [{ code: 'abc' }, { code: 'QRAB12345' }, { account_id: 'x' }, { amount: '0' }, { amount: '12.5' }]) {
    assert.equal((await confirmQr(staff.api, fields)).status, 400, JSON.stringify(fields));
  }
  assert.equal(staff.uploads.length, 2, 'bad requests upload nothing');
  assert.equal(state.finance_manual_receipts.length, 0);

  // Trigger chưa cài: tiền vẫn xác nhận, ảnh không để mồ côi.
  res = await confirmQr(staff.api, { code: 'QRNOROW1' });
  assert.deepEqual([res.status, res.body.photoSaved], [200, false]);
  assert.equal(staff.removed.at(-1), '2026-10/ck-3.jpg');
});

test('cash on the QR page is recorded only with a photo of the bill', async () => {
  const state = qrDb();
  const staff = load({ state });
  const id = '00000000-0000-4000-8000-0000000000c1';
  assert.equal((await post(staff.api, { action: 'qr_cash', receipt_id: id, amount: '120000' })).status, 400);
  assert.equal(state.rpcCalls, undefined);
  const res = await post(staff.api, { action: 'qr_cash', receipt_id: id, amount: '120000', kind: 'ck', image: image() });
  assert.deepEqual([res.status, res.body.photoSaved], [200, true]);
  assert.deepEqual(plain(state.rpcCalls), [['record_custom_cash_receipt', { p_id: id, p_amount: 120000 }]]);
  assert.deepEqual([state.finance_manual_receipts[0].image_path, state.finance_manual_receipts[0].transfer_image_path], ['2026-10/bill-1.jpg', undefined], 'cash photo is always the bill');
  assert.equal((await post(staff.api, { action: 'qr_cash', receipt_id: 'not-a-uuid', amount: '120000', image: image() })).status, 400);
});

// Trang Bàn: như DB thật — đóng bàn trong 1 giao dịch, trigger ghi bill vào Sổ thu chi.
const TABLE = '00000000-0000-4000-8000-0000000000f1';
const ORDERS = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];
const tableDb = () => ({ ...base(), rpc: {
  complete_table_payment_atomic: (args, state) => {
    if (args.p_expected_amount === 999) return { data: { success: false, reason: 'amount_changed', total: 1200 }, error: null };
    if (args.p_expected_amount === 998) return { data: null, error: { code: 'P0001', message: 'Nhóm bàn đã thay đổi' } };
    for (const id of args.p_expected_order_ids) state.finance_revenue_ledger.push({ order_id: id, business_date: today, payment_method: args.p_payment_method, amount: 1 });
    return { data: { success: true }, error: null };
  },
} });
const payTable = (api, fields = {}) => post(api, { action: 'table_pay', table_id: TABLE, order_ids: ORDERS.join(','), amount: '300000', method: 'cash', image: image(), ...fields });

test('a transfer table closes only with a photo of the customer screen; cash needs no photo; a photo goes on every bill of the group', async () => {
  const state = tableDb();
  const staff = load({ state });
  let res = await payTable(staff.api, { method: 'transfer', account_id: ACC, image: undefined });
  assert.deepEqual([res.status, res.body.error], [400, 'Chụp màn hình chuyển khoản của khách trước khi đóng bàn.']);
  assert.equal(state.rpcCalls, undefined, 'transfer: no photo, no reason → the table stays open');

  // Tiền mặt: chủ quán bỏ bước chụp tiền — đóng bàn luôn, Sổ thu chi không ghi "không ảnh".
  const cashOnly = tableDb();
  res = await payTable(load({ state: cashOnly }).api, { image: undefined });
  assert.deepEqual([res.status, res.body.ok], [200, true]);
  assert.equal(plain(cashOnly.rpcCalls)[0][1].p_payment_method, 'cash');
  assert.deepEqual(plain(cashOnly.finance_revenue_ledger).map(r => [r.photo_skip_reason ?? null, r.cash_image_path ?? null]), [[null, null], [null, null]]);

  res = await payTable(staff.api);
  assert.deepEqual([res.status, res.body.photoSaved], [200, true]);
  const [name, args] = plain(state.rpcCalls)[0];
  assert.equal(name, 'complete_table_payment_atomic');
  assert.deepEqual(args, { p_table_id: TABLE, p_expected_order_ids: ORDERS, p_expected_amount: 300000, p_payment_method: 'cash',
    p_account_id: null, p_hide_stats: false, p_staff_id: STAFF, p_staff_name: 'Thu ngân', p_transaction_code: null }, 'staff comes from the login, not the browser');
  assert.deepEqual(plain(state.finance_revenue_ledger).map(r => [r.cash_image_path, r.photo_by, r.transfer_image_path ?? null]),
    [['2026-10/cash-1.jpg', 'Thu ngân', null], ['2026-10/cash-1.jpg', 'Thu ngân', null]]);
});

test('a transfer table keeps the customer screen as its transfer photo and passes the card and QR code', async () => {
  const state = tableDb();
  const staff = load({ state });
  const res = await payTable(staff.api, { method: 'transfer', account_id: ACC, hide_stats: '1', transaction_code: 'HD123' });
  assert.equal(res.status, 200);
  const args = plain(state.rpcCalls)[0][1];
  assert.deepEqual([args.p_payment_method, args.p_account_id, args.p_hide_stats, args.p_transaction_code], ['transfer', ACC, true, 'HD123']);
  assert.deepEqual(plain(state.finance_revenue_ledger).map(r => [r.transfer_image_path, r.transfer_image_by, r.cash_image_path ?? null]),
    [['2026-10/ck-1.jpg', 'Thu ngân', null], ['2026-10/ck-1.jpg', 'Thu ngân', null]]);
});

test('when the camera is broken a transfer table closes only with a written reason, shown in the finance book', async () => {
  const state = tableDb();
  const staff = load({ state });
  assert.equal((await payTable(staff.api, { method: 'transfer', account_id: ACC, image: undefined, skip_reason: ' a ' })).status, 400, 'a real reason is needed');
  const res = await payTable(staff.api, { method: 'transfer', account_id: ACC, image: undefined, skip_reason: 'Máy lỗi camera' });
  assert.deepEqual([res.status, res.body.photoSaved], [200, true]);
  assert.equal(staff.uploads.length, 0);
  assert.deepEqual(plain(state.finance_revenue_ledger).map(r => [r.photo_skip_reason, r.photo_by]), [['Máy lỗi camera', 'Thu ngân'], ['Máy lỗi camera', 'Thu ngân']]);
});

test('a bill that changed while paying keeps the table open and drops the photo', async () => {
  const state = tableDb();
  const staff = load({ state });
  let res = await payTable(staff.api, { amount: '999' });
  assert.deepEqual([res.status, res.body.reason, res.body.total], [409, 'amount_changed', 1200]);
  res = await payTable(staff.api, { amount: '998' });
  assert.deepEqual([res.status, res.body.error], [400, 'Nhóm bàn đã thay đổi']);
  assert.deepEqual(staff.removed, ['2026-10/cash-1.jpg', '2026-10/cash-2.jpg']);
  assert.equal(state.finance_revenue_ledger.length, 0);
  for (const fields of [{ table_id: 'x' }, { order_ids: '' }, { order_ids: 'a,b' }, { amount: '0' }, { method: 'card' }, { method: 'transfer', account_id: 'x' }]) {
    assert.equal((await payTable(staff.api, fields)).status, 400, JSON.stringify(fields));
  }
  assert.equal(staff.uploads.length, 2, 'bad requests upload nothing');
});
