// Mô phỏng Gọi gia vị trên đúng code máy chủ (/api/admin/spices, /api/spice-supplier) với DB giả:
// 1) từng tình huống dễ gây cãi nhau / lỗi (bấm cùng lúc, thêm món khi chủ gia vị đang điền giá, qua nửa đêm, qua tháng,
//    trả dư, đổi link, số quá lớn…); 2) mô phỏng ngẫu nhiên hàng trăm thao tác của nhiều người, sau MỖI bước kiểm lại
//    tiền: tổng đơn, công nợ, trang chủ gia vị, Sổ thu chi, thống kê luôn khớp nhau và không bao giờ lỗi 500.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import * as spice from '../src/lib/spiceOrders.mjs';
import { summarizeMonth } from '../src/lib/ownerFinance.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const strip = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const ADMIN_SRC = strip('../src/app/api/admin/spices/route.js');
const SUPPLIER_SRC = strip('../src/app/api/spice-supplier/route.js');
const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body: JSON.parse(JSON.stringify(body)) }) };
const GLOBALS = { Object, URL, Number, Math, String, JSON, Date, Map, Set, Array, Promise, Boolean, console: { error() {} } };
const PEOPLE = {
  owner: { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' },
  thy: { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Thy', role: 'staff' },
  tai: { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Tài', role: 'staff' },
  lan: { id: '00000000-0000-4000-8000-00000000dddd', full_name: 'Lan', role: 'manager' },
};
const T = (dateVN, hh = 8, mm = 0) => new Date(Date.parse(`${dateVN}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`)).toISOString();

function world() {
  const state = { __seq: 0, now: Date.parse(T('2026-11-01')), spice_suppliers: [], spice_items: [], spice_orders: [], spice_payments: [] };
  const as = who => vm.runInNewContext(`${ADMIN_SRC}\n({ GET, POST })`, {
    ...GLOBALS, ...spice, NextResponse, randomBytes, nowMs: () => state.now,
    getStaffSession: async () => ({ code: 200, user: PEOPLE[who] }), staffDatabase: () => fakeDb(state),
  });
  const supplierApi = vm.runInNewContext(`${SUPPLIER_SRC}\n({ GET, POST })`, { ...GLOBALS, ...spice, NextResponse, nowMs: () => state.now, statusDatabase: () => fakeDb(state) });
  const api = Object.fromEntries(Object.keys(PEOPLE).map(k => [k, as(k)]));
  const post = (who, body) => api[who].POST({ url: 'http://x/api', json: async () => body });
  const get = (who, qs = '') => api[who].GET({ url: `http://x/api${qs}` });
  const sup = {
    get: token => supplierApi.GET({ url: `http://x/api?t=${encodeURIComponent(token)}` }),
    post: body => supplierApi.POST({ url: 'http://x/api', json: async () => body }),
  };
  const at = (dateVN, hh, mm) => { state.now = Date.parse(T(dateVN, hh, mm)); };
  return { state, post, get, sup, at };
}
const order = (w, id) => w.state.spice_orders.find(o => o.id === id);

/* ---------------- Tình huống cụ thể ---------------- */

test('hai nhân viên cùng bấm Nhận: chỉ một người được ghi, người kia được báo ai đã nhận', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'Cô Hai' })).body.supplier;
  const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 2 }] })).body.order;
  const seenByBoth = order(w, o.id).updated_at;
  w.at('2026-11-01', 9);
  assert.equal((await w.post('thy', { action: 'receive', id: o.id, updated_at: seenByBoth, received: [] })).status, 200);
  const late = await w.post('tai', { action: 'receive', id: o.id, updated_at: seenByBoth, received: ['1'] });
  assert.equal(late.status, 409);
  assert.equal(order(w, o.id).received_by_name, 'Thy');
  assert.equal(order(w, o.id).items[0].received_qty, null, 'số của người bấm sau không đè lên');
  // Bấm lại sau khi tải lại: báo rõ ai đã nhận.
  assert.equal((await w.post('tai', { action: 'receive', id: o.id, received: [] })).body.error, 'Đơn đã được Thy bấm nhận rồi.');
});

test('chủ gia vị đang điền giá thì quán thêm món: lưu giá cũ bị chặn, tải lại thấy món mới, đơn về "Mới gửi"', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'Cô Hai' })).body.supplier;
  const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 2 }] })).body.order;
  const page = (await w.sup.get(s.token)).body.orders[0];
  // Chủ gia vị báo xong trước.
  w.at('2026-11-01', 8, 30);
  const done = await w.sup.post({ t: s.token, id: o.id, updated_at: page.updated_at, done: true, prices: [{ index: 0, price: 12000 }] });
  assert.equal(done.body.order.priced_at !== null, true);
  // Quán gọi thêm: đơn về Mới gửi, món mới chưa có giá.
  w.at('2026-11-01', 9);
  const added = await w.post('tai', { action: 'add_lines', id: o.id, lines: [{ name: 'Ớt', qty: 1, unit: 'kg' }], note: 'hết ớt' });
  assert.equal(added.status, 200);
  assert.equal(spice.orderState(order(w, o.id)), 'new');
  // Chủ gia vị bấm lưu với bản cũ trên máy → bị chặn, không mất món Ớt.
  const stale = await w.sup.post({ t: s.token, id: o.id, updated_at: done.body.order.updated_at, prices: [{ index: 0, price: 13000 }] });
  assert.equal(stale.status, 409);
  assert.equal(order(w, o.id).items.length, 2);
  assert.equal(order(w, o.id).items[0].price, 12000);
  // Tải lại: thấy Ớt (ai thêm, lúc nào), điền giá, báo xong lần nữa.
  const fresh = (await w.sup.get(s.token)).body.orders[0];
  assert.equal(fresh.items[1].added_by, 'Tài');
  assert.ok(spice.addedLater(fresh, fresh.items[1]));
  w.at('2026-11-01', 9, 10);
  const again = await w.sup.post({ t: s.token, id: o.id, updated_at: fresh.updated_at, done: true, prices: [{ index: 1, price: 50000 }] });
  assert.equal(spice.orderState(again.body.order), 'priced');
  assert.deepEqual(again.body.order.log.map(e => e.type), ['create', 'price', 'done', 'add', 'price', 'done']);
});

test('nhân viên nhận trước khi chủ gia vị điền giá: tiền vào sổ khi giá được điền, đúng ngày nhận; sau đó giá khoá', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'Cô Hai' })).body.supplier;
  w.at('2026-11-10', 22);
  const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Sả', qty: 3, unit: 'kg' }] })).body.order;
  w.at('2026-11-10', 23, 50);
  await w.post('thy', { action: 'receive', id: o.id, received: [] });
  assert.equal(order(w, o.id).received_date, '2026-11-10');
  assert.equal(spice.orderState(order(w, o.id)), 'waiting_price');
  let byDay = spice.spiceCostByDay(w.state.spice_orders);
  assert.deepEqual([byDay['2026-11-10'].amount, byDay['2026-11-10'].waiting], [0, 1]);
  // Chủ gia vị điền giá sáng hôm sau: chi phí vẫn thuộc ngày nhận (10/11).
  w.at('2026-11-11', 7);
  const page = (await w.sup.get(s.token)).body.orders[0];
  assert.equal((await w.sup.post({ t: s.token, id: o.id, updated_at: page.updated_at, prices: [{ index: 0, price: 30000 }] })).status, 200);
  byDay = spice.spiceCostByDay(w.state.spice_orders);
  assert.deepEqual([byDay['2026-11-10'].amount, byDay['2026-11-10'].waiting], [90000, 0]);
  assert.equal(byDay['2026-11-11'], undefined);
  // Sửa lại giá đã điền: không được (đã nhận) — phải báo chủ quán.
  const p2 = (await w.sup.get(s.token)).body.orders[0];
  const refused = await w.sup.post({ t: s.token, id: o.id, updated_at: p2.updated_at, prices: [{ index: 0, price: 35000 }] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /báo chủ quán/);
  // Chủ quán sửa thì được, lịch sử ghi rõ.
  const fixed = await w.post('owner', { action: 'set_prices', id: o.id, prices: [{ index: 0, price: 32000 }] });
  assert.equal(fixed.body.order.total, 96000);
  assert.equal(spice.logLine(fixed.body.order.log.at(-1)).text, 'đổi giá: Sả 30.000đ → 32.000đ');
});

test('qua nửa đêm và qua tháng: nhận 23:59 là ngày cũ, 00:01 là ngày mới; tháng 11 / tháng 12 tách đúng', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'A' })).body.supplier;
  const make = async (when, qty) => {
    w.at(...when);
    const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty }] })).body.order;
    await w.post('owner', { action: 'set_prices', id: o.id, prices: [{ index: 0, price: 10000 }] });
    await w.post('thy', { action: 'receive', id: o.id, received: [] });
    return order(w, o.id);
  };
  assert.equal((await make(['2026-11-30', 23, 59], 1)).received_date, '2026-11-30');
  assert.equal((await make(['2026-12-01', 0, 1], 2)).received_date, '2026-12-01');
  const byDay = spice.spiceCostByDay(w.state.spice_orders);
  const nov = summarizeMonth({ month: '2026-11', today: '2026-12-01', startDate: '2026-11-01', spices: byDay });
  const dec = summarizeMonth({ month: '2026-12', today: '2026-12-01', startDate: '2026-11-01', spices: byDay });
  assert.equal(nov.totals.spices, 10000);
  assert.equal(dec.totals.spices, 20000);
  const months = spice.spiceStats(w.state.spice_orders, { period: 'month' });
  assert.deepEqual(months.map(m => [m.key, m.total]), [['2026-12', 20000], ['2026-11', 10000]]);
  assert.deepEqual(spice.spiceStats(w.state.spice_orders, { period: 'year' }).map(m => [m.key, m.total]), [['2026', 30000]]);
});

test('trả dư, xoá lần trả, sửa giá sau khi đã trả: công nợ và trang chủ gia vị luôn khớp', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'A' })).body.supplier;
  const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 2 }] })).body.order;
  await w.post('owner', { action: 'set_prices', id: o.id, prices: [{ index: 0, price: 10000 }] });
  await w.post('thy', { action: 'receive', id: o.id, received: [] });
  const pay = (await w.post('owner', { action: 'pay', supplier_id: s.id, amount: 30000 })).body.payment;
  let mine = (await w.sup.get(s.token)).body.summary;
  assert.deepEqual([mine.delivered, mine.paid, mine.owed], [20000, 30000, -10000], 'trả dư 10.000đ');
  assert.equal((await w.get('owner')).body.balances[s.id].debt, -10000);
  await w.post('owner', { action: 'set_prices', id: o.id, prices: [{ index: 0, price: 15000 }] });
  mine = (await w.sup.get(s.token)).body.summary;
  assert.equal(mine.owed, 0);
  await w.post('owner', { action: 'delete_payment', id: pay.id });
  assert.equal((await w.sup.get(s.token)).body.summary.owed, 30000);
  assert.equal((await w.get('owner')).body.balances[s.id].debt, 30000);
});

test('đổi link khi chủ gia vị đang mở trang: lưu bị từ chối với lời nhắn rõ; ngưng chủ gia vị thì đơn cũ vẫn nhận được', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'A' })).body.supplier;
  const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 2 }] })).body.order;
  const page = (await w.sup.get(s.token)).body.orders[0];
  await w.post('owner', { action: 'new_link', id: s.id });
  const res = await w.sup.post({ t: s.token, id: o.id, updated_at: page.updated_at, prices: [{ index: 0, price: 1000 }] });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /link mới/);
  await w.post('owner', { action: 'save_supplier', id: s.id, name: 'A', active: false });
  assert.equal((await w.post('thy', { action: 'receive', id: o.id, received: [] })).status, 200);
});

test('nhập sai / quá lớn: báo lời dễ hiểu, không bao giờ lỗi 500, không ghi gì', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'A' })).body.supplier;
  const bad = [
    { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: '0' }] },
    { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: '-2' }] },
    { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: '20000' }] },
    { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 'hai' }] },
    { action: 'create', supplier_id: s.id, lines: [{ name: '   ', qty: 1 }] },
    { action: 'create', supplier_id: s.id, lines: 'muối' },
    { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 1 }, { name: ' MUỐI ', qty: 1 }] },
    { action: 'create', supplier_id: s.id, lines: Array.from({ length: 61 }, (_, i) => ({ name: `Món ${i}`, qty: 1 })) },
    { action: 'create', supplier_id: '00000000-0000-4000-8000-000000000999', lines: [{ name: 'Muối', qty: 1 }] },
    { action: 'create' },
    {},
  ];
  for (const body of bad) {
    const r = await w.post('thy', body);
    assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(body).slice(0, 80));
    assert.ok(r.body.error, 'có lời báo');
  }
  assert.equal(w.state.spice_orders.length, 0);
  // Tên món dài, có khoảng trắng thừa: gọn lại, tối đa 60 chữ.
  const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: `  Bột   ngọt ${'x'.repeat(80)}`, qty: '1,25' }] })).body.order;
  assert.equal(o.items[0].name.length, 60);
  assert.equal(o.items[0].qty, 1.25);
  // Giá quá lớn / tổng quá lớn.
  const page = (await w.sup.get(s.token)).body.orders[0];
  assert.match((await w.sup.post({ t: s.token, id: o.id, updated_at: page.updated_at, prices: [{ index: 0, price: 60_000_000 }] })).body.error, /không hợp lệ/);
  assert.match((await w.sup.post({ t: s.token, id: o.id, updated_at: page.updated_at, prices: [{ index: 0, price: 'mười nghìn' }] })).body.error, /không hợp lệ/);
  assert.match((await w.sup.post({ t: s.token, id: o.id, updated_at: page.updated_at, prices: [{ index: 5, price: 1000 }] })).body.error, /Dòng hàng/);
  const junk = await w.sup.post({ t: s.token, id: o.id, updated_at: page.updated_at, prices: 'abc' });
  assert.equal(junk.status, 200, 'giá gửi lên sai dạng = không đổi gì');
  assert.equal(order(w, o.id).items[0].price, null);
  const big = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Tiêu', qty: 10000 }] })).body.order;
  const p2 = (await w.sup.get(s.token)).body.orders.find(x => x.id === big.id);
  const tooBig = await w.sup.post({ t: s.token, id: big.id, updated_at: p2.updated_at, prices: [{ index: 0, price: 50_000_000 }] });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.body.error, /quá lớn/);
  // Nhận số lạ: bỏ qua (coi như nhận đủ), không lỗi.
  assert.equal((await w.post('thy', { action: 'receive', id: o.id, received: ['abc', 'x'] })).status, 200);
  assert.equal(order(w, o.id).items[0].received_qty, null);
  // Trả tiền sai.
  for (const amount of ['', '0', '999', 'abc', '2000000000']) assert.equal((await w.post('owner', { action: 'pay', supplier_id: s.id, amount })).status, 400, amount);
  assert.equal(w.state.spice_payments.length, 0);
});

test('nhận dư hàng: lịch sử ghi "dư", tiền tính theo số nhận', async () => {
  const w = world();
  const s = (await w.post('owner', { action: 'save_supplier', name: 'A' })).body.supplier;
  const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 2, unit: 'kg' }] })).body.order;
  await w.post('owner', { action: 'set_prices', id: o.id, prices: [{ index: 0, price: 10000 }] });
  await w.post('thy', { action: 'receive', id: o.id, received: ['3'] });
  assert.equal(order(w, o.id).total, 30000);
  assert.equal(spice.logLine(order(w, o.id).log.at(-1)).text, 'nhận hàng: Muối dư 1 kg (gọi 2, nhận 3)');
});

test('chủ gia vị chỉ thấy đơn của mình, không thấy mã nhân viên, không sửa được đơn người khác hay đơn đã huỷ', async () => {
  const w = world();
  const a = (await w.post('owner', { action: 'save_supplier', name: 'A' })).body.supplier;
  const b = (await w.post('owner', { action: 'save_supplier', name: 'B' })).body.supplier;
  const oa = (await w.post('thy', { action: 'create', supplier_id: a.id, lines: [{ name: 'Muối', qty: 1 }] })).body.order;
  const ob = (await w.post('thy', { action: 'create', supplier_id: b.id, lines: [{ name: 'Muối', qty: 1 }] })).body.order;
  const pageA = (await w.sup.get(a.token)).body;
  assert.deepEqual(pageA.orders.map(o => o.id), [oa.id]);
  assert.ok(!JSON.stringify(pageA).includes(PEOPLE.thy.id));
  assert.ok(!JSON.stringify(pageA).includes(b.token));
  assert.equal((await w.sup.post({ t: a.token, id: ob.id, prices: [{ index: 0, price: 1 }] })).status, 404);
  await w.post('thy', { action: 'cancel', id: oa.id, reason: 'gọi nhầm' });
  const cancelled = (await w.sup.get(a.token)).body.orders[0];
  assert.ok(cancelled.cancelled_at);
  assert.match((await w.sup.post({ t: a.token, id: oa.id, updated_at: cancelled.updated_at, prices: [{ index: 0, price: 1 }] })).body.error, /huỷ/);
});

test('giá lần trước: lấy đúng giá của chính chủ gia vị đó, bỏ qua đơn huỷ, đơn mới nhất thắng', async () => {
  const w = world();
  const a = (await w.post('owner', { action: 'save_supplier', name: 'A' })).body.supplier;
  const b = (await w.post('owner', { action: 'save_supplier', name: 'B' })).body.supplier;
  const buy = async (s, price, day, cancel = false) => {
    w.at(day, 8);
    const o = (await w.post('thy', { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 1 }] })).body.order;
    await w.post('owner', { action: 'set_prices', id: o.id, prices: [{ index: 0, price }] });
    if (cancel) await w.post('thy', { action: 'cancel', id: o.id });
    return o;
  };
  await buy(a, 10000, '2026-11-01');
  await buy(b, 8000, '2026-11-02');
  await buy(a, 12000, '2026-11-03');
  await buy(a, 99000, '2026-11-04', true);
  w.at('2026-11-05', 8);
  const next = (await w.post('thy', { action: 'create', supplier_id: a.id, lines: [{ name: 'muối', qty: 1 }] })).body.order;
  assert.deepEqual([next.items[0].price, next.items[0].old_price], [12000, 12000]);
  const lastB = (await w.get('thy')).body.lastPrices[b.id];
  assert.equal(lastB['muối'], 8000);
});

/* ---------------- Mô phỏng ngẫu nhiên ---------------- */

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const NAMES = ['Muối', 'Đường', 'Sả', 'Ớt', 'Tiêu', 'Bột ngọt', 'Tỏi', 'Hành tím', 'Nước mắm', 'Me'];
const STAFF = ['thy', 'tai', 'lan', 'owner'];

async function checkWorld(w, step) {
  const where = `bước ${step}`;
  const orders = w.state.spice_orders, payments = w.state.spice_payments;
  for (const o of orders) {
    assert.equal(o.total, spice.orderTotal(o.items), `${where}: tổng đơn ${o.id} khớp các dòng`);
    assert.ok(o.total >= 0 && o.total <= spice.MAX_SPICE_TOTAL, `${where}: tổng trong giới hạn`);
    assert.equal(o.log[0].type, 'create', `${where}: lịch sử bắt đầu bằng gọi`);
    for (let i = 1; i < o.log.length; i += 1) assert.ok(o.log[i].at >= o.log[i - 1].at, `${where}: lịch sử theo giờ`);
    assert.equal(new Set(o.items.map(l => spice.itemKey(l.name))).size, o.items.length, `${where}: không trùng món trong đơn`);
    assert.ok(!(o.cancelled_at && o.received_at), `${where}: không vừa huỷ vừa nhận`);
    if (o.received_at) assert.equal(o.received_date, spice.vnDateOf(o.received_at), `${where}: ngày nhận theo giờ VN`);
    // Sau khi nhận, chủ gia vị chỉ được điền giá dòng đang trống.
    const receivedAt = o.received_at;
    if (receivedAt) {
      for (const l of o.items) {
        const c = spice.lineCheck(l);
        assert.ok(spice.CHECKS.includes(c.check), `${where}: nhãn kiểm hàng hợp lệ`);
        if (c.check === 'short') assert.ok(c.got < Number(l.qty), `${where}: thiếu thì nhận ít hơn`);
        if (c.check === 'over') assert.ok(c.got > Number(l.qty), `${where}: dư thì nhận nhiều hơn`);
        if (c.check === 'wrong') assert.ok(c.note, `${where}: sai hàng có ghi chú`);
        if (c.check === 'ok') assert.equal(c.got, Number(l.qty), `${where}: đủ thì đúng số gọi`);
      }
      const filled = new Set();
      for (const e of o.log.filter(e => e.type === 'price' && e.who === 'supplier' && e.at > receivedAt)) {
        for (const c of e.changes) {
          assert.equal(c.from, null, `${where}: chủ gia vị không đổi giá đã có sau khi quán nhận`);
          assert.ok(!filled.has(c.name), `${where}: mỗi dòng trống chỉ điền một lần`);
          filled.add(c.name);
        }
      }
    }
  }
  // Công nợ chủ quán thấy = tự tính lại = trang chủ gia vị thấy.
  const owner = (await w.get('owner')).body;
  for (const s of w.state.spice_suppliers) {
    const mine = orders.filter(o => o.supplier_id === s.id && o.received_at && !o.cancelled_at);
    const delivered = mine.reduce((a, o) => a + o.total, 0);
    const paid = payments.filter(p => p.supplier_id === s.id).reduce((a, p) => a + p.amount, 0);
    assert.equal(owner.balances?.[s.id]?.debt ?? 0, delivered - paid, `${where}: nợ ${s.name}`);
    // Đối soát từng ngày: nợ cuối ngày gần nhất = công nợ; tổng các ngày = tổng đã giao.
    const days = spice.supplierDays(orders.filter(o => o.supplier_id === s.id), payments.filter(p => p.supplier_id === s.id));
    assert.equal(days[0]?.balance ?? 0, delivered - paid, `${where}: đối soát nợ cuối ${s.name}`);
    assert.equal(days.reduce((a, d) => a + d.total, 0), delivered, `${where}: đối soát tổng ${s.name}`);
    if (s.active) {
      const pageAll = (await w.sup.get(s.token)).body, page = pageAll.summary;
      assert.deepEqual([page.delivered, page.paid, page.owed], [delivered, paid, delivered - paid], `${where}: trang chủ gia vị ${s.name}`);
      if (pageAll.days.length) assert.equal(pageAll.days[0].balance, delivered - paid, `${where}: đối soát trên trang chủ gia vị ${s.name}`);
    }
  }
  // Sổ thu chi tháng = thống kê = cộng tay các đơn đã nhận.
  const byDay = spice.spiceCostByDay(orders);
  for (const month of ['2026-11', '2026-12']) {
    const want = orders.filter(o => o.received_at && !o.cancelled_at && o.received_date.startsWith(month)).reduce((a, o) => a + o.total, 0);
    const book = summarizeMonth({ month, today: '2026-12-31', startDate: '2026-11-01', spices: byDay }).totals.spices;
    assert.equal(book, want, `${where}: Sổ thu chi tháng ${month}`);
    const stat = spice.spiceStats(orders, { period: 'month' }).find(m => m.key === month)?.total || 0;
    assert.equal(stat, want, `${where}: thống kê tháng ${month}`);
  }
}

// Chạy nhiều hơn: SPICE_SIM_SEEDS=30 node --test tests/spice-simulation.test.mjs
const SEEDS = process.env.SPICE_SIM_SEEDS ? Array.from({ length: Number(process.env.SPICE_SIM_SEEDS) }, (_, i) => 1000 + i) : [1, 7, 42, 2026];
for (const seed of SEEDS) {
  test(`mô phỏng ngẫu nhiên (seed ${seed}): 250 thao tác của nhiều người, tiền luôn khớp, không lỗi 500`, async () => {
    const w = world();
    const r = rng(seed);
    const pick = list => list[Math.floor(r() * list.length)];
    const suppliers = [];
    for (const name of ['Cô Hai', 'Chú Ba', 'Chị Tư']) suppliers.push((await w.post('owner', { action: 'save_supplier', name })).body.supplier);
    let day = Date.parse('2026-11-01T01:00:00Z');
    const stats = {};
    for (let step = 1; step <= 250; step += 1) {
      day += Math.floor(r() * 5 * 3600000); // thời gian trôi 0–5 giờ mỗi bước (qua đêm, qua tháng)
      w.state.now = day;
      const orders = w.state.spice_orders;
      const open = orders.filter(o => !o.received_at && !o.cancelled_at);
      const any = orders.length ? pick(orders) : null;
      const who = pick(STAFF);
      const lines = () => Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ name: pick(NAMES), qty: String(Math.round((0.5 + r() * 4) * 2) / 2).replace('.', ','), unit: pick(['kg', 'bịch', '']) }));
      const kind = pick(['create', 'create', 'add', 'supplier', 'supplier', 'supplier', 'receive', 'receive', 'recheck', 'cancel', 'admin_price', 'pay', 'unpay', 'stale', 'link']);
      let res = null;
      const live = s => w.state.spice_suppliers.find(x => x.id === s.id);
      if (kind === 'create') res = await w.post(who, { action: 'create', supplier_id: pick(suppliers).id, lines: lines(), note: r() < 0.3 ? 'gấp' : '' });
      else if (kind === 'add' && any) res = await w.post(who, { action: 'add_lines', id: any.id, lines: lines() });
      else if (kind === 'supplier' && any) {
        const s = live(suppliers.find(x => x.id === any.supplier_id));
        const page = (await w.sup.get(s.token)).body.orders?.find(o => o.id === any.id);
        if (page) {
          const prices = page.items.map((l, index) => ({ index, price: r() < 0.15 ? '' : Math.round(5 + r() * 95) * 1000 })).filter(() => r() < 0.8);
          res = await w.sup.post({ t: s.token, id: any.id, updated_at: page.updated_at, prices, done: r() < 0.6, ...(r() < 0.2 ? { note: 'hết hàng' } : {}) });
        }
      } else if (kind === 'receive' && open.length) {
        const o = pick(open);
        // Kiểm từng món: đủ / thiếu / dư / sai (có khi nhập sai để chắc máy chủ chặn đúng).
        const recv = o.items.map(l => {
          const x = r(), q = Number(l.qty);
          if (x < 0.55) return null;
          if (x < 0.7) return { check: 'short', qty: String(Math.floor(r() * q * 2) / 2) };
          if (x < 0.8) return { check: 'over', qty: String(q + 0.5 + Math.floor(r() * 4) / 2) };
          if (x < 0.9) return { check: 'wrong', qty: r() < 0.5 ? '0' : String(q), note: r() < 0.9 ? 'hàng hư' : '' };
          return String(Math.round(r() * q * 2) / 2);
        });
        res = await w.post(who, { action: 'receive', id: o.id, updated_at: o.updated_at, received: recv, note: r() < 0.3 ? 'giao trễ' : '' });
      } else if (kind === 'recheck' && any?.received_at) {
        res = await w.post(who, { action: 'recheck', id: any.id, updated_at: any.updated_at, received: any.items.map(l => (r() < 0.6 ? null : { check: 'short', qty: String(Math.floor(r() * Number(l.qty) * 2) / 2) })) });
        if (!['owner', 'lan'].includes(who)) assert.equal(res.status, 403, `bước ${step}: ${who} không được kiểm lại`);
      } else if (kind === 'cancel' && any) res = await w.post(who, { action: 'cancel', id: any.id });
      else if (kind === 'admin_price' && any) res = await w.post(who, { action: 'set_prices', id: any.id, prices: [{ index: 0, price: Math.round(r() * 100) * 1000 }] });
      else if (kind === 'pay') res = await w.post(who, { action: 'pay', supplier_id: pick(suppliers).id, amount: String(Math.round(r() * 300) * 1000), method: pick(['cash', 'transfer']) });
      else if (kind === 'unpay' && w.state.spice_payments.length) res = await w.post(who, { action: 'delete_payment', id: pick(w.state.spice_payments).id });
      else if (kind === 'stale' && any) {
        // Bấm bằng bản cũ trên máy (người khác vừa sửa): phải bị chặn hoặc không đổi gì, không bao giờ đè dữ liệu.
        const before = JSON.stringify(order(w, any.id));
        res = await w.post(who, { action: 'receive', id: any.id, updated_at: '2026-01-01T00:00:00.000Z', received: [] });
        assert.ok(res.status === 409 || res.status === 400, `bước ${step}: bản cũ bị chặn (${res.status})`);
        assert.equal(JSON.stringify(order(w, any.id)), before, `bước ${step}: bản cũ không đè`);
      } else if (kind === 'link' && r() < 0.3) {
        const s = pick(suppliers);
        res = await w.post('owner', { action: 'new_link', id: s.id });
        suppliers[suppliers.indexOf(s)] = res.body.supplier;
      }
      if (res) {
        assert.ok(res.status < 500, `bước ${step} (${kind}): lỗi ${res.status} ${res.body.error}`);
        // Quyền: nhân viên không làm việc của chủ quán.
        if (['admin_price', 'pay', 'unpay', 'link'].includes(kind) && who !== 'owner' && kind !== 'link') assert.equal(res.status, 403, `bước ${step}: ${who} không được ${kind}`);
        stats[`${kind}:${res.status}`] = (stats[`${kind}:${res.status}`] || 0) + 1;
      }
      await checkWorld(w, step);
    }
    // Mô phỏng phải thật sự chạm đủ các nhánh, không chỉ toàn lỗi.
    const okCount = k => stats[`${k}:200`] || 0;
    assert.ok(w.state.spice_orders.some(o => o.items.some(l => l.check && l.check !== 'ok')), 'có món thiếu / dư / sai');
    for (const k of ['create', 'supplier', 'receive']) assert.ok(okCount(k) > 3, `${k} thành công đủ nhiều: ${JSON.stringify(stats)}`);
    assert.ok(w.state.spice_orders.some(o => o.received_at), 'có đơn đã nhận');
    assert.ok(w.state.spice_orders.some(o => o.received_date?.startsWith('2026-12')) || day < Date.parse('2026-12-01T00:00:00Z'), 'nếu sang tháng 12 thì có đơn tháng 12');
  });
}
