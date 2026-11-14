// Nhân viên xem giỏ khách chưa gửi, Gửi hộ / Sửa rồi gửi; điện thoại khách bớt đúng các món đã nhận.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { cartAfterTaken, cartAlertItems, cartItemsToDraft, customerCartsFromServer } from '../src/lib/customerCartAlert.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OC = id(21), BIA = id(22), NUOC = id(23);
const T1 = id(11), T2 = id(12);
const KEY_A = 'a'.repeat(32), KEY_B = 'b'.repeat(40);

// ── DB thử (dựng trước khi khai báo test: after() đóng DB khi các test xong) ──
const db = new PGlite();
after(() => db.close());
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TABLE tables(id uuid PRIMARY KEY, table_number int, status text, table_type text,
    merged_with uuid, last_payment_at timestamptz);
  CREATE TABLE menu_items(id uuid PRIMARY KEY, name text);
  INSERT INTO tables(id, table_number, table_type) VALUES ('${T1}', 1, 'dine_in'), ('${T2}', 2, 'dine_in');
  INSERT INTO menu_items VALUES ('${OC}', 'Ốc hương'), ('${BIA}', 'Bia'), ('${NUOC}', 'Nước sâm');
`);
await db.exec(readFileSync(new URL('../supabase/migrations/customer_cart_alert.sql', import.meta.url), 'utf8'));

const report = async (key, table, items) =>
  (await db.query('SELECT public.report_customer_cart($1, $2, $3::jsonb) AS r', [key, table, JSON.stringify(items)])).rows[0].r;
const carts = async () => (await db.query('SELECT * FROM public.get_customer_carts()')).rows;
const take = async (table, cartId, updatedAt) =>
  (await db.query('SELECT public.take_customer_cart($1, $2, $3) AS r', [table, cartId, updatedAt])).rows[0].r;
const takenGet = async key => (await db.query('SELECT public.customer_cart_taken_get($1) AS r', [key])).rows[0].r;
const takenAck = async (key, at) => (await db.query('SELECT public.customer_cart_taken_ack($1, $2) AS r', [key, at])).rows[0].r;

// ── Máy khách: dòng gửi máy chủ đủ để gửi hộ đúng món ──
const ocRang = { id: OC, name: 'Ốc hương', quantity: 2, price: 150000, _options: [{ name: 'LOẠI', choice: 'Rang muối' }, { name: 'KHẨU VỊ', choice: 'Cay, Ít hành' }], _note: 'ít cay' };
const bia = { id: BIA, name: 'Bia', quantity: 3, price: 20000 };
const nuocQua = { id: NUOC, name: 'Nước sâm', price: 0, is_gift: true, _options: [{ name: 'KHẨU VỊ', choice: 'Bình thường' }] };

test('the phone reports each group of choices and the kitchen note, so staff can send the exact dish', () => {
  assert.deepEqual(cartAlertItems([ocRang, bia], [nuocQua], { [BIA]: 'không đá' }), [
    { id: OC, q: 2, o: 'Rang muối, Cay, Ít hành', p: [{ n: 'LOẠI', c: 'Rang muối' }, { n: 'KHẨU VỊ', c: 'Cay, Ít hành' }], t: 'ít cay' },
    { id: BIA, q: 3, t: 'không đá' },
    { id: NUOC, q: 1, o: 'Bình thường', p: [{ n: 'KHẨU VỊ', c: 'Bình thường' }], g: true },
  ]);
  // Cắt như máy chủ: 8 nhóm lựa chọn, ghi chú 120 ký tự (emoji tính 1 ký tự).
  const many = { id: OC, quantity: 1, _options: Array.from({ length: 10 }, (_, i) => ({ name: `N${i}`, choice: `C${i}` })), _note: `${'😀'.repeat(130)}` };
  const [line] = cartAlertItems([many], []);
  assert.equal(line.p.length, 8);
  assert.equal(Array.from(line.t).length, 120);
});

test('staff took the cart: the phone drops exactly those dishes and keeps what the customer added after', () => {
  const taken = cartAlertItems([ocRang, bia], [nuocQua], { [BIA]: 'không đá' });
  const later = { id: OC, name: 'Ốc hương', quantity: 1, _options: [{ name: 'LOẠI', choice: 'Hấp sả' }] };
  const left = cartAfterTaken([{ ...ocRang, quantity: 3 }, bia, later], [nuocQua], { [BIA]: 'không đá' }, taken);
  assert.deepEqual(left.cart.map(c => [c.id, c.quantity, c._options?.[0]?.choice || null]), [[OC, 1, 'Rang muối'], [OC, 1, 'Hấp sả']]);
  assert.deepEqual(left.gifts, []);
  assert.equal(left.count, 6);
  // Ghi chú khác = món khác: không bớt nhầm.
  const other = cartAfterTaken([bia], [], { [BIA]: 'nhiều đá' }, taken);
  assert.deepEqual(other.cart.map(c => c.quantity), [3]);
  assert.equal(other.count, 0);
});

test('a customer cart becomes staff draft lines priced from today\'s menu; switched-off dishes are left out', () => {
  const menu = [
    { id: OC, name: 'Ốc hương', price: 120000, is_available: true, options: [
      { name: 'LOẠI', choices: ['Rang muối', 'Hấp sả'], prices: [150000, 130000], hiddenChoices: [false, true] },
      { name: 'KHẨU VỊ', choices: ['Cay', 'Ít hành'], prices: [] },
    ] },
    { id: BIA, name: 'Bia', price: 20000, is_available: true, options: [] },
    { id: NUOC, name: 'Nước sâm', price: 15000, is_available: true, options: [{ name: 'KHẨU VỊ', choices: ['Bình thường', 'Ít đá'] }] },
    { id: id(30), name: 'Ghẹ', price: 300000, is_available: false },
  ];
  const items = [
    { id: OC, q: 2, p: [{ n: 'LOẠI', c: 'Rang muối' }, { n: 'KHẨU VỊ', c: 'Cay, Ít hành' }], t: 'ít cay' },
    { id: BIA, q: 3 },
    { id: OC, q: 1, p: [{ n: 'LOẠI', c: 'Hấp sả' }] },           // lựa chọn đang tắt
    { id: OC, q: 1, o: 'Rang muối' },                           // máy khách bản cũ: không biết nhóm lựa chọn
    { id: id(99), q: 1 },                                       // không còn trên thực đơn
    { id: NUOC, q: 1, p: [{ n: 'KHẨU VỊ', c: 'Ít đá' }], g: true },
  ];
  const r = cartItemsToDraft(items, menu);
  assert.deepEqual(r.lines.map(l => [l.menuItem.id, l.qty, l.price, l.note, l.options.map(o => o.choice).join('|')]), [
    [OC, 2, 150000, 'ít cay', 'Rang muối|Cay, Ít hành'],
    [BIA, 3, 20000, '', ''],
  ]);
  assert.deepEqual(r.gifts.map(g => [g.menuItem.id, g.options[0].choice]), [[NUOC, 'Ít đá']]);
  assert.equal(r.skipped.length, 3);
  assert.match(r.skipped.join(' / '), /Hấp sả/);
});

test('the Bàn page keeps which version of the cart staff are looking at', () => {
  const [c] = customerCartsFromServer([{ table_id: T1, item_count: 2, items: [], idle_ms: 1000, age_ms: 2000, cart_id: 'f'.repeat(64), updated_at: '2026-11-14T10:00:00.123456+00:00' }], 10_000);
  assert.equal(c.cartId, 'f'.repeat(64));
  assert.equal(c.updatedAt, '2026-11-14T10:00:00.123456+00:00');
});

// ── SQL ──
test('report keeps choice groups and notes the same way the phone cut them', async () => {
  const items = cartAlertItems([ocRang, bia], [nuocQua], { [BIA]: 'không đá' });
  assert.equal((await report(KEY_A, T1, [...items, { id: OC, q: 1, p: [{ n: '', c: 'x' }, { n: 'a', c: '' }, 'rác', { n: 'LOẠI', c: 'Rang muối' }] }])).ok, true);
  const [c] = await carts();
  assert.deepEqual(c.items.slice(0, 3), items, 'máy chủ giữ y hệt dòng máy khách gửi');
  assert.deepEqual(c.items[3].p, [{ n: 'LOẠI', c: 'Rang muối' }], 'bỏ nhóm lựa chọn rỗng / sai kiểu');
  assert.match(c.cart_id, /^[0-9a-f]{64}$/);
  assert.ok(c.updated_at instanceof Date || typeof c.updated_at === 'string');
});

test('staff take the exact version they saw; a changed or sent cart is refused', async () => {
  const [c] = await carts();
  // Khách vừa sửa giỏ → bản nhân viên xem đã cũ.
  await new Promise(r => setTimeout(r, 5));
  await report(KEY_A, T1, [{ id: BIA, q: 1 }]);
  const changed = await take(T1, c.cart_id, c.updated_at);
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'changed');

  const [now] = await carts();
  assert.equal((await take(T2, now.cart_id, now.updated_at)).reason, 'gone', 'sai bàn → không nhận');
  const ok = await take(T1, now.cart_id, now.updated_at);
  assert.deepEqual(ok, { ok: true, items: [{ id: BIA, q: 1 }] });
  assert.equal((await carts()).length, 0, 'nhận xong thì bàn hết báo');
  // Mất phản hồi / ghi bill lỗi → bấm gửi lại: vẫn nhận được đúng bản đó.
  assert.equal((await take(T1, now.cart_id, now.updated_at)).again, true);

  // Điện thoại khách chưa biết → báo giỏ cũ không làm bàn báo lại.
  assert.deepEqual(await report(KEY_A, T1, [{ id: BIA, q: 1 }]), { ok: true, taken: true });
  assert.equal((await carts()).length, 0);
  const got = await takenGet(KEY_A);
  assert.deepEqual(got.items, [{ id: BIA, q: 1 }]);
  assert.equal(await takenGet(KEY_B), null, 'máy khác không thấy');
  assert.equal(await takenAck(KEY_B, got.at), false);
  assert.equal(await takenAck(KEY_A, got.at), true);
  assert.equal(await takenGet(KEY_A), null);
  assert.equal(await takenAck(KEY_A, got.at), false, 'đánh dấu 1 lần');

  // Khách chọn tiếp giỏ mới → báo bình thường; lần gửi lại muộn của nhân viên vẫn được coi là đã nhận.
  assert.equal((await report(KEY_A, T1, [{ id: OC, q: 1 }])).count, 1);
  assert.equal((await carts()).length, 1);
  assert.equal((await take(T1, now.cart_id, now.updated_at)).again, true);
  assert.equal((await carts()).length, 1, 'không đụng giỏ mới');

  // Khách tự gửi đơn (giỏ trống) → nhân viên bấm Gửi hộ bản cũ thì bị từ chối.
  const [fresh] = await carts();
  await report(KEY_A, T1, []);
  assert.equal((await take(T1, fresh.cart_id, fresh.updated_at)).reason, 'gone');
});

test('what the server hands back (jsonb reorders keys) still drops the right dishes on the phone', async () => {
  const key = 'd'.repeat(32);
  const items = cartAlertItems([ocRang, bia], [nuocQua], { [BIA]: 'không đá' });
  await report(key, T2, items);
  const c = (await carts()).find(x => x.table_id === T2);
  assert.equal((await take(T2, c.cart_id, c.updated_at)).ok, true);
  const got = await takenGet(key);
  assert.deepEqual(Object.keys(got.items[0].p[0]), ['c', 'n'], 'jsonb sắp lại khoá');
  const left = cartAfterTaken([ocRang, bia], [nuocQua], { [BIA]: 'không đá' }, got.items);
  assert.deepEqual(left.cart, []);
  assert.deepEqual(left.gifts, []);
  assert.equal(left.count, 6);
  await takenAck(key, got.at);
});

test('two takes before the phone notices: the phone drops both', async () => {
  await report(KEY_B, T2, [{ id: OC, q: 2 }]);
  let [c] = await carts();
  assert.equal((await take(T2, c.cart_id, c.updated_at)).ok, true);
  // Điện thoại chưa hỏi; nhân viên khác... (giỏ mới chỉ có khi máy đã biết, nên giả lập dòng mới)
  await db.exec(`INSERT INTO customer_cart_drafts(device_hash, table_id, item_count, items) VALUES ('${c.cart_id}', '${T2}', 1, '[{"id":"${BIA}","q":1}]')`);
  [c] = await carts();
  assert.equal((await take(T2, c.cart_id, c.updated_at)).ok, true);
  assert.deepEqual((await takenGet(KEY_B)).items, [{ id: OC, q: 2 }, { id: BIA, q: 1 }]);
});

test('only the server (logged-in staff) can take a cart; the browser key cannot read what was taken', async () => {
  await db.exec('SET ROLE anon');
  try {
    await assert.rejects(db.query(`SELECT public.take_customer_cart('${T1}', '${'0'.repeat(64)}', now())`), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM customer_cart_taken'), /permission denied/);
    assert.equal((await db.query('SELECT public.customer_cart_taken_get($1) AS r', ['c'.repeat(32)])).rows[0].r, null);
  } finally {
    await db.exec('RESET ROLE');
  }
});

// ── Trang Bàn + trang gọi món ──
test('Bàn page: tapping 🛒 opens the cart (view only) with Gửi hộ / Sửa rồi gửi; sending takes the cart first', () => {
  const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
  assert.equal(page.match(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); openCartView\(table\); \}\}/g)?.length, 4, '🛒 / quên gửi trên ô bàn điện thoại + PC');
  assert.match(page, /onClick=\{\(\) => editCustomerCart\(table, cart\)\}>✏️ Sửa rồi gửi/);
  assert.match(page, /onClick=\{\(\) => sendCustomerCartNow\(table, cart\)\}/);
  // Nhận giỏ (máy chủ, có kiểm đăng nhập) trước khi ghi bill; khách vừa sửa / đã gửi → bỏ món giỏ khách khỏi nháp.
  const send = page.slice(page.indexOf('async function sendDraftLines('), page.indexOf('function handleConfirmOptions('));
  assert.ok(send.indexOf('await takeCustomerCart(link)') > 0 && send.indexOf('await takeCustomerCart(link)') < send.indexOf("supabase.rpc('confirm_draft_order'"));
  assert.match(send, /removeSentLines\(cur, \[\.\.\.link\.lineIds\]\)/);
  assert.match(page, /fetchWithTimeout\('\/api\/admin\/customer-cart'/);
  // Sửa rồi gửi chỉ đưa vào giỏ nháp, chưa nhận giỏ của khách.
  const edit = page.slice(page.indexOf('function editCustomerCart('), page.indexOf('async function sendDraftLines('));
  assert.doesNotMatch(edit.replace(/sendCustomerCartNow\(table, cart\)/, ''), /takeCustomerCart/);
  const route = readFileSync(new URL('../src/app/api/admin/customer-cart/route.js', import.meta.url), 'utf8');
  assert.match(route, /getStaffSession\(request\)/);
  assert.match(route, /rpc\('take_customer_cart'/);
});

test('order page: checks for a staff-taken cart before sending, so the same dishes never go twice', () => {
  const page = readFileSync(new URL('../src/app/order/page.jsx', import.meta.url), 'utf8');
  const submit = page.slice(page.indexOf('async function submitOrder('), page.indexOf('async function finishSentOrder('));
  const lock = submit.indexOf('submittingRef.current = true');
  const check = submit.indexOf('await checkCartTaken()');
  const rpc = submit.indexOf("supabase.rpc('submit_customer_order_atomic'");
  assert.ok(lock > 0 && check > lock && rpc > check, 'khoá nút gửi → hỏi giỏ đã được nhận chưa → mới gửi đơn');
  assert.match(page, /customer_cart_taken_ack/);
  assert.match(page, /cartAfterTaken\(nowCart, nowGifts, nowNotes, data\.items\)/);
  assert.match(page, /cartAlertItems\(cart, giftCart, notes\)/);
});
