import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  openChoices, menuLinePrice, refreshSavedCart, customerOrderLines, applyOrderRefusal, cartAfterSentOrder,
  initialOptionSelection, isMultiOption, multiChoices, toggleMultiChoice, selectionToItemOptions,
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
  const comma = { ...oc, options: [{ name: 'THÊM', choices: ['Bánh mì', 'Rau, giá'], prices: [5000, 4000], hiddenChoices: [] }] };
  assert.deepEqual(menuLinePrice(comma, [{ name: 'THÊM', choice: 'Rau, giá, Bánh mì' }], NOW), { price: 9000, off: null }, 'a choice name with a comma');
  assert.deepEqual(menuLinePrice(comma, [{ name: 'THÊM', choice: 'Bánh mì, Ớt' }], NOW), { price: null, off: 'Ớt' });
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
    reportCartNow: (c, g) => calls.push(['reportCartNow', c.map(x => [x.id, x.quantity]), g.length]),
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
  assert.deepEqual(h.calls.filter(c => c[0] === 'reportCartNow'), [['reportCartNow', [['bia', 1]], 0]],
    'trang Bàn biết ngay phần giỏ còn lại (bàn thôi chớp "quên gửi" cho phần đã vào quán)');
  assert.deepEqual(h.ui.cart.map(c => [c.id, c.quantity]), [['bia', 1]], 'only the added beer stays in the cart');
  assert.match(h.ui.alerts[1], /Đơn trước của Quý khách đã tới quán/);
});

test('a saved order tells the Bàn page "cart empty" at once, before the cart clears and the kitchen ticket prints', async () => {
  const order = [];
  const h = orderHarness({
    cart: [{ ...bia, quantity: 2, price: 20000 }],
    rpc: async args => ({ data: { order_id: args.p_order_id }, error: null }),
  });
  h.context.reportCartNow = (c, g) => order.push(['report', c.length, g.length]);
  h.context.setCart = v => { order.push(['setCart', v.length]); h.ui.cart = v; };
  h.context.finishSentOrder = async id => order.push(['finish', id]);
  await h.submit();
  assert.deepEqual(h.ui.alerts, []);
  assert.deepEqual(order, [['report', 0, 0], ['setCart', 0], ['finish', 'order-1']]);
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
  assert.match(addToCart, /const init = initialOptionSelection\(item\.options\);/);
  assert.doesNotMatch(addToCart, /opt\.choices\[0\]/);
  const quick = page.slice(page.indexOf('  function getQuickSuggestions('), page.indexOf('  // Thêm nhanh 1 món đã xác định LOẠI'));
  assert.match(quick, /const loaiOpen = openChoices\(loaiOpt\);/);
  assert.doesNotMatch(quick, /loaiOpt\.choices\.map/);
  const batch = page.slice(page.indexOf('  function matchOneLine('), page.indexOf('  // Tách số lượng khỏi dòng'));
  assert.doesNotMatch(batch, /loaiOpt\.choices\.map/);
  assert.match(page, /\{openChoices\(loaiOpt\)\.map\(\(c, ci\) => <option key=\{ci\} value=\{c\}>\{c\}<\/option>\)\}/);
  assert.match(page, /setSelectedOpts\(initialOptionSelection\(g\.options\)\);/, 'the 8-for-1 gift window');
  assert.match(page, /\{openChoices\(opt\)\.map\(choice => \{/, 'the wheel gift picker');
});

// ── Bảng chọn món quà "8 tặng 1" (báo lỗi bàn 10: đủ món tặng, bấm chọn quà thì báo "món đã hết") ──
// Mọi món tặng của quán có LOẠI (chọn 1) + KHẨU VỊ (chọn nhiều). Bảng quà từng đặt sẵn KHẨU VỊ bằng
// chữ "Bình Thường" thay vì mảng → khách bấm thêm 1 khẩu vị thì chữ bị tách từng ký tự, máy chủ không
// thấy lựa chọn "B" trong thực đơn và trả "Món đã hết / tạm ngưng". Khách không bấm khẩu vị thì gửi được.
const KHAU_VI = { name: 'KHẨU VỊ', choices: ['Bình Thường', 'Làm Cay', 'Không Cay'], prices: [null, null, null], hiddenChoices: [false, false, false] };
const ocMon = { id: 'oc-mon', name: 'Ốc Môn', price: 50000, is_available: true, hidden_until: null, is_gift_item: true,
  options: [{ name: 'LOẠI', choices: ['Nướng mỡ hành', 'Nướng phô mai'], prices: [50000, 50000], hiddenChoices: [true, false] }, KHAU_VI] };

test('the choice window starts with the first open LOẠI and no taste ticked — for gifts the same as for dishes', () => {
  assert.equal(isMultiOption(KHAU_VI), true);
  assert.equal(isMultiOption({ name: 'Thêm topping' }), true);
  assert.equal(isMultiOption(LOAI), false);
  assert.deepEqual(initialOptionSelection(ocMon.options, NOW), { 'LOẠI': 'Nướng phô mai', 'KHẨU VỊ': [] });
  assert.deepEqual(initialOptionSelection(oc.options, NOW), { 'LOẠI': 'Rang muối', 'THÊM': [] });
  const allOff = [{ name: 'LOẠI', choices: ['A'], hiddenChoices: [true] }, { name: 'ghi', choices: [] }, { choices: ['x'] }];
  assert.deepEqual(initialOptionSelection(allOff, NOW), { 'LOẠI': '' }, 'every LOẠI off → "" (window says tạm hết)');
});

test('ticking tastes on a gift sends real choices the server accepts', () => {
  let sel = initialOptionSelection(ocMon.options, NOW);
  sel = { ...sel, 'KHẨU VỊ': toggleMultiChoice(sel['KHẨU VỊ'], 'Làm Cay') };
  sel = { ...sel, 'KHẨU VỊ': toggleMultiChoice(sel['KHẨU VỊ'], 'Không Cay') };
  sel = { ...sel, 'KHẨU VỊ': toggleMultiChoice(sel['KHẨU VỊ'], 'Làm Cay') };
  const opts = selectionToItemOptions(sel);
  assert.deepEqual(opts, [{ name: 'LOẠI', choice: 'Nướng phô mai' }, { name: 'KHẨU VỊ', choice: 'Không Cay' }]);
  const [line] = customerOrderLines([], [{ id: ocMon.id, name: ocMon.name, price: 0, is_gift: true, _options: opts }]);
  assert.equal(line.is_gift, true);
  assert.deepEqual(menuLinePrice(ocMon, line.item_options, NOW).off, null, 'no "hết" refusal');
  assert.deepEqual(selectionToItemOptions({ 'LOẠI': 'Nướng phô mai', 'KHẨU VỊ': [] }), [{ name: 'LOẠI', choice: 'Nướng phô mai' }]);
});

test('a taste kept as text (the old gift window) is one ticked choice, never split into letters', () => {
  assert.deepEqual(multiChoices('Bình Thường'), ['Bình Thường']);
  assert.deepEqual(multiChoices(undefined), []);
  assert.deepEqual(toggleMultiChoice('Bình Thường', 'Làm Cay'), ['Bình Thường', 'Làm Cay']);
  assert.deepEqual(toggleMultiChoice('Bình Thường', 'Bình Thường'), [], 'untick works (used to throw: string has no .filter)');
  // Cái lỗi cũ: [...'Bình Thường', 'Làm Cay'] → máy chủ không thấy lựa chọn "B".
  const old = [...'Bình Thường', 'Làm Cay'].join(', ');
  assert.deepEqual(menuLinePrice(ocMon, [{ name: 'KHẨU VỊ', choice: old }], NOW), { price: null, off: 'B' });
  const fixed = toggleMultiChoice('Bình Thường', 'Làm Cay').join(', ');
  assert.deepEqual(menuLinePrice(ocMon, [{ name: 'KHẨU VỊ', choice: fixed }], NOW).off, null);
});

test('the gift window and the dish window both open through initialOptionSelection and tick tastes with toggleMultiChoice', () => {
  const gift = page.slice(page.indexOf('co-gift-add'), page.indexOf('{addedQty > 0 ? \'+ Thêm\' : \'Chọn\'}'));
  assert.match(gift, /setIsGiftMode\(true\)/);
  assert.match(gift, /setSelectedOpts\(initialOptionSelection\(g\.options\)\)/);
  assert.doesNotMatch(gift, /openChoices\(opt\)\[0\]/, 'no hand-made start selection');
  assert.match(page, /\[opt\.name\]: toggleMultiChoice\(selectedOpts\[opt\.name\], choice\)/);
  assert.doesNotMatch(page, /\[\.\.\.currentArr, choice\]/, 'no spreading of the stored taste');
  assert.match(page, /const optionsArr = selectionToItemOptions\(selectedOpts\);/);
});
