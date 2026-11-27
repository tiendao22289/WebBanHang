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
  assert.deepEqual(mine, { delivered: 93000, paid: 50000, cash: 50000, owed: 43000, open: 1, waitingPrice: 1 });
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
  // Món lần đầu có giá rồi trong cùng ngày đổi giá: vẫn thấy ▲ so với giá đầu ngày; một lần duy nhất thì không có ▲▼.
  const fresh = [
    { supplier_id: SUP, received_at: '2026-11-27T03:00:00Z', items: [{ name: 'Ớt', qty: 1, price: 60000, old_price: null }] },
    { supplier_id: SUP, received_at: '2026-11-27T05:00:00Z', items: [{ name: 'Ớt', qty: 1, price: 70000, old_price: 60000 }, { name: 'Sả', qty: 1, price: 25000, old_price: null }] },
  ];
  const day = spice.spiceStats(fresh, { period: 'day' })[0];
  assert.equal(day.items.find(i => i.name === 'Ớt').change, 10000);
  assert.equal(day.items.find(i => i.name === 'Sả').change, 0);
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
  assert.deepEqual(state.spice_items, [], 'món nhân viên gõ không tự vào danh sách (danh sách do chủ quán quyết)');

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
  assert.deepEqual(after.summary, { delivered: 79000, paid: 0, cash: 0, owed: 79000, open: 0, waitingPrice: 0 });

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
  assert.equal((await post(owner, { action: 'save_item', name: 'Ớt' })).status, 200);
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

test('tìm món không dấu, số mặc định mỗi lần bấm, đúng thứ tự chủ quán xếp', () => {
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
  const ranked = spice.rankItems(items, orders, SUP);
  assert.deepEqual(ranked.map(i => i.name), ['Muối', 'Đường', 'Sả'], 'thứ tự chủ quán, không theo số lần gọi');
  assert.deepEqual(ranked.map(i => i.uses), [0, 2, 3]);
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

test('chủ quán xếp món: lên / xuống, đánh số lại khi sort trùng', () => {
  const items = [{ id: 'a', name: 'Muối', sort: 1 }, { id: 'b', name: 'Đường', sort: 2 }, { id: 'c', name: 'Sả', sort: 3 }];
  assert.deepEqual(spice.moveItem(items, 'c', -1), [{ id: 'c', sort: 2 }, { id: 'b', sort: 3 }]);
  assert.deepEqual(spice.moveItem(items, 'a', -1), [], 'đầu danh sách thì không lên được');
  assert.deepEqual(spice.moveItem(items, 'c', 1), []);
  assert.deepEqual(spice.moveItem(items, 'x', 1), []);
  // Món cũ sort = 0 cả: đánh số lại theo tên rồi đổi chỗ.
  const flat = [{ id: 'a', name: 'Muối', sort: 0 }, { id: 'b', name: 'Bơ', sort: 0 }, { id: 'c', name: 'Ớt', sort: 0 }];
  const ch = spice.moveItem(flat, 'c', -1);
  const after = spice.orderedItems(flat.map(i => ({ ...i, sort: ch.find(c => c.id === i.id)?.sort ?? i.sort })));
  assert.deepEqual(after.map(i => i.name), ['Bơ', 'Ớt', 'Muối']);
  assert.equal(spice.itemLineText({ name: 'Tiêu xay', default_qty: 0.5, unit: 'kg' }), 'Tiêu xay 0,5 kg');
  assert.equal(spice.itemLineText({ name: 'Muối', default_qty: null, unit: 'kg' }), 'Muối 1 kg');
  assert.equal(spice.itemLineText({ name: 'Rau răm', default_qty: null, unit: null }), 'Rau răm');
  // Chữ của danh sách đọc lại ra đúng món.
  for (const it of [{ name: 'Tiêu xay', default_qty: 0.5, unit: 'kg' }, { name: 'Nước mắm Phú Quốc', default_qty: 2, unit: 'chai' }, { name: 'Sả', default_qty: null, unit: null }]) {
    const [back] = spice.parseItemLines(spice.itemLineText(it));
    assert.equal(back.name, it.name);
    assert.equal(back.unit || null, it.unit);
  }
});

test('sửa cả danh sách bằng chữ: đúng thứ tự dòng, sửa số / đơn vị, xoá món không còn, thêm món mới', () => {
  const old = [
    { id: 'a', name: 'Muối', unit: 'kg', default_qty: 1, sort: 1, active: true },
    { id: 'b', name: 'Đường', unit: 'kg', default_qty: 2, sort: 2, active: true },
    { id: 'c', name: 'Bơ', unit: 'hộp', default_qty: null, sort: 3, active: false },
  ];
  const plan = spice.planItemList(old, 'đường 2 kg\nMuối 1 kg\nỚt hiểm 0,5 kg');
  assert.deepEqual(plan.deletes, ['c']);
  assert.deepEqual(plan.inserts, [{ name: 'Ớt hiểm', unit: 'kg', default_qty: 0.5, sort: 3, active: true }]);
  assert.deepEqual(plan.updates, [
    { id: 'b', patch: { name: 'đường', unit: 'kg', default_qty: 2, sort: 1, active: true } },
    { id: 'a', patch: { name: 'Muối', unit: 'kg', default_qty: 1, sort: 2, active: true } },
  ]);
  // Không đổi gì thì không ghi gì.
  assert.deepEqual(spice.planItemList(old.slice(0, 2), 'Muối 1 kg\nĐường 2 kg'), { updates: [], inserts: [], deletes: [] });
  assert.match(spice.planItemList(old, '  \n').error, /trống/);
});

test('máy chủ: chủ quán sửa cả danh sách, xếp, xoá món; nhân viên không làm được; nhân viên thấy đúng thứ tự', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff');
  state.spice_items.push(
    { id: '00000000-0000-4000-8000-0000000000a1', name: 'Muối', unit: 'kg', default_qty: 1, sort: 1, active: true },
    { id: '00000000-0000-4000-8000-0000000000a2', name: 'Bột ngọt', unit: 'kg', default_qty: 1, sort: 2, active: true },
    { id: '00000000-0000-4000-8000-0000000000a3', name: 'Đường', unit: 'kg', default_qty: 2, sort: 3, active: true },
  );
  for (const body of [{ action: 'replace_items', text: 'Ớt 1 kg' }, { action: 'move_item', id: state.spice_items[0].id, dir: 1 }, { action: 'delete_item', id: state.spice_items[0].id }]) {
    assert.equal((await post(thy, body)).status, 403);
  }
  const r = await post(owner, { action: 'replace_items', text: 'Đường 3 kg\nMuối 1 kg\nSa tế 2 hũ' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.total, r.body.added, r.body.removed], [3, 1, 1]);
  const names = async api => (await get(api)).body.items.sort((a, b) => a.sort - b.sort).map(i => `${i.name} ${i.default_qty} ${i.unit}`);
  assert.deepEqual(await names(thy), ['Đường 3 kg', 'Muối 1 kg', 'Sa tế 2 hũ']);
  const sate = state.spice_items.find(i => i.name === 'Sa tế');
  assert.equal((await post(owner, { action: 'move_item', id: sate.id, dir: -1 })).status, 200);
  assert.deepEqual((await names(thy)).map(n => n.split(' ')[0]), ['Đường', 'Sa', 'Muối']);
  // Món mới thêm từng món vào cuối danh sách.
  await post(owner, { action: 'save_item', name: 'Gừng', unit: 'kg', default_qty: '0,5'.replace(',', '.') });
  assert.equal((await names(thy)).at(-1), 'Gừng 0.5 kg');
  assert.equal((await post(owner, { action: 'delete_item', id: sate.id })).status, 200);
  assert.equal((await post(owner, { action: 'delete_item', id: sate.id })).status, 404);
  assert.equal((await post(owner, { action: 'delete_item', id: 'abc' })).status, 400);
  assert.ok(!state.spice_items.some(i => i.name === 'Sa tế'));
  assert.match((await post(owner, { action: 'replace_items', text: '' })).body.error, /trống/);
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
  assert.deepEqual(days[2].counts, { short: 1, over: 0, wrong: 1, skip: 0 });
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

/* ---------------- Chủ gia vị tự thêm món, quán Không lấy, chủ gia vị đánh dấu đã / chưa thanh toán ---------------- */

test('chủ gia vị tự thêm món: đánh dấu by_supplier, giá chủ gia vị ghi, đơn đã nhận thì khoá; quán Không lấy được', () => {
  const order = { id: 'o1', created_at: T(8), items: [{ name: 'Muối', unit: 'kg', qty: 1, price: 12000, old_price: 12000 }], log: [] };
  const last = new Map([['sả', { price: 25000 }]]);
  const r = spice.supplierAddLines(order, [{ name: 'Sả', qty: '2', unit: 'kg' }, { name: 'Gừng', qty: '0.5', unit: 'kg', price: '40.000' }], { last, by: 'Cô Hai', at: T(9) });
  assert.deepEqual(r.lines.map(l => [l.name, l.price, l.by_supplier, l.price_by ?? null]), [['Sả', 25000, true, null], ['Gừng', 40000, true, 'supplier']]);
  assert.equal(r.patch.total, 12000 + 50000 + 20000);
  assert.deepEqual(r.patch.log.at(-1), { at: T(9), by: 'Cô Hai', who: 'supplier', type: 'add', items: [{ name: 'Sả', qty: 2, unit: 'kg' }, { name: 'Gừng', qty: 0.5, unit: 'kg' }] });
  assert.match(spice.supplierAddLines(order, [{ name: 'muối', qty: 1 }], { by: 'x', at: T(9) }).error, /đã có/);
  assert.match(spice.supplierAddLines({ ...order, received_at: T(10) }, [{ name: 'Ớt', qty: 1 }], { by: 'x', at: T(9) }).error, /đã nhận/);
  assert.match(spice.supplierAddLines(order, [{ name: 'Ớt', qty: 1, price: 'abc' }], { by: 'x', at: T(9) }).error, /Giá/);
  // Quán nhận: Không lấy Sả (chủ gia vị thêm) → 0đ; món quán gọi thì không chọn Không lấy được.
  const withAdd = { ...order, ...r.patch };
  const got = spice.receiveOrder(withAdd, [null, { check: 'skip' }, null], { by: 'Thy', at: T(11) });
  assert.equal(got.patch.total, 12000 + 20000);
  assert.equal(spice.lineCheck(got.patch.items[1]).check, 'skip');
  assert.match(spice.logLine(got.patch.log.at(-1)).text, /Sả không lấy/);
  assert.match(spice.receiveOrder(withAdd, [{ check: 'skip' }], { by: 'Thy', at: T(11) }).error, /Thiếu/);
  const days = spice.supplierDays([{ ...withAdd, ...got.patch }], [], {});
  assert.equal(days[0].counts.skip, 1);
  assert.equal(days[0].orders[0].lines[1].by_supplier, true);
  assert.match(spice.dayReportText({ day: days[0] }), /không lấy 1 món/);
});

test('thống kê quán ghi món chủ gia vị tự thêm và chủ gia vị sửa giá', () => {
  const orders = [{ supplier_id: SUP, received_at: T(9), items: [
    { name: 'Ớt', qty: 1, price: 70000, old_price: 60000, price_by: 'supplier' },
    { name: 'Sả', qty: 2, price: 25000, old_price: null, by_supplier: true },
    { name: 'Muối', qty: 1, price: 12000, old_price: 12000, price_by: 'supplier' },
  ] }];
  const items = spice.spiceStats(orders, { period: 'day' })[0].items;
  const by = n => items.find(i => i.name === n);
  assert.deepEqual([by('Ớt').supplierEdits, by('Ớt').supplierAdded], [1, 0]);
  assert.deepEqual([by('Sả').supplierEdits, by('Sả').supplierAdded], [0, 2]);
  assert.equal(by('Sả').supplierOffered, 2);
  const skipped = spice.spiceStats([{ received_at: T(9), items: [{ name: 'Chanh', qty: 1, received_qty: 0, check: 'skip', price: 30000, by_supplier: true }] }])[0].items[0];
  assert.deepEqual([skipped.supplierOffered, skipped.supplierAdded], [1, 0]);
  assert.equal(by('Muối').supplierEdits, 0, 'giá giữ nguyên thì không tính là sửa');
  const priced = spice.applyPrices({ items: [{ name: 'Ớt', qty: 1, price: 60000 }], log: [] }, [{ index: 0, price: 65000 }], { by: 'Chủ quán', at: T(9), who: 'admin' });
  assert.equal(priced.patch.items[0].price_by, 'admin');
});

test('chủ gia vị đánh dấu đã / chưa thanh toán, lọc theo đó và theo tháng, số lượng từng món', () => {
  const o = { id: 'o1', received_at: T(10), items: [], log: [] };
  const paid = spice.setSupplierPaid(o, true, { by: 'Cô Hai', at: T(12) });
  assert.equal(paid.patch.supplier_paid_at, T(12));
  assert.equal(spice.logLine(paid.patch.log[0]).text, 'đánh dấu đã nhận tiền đơn này');
  assert.equal(spice.setSupplierPaid({ ...o, supplier_paid_at: T(12) }, true, { by: 'x', at: T(13) }).patch, null);
  assert.equal(spice.setSupplierPaid({ ...o, supplier_paid_at: T(12) }, false, { by: 'x', at: T(13) }).patch.supplier_paid_at, null);
  assert.match(spice.setSupplierPaid({ id: 'o2', items: [] }, true, { by: 'x', at: T(13) }).error, /chưa nhận/);
  const list = [
    { id: 'a', received_at: T(10, 0, 3), received_date: '2026-11-03', supplier_paid_at: T(12), items: [{ name: 'Muối', unit: 'kg', qty: 2, price: 10000 }] },
    { id: 'b', received_at: T(10, 0, 20), received_date: '2026-11-20', items: [{ name: 'Muối', unit: 'kg', qty: 1, price: 10000 }, { name: 'Sả', unit: 'kg', qty: 2, received_qty: 0, check: 'skip', price: 25000 }] },
    { id: 'c', received_at: '2026-10-30T03:00:00Z', received_date: '2026-10-30', items: [{ name: 'Ớt', unit: 'kg', qty: 1, price: 60000 }] },
    { id: 'd', items: [{ name: 'Ớt', qty: 1, price: 1 }] },
    { id: 'e', received_at: T(10), cancelled_at: T(11), items: [{ name: 'Ớt', qty: 1, price: 1 }] },
  ];
  const all = spice.supplierOrderStats(list);
  assert.deepEqual([all.count, all.total, all.paid.total, all.unpaid.total], [3, 90000, 20000, 70000]);
  assert.deepEqual(all.orders.map(x => x.id), ['b', 'a', 'c']);
  const unpaidNov = spice.supplierOrderStats(list, { paid: 'unpaid', from: '2026-11-01', to: '2026-11-31' });
  assert.deepEqual([unpaidNov.count, unpaidNov.total], [1, 10000]);
  assert.deepEqual(unpaidNov.items, [{ name: 'Muối', unit: 'kg', qty: 1, amount: 10000, orders: 1 }], 'món Không lấy không tính số lượng');
  const novAll = spice.supplierOrderStats(list, { from: '2026-11-01', to: '2026-11-31' });
  assert.deepEqual(novAll.items.map(i => [i.name, i.qty, i.orders]), [['Muối', 3, 2]]);
});

test('máy chủ: chủ gia vị thêm món qua link, quán Không lấy, chủ gia vị đánh dấu đã thanh toán', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff'), supplier = supplierApi(state);
  const sup = (await post(owner, { action: 'save_supplier', name: 'Cô Hai' })).body.supplier;
  const order = (await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Muối', qty: 1, unit: 'kg' }] })).body.order;
  const added = await post(supplier, { t: sup.token, id: order.id, updated_at: order.updated_at, add: [{ name: 'Sả', qty: '1', unit: 'kg', price: '25000' }] });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.order.items.map(l => [l.name, !!l.by_supplier]), [['Muối', false], ['Sả', true]]);
  // Đơn chưa nhận thì chưa đánh dấu tiền được.
  assert.match((await post(supplier, { t: sup.token, id: order.id, paid: true })).body.error, /chưa nhận/);
  const cur = state.spice_orders[0];
  assert.equal((await post(thy, { action: 'receive', id: cur.id, updated_at: cur.updated_at, received: [null, { check: 'skip' }] })).status, 200);
  assert.equal(state.spice_orders[0].total, 0, 'Muối chưa có giá, Sả không lấy');
  // Thêm món sau khi nhận: khoá.
  assert.match((await post(supplier, { t: sup.token, id: order.id, add: [{ name: 'Ớt', qty: 1 }] })).body.error, /đã nhận/);
  assert.equal((await post(supplier, { t: sup.token, id: order.id, paid: true })).status, 200);
  const page = (await get(supplier, `?t=${sup.token}`)).body;
  assert.equal(page.history.length, 1);
  assert.ok(page.history[0].supplier_paid_at);
  assert.equal(page.orders[0].supplier_paid_at, page.history[0].supplier_paid_at);
  assert.ok(!('created_by' in page.history[0]));
  // Quán thấy dấu đã thanh toán và lịch sử.
  const seen = (await get(owner)).body.orders[0];
  assert.ok(seen.supplier_paid_at);
  assert.deepEqual(seen.log.filter(e => e.who === 'supplier').map(e => e.type), ['add', 'paid']);
  assert.equal((await post(supplier, { t: sup.token, id: order.id, paid: false })).status, 200);
  assert.equal(state.spice_orders[0].supplier_paid_at, null);
});

test('chủ quán huỷ đơn đã nhận (đơn thử / nhận nhầm): bắt buộc lý do, ra khỏi sổ, công nợ, thống kê, đối soát', async () => {
  const o = { id: 'o1', supplier_id: SUP, received_at: T(10), received_date: '2026-11-25', items: [{ name: 'Muối', qty: 2, price: 10000 }], log: [] };
  assert.match(spice.cancelOrder(o, { by: 'Chủ quán', at: T(11), owner: true }).error, /lý do/);
  const r = spice.cancelOrder(o, { by: 'Chủ quán', at: T(11), owner: true, reason: 'đơn thử' });
  const after = { ...o, ...r.patch };
  assert.equal(after.cancelled_at, T(11));
  assert.equal(after.received_at, T(10), 'giữ giờ nhận để xem lại');
  assert.match(spice.logLine(after.log.at(-1)).text, /huỷ đơn đã nhận \(20\.000đ ra khỏi sổ và công nợ\) · ghi chú: đơn thử/);
  assert.equal(after.log.at(-1).who, 'admin');
  assert.equal(spice.orderState(after), 'cancelled');
  assert.deepEqual(spice.spiceCostByDay([after]), {});
  assert.equal(spice.supplierSummary([after], []).delivered, 0);
  assert.deepEqual(spice.supplierDays([after], [], {}), []);
  assert.equal(spice.spiceStats([after]).length, 0);
  assert.equal(spice.supplierOrderStats([after]).count, 0);

  // Máy chủ: nhân viên / quản lý không huỷ được đơn đã nhận; chủ quán được, phải có lý do.
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff'), mgr = adminApi(state, 'manager');
  const sup = (await post(owner, { action: 'save_supplier', name: 'Đào' })).body.supplier;
  const order = (await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Muối', qty: 1 }] })).body.order;
  await post(thy, { action: 'receive', id: order.id, updated_at: order.updated_at, received: [] });
  assert.equal((await post(thy, { action: 'cancel', id: order.id, reason: 'x' })).status, 403);
  assert.equal((await post(mgr, { action: 'cancel', id: order.id, reason: 'x' })).status, 403);
  assert.match((await post(owner, { action: 'cancel', id: order.id })).body.error, /lý do/);
  const ok = await post(owner, { action: 'cancel', id: order.id, reason: 'đơn thử' });
  assert.equal(ok.status, 200);
  assert.ok(state.spice_orders[0].cancelled_at);
  assert.equal((await get(owner)).body.balances?.[sup.id]?.debt ?? 0, 0);
});

test('thống kê chủ gia vị: mục Đã huỷ riêng, không tính vào đã / chưa thanh toán', () => {
  const list = [
    { id: 'a', received_at: T(10), received_date: '2026-11-25', items: [{ name: 'Muối', qty: 1, price: 10000 }] },
    { id: 'b', received_at: T(10), received_date: '2026-11-25', cancelled_at: T(12), items: [{ name: 'Ớt', qty: 1, price: 50000 }] },
    { id: 'c', created_at: T(9), cancelled_at: T(9, 30), items: [{ name: 'Sả', qty: 2, price: null }] },
  ];
  const all = spice.supplierOrderStats(list);
  assert.deepEqual([all.count, all.unpaid.count, all.cancelled.count, all.cancelled.total], [1, 1, 2, 50000]);
  const cx = spice.supplierOrderStats(list, { paid: 'cancelled' });
  assert.deepEqual(cx.orders.map(o => o.id), ['b', 'c']);
});

test('máy chủ: chủ gia vị tích nhiều đơn rồi đánh dấu đã thanh toán một lần', async () => {
  const state = newState();
  const owner = adminApi(state, 'admin'), thy = adminApi(state, 'staff'), supplier = supplierApi(state);
  const sup = (await post(owner, { action: 'save_supplier', name: 'Cô Hai' })).body.supplier;
  const other = (await post(owner, { action: 'save_supplier', name: 'Chú Ba' })).body.supplier;
  const make = async s => {
    const o = (await post(thy, { action: 'create', supplier_id: s.id, lines: [{ name: 'Muối', qty: 1 }] })).body.order;
    await post(thy, { action: 'receive', id: o.id, updated_at: o.updated_at, received: [] });
    return o.id;
  };
  const a = await make(sup), b = await make(sup), mine = await make(other);
  const open = (await post(thy, { action: 'create', supplier_id: sup.id, lines: [{ name: 'Ớt', qty: 1 }] })).body.order.id;
  const r = await post(supplier, { t: sup.token, ids: [a, b, mine, open, 'xx'], paid: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, 2, 'chỉ đơn đã nhận của chính chủ gia vị này');
  const byId = id => state.spice_orders.find(o => o.id === id);
  assert.ok(byId(a).supplier_paid_at && byId(b).supplier_paid_at);
  assert.equal(byId(mine).supplier_paid_at ?? null, null);
  assert.equal(byId(open).supplier_paid_at ?? null, null);
  assert.equal((await post(supplier, { t: sup.token, ids: [a], paid: false })).body.changed, 1);
  assert.match((await post(supplier, { t: sup.token, ids: [], paid: true })).body.error, /Chưa chọn/);
});

test('đối chiếu tiền: chủ gia vị bấm Đã TT là hết nợ đơn đó; quán ghi trả trừ đơn cũ trước, không trừ hai lần', () => {
  const o = (id, h, total, paidAt = null) => ({ id, supplier_id: SUP, received_at: T(h), received_date: '2026-11-25', supplier_paid_at: paidAt, items: [{ name: 'Muối', qty: 1, price: total }] });
  const A = o('a', 8, 100000), B = o('b', 9, 100000), C = o('c', 10, 100000);
  // 1. Chỉ chủ gia vị bấm Đã TT (quán chưa ghi trả): nợ giảm đúng đơn đó.
  assert.equal(spice.settleOrders([A, { ...B, supplier_paid_at: T(12) }, C], []).owed, 200000);
  // 2. Bấm Đã TT hết → về 0 (đúng như trên ảnh của chủ quán).
  const allMarked = [A, B, C].map(x => ({ ...x, supplier_paid_at: T(12) }));
  assert.equal(spice.supplierSummary(allMarked, []).owed, 0);
  assert.equal(spice.supplierSummary(allMarked, []).paid, 300000);
  // 3. Quán ghi trả 200k (phủ A, B) và chủ gia vị cũng bấm Đã TT A, B → còn đúng C, không trừ hai lần.
  const pay200 = [{ supplier_id: SUP, amount: 200000, paid_date: '2026-11-25' }];
  assert.equal(spice.settleOrders([{ ...A, supplier_paid_at: T(12) }, { ...B, supplier_paid_at: T(12) }, C], pay200).owed, 100000);
  // 4. Quán ghi trả 200k, chủ gia vị chưa bấm gì → A, B tự thành đã thanh toán.
  const st = spice.settleOrders([A, B, C], pay200);
  assert.deepEqual([...st.byOrder.values()].map(x => x.paid), [true, true, false]);
  assert.equal(st.owed, 100000);
  // 5. Trả lẻ 150k: A đủ, B còn 50k.
  const st2 = spice.settleOrders([A, B], [{ supplier_id: SUP, amount: 150000, paid_date: '2026-11-25' }]);
  assert.deepEqual([...st2.byOrder.values()].map(x => [x.paid, x.left]), [[true, 0], [false, 50000]]);
  // 6. Trả dư → nợ âm (quán trả dư).
  assert.equal(spice.settleOrders([A], [{ supplier_id: SUP, amount: 120000, paid_date: '2026-11-25' }]).owed, -20000);
  // 7. Công nợ của chủ quán, thống kê chủ gia vị, đối soát cuối ngày, sổ đều cùng số.
  const list = [A, { ...B, supplier_paid_at: T(12) }, C];
  assert.equal(spice.supplierBalances(list, [])[SUP].debt, 200000);
  const stats = spice.supplierOrderStats(list, { payments: [] });
  assert.deepEqual([stats.paid.total, stats.unpaid.total], [100000, 200000]);
  assert.equal(spice.supplierDays(list, [], {})[0].balance, 200000);
  assert.equal(spice.spiceDayData({ orders: list, payments: [], date: '2026-11-25' }).debt, 200000);
  // Đơn bấm Đã TT sau ngày đó thì nợ cuối ngày hôm trước chưa trừ.
  const later = [{ ...A, supplier_paid_at: '2026-11-26T03:00:00Z' }];
  assert.equal(spice.spiceDayData({ orders: later, payments: [], date: '2026-11-25' }).debt, 100000);
  assert.equal(spice.spiceDayData({ orders: later, payments: [], date: '2026-11-26' }).debt, 0);
  // Đơn chưa có giá (0đ) không tính là đã thanh toán.
  assert.equal(spice.settleOrders([o('z', 8, null)], []).byOrder.get('z').paid, false);
});
