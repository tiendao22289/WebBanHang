import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  openChoices, menuLinePrice, refreshSavedCart, customerOrderLines, applyOrderRefusal, cartAfterSentOrder,
} from '../src/lib/draftCart.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

// Trang gọi món (order/page.jsx): giỏ khách theo thực đơn đang bán, xử lý khi máy chủ từ chối đơn
// (submit_customer_order_menu_check.sql), và không tạo đơn thứ hai khi lần gửi trước mất phản hồi.
const NOW = Date.parse('2026-11-04T12:00:00Z');
const LATER = '2026-11-04T22:00:00.000Z';
const LOAI = { name: 'LOẠI', choices: ['Nướng mỡ hành', 'Rang muối', 'Hấp sả'], prices: [120000, 150000, null], hiddenChoices: [true, false, false] };
const THEM = { name: 'THÊM', choices: ['Bánh mì', 'Rau'], prices: [5000, 3000], hiddenChoices: [false, LATER] };
const oc = { id: 'oc', name: 'Ốc hương', price: 0, is_available: true, hidden_until: null, options: [LOAI, THEM] };
const ghe = { id: 'ghe', name: 'Ghẹ rang me', price: 350000, is_available: true, hidden_until: LATER, options: [] };
const bia = { id: 'bia', name: 'Bia', price: 20000, is_available: true, hidden_until: null, options: [] };

test('switched-off choices are skipped, in menu order', () => {
  assert.deepEqual(openChoices(LOAI, NOW), ['Rang muối', 'Hấp sả']);
  assert.deepEqual(openChoices(THEM, NOW), ['Bánh mì']);
  assert.deepEqual(openChoices(THEM, Date.parse(LATER) + 1), ['Bánh mì', 'Rau'], 'a "until" switch-off ends');
});

test('the line price follows the same rule as the server: chosen priced choices, else the dish price', () => {
  assert.deepEqual(menuLinePrice(oc, [{ name: 'LOẠI', choice: 'Rang muối' }, { name: 'THÊM', choice: 'Bánh mì' }], NOW), { price: 155000, off: null });
  assert.deepEqual(menuLinePrice(oc, [{ name: 'LOẠI', choice: 'Hấp sả' }], NOW), { price: 0, off: null }, 'Hấp sả has no price → dish price (theo thời giá)');
  assert.deepEqual(menuLinePrice(oc, [{ name: 'LOẠI', choice: 'Nướng mỡ hành' }], NOW), { price: null, off: 'Nướng mỡ hành' });
  assert.deepEqual(menuLinePrice(oc, [{ name: 'THÊM', choice: 'Bánh mì, Rau' }], NOW), { price: null, off: 'Rau' });
  assert.deepEqual(menuLinePrice(bia, [], NOW), { price: 20000, off: null });
});

test('a reopened saved cart drops dishes and choices switched off since, and takes today\'s prices', () => {
  const saved = [
    { id: 'bia', q: 3, pk: undefined, po: undefined, p: 17000 },
    { id: 'ghe', q: 1, p: 350000 },
    { id: 'oc', q: 2, pk: 'oc-Nướng mỡ hành-', po: [{ name: 'LOẠI', choice: 'Nướng mỡ hành' }], p: 120000 },
    { id: 'oc', q: 1, pk: 'oc-Rang muối-', po: [{ name: 'LOẠI', choice: 'Rang muối' }], p: 150000 },
    { id: 'gone', q: 1, p: 1000 },
  ];
  const { cart, dropped, repriced } = refreshSavedCart(saved, [bia, ghe, oc], NOW);
  assert.deepEqual(cart.map(c => [c.id, c.quantity, c.price]), [['bia', 3, 20000], ['oc', 1, 150000]]);
  assert.deepEqual(dropped, ['Ghẹ rang me', 'Ốc hương', 'Một món']);
  assert.deepEqual(repriced, ['Bia']);
});

test('a refusal removes switched-off lines and refused gifts, updates prices, and says so', () => {
  const cart = [{ ...bia, quantity: 2, price: 17000 }, { ...ghe, quantity: 1, price: 350000 }];
  const gifts = [{ id: 'nuoc', name: 'Nước sâm', price: 0, is_gift: true }];
  const r = applyOrderRefusal(cart, gifts, [
    { index: 0, problem: 'price', price: 20000, name: 'Bia' },
    { index: 1, problem: 'off', name: 'Ghẹ rang me' },
    { index: 2, problem: 'gift', name: 'Nước sâm' },
  ]);
  assert.deepEqual(r.cart.map(c => [c.id, c.price]), [['bia', 20000]]);
  assert.deepEqual(r.gifts, []);
  assert.match(r.message, /hết \/ tạm ngưng.*Ghẹ rang me/);
  assert.match(r.message, /Quà tặng chưa đủ điều kiện.*Nước sâm/);
  assert.match(r.message, /Bia 20\.000đ/);
});

test('after a lost reply only what was not in the first order stays in the cart', () => {
  const first = customerOrderLines([{ ...bia, quantity: 2, price: 20000 }], [{ id: 'nuoc', name: 'Nước sâm' }]);
  const now = [{ ...bia, quantity: 3, price: 20000 }, { ...oc, quantity: 1, price: 150000, _options: [{ name: 'LOẠI', choice: 'Rang muối' }] }];
  const left = cartAfterSentOrder(now, [{ id: 'nuoc', name: 'Nước sâm' }], first);
  assert.deepEqual(left.cart.map(c => [c.id, c.quantity]), [['bia', 1], ['oc', 1]]);
  assert.deepEqual(left.gifts, []);
});

// ── submitOrder của trang gọi món chạy trong vm với DB giả ──
const page = readFileSync(new URL('../src/app/order/page.jsx', import.meta.url), 'utf8');
const submitSource = page.slice(page.indexOf('  async function submitOrder('), page.indexOf('  // Đơn đã vào DB (vừa gửi'));

function orderHarness({ cart, gifts = [], rpc, state = {} }) {
  const calls = [];
  const db = fakeDb({ customers: [], orders: [], ...state });
  db.rpc = async (name, args) => { calls.push(['rpc', args.p_order_id]); return rpc(args, state); };
  const ui = { cart, gifts, alerts: [], finished: [], showCart: null };
  const store = new Map();
  let n = 0;
  const context = {
    cart, giftCart: gifts, submitting: false, submittingRef: { current: false }, promoConfig: { enabled: false },
    availableGiftSlots: 0, giftPromptPending: false, nudgeDismissedRef: { current: true }, notes: {},
    customerPhone: '', customerName: 'Lan', activeTableId: 'table-1', isTakeaway: false, deliveryAddress: '', customerNote: '',
    supabase: db, sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    customerOrderLines, cartAfterSentOrder, applyOrderRefusal, JSON, Array, console: { error() {}, warn() {} },
    newLuckyRequestId: () => `order-${++n}`, bindOrderToDevice: async () => {},
    setGiftPromptPending() {}, setShowGiftModal() {}, setPromoNudge() {}, getAlmostThereSuggestion: () => null,
    setSubmitting() {}, setSubmitSlow() {}, setNotes() {}, setCustomerNote() {},
    setCart: v => { ui.cart = v; }, setGiftCart: v => { ui.gifts = v; }, setShowCart: v => { ui.showCart = v; },
    fetchMenu: async () => calls.push(['fetchMenu']), fetchPreviousOrders: async () => calls.push(['fetchPreviousOrders']),
    finishSentOrder: async (id, left) => ui.finished.push([id, left?.length ?? null]),
    alert: m => ui.alerts.push(m), setTimeout: () => 0, clearTimeout() {},
  };
  const submit = vm.runInNewContext(`(${submitSource.trim()})`, context);
  return { submit, calls, ui, context, store };
}

test('a lost reply then an edited cart shows the first order as sent instead of making a second one', async () => {
  const state = { orders: [] };
  let lose = true;
  const h = orderHarness({
    cart: [{ ...bia, quantity: 2, price: 20000 }], state,
    rpc: async args => {
      state.orders.push({ id: args.p_order_id, table_id: args.p_table_id });
      if (lose) { lose = false; throw new Error('network'); }
      return { data: { order_id: args.p_order_id }, error: null };
    },
  });
  await h.submit();
  assert.deepEqual(h.ui.alerts, ['Có lỗi xảy ra. Vui lòng thử lại.']);
  assert.equal(state.orders.length, 1, 'the first order reached the shop');
  // Khách thêm 1 bia rồi bấm gửi lại: mã đơn mới sẽ tạo bill thứ hai.
  h.context.cart = [{ ...bia, quantity: 3, price: 20000 }];
  await h.submit();
  assert.equal(state.orders.length, 1, 'no second order');
  assert.deepEqual(h.calls.filter(c => c[0] === 'rpc'), [['rpc', 'order-1']]);
  assert.deepEqual(h.ui.finished, [['order-1', 1]], 'the first order is printed / shown as sent');
  assert.deepEqual(h.ui.cart.map(c => [c.id, c.quantity]), [['bia', 1]], 'only the added beer stays in the cart');
  assert.match(h.ui.alerts[1], /Đơn trước của Quý khách đã tới quán/);
});

test('a refused order updates the cart, reloads the menu and tells the customer, nothing is shown as sent', async () => {
  const h = orderHarness({
    cart: [{ ...bia, quantity: 2, price: 17000 }, { ...ghe, quantity: 1, price: 350000 }],
    rpc: async () => ({ data: { rejected: true, reason: 'item_off', order_id: null, lines: [
      { index: 0, problem: 'price', price: 20000, name: 'Bia' }, { index: 1, problem: 'off', name: 'Ghẹ rang me' }] }, error: null }),
  });
  await h.submit();
  assert.deepEqual(h.ui.finished, []);
  assert.deepEqual(h.ui.cart.map(c => [c.id, c.price]), [['bia', 20000]]);
  assert.equal(h.ui.showCart, true);
  assert.ok(h.calls.some(c => c[0] === 'fetchMenu'));
  assert.match(h.ui.alerts[0], /Ghẹ rang me/);
  assert.equal(h.store.size, 0, 'the refused code is forgotten');
});

test('switched-off LOẠI choices are skipped by the choice window, quick search, "ghi nhiều món" and the wheel gift picker', () => {
  const addToCart = page.slice(page.indexOf('  function addToCart(item) {'), page.indexOf('  // Bấm gợi ý ở thanh tìm'));
  assert.match(addToCart, /const first = openChoices\(opt\)\[0\];/);
  assert.doesNotMatch(addToCart, /opt\.choices\[0\]/);
  const quick = page.slice(page.indexOf('  function getQuickSuggestions('), page.indexOf('  // Thêm nhanh 1 món đã xác định LOẠI'));
  assert.match(quick, /const loaiOpen = openChoices\(loaiOpt\);/);
  assert.doesNotMatch(quick, /loaiOpt\.choices\.map/);
  const batch = page.slice(page.indexOf('  function matchOneLine('), page.indexOf('  // Tách số lượng khỏi dòng'));
  assert.doesNotMatch(batch, /loaiOpt\.choices\.map/);
  assert.match(page, /\{openChoices\(loaiOpt\)\.map\(\(c, ci\) => <option key=\{ci\} value=\{c\}>\{c\}<\/option>\)\}/);
  assert.match(page, /init\[opt\.name\] = openChoices\(opt\)\[0\] \?\? '';/, 'the 8-for-1 gift window');
  assert.match(page, /\{openChoices\(opt\)\.map\(choice => \{/, 'the wheel gift picker');
});
