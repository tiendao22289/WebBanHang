// Gọi gia vị: nhân viên gửi đơn cho chủ gia vị qua Zalo (link riêng), chủ gia vị tự điền giá (giá cũ điền sẵn), nhân viên bấm
// nhận; đơn đã nhận ghi nợ chủ gia vị và vào Sổ thu chi đúng ngày nhận; chủ quán trả gom. Mọi việc ghi lịch sử (ai, giờ nào).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import * as spice from '../src/lib/spiceOrders.mjs';
import { dailyReportText, dayCostTotal, summarizeMonth, costParts } from '../src/lib/ownerFinance.mjs';
import { canOpenPath } from '../src/lib/staffRoles.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const SUP = '00000000-0000-4000-8000-0000000000a1';
const SUP2 = '00000000-0000-4000-8000-0000000000a2';
const T = (h, m = 0, d = 25) => new Date(Date.UTC(2026, 10, d, h - 7, m)).toISOString(); // giờ Việt Nam ngày d/11/2026

/* ---------------- Thư viện ---------------- */

test('đọc số lượng và giá như người Việt gõ', () => {
  assert.equal(spice.parseQty('1,5'), 1.5);
  assert.equal(spice.parseQty('2'), 2);
  assert.equal(spice.parseQty('0'), null);
  assert.equal(spice.parseQty('abc'), null);
  assert.equal(spice.parseQty('-1'), null);
  assert.equal(spice.parsePrice('25.000'), 25000);
  assert.equal(spice.parsePrice('25k'), 25000);
  assert.equal(spice.parsePrice('1,5k'), 1500);
  assert.equal(spice.parsePrice(''), null);
  assert.equal(spice.parsePrice(null), null);
  assert.equal(spice.parsePrice(0), 0);
  assert.equal(spice.parsePrice('abc'), undefined);
  assert.equal(spice.parsePrice(-5), undefined);
  assert.equal(spice.parsePrice('999999999999'), undefined);
});

test('giá lần trước lấy theo từng chủ gia vị, đơn mới nhất trước, bỏ đơn huỷ', () => {
  const orders = [
    { supplier_id: SUP, created_at: T(8, 0, 20), items: [{ name: 'Muối', price: 10000 }, { name: 'Sả', price: null }] },
    { supplier_id: SUP, created_at: T(8, 0, 22), items: [{ name: 'muối ', price: 12000 }] },
    { supplier_id: SUP, created_at: T(8, 0, 23), cancelled_at: T(9, 0, 23), items: [{ name: 'Muối', price: 99000 }] },
    { supplier_id: SUP2, created_at: T(8, 0, 24), items: [{ name: 'Muối', price: 5000 }] },
  ];
  const last = spice.lastPrices(orders, SUP);
  assert.equal(last.get('muối').price, 12000);
  assert.equal(last.has('sả'), false);
  assert.equal(spice.lastPrices(orders, SUP2).get('muối').price, 5000);
});

test('gọi đơn: giá cũ điền sẵn, món mới để trống, ghi ai gọi lúc nào; trùng món thì báo', () => {
  const last = new Map([['muối', { price: 12000 }]]);
  const built = spice.buildLines([{ name: ' Muối ', qty: '2', unit: 'kg' }, { name: 'Sả', qty: '1,5', unit: 'kg' }, { name: '', qty: 3 }], { last, by: 'Thy', at: T(8) });
  assert.deepEqual(built.lines.map(l => [l.name, l.qty, l.price, l.old_price, l.added_by]), [['Muối', 2, 12000, 12000, 'Thy'], ['Sả', 1.5, null, null, 'Thy']]);
  assert.match(spice.buildLines([{ name: 'Muối', qty: 1 }, { name: 'muối', qty: 2 }]).error, /đã có/);
  assert.match(spice.buildLines([{ name: 'Muối', qty: 'x' }]).error, /Số lượng/);
  assert.match(spice.buildLines([]).error, /Chưa có món/);
  assert.match(spice.buildLines(Array.from({ length: 61 }, (_, i) => ({ name: `M${i}`, qty: 1 }))).error, /Tối đa/);
  const row = spice.createOrderRow({ lines: built.lines, note: 'giao trước 10h', by: 'Thy', at: T(8), supplierId: SUP });
  assert.equal(row.total, 24000);
  assert.equal(row.log[0].type, 'create');
  assert.equal(spice.logLine(row.log[0]).text, 'gọi: Muối 2 kg, Sả 1,5 kg · ghi chú: giao trước 10h');
  assert.equal(spice.logLine(row.log[0]).who, 'Thy');
  assert.equal(spice.logLine(row.log[0]).time, '08:00 25/11');
});

const baseOrder = () => {
  const lines = spice.buildLines([{ name: 'Muối', qty: 2, unit: 'kg' }, { name: 'Sả', qty: 1, unit: 'kg' }], { last: new Map([['muối', { price: 12000 }]]), by: 'Thy', at: T(8) }).lines;
  return { id: 'o1', ...spice.createOrderRow({ lines, by: 'Thy', at: T(8), supplierId: SUP }) };
};

test('nhân viên thêm món: dòng mới ghi ai thêm, giờ nào; đơn đã nhận / đã huỷ không thêm được', () => {
  const o = baseOrder();
  const r = spice.addLines(o, [{ name: 'Ớt', qty: 1, unit: 'kg' }], { last: new Map(), by: 'Tài', at: T(9, 10), note: 'hết ớt' });
  assert.equal(r.patch.items.length, 3);
  assert.equal(r.patch.items[2].added_by, 'Tài');
  assert.ok(spice.addedLater({ ...o, ...r.patch }, r.patch.items[2]));
  assert.ok(!spice.addedLater(o, o.items[0]));
  assert.equal(spice.logLine(r.patch.log.at(-1)).text, 'thêm: Ớt 1 kg · ghi chú: hết ớt');
  assert.match(spice.addLines(o, [{ name: 'muối', qty: 1 }], { by: 'Tài', at: T(9) }).error, /đã có/);
  assert.match(spice.addLines({ ...o, received_at: T(10) }, [{ name: 'Ớt', qty: 1 }], { by: 'Tài', at: T(11) }).error, /đã nhận/);
  assert.match(spice.addLines({ ...o, cancelled_at: T(10) }, [{ name: 'Ớt', qty: 1 }], { by: 'Tài', at: T(11) }).error, /huỷ/);
});

test('chủ gia vị điền / sửa giá: đơn chưa nhận sửa được hết; đã nhận chỉ điền được dòng trống; chủ quán sửa mọi lúc', () => {
  const o = baseOrder();
  const r = spice.applyPrices(o, [{ index: 0, price: '13.000' }, { index: 1, price: 30000 }], { by: 'Cô Hai', at: T(9), who: 'supplier', done: true, note: 'sả tươi' });
  const priced = { ...o, ...r.patch };
  assert.equal(priced.total, 2 * 13000 + 30000);
  assert.equal(priced.priced_at, T(9));
  assert.equal(priced.supplier_note, 'sả tươi');
  assert.deepEqual(priced.log.slice(1).map(e => e.type), ['price', 'done', 'note']);
  assert.equal(spice.logLine(priced.log[1]).text, 'đổi giá: Muối 12.000đ → 13.000đ, Sả trống → 30.000đ');
  assert.equal(spice.priceChange(priced.items[0]), 1000);
  // Bấm "Đã soạn xong" lần nữa: không ghi thêm.
  assert.equal(spice.applyPrices(priced, [], { by: 'Cô Hai', at: T(9, 5), done: true }).patch, null);
  // Giá sai.
  assert.match(spice.applyPrices(o, [{ index: 0, price: 'abc' }], { by: 'x', at: T(9) }).error, /không hợp lệ/);
  assert.match(spice.applyPrices(o, [{ index: 9, price: 1 }], { by: 'x', at: T(9) }).error, /Dòng hàng/);
  // Đã nhận: dòng có giá thì chủ gia vị không sửa được, dòng trống thì điền được.
  const got = { ...o, received_at: T(10) };
  assert.match(spice.applyPrices(got, [{ index: 0, price: 50000 }], { by: 'Cô Hai', at: T(11) }).error, /báo chủ quán/);
  assert.equal(spice.applyPrices(got, [{ index: 1, price: 25000 }], { by: 'Cô Hai', at: T(11) }).patch.items[1].price, 25000);
  assert.equal(spice.applyPrices(got, [{ index: 0, price: 50000 }], { by: 'Chủ quán', at: T(11), who: 'admin' }).patch.items[0].price, 50000);
  // Đơn huỷ: không ai sửa.
  assert.match(spice.applyPrices({ ...o, cancelled_at: T(9) }, [{ index: 0, price: 1 }], { by: 'Cô Hai', at: T(9) }).error, /huỷ/);
});

test('nhận hàng: nhận đủ hoặc nhận thiếu (ghi rõ thiếu món nào), tiền theo số nhận; chỉ nhận một lần', () => {
  const o = { ...baseOrder(), items: baseOrder().items.map(l => ({ ...l, price: l.price ?? 30000 })) };
  const full = spice.receiveOrder(o, [], { by: 'Thy', at: T(10) });
  assert.equal(full.patch.total, 2 * 12000 + 30000);
  assert.equal(full.patch.received_date, '2026-11-25');
  assert.equal(spice.logLine(full.patch.log.at(-1)).text, 'nhận đủ hàng');
  const short = spice.receiveOrder(o, ['1,5', '0'], { by: 'Thy', at: T(10) });
  assert.equal(short.patch.total, 1.5 * 12000);
  assert.equal(spice.logLine(short.patch.log.at(-1)).text, 'nhận hàng: Muối thiếu 0,5 kg (gọi 2, nhận 1,5); Sả thiếu 1 kg (gọi 1, nhận 0)');
  // Gõ đúng số đã gọi = nhận đủ.
  assert.equal(spice.receiveOrder(o, ['2', '1'], { by: 'Thy', at: T(10) }).patch.items[0].received_qty, null);
  assert.match(spice.receiveOrder({ ...o, ...full.patch }, [], { by: 'Tài', at: T(11) }).error, /Thy/);
  // Nhận lúc 23h30 giờ VN vẫn là ngày đó, 00h30 là ngày sau.
  assert.equal(spice.receiveOrder(o, [], { by: 'x', at: T(23, 30) }).patch.received_date, '2026-11-25');
  assert.equal(spice.receiveOrder(o, [], { by: 'x', at: T(24, 30) }).patch.received_date, '2026-11-26');
});

test('huỷ đơn: chỉ đơn chưa nhận, ghi ai huỷ', () => {
  const o = baseOrder();
  const r = spice.cancelOrder(o, { by: 'Quản lý', at: T(9), reason: 'gọi nhầm' });
  assert.equal(spice.orderState({ ...o, ...r.patch }), 'cancelled');
  assert.equal(spice.logLine(r.patch.log.at(-1)).text, 'huỷ đơn · ghi chú: gọi nhầm');
  assert.match(spice.cancelOrder({ ...o, received_at: T(10) }, { by: 'x', at: T(11) }).error, /đã nhận/);
});

test('trạng thái đơn', () => {
  const o = baseOrder();
  assert.equal(spice.orderState(o), 'new');
  assert.equal(spice.orderState({ ...o, priced_at: T(9) }), 'priced');
  assert.equal(spice.orderState({ ...o, received_at: T(10) }), 'waiting_price'); // Sả chưa có giá
  assert.equal(spice.orderState({ ...o, received_at: T(10), items: o.items.map(l => ({ ...l, price: 1000 })) }), 'done');
  // Món nhận 0 thì không cần giá.
  assert.equal(spice.orderState({ ...o, received_at: T(10), items: [o.items[0], { ...o.items[1], received_qty: 0 }] }), 'done');
});

const received = (id, supplier, date, items, extra = {}) => ({ id, supplier_id: supplier, created_at: `${date}T01:00:00.000Z`, received_at: `${date}T03:00:00.000Z`, received_date: date, items, ...extra });
const ORDERS = [
  received('a', SUP, '2026-11-24', [{ name: 'Muối', unit: 'kg', qty: 2, price: 12000, old_price: null }, { name: 'Sả', unit: 'kg', qty: 1, price: 30000, old_price: null }]),
  received('b', SUP, '2026-11-25', [{ name: 'Muối', unit: 'kg', qty: 3, price: 13000, old_price: 12000 }, { name: 'Ớt', unit: 'kg', qty: 1, price: null, old_price: null }]),
  received('c', SUP2, '2026-11-25', [{ name: 'Đường', unit: 'kg', qty: 5, price: 20000, old_price: 22000 }]),
  received('d', SUP, '2026-11-25', [{ name: 'Muối', unit: 'kg', qty: 9, price: 13000 }], { cancelled_at: '2026-11-25T04:00:00Z' }),
  { id: 'e', supplier_id: SUP, created_at: '2026-11-25T05:00:00Z', items: [{ name: 'Tiêu', qty: 1, price: 90000 }] }, // chưa nhận
];
const PAYMENTS = [{ supplier_id: SUP, amount: 50000, method: 'cash', paid_date: '2026-11-25' }];

test('công nợ: đã giao (đơn đã nhận) − đã trả; đơn chưa nhận / huỷ không tính', () => {
  const b = spice.supplierBalances(ORDERS, PAYMENTS);
  assert.deepEqual(b[SUP], { owed: 54000 + 39000, paid: 50000, debt: 43000, waiting: 1 });
  assert.deepEqual(b[SUP2], { owed: 100000, paid: 0, debt: 100000, waiting: 0 });
  const mine = spice.supplierSummary(ORDERS.filter(o => o.supplier_id === SUP), PAYMENTS);
  assert.deepEqual(mine, { delivered: 93000, paid: 50000, owed: 43000, open: 1, waitingPrice: 1 });
});

test('tiền gia vị theo ngày nhận vào Sổ thu chi: trừ vào lãi, có từng món, báo đơn chưa đủ giá', () => {
  const byDay = spice.spiceCostByDay(ORDERS);
  assert.equal(byDay['2026-11-24'].amount, 54000);
  assert.equal(byDay['2026-11-25'].amount, 39000 + 100000);
  assert.equal(byDay['2026-11-25'].waiting, 1);
  const without = summarizeMonth({ month: '2026-11', today: '2026-11-25', startDate: '2026-11-01' });
  const withSpices = summarizeMonth({ month: '2026-11', today: '2026-11-25', startDate: '2026-11-01', spices: byDay });
  const day = withSpices.days.find(d => d.date === '2026-11-25');
  assert.equal(day.spices, 139000);
  assert.equal(day.spiceWaiting, 1);
  assert.equal(dayCostTotal(day), dayCostTotal(without.days.find(d => d.date === '2026-11-25')) + 139000);
  assert.equal(withSpices.totals.spices, 193000);
  assert.equal(without.totals.profit - withSpices.totals.profit, 193000);
  assert.equal(costParts(day).spices, 139000);
  assert.deepEqual(Object.values(day.costItems.spices).map(x => [x.name, x.amount]).sort(), [['Muối', 39000], ['Đường', 100000]].sort());
  const text = dailyReportText({ day, monthTotals: withSpices.totals });
  assert.match(text, /gia vị 139\.000đ/);
});

test('thống kê từng món theo ngày / tháng / năm, có giá tăng giảm so với lần trước', () => {
  const names = { [SUP]: 'Cô Hai', [SUP2]: 'Chú Ba' };
  const days = spice.spiceStats(ORDERS, { period: 'day', supplierNames: names });
  assert.deepEqual(days.map(g => [g.key, g.total]), [['2026-11-25', 139000], ['2026-11-24', 54000]]);
  const muoi = days[0].items.find(i => i.name === 'Muối');
  assert.deepEqual([muoi.qty, muoi.amount, muoi.price, muoi.change, muoi.suppliers], [3, 39000, 13000, 1000, ['Cô Hai']]);
  assert.equal(days[0].items.find(i => i.name === 'Đường').change, -2000);
  assert.equal(days[0].items[0].name, 'Đường'); // nhiều tiền trước
  const month = spice.spiceStats(ORDERS, { period: 'month' });
  assert.equal(month.length, 1);
  assert.equal(month[0].key, '2026-11');
  assert.equal(month[0].items.find(i => i.name === 'Muối').qty, 5);
  assert.equal(month[0].items.find(i => i.name === 'Muối').first, 12000);
  assert.equal(spice.spiceStats(ORDERS, { period: 'year' })[0].key, '2026');
});

test('mục Gia vị của một ngày (/thongke): từng món, tăng / giảm, đã trả, còn nợ tới hết ngày', () => {
  const d = spice.spiceDayData({ orders: ORDERS, payments: PAYMENTS, date: '2026-11-25', supplierNames: { [SUP]: 'Cô Hai' } });
  assert.equal(d.total, 139000);
  assert.equal(d.orders, 2);
  assert.equal(d.waiting, 1);
  assert.equal(d.up, 1);
  assert.equal(d.down, 1);
  assert.equal(d.paid, 50000);
  assert.equal(d.debt, 54000 + 139000 - 50000);
  const before = spice.spiceDayData({ orders: ORDERS, payments: PAYMENTS, date: '2026-11-24' });
  assert.equal(before.debt, 54000);
  assert.equal(before.paid, 0);
});

test('tin gửi Zalo có món, người gọi và link', () => {
  const text = spice.shareText({ supplierName: 'Cô Hai', items: [{ name: 'Muối', qty: 1.5, unit: 'kg' }], by: 'Thy', note: 'gấp', link: 'https://x/giavi/abc?don=1' });
  assert.match(text, /Quán gọi gia vị – gửi Cô Hai/);
  assert.match(text, /• Muối: 1,5 kg/);
  assert.match(text, /Người gọi: Thy/);
  assert.match(text, /https:\/\/x\/giavi\/abc\?don=1/);
  assert.match(spice.shareText({ items: [], title: 'Quán gọi THÊM gia vị' }), /THÊM/);
});

test('nhân viên, quản lý, admin đều mở được trang Gia vị', () => {
  for (const role of ['staff', 'manager', 'admin']) assert.ok(canOpenPath(role, '/admin/spices'), role);
});

/* ---------------- Máy chủ: /api/admin/spices và /api/spice-supplier ---------------- */

const strip = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const ADMIN_SRC = strip('../src/app/api/admin/spices/route.js');
const SUPPLIER_SRC = strip('../src/app/api/spice-supplier/route.js');
const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body: JSON.parse(JSON.stringify(body)) }) };
const USERS = {
  admin: { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' },
  staff: { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Thy', role: 'staff' },
  staff2: { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Tài', role: 'staff' },
  manager: { id: '00000000-0000-4000-8000-00000000dddd', full_name: 'Quản lý', role: 'manager' },
};
const GLOBALS = { Object, URL, Number, Math, String, JSON, Date, Map, Set, Array, Promise, Boolean, console: { error() {} } };
function adminApi(state, who) {
  return vm.runInNewContext(`${ADMIN_SRC}\n({ GET, POST })`, {
    ...GLOBALS, ...spice, NextResponse, randomBytes, nowMs: () => state.now,
    getStaffSession: async () => ({ code: 200, user: USERS[who] }), staffDatabase: () => fakeDb(state),
  });
}
function supplierApi(state) {
  return vm.runInNewContext(`${SUPPLIER_SRC}\n({ GET, POST })`, { ...GLOBALS, ...spice, NextResponse, nowMs: () => state.now, statusDatabase: () => fakeDb(state) });
}
const post = (api, body) => api.POST({ url: 'http://x/api', json: async () => body });
const get = (api, qs = '') => api.GET({ url: `http://x/api${qs}` });
const newState = () => ({ __seq: 0, now: Date.parse(T(8)), spice_suppliers: [], spice_items: [], spice_orders: [], spice_payments: [] });

test('máy chủ: trọn quy trình gọi → thêm món → chủ gia vị điền giá → nhận → trả nợ', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff'), tai = adminApi(state, 'staff2');
  // Nhân viên không tạo được chủ gia vị.
  assert.equal((await post(thy, { action: 'save_supplier', name: 'X' })).status, 403);
  const sup = (await post(owner, { action: 'save_supplier', name: 'Cô Hai', phone: '0909 123 456' })).body.supplier;
  assert.equal(sup.phone, '0909123456');
  assert.ok(sup.token.length >= 24);

  // Lần 1: chưa có giá cũ.
  const first = await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Muối', qty: '2', unit: 'kg' }, { name: 'Sả', qty: 1, unit: 'kg' }], note: 'trước 10h' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.order.items.map(l => l.price), [null, null]);
  assert.equal(first.body.supplier.token, sup.token);
  assert.deepEqual(state.spice_items.map(i => i.name).sort(), ['Muối', 'Sả']);

  // Tài thêm món lúc 9h.
  state.now = Date.parse(T(9));
  const added = await post(tai, { action: 'add_lines', id: first.body.order.id, lines: [{ name: 'Ớt', qty: 1, unit: 'kg' }] });
  assert.equal(added.status, 200);
  assert.equal(added.body.order.items[2].added_by, 'Tài');
  assert.equal(added.body.supplier.token, sup.token);

  // Chủ gia vị mở link: thấy đơn, tổng; điền giá, báo xong.
  const supplier = supplierApi(state);
  const page = await get(supplier, `?t=${sup.token}`);
  assert.equal(page.status, 200);
  assert.equal(page.body.supplier.name, 'Cô Hai');
  assert.equal(page.body.orders.length, 1);
  assert.equal('created_by' in page.body.orders[0], false); // không lộ mã nhân viên
  assert.deepEqual(page.body.orders[0].log.map(e => [e.type, e.by]), [['create', 'Thy'], ['add', 'Tài']]);
  state.now = Date.parse(T(9, 30));
  const order = page.body.orders[0];
  const priced = await post(supplier, { t: sup.token, id: order.id, updated_at: order.updated_at, done: true, prices: [{ index: 0, price: 12000 }, { index: 1, price: 30000 }, { index: 2, price: 50000 }] });
  assert.equal(priced.status, 200);
  assert.equal(priced.body.order.total, 24000 + 30000 + 50000);
  // Bấm lại với updated_at cũ → báo tải lại, không ghi đè.
  assert.equal((await post(supplier, { t: sup.token, id: order.id, updated_at: order.updated_at, prices: [{ index: 0, price: 1 }] })).status, 409);

  // Thy nhận, thiếu ớt.
  state.now = Date.parse(T(10));
  const listBefore = (await get(thy)).body;
  assert.equal(listBefore.balances, null); // nhân viên không thấy công nợ
  const cur = listBefore.orders[0];
  const got = await post(thy, { action: 'receive', id: cur.id, updated_at: cur.updated_at, received: [null, null, '0,5'] });
  assert.equal(got.status, 200);
  assert.equal(got.body.order.total, 24000 + 30000 + 25000);
  assert.equal(got.body.order.received_date, '2026-11-25');
  assert.equal((await post(tai, { action: 'receive', id: cur.id, received: [] })).body.error, 'Đơn đã được Thy bấm nhận rồi.');
  // Đã nhận: chủ gia vị không đổi giá được nữa.
  const after = (await get(supplier, `?t=${sup.token}`)).body;
  assert.match((await post(supplier, { t: sup.token, id: cur.id, updated_at: after.orders[0].updated_at, prices: [{ index: 0, price: 99000 }] })).body.error, /báo chủ quán/);
  assert.deepEqual(after.summary, { delivered: 79000, paid: 0, owed: 79000, open: 0, waitingPrice: 0 });

  // Lần 2: giá cũ điền sẵn.
  state.now = Date.parse(T(8, 0, 26));
  const second = await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'muối', qty: 1, unit: 'kg' }, { name: 'Tiêu', qty: 1 }] });
  assert.deepEqual(second.body.order.items.map(l => [l.price, l.old_price]), [[12000, 12000], [null, null]]);

  // Chủ quán trả gom một phần.
  assert.equal((await post(thy, { action: 'pay', supplier_id: sup.id, amount: 50000 })).status, 403);
  assert.match((await post(owner, { action: 'pay', supplier_id: sup.id, amount: '500' })).body.error, /không hợp lệ/);
  assert.match((await post(owner, { action: 'pay', supplier_id: sup.id, amount: 50000, paid_date: '2099-01-01' })).body.error, /sau hôm nay/);
  const paid = await post(owner, { action: 'pay', supplier_id: sup.id, amount: '50.000', method: 'transfer' });
  assert.equal(paid.body.payment.amount, 50000);
  assert.equal(paid.body.payment.paid_date, '2026-11-26');
  const ownerView = (await get(owner)).body;
  assert.deepEqual(ownerView.balances[sup.id], { owed: 79000, paid: 50000, debt: 29000, waiting: 0 });
  assert.equal((await get(supplier, `?t=${sup.token}`)).body.summary.owed, 29000);
  assert.equal((await get(supplier, `?t=${sup.token}`)).body.payments[0].method, 'transfer');

  // Thống kê chỉ chủ quán.
  assert.equal((await get(thy, '?stats=day')).status, 403);
  const stats = (await get(owner, '?stats=day')).body.stats;
  assert.equal(stats[0].key, '2026-11-25');
  assert.equal(stats[0].total, 79000);
});

test('máy chủ: link sai / đổi link / chủ gia vị ngưng thì không mở được; chủ gia vị không đụng được đơn của người khác', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff');
  const a = (await post(owner, { action: 'save_supplier', name: 'A' })).body.supplier;
  const b = (await post(owner, { action: 'save_supplier', name: 'B' })).body.supplier;
  const ob = (await post(thy, { action: 'create', supplier_id: b.id, lines: [{ name: 'Muối', qty: 1 }] })).body.order;
  const supplier = supplierApi(state);
  assert.equal((await get(supplier, '?t=short')).status, 404);
  assert.equal((await get(supplier, `?t=${'x'.repeat(32)}`)).status, 404);
  assert.equal((await get(supplier, `?t=${a.token}`)).body.orders.length, 0);
  assert.equal((await post(supplier, { t: a.token, id: ob.id, prices: [{ index: 0, price: 1000 }] })).status, 404);
  const fresh = (await post(owner, { action: 'new_link', id: b.id })).body.supplier;
  assert.notEqual(fresh.token, b.token);
  assert.equal((await get(supplier, `?t=${b.token}`)).status, 404);
  assert.equal((await get(supplier, `?t=${fresh.token}`)).status, 200);
  await post(owner, { action: 'save_supplier', id: b.id, name: 'B', active: false });
  assert.equal((await get(supplier, `?t=${fresh.token}`)).status, 404);
  assert.match((await post(thy, { action: 'create', supplier_id: b.id, lines: [{ name: 'Muối', qty: 1 }] })).body.error, /không còn nhận đơn/);
  // Nhân viên không thấy chủ gia vị đã ngưng.
  assert.deepEqual((await get(thy)).body.suppliers.map(s => s.name), ['A']);
});

test('máy chủ: huỷ đơn — người gọi hoặc quản lý; nhân viên khác không huỷ được; sửa giá chỉ chủ quán', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff'), tai = adminApi(state, 'staff2'), mgr = adminApi(state, 'manager');
  const sup = (await post(owner, { action: 'save_supplier', name: 'A' })).body.supplier;
  const o1 = (await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Muối', qty: 1 }] })).body.order;
  const o2 = (await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Sả', qty: 1 }] })).body.order;
  assert.equal((await post(tai, { action: 'cancel', id: o1.id })).status, 403);
  assert.equal((await post(thy, { action: 'cancel', id: o1.id })).status, 200);
  assert.equal((await post(mgr, { action: 'cancel', id: o2.id })).status, 200);
  assert.equal(state.spice_orders.find(o => o.id === o2.id).cancelled_by_name, 'Quản lý');
  assert.match((await post(thy, { action: 'add_lines', id: o1.id, lines: [{ name: 'Ớt', qty: 1 }] })).body.error, /huỷ/);
  const o3 = (await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Ớt', qty: 1 }] })).body.order;
  assert.equal((await post(thy, { action: 'set_prices', id: o3.id, prices: [{ index: 0, price: 1000 }] })).status, 403);
  const fixed = await post(owner, { action: 'set_prices', id: o3.id, prices: [{ index: 0, price: 1000 }] });
  assert.equal(fixed.body.order.log.at(-1).who, 'admin');
  // Trùng tên món khi tạo món trong Cài đặt.
  assert.match((await post(owner, { action: 'save_item', name: ' ớt ' })).body.error, /Đã có/);
  // Dữ liệu lạ.
  assert.equal((await post(thy, { action: 'create', supplier_id: 'abc', lines: [] })).status, 400);
  assert.equal((await post(thy, { action: 'receive', id: 'abc' })).status, 400);
  assert.equal((await post(thy, { action: 'hack' })).status, 403);
});

test('máy chủ: chưa cài bảng thì báo rõ, không lỗi 500 khó hiểu', async () => {
  const state = { ...newState(), __noTable: ['spice_suppliers', 'spice_items', 'spice_orders', 'spice_payments'] };
  const res = await get(adminApi(state, 'staff'));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /Apply Finance Migration/);
});

/* ---------------- SQL thật (PGlite): bảng cài được, chạy lại được, khoá web công khai ---------------- */

test('spice_orders.sql cài trên Postgres thật, chạy lại được, web công khai không đọc được', async () => {
  const db = new PGlite();
  await db.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
  END $$;`);
  const sql = readFileSync(new URL('../supabase/migrations/spice_orders.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql); // chạy lại được
  const { rows: [r] } = await db.query(`SELECT has_table_privilege('anon', 'public.spice_orders', 'SELECT') AS anon_read,
    has_table_privilege('service_role', 'public.spice_payments', 'INSERT') AS server_write`);
  assert.equal(r.anon_read, false);
  assert.equal(r.server_write, true);
  const { rows: [s] } = await db.query(`INSERT INTO spice_suppliers (name, token) VALUES ('A', $1) RETURNING id`, [randomBytes(24).toString('base64url')]);
  await assert.rejects(db.query(`INSERT INTO spice_suppliers (name, token) VALUES ('B', 'short')`));
  await db.query(`INSERT INTO spice_orders (supplier_id, items) VALUES ($1, '[]')`, [s.id]);
  // Có ngày nhận thì phải có giờ nhận (và ngược lại).
  await assert.rejects(db.query(`INSERT INTO spice_orders (supplier_id, items, received_at) VALUES ($1, '[]', now())`, [s.id]));
  await assert.rejects(db.query(`INSERT INTO spice_payments (supplier_id, amount, method, paid_date) VALUES ($1, 500, 'cash', '2026-11-25')`, [s.id]));
  await assert.rejects(db.query(`INSERT INTO spice_payments (supplier_id, amount, method, paid_date) VALUES ($1, 5000, 'card', '2026-11-25')`, [s.id]));
  await assert.rejects(db.query(`INSERT INTO spice_items (name) VALUES ('Muối Tây'), ('muối tây')`));
  // Danh sách gia vị mặc định: thêm khi bảng trống, chạy lại không thêm trùng; chủ quán xoá hết thì không tự thêm lại? — chỉ khi trống.
  const { rows: seeded } = await db.query('SELECT name, unit, default_qty FROM spice_items ORDER BY sort');
  assert.equal(seeded.length, 20);
  assert.deepEqual([seeded[0].name, seeded[0].unit, Number(seeded[0].default_qty)], ['Muối', 'kg', 1]);
  assert.equal(Number(seeded.find(r => r.name === 'Tiêu xay').default_qty), 0.5);
  await db.exec(sql);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM spice_items')).rows[0].n, 20);
  await assert.rejects(db.query(`UPDATE spice_items SET default_qty = 0 WHERE name = 'Muối'`));
  await db.close();
});

/* ---------------- Danh sách món chọn nhanh ---------------- */

test('tìm món không dấu, số mặc định mỗi lần bấm, món hay gọi lên đầu', () => {
  assert.equal(spice.plainText('Hành Tím'), 'hanh tim');
  assert.equal(spice.plainText('Đường'), 'duong');
  assert.equal(spice.itemStep({ default_qty: 0.5 }), 0.5);
  assert.equal(spice.itemStep({ default_qty: null }), 1);
  assert.equal(spice.itemStep(undefined), 1);
  const items = [{ name: 'Muối', sort: 1 }, { name: 'Đường', sort: 2 }, { name: 'Sả', sort: 3 }, { name: 'Ẩn', sort: 0, active: false }];
  const orders = [
    { supplier_id: SUP, items: [{ name: 'Sả' }] },
    { supplier_id: SUP2, items: [{ name: 'Đường' }, { name: 'Đường ' }] },
    { supplier_id: SUP, cancelled_at: 'x', items: [{ name: 'Muối' }, { name: 'Muối' }, { name: 'Muối' }, { name: 'Muối' }] },
  ];
  assert.deepEqual(spice.rankItems(items, orders, SUP).map(i => i.name), ['Sả', 'Đường', 'Muối']);
  assert.deepEqual(spice.rankItems(items, [], null).map(i => i.name), ['Muối', 'Đường', 'Sả']);
});

test('chủ quán dán nhiều món một lần: "Muối 2 kg", "Tiêu 0,5kg", phẩy có cách, chấm phẩy, trùng tên', () => {
  assert.deepEqual(spice.parseItemLines('Muối 2 kg\nTiêu 0,5kg, Rau răm;  hạt nêm 3 gói\nmuối 5\n\n7 Up 2 lon'), [
    { name: 'Muối', qty: 2, unit: 'kg' }, { name: 'Tiêu', qty: 0.5, unit: 'kg' }, { name: 'Rau răm', qty: null, unit: '' },
    { name: 'hạt nêm', qty: 3, unit: 'gói' }, { name: '7 Up', qty: 2, unit: 'lon' },
  ]);
  assert.deepEqual(spice.parseItemLines(''), []);
  assert.deepEqual(spice.parseItemLines('Nước mắm Phú Quốc 2 chai'), [{ name: 'Nước mắm Phú Quốc', qty: 2, unit: 'chai' }]);
  assert.equal(spice.parseItemLines(Array.from({ length: 150 }, (_, i) => `M${i}`).join('\n')).length, 100);
});

test('máy chủ: thêm nhiều món, sửa số mặc định; nhân viên không sửa danh sách được', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff');
  state.spice_items.push({ id: 'i1', name: 'Muối', unit: 'kg', default_qty: 1, sort: 1, active: false });
  assert.equal((await post(thy, { action: 'save_items', text: 'Ớt 1 kg' })).status, 403);
  const r = await post(owner, { action: 'save_items', text: 'muối 2 kg\nTiêu 0,5 kg\nRau răm 2 bó' });
  assert.deepEqual([r.body.added, r.body.updated], [2, 1]);
  const muoi = state.spice_items.find(i => i.id === 'i1');
  assert.deepEqual([muoi.name, muoi.default_qty, muoi.active], ['Muối', 2, true], 'món đã có: cập nhật số, hiện lại');
  assert.deepEqual(state.spice_items.filter(i => i.id !== 'i1').map(i => [i.name, i.default_qty, i.unit, i.sort]), [['Tiêu', 0.5, 'kg', 2], ['Rau răm', 2, 'bó', 3]]);
  assert.match((await post(owner, { action: 'save_items', text: '  \n ' })).body.error, /Chưa có món/);
  const tieu = state.spice_items.find(i => i.name === 'Tiêu');
  assert.equal((await post(owner, { action: 'save_item', id: tieu.id, name: 'Tiêu', unit: 'kg', default_qty: '0.25' })).body.item.default_qty, 0.25);
  assert.equal((await post(owner, { action: 'save_item', id: tieu.id, name: 'Tiêu', unit: 'kg', default_qty: '' })).body.item.default_qty, null);
  assert.match((await post(owner, { action: 'save_item', id: tieu.id, name: 'Tiêu', default_qty: 'abc' })).body.error, /mặc định/);
  // Nhân viên thấy món đang hiện, có số mặc định để bấm nhanh.
  const seen = (await get(thy)).body.items;
  assert.ok(seen.every(i => i.active !== false));
  assert.equal(seen.find(i => i.name === 'Rau răm').default_qty, 2);
});

test('tin gửi Zalo là link của riêng đơn đó', () => {
  const text = spice.shareText({ items: [{ name: 'Muối', qty: 1 }], link: 'https://x/giavi/abc?don=o1' });
  assert.match(text, /Mở link đơn này để soạn hàng và điền giá: https:\/\/x\/giavi\/abc\?don=o1/);
});

/* ---------------- Kiểm hàng từng món + đối soát từng ngày ---------------- */

const fourLines = () => ({ id: 'k1', supplier_id: SUP, created_at: T(8), created_by_name: 'Thy', log: [], items: [
  { name: 'Muối', unit: 'kg', qty: 2, price: 10000 }, { name: 'Ớt', unit: 'kg', qty: 1, price: 50000 },
  { name: 'Sả', unit: 'kg', qty: 1, price: 30000 }, { name: 'Tỏi', unit: 'kg', qty: 1, price: 20000 }] });

test('kiểm hàng: Đủ / Thiếu / Dư / Sai hàng từng món, tiền theo số thật nhận, lịch sử ghi rõ', () => {
  const o = fourLines();
  const r = spice.receiveOrder(o, [{ check: 'short', qty: '1,5' }, { check: 'wrong', note: 'ớt xanh thay ớt đỏ' }, { check: 'over', qty: 2, note: 'giao dư' }, null],
    { by: 'Tài', at: T(10), note: 'giao trễ' });
  assert.equal(r.patch.total, 15000 + 0 + 60000 + 20000);
  assert.deepEqual(r.patch.items.map(l => [l.check, l.received_qty, l.check_note || '']), [['short', 1.5, ''], ['wrong', 0, 'ớt xanh thay ớt đỏ'], ['over', 2, 'giao dư'], ['ok', null, '']]);
  assert.equal(spice.logLine(r.patch.log.at(-1)).text,
    'nhận hàng: Muối thiếu 0,5 kg (gọi 2, nhận 1,5); Ớt sai hàng: ớt xanh thay ớt đỏ (gọi 1, lấy 0 kg); Sả dư 1 kg (gọi 1, nhận 2) · giao dư · ghi chú: giao trễ');
  // Sai hàng nhưng vẫn lấy 1 kg (dùng tạm): tính tiền 1 kg.
  const keep = spice.receiveOrder(o, [null, { check: 'wrong', qty: 1, note: 'ớt hơi héo, vẫn lấy' }], { by: 'Tài', at: T(10) });
  assert.equal(keep.patch.total, 20000 + 50000 + 30000 + 20000);
  // Kiểm tra số cho đúng loại.
  assert.match(spice.receiveOrder(o, [{ check: 'short', qty: 2 }], { by: 'x', at: T(10) }).error, /ít hơn 2/);
  assert.match(spice.receiveOrder(o, [{ check: 'short' }], { by: 'x', at: T(10) }).error, /ít hơn/);
  assert.match(spice.receiveOrder(o, [{ check: 'over', qty: '1,5' }], { by: 'x', at: T(10) }).error, /nhiều hơn 2/);
  assert.match(spice.receiveOrder(o, [null, { check: 'wrong', note: '  ' }], { by: 'x', at: T(10) }).error, /ghi rõ sai/);
  assert.match(spice.receiveOrder(o, [{ check: 'short', qty: 'abc' }], { by: 'x', at: T(10) }).error, /không hợp lệ/);
  assert.equal(spice.receiveOrder(o, [{ check: 'short', qty: 0 }], { by: 'x', at: T(10) }).patch.items[0].received_qty, 0, 'thiếu hết = 0');
  // Lạ / kiểu cũ vẫn chạy.
  assert.equal(spice.receiveOrder(o, [{ check: 'hack' }], { by: 'x', at: T(10) }).patch.items[0].check, 'ok');
  assert.equal(spice.receiveOrder(o, ['1'], { by: 'x', at: T(10) }).patch.items[0].check, 'short');
  // Nhãn từng dòng (đơn cũ chưa có check: suy ra từ số nhận).
  assert.deepEqual(spice.lineCheck({ qty: 2, received_qty: 3 }), { check: 'over', got: 3, diff: 1, note: '' });
  assert.deepEqual(spice.lineCheck({ qty: 2, received_qty: null }), { check: 'ok', got: 2, diff: 0, note: '' });
});

test('kiểm lại đơn đã nhận (đối soát): giữ ngày nhận, ghi lịch sử, đổi tiền theo số mới', () => {
  const o = fourLines();
  const got = { ...o, ...spice.receiveOrder(o, [], { by: 'Tài', at: T(10) }).patch };
  assert.match(spice.recheckOrder(o, [], { by: 'Lan', at: T(11) }).error, /chưa nhận/);
  const r = spice.recheckOrder(got, [{ check: 'short', qty: 1, note: 'cân lại thiếu' }], { by: 'Lan', at: T(9, 0, 26), note: 'đối soát với chủ gia vị' });
  assert.equal(r.patch.received_date, undefined, 'ngày nhận không đổi');
  assert.equal(r.patch.total, 10000 + 50000 + 30000 + 20000);
  assert.equal(spice.logLine(r.patch.log.at(-1)).text, 'kiểm lại: Muối thiếu 1 kg (gọi 2, nhận 1) · cân lại thiếu · ghi chú: đối soát với chủ gia vị');
  assert.equal(spice.logLine(spice.recheckOrder(got, [], { by: 'Lan', at: T(11) }).patch.log.at(-1)).text, 'kiểm lại: tất cả đủ');
});

test('đối soát từng ngày: món đủ / thiếu / dư / sai, tiền ngày, trả trong ngày, nợ cuối ngày cộng dồn', () => {
  const o1 = fourLines();
  const a = { ...o1, ...spice.receiveOrder(o1, [{ check: 'short', qty: 1 }, { check: 'wrong', note: 'hư' }, null, null], { by: 'Tài', at: T(10, 0, 24), note: 'trễ' }).patch };
  const o2 = { ...fourLines(), id: 'k2', created_at: T(8, 0, 25) };
  const b = { ...o2, ...spice.receiveOrder(o2, [], { by: 'Thy', at: T(9, 0, 25) }).patch };
  const cancelled = { ...fourLines(), id: 'k3', cancelled_at: T(9), received_at: null };
  const pays = [{ supplier_id: SUP, amount: 50000, method: 'cash', paid_date: '2026-11-25', note: 'trả bớt' }, { supplier_id: SUP, amount: 10000, method: 'transfer', paid_date: '2026-11-26' }];
  const days = spice.supplierDays([a, b, cancelled], pays);
  assert.deepEqual(days.map(d => [d.date, d.orders.length, d.total, d.paid, d.balance]), [
    ['2026-11-26', 0, 0, 10000, 60000 + 120000 - 50000 - 10000], ['2026-11-25', 1, 120000, 50000, 60000 + 120000 - 50000], ['2026-11-24', 1, 60000, 0, 60000]]);
  assert.deepEqual(days[2].counts, { short: 1, over: 0, wrong: 1 });
  assert.equal(days[2].orders[0].receive_note, 'trễ');
  assert.deepEqual(days[2].orders[0].lines.map(l => [l.name, l.check, l.got, l.amount]), [['Muối', 'short', 1, 10000], ['Ớt', 'wrong', 0, 0], ['Sả', 'ok', 1, 30000], ['Tỏi', 'ok', 1, 20000]]);
  assert.equal(spice.supplierDays([a, b], pays, { from: '2026-11-25' }).length, 2, 'lọc từ ngày, nợ vẫn tính từ đầu');
  assert.equal(spice.supplierDays([a, b], pays, { from: '2026-11-25' }).at(-1).balance, 130000);
  const text = spice.dayReportText({ supplierName: 'Cô Hai', day: days[2] });
  assert.match(text, /Đối soát gia vị ngày 24\/11\/2026 – Cô Hai/);
  assert.match(text, /➖ Muối: thiếu 1 kg \(gọi 2, nhận 1\) = 10\.000đ/);
  assert.match(text, /⚠️ Ớt: sai hàng: hư/);
  assert.match(text, /✅ Sả: 1 kg đủ = 30\.000đ/);
  assert.match(text, /Ghi chú nhận: trễ/);
  assert.match(text, /Cần đối lại: 1 món thiếu, 1 món sai/);
  assert.match(text, /Quán còn nợ tới hết ngày: 60\.000đ/);
  assert.doesNotMatch(spice.dayReportText({ day: days[2], withMoney: false }), /đ$/m);
});

test('máy chủ: kiểm hàng khi nhận, kiểm lại chỉ quản lý / chủ quán, đối soát cho cả hai bên (nhân viên không thấy nợ)', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff'), tai = adminApi(state, 'staff2'), mgr = adminApi(state, 'manager');
  const sup = (await post(owner, { action: 'save_supplier', name: 'Cô Hai' })).body.supplier;
  const o = (await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Muối', qty: 2, unit: 'kg' }, { name: 'Ớt', qty: 1, unit: 'kg' }] })).body.order;
  await post(owner, { action: 'set_prices', id: o.id, prices: [{ index: 0, price: 10000 }, { index: 1, price: 50000 }] });
  state.now = Date.parse(T(10));
  const bad = await post(tai, { action: 'receive', id: o.id, received: [null, { check: 'wrong' }] });
  assert.equal(bad.status, 400);
  assert.equal(state.spice_orders[0].received_at, undefined, 'báo lỗi thì chưa nhận');
  const got = await post(tai, { action: 'receive', id: o.id, received: [{ check: 'short', qty: '1,5' }, { check: 'wrong', note: 'ớt xanh' }], note: 'giao trễ' });
  assert.equal(got.status, 200);
  assert.equal(got.body.order.total, 15000);
  // Kiểm lại: nhân viên không được, quản lý được.
  assert.equal((await post(thy, { action: 'recheck', id: o.id, received: [] })).status, 403);
  state.now = Date.parse(T(9, 0, 26));
  const re = await post(mgr, { action: 'recheck', id: o.id, received: [{ check: 'short', qty: '1,5' }, { check: 'wrong', qty: 1, note: 'ớt xanh, quán lấy dùng' }], note: 'đã nói với chủ gia vị' });
  assert.equal(re.body.order.total, 65000);
  assert.equal(re.body.order.received_date, '2026-11-25');
  await post(owner, { action: 'pay', supplier_id: sup.id, amount: 20000, paid_date: '2026-11-25' });
  // Chủ quán: thấy trả / nợ. Nhân viên: không.
  const ownDays = (await get(owner, `?days=${sup.id}`)).body.days;
  assert.deepEqual(ownDays.map(d => [d.date, d.total, d.paid, d.balance]), [['2026-11-25', 65000, 20000, 45000]]);
  assert.equal(ownDays[0].orders[0].receive_note, 'đã nói với chủ gia vị');
  const staffDays = (await get(thy, `?days=${sup.id}`)).body.days;
  assert.deepEqual(staffDays.map(d => [d.total, d.paid, d.balance, d.payments.length]), [[65000, 0, null, 0]]);
  assert.equal((await get(thy, '?days=abc')).status, 400);
  // Chủ gia vị thấy cùng số, kèm nhãn từng món.
  const page = (await get(supplierApi(state), `?t=${sup.token}`)).body;
  assert.deepEqual(page.days.map(d => [d.date, d.total, d.balance, d.counts.short, d.counts.wrong]), [['2026-11-25', 65000, 45000, 1, 1]]);
  assert.equal(page.days[0].orders[0].lines[1].note, 'ớt xanh, quán lấy dùng');
  assert.deepEqual(page.orders[0].items.map(l => l.check), ['short', 'wrong']);
  assert.ok(!JSON.stringify(page.payments).includes(sup.id), 'không lộ mã');
});
