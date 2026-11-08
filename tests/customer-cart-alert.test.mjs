import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  CART_BELL_GAP_MS, CART_BELL_MAX_RINGS, CART_BELL_REPEAT_MS, CART_FORGOT_MS, CART_REMIND_MS, cartAlertItems,
  cartMinutesText, createCartBell, createCartReminder, createCartReporter, customerCartsByTable, customerCartsFromServer,
} from '../src/lib/customerCartAlert.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── DB thử cho phần SQL (dựng trước khi khai báo test: after() đóng DB khi các test xong) ──
const db = new PGlite();
after(() => db.close());
const T1 = id(11), T2 = id(12), TW = id(13), HOST = id(14), SAT = id(15);
const OC = id(21), BIA = id(22);
const KEY_A = 'a'.repeat(32), KEY_B = 'b'.repeat(40);

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TABLE tables(id uuid PRIMARY KEY, table_number int, status text, table_type text,
    merged_with uuid, last_payment_at timestamptz);
  CREATE TABLE menu_items(id uuid PRIMARY KEY, name text);
  INSERT INTO tables(id, table_number, table_type, merged_with) VALUES
    ('${T1}', 1, 'dine_in', NULL), ('${T2}', 2, NULL, NULL), ('${TW}', 99, 'takeaway', NULL),
    ('${HOST}', 3, 'dine_in', NULL), ('${SAT}', 4, 'dine_in', '${HOST}');
  INSERT INTO menu_items VALUES ('${OC}', 'Ốc hương'), ('${BIA}', 'Bia');
`);
const migration = readFileSync(new URL('../supabase/migrations/customer_cart_alert.sql', import.meta.url), 'utf8');
await db.exec(migration);
await db.exec(migration); // chạy lại được


// ── Trang khách: giỏ → các dòng gửi máy chủ ─────────────────────────────────
test('cartAlertItems keeps dish id, portions, choices and gifts — no prices or names', () => {
  const cart = [
    { id: id(1), name: 'Ốc hương', price: 90000, quantity: 2, _options: [{ name: 'Kiểu', choice: 'Xào bơ' }, { name: 'Cay', choice: '' }] },
    { id: id(2), name: 'Bia', price: 25000, quantity: 150 },
    { id: id(3), name: 'Hết', quantity: 0 },
    { name: 'Không mã', quantity: 1 },
  ];
  const gifts = [{ id: id(4), name: 'Nước tặng', price: 0, is_gift: true }];
  assert.deepEqual(cartAlertItems(cart, gifts), [
    { id: id(1), q: 2, o: 'Xào bơ' },
    { id: id(2), q: 99 },
    { id: id(4), q: 1, g: true },
  ]);
  assert.deepEqual(cartAlertItems(null, undefined), []);
});

// ── Trang khách: báo giỏ lên máy chủ ────────────────────────────────────────
function fakeTimers() {
  let now = 0, seq = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { const k = ++seq; jobs.set(k, { at: now + ms, fn }); return k; },
    clearTimeout(k) { jobs.delete(k); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        jobs.delete(next[0]);
        now = next[1].at;
        next[1].fn(); // không chờ: lần gửi có thể đang treo (mạng chậm)
        await new Promise(r => setImmediate(r));
      }
      now = end;
    },
    pending: () => jobs.size,
  };
}

test('reporter waits for the cart to settle, skips repeats and only sends after the saved cart is back', async () => {
  const timers = fakeTimers();
  const calls = [];
  let ready = false;
  const r = createCartReporter({ timers, isReady: () => ready, send: async (t, items) => { calls.push([t, items]); return true; } });
  r.update('T1', []);
  await timers.advance(5000);
  assert.equal(calls.length, 0, 'giỏ cũ chưa nạp lại → không được báo giỏ trống (sẽ xoá báo của máy này)');
  r.update('T1', [{ id: 'a', q: 1 }]);
  await timers.advance(500);
  r.update('T1', [{ id: 'a', q: 2 }]);
  ready = true;
  await timers.advance(1200);
  assert.deepEqual(calls, [['T1', [{ id: 'a', q: 2 }]]], 'chỉ gửi giỏ sau cùng');
  r.update('T1', [{ id: 'a', q: 2 }]);
  await timers.advance(3000);
  assert.equal(calls.length, 1, 'giỏ không đổi thì không gửi lại');
  r.update('T1', []);
  await timers.advance(1200);
  assert.deepEqual(calls.at(-1), ['T1', []], 'xoá hết giỏ / gửi đơn → báo giỏ trống');
  r.dispose();
});

test('reporter never lets a slow send overwrite a newer cart, and retries failures more and more slowly', async () => {
  const timers = fakeTimers();
  const calls = [];
  let release;
  let fail = false;
  const r = createCartReporter({
    timers,
    send: (t, items) => {
      calls.push(items.length);
      if (fail) return Promise.resolve(false);
      if (calls.length === 1) return new Promise(res => { release = () => res(true); });
      return Promise.resolve(true);
    },
  });
  r.update('T1', [{ id: 'a', q: 1 }]);
  await timers.advance(1200);
  assert.deepEqual(calls, [1]);
  r.update('T1', [{ id: 'a', q: 1 }, { id: 'b', q: 1 }]);
  await timers.advance(5000);
  assert.deepEqual(calls, [1], 'lần gửi trước chưa xong thì chờ');
  release();
  await new Promise(r2 => setImmediate(r2));
  await timers.advance(1200);
  assert.deepEqual(calls, [1, 2], 'xong lần trước thì gửi giỏ mới nhất');

  fail = true;
  r.update('T1', []);
  await timers.advance(1200);
  assert.equal(calls.length, 3);
  await timers.advance(14000);
  assert.equal(calls.length, 3, 'chưa tới 15 giây chưa thử lại');
  await timers.advance(1000);
  assert.equal(calls.length, 4);
  await timers.advance(29000);
  assert.equal(calls.length, 4, 'lần sau chờ 30 giây');
  await timers.advance(1000);
  assert.equal(calls.length, 5);
  fail = false;
  await timers.advance(60000);
  assert.equal(calls.length, 6);
  await timers.advance(600000);
  assert.equal(calls.length, 6, 'đã nhận thì thôi');
  assert.equal(timers.pending(), 0);
  r.dispose();
});

// ── Trang khách: nhắc "chưa gửi món" ────────────────────────────────────────
test('the phone reminds the customer after 3 idle minutes, before the staff page starts blinking', async () => {
  assert.ok(CART_REMIND_MS < CART_FORGOT_MS, 'khách được nhắc trước, nhân viên mới phải ra');
  const timers = fakeTimers();
  const seen = [];
  const r = createCartReminder({ timers, onChange: v => seen.push(v) });
  r.update('[]', { hasItems: false });
  await timers.advance(CART_REMIND_MS * 2);
  assert.deepEqual(seen, [], 'giỏ trống thì không nhắc');

  r.update('A', { hasItems: true });
  await timers.advance(CART_REMIND_MS - 1000);
  r.update('AB', { hasItems: true }); // khách thêm món → đếm lại
  await timers.advance(CART_REMIND_MS - 1000);
  assert.deepEqual(seen, []);
  await timers.advance(1000);
  assert.deepEqual(seen, [true]);

  r.update('AB', { hasItems: true, paused: true }); // mở giỏ xem → ẩn, không đếm khi đang xem
  assert.deepEqual(seen, [true, false]);
  await timers.advance(CART_REMIND_MS * 2);
  assert.deepEqual(seen, [true, false]);
  r.update('AB', { hasItems: true }); // đóng giỏ mà chưa gửi → 3 phút sau nhắc lại
  await timers.advance(CART_REMIND_MS);
  assert.deepEqual(seen, [true, false, true]);

  r.mute(); // "Để sau"
  assert.deepEqual(seen, [true, false, true, false]);
  r.update('AB', { hasItems: true, paused: true });
  r.update('AB', { hasItems: true });
  await timers.advance(CART_REMIND_MS * 3);
  assert.equal(seen.length, 4, 'bấm Để sau thì thôi nhắc tới khi giỏ đổi');
  r.update('ABC', { hasItems: true });
  await timers.advance(CART_REMIND_MS);
  assert.deepEqual(seen.slice(4), [true], 'giỏ đổi thì nhắc lại được');

  r.update('', { hasItems: false }); // gửi đơn xong → giỏ trống → tắt
  assert.deepEqual(seen.slice(4), [true, false]);
  r.dispose();
  assert.equal(timers.pending(), 0);
});

// ── Trang Bàn ───────────────────────────────────────────────────────────────
test('the 5 minutes count from the first dish in the cart (server time), not from the last change', () => {
  const now = 1_000_000_000;
  const carts = customerCartsFromServer([
    // khách chọn 10 món suốt 6 phút, sửa giỏ lần cuối 30 giây trước → vẫn là quá 5 phút
    { table_id: 'T1', item_count: 10, items: [{ id: 'a', q: 10 }], idle_ms: 30_000, age_ms: 6 * 60_000 },
    { table_id: 'T2', item_count: 3, items: [], idle_ms: 60_000, age_ms: CART_FORGOT_MS - 1 },
    { table_id: 'T2', item_count: 2, items: [], idle_ms: 10_000, age_ms: 2 * 60_000 },
    { table_id: 'T3', item_count: 0, items: [], idle_ms: 0, age_ms: 0 },
    { table_id: null, item_count: 4, items: [], idle_ms: 0, age_ms: 0 },
    { table_id: 'T4', item_count: 1, items: [], idle_ms: CART_FORGOT_MS }, // máy chủ cũ: thiếu age_ms
  ], now);
  assert.equal(carts.length, 4);
  assert.equal(carts[0].changedAt, now - 30_000);
  assert.equal(carts[0].startedAt, now - 6 * 60_000);
  const byTable = customerCartsByTable(carts, now);
  assert.deepEqual(byTable.T1, { count: 10, ageMs: 6 * 60_000, forgot: true, forgotCount: 10, idleMs: 30_000 });
  assert.equal(byTable.T2.count, 5, '2 điện thoại cùng bàn → cộng số món');
  assert.equal(byTable.T2.ageMs, CART_FORGOT_MS - 1, 'số phút = máy chọn lâu nhất');
  assert.equal(byTable.T2.forgot, false);
  const later = customerCartsByTable(carts, now + 1).T2;
  assert.equal(later.forgot, true, 'đúng 5 phút thì chớp');
  assert.equal(later.forgotCount, 3, 'chỉ đếm món của giỏ đã quá 5 phút');
  assert.equal(byTable.T3, undefined);
  assert.equal(byTable.T4.forgot, true, 'thiếu age_ms thì lấy idle_ms');
  assert.equal(customerCartsByTable(carts, now + 4 * 60_000).T1.ageMs, 10 * 60_000, 'số phút tự tăng theo đồng hồ máy này');
});

test('minutes text on the table card (spaces that never break "4 | phút" apart)', () => {
  const plain = ms => cartMinutesText(ms).replace(/ /g, ' ');
  assert.equal(plain(0), '<1 phút');
  assert.equal(plain(59_999), '<1 phút');
  assert.equal(plain(4 * 60_000 + 59_000), '4 phút');
  assert.equal(plain(CART_FORGOT_MS + 59_000), '5 phút');
  assert.equal(plain(83 * 60_000), '1 giờ 23 phút');
  assert.equal(plain(NaN), '<1 phút');
  assert.equal(cartMinutesText(4 * 60_000), '4 phút');
});

// ── Trang Bàn: chuông ───────────────────────────────────────────────────────
test('bell rings when a table starts blinking, repeats every 2 minutes, at most 5 times', () => {
  const bell = createCartBell();
  let t = 0;
  assert.deepEqual(bell.check([], t), { ring: [], blocked: false });
  assert.deepEqual(bell.check(['T1'], t).ring, ['T1'], 'đủ 5 phút → kêu ngay');
  const rings = [t];
  for (t = 10_000; t <= 30 * 60_000; t += 10_000) if (bell.check(['T1'], t).ring.length) rings.push(t);
  assert.equal(rings.length, CART_BELL_MAX_RINGS, 'có chừng mực: tối đa 5 lần rồi chỉ còn chớp');
  assert.deepEqual(rings, [0, 1, 2, 3, 4].map(i => i * CART_BELL_REPEAT_MS), 'mỗi 2 phút một lần');
});

test('bell: several tables at once ring once, rings are at least 30 seconds apart, each table keeps its own count', () => {
  const bell = createCartBell();
  assert.deepEqual(bell.check(['T1', 'T2'], 0).ring, ['T1', 'T2'], 'hai bàn cùng lúc → kêu một lần');
  assert.deepEqual(bell.check(['T1', 'T2', 'T3'], 10_000).ring, [], 'bàn mới tới lượt nhưng vừa kêu → chờ');
  assert.deepEqual(bell.check(['T1', 'T2', 'T3'], CART_BELL_GAP_MS).ring, ['T3']);
  assert.deepEqual(bell.check(['T1', 'T2', 'T3'], CART_BELL_REPEAT_MS).ring, ['T1', 'T2']);
});

test('bell stops for a table once staff open it, when the cart is sent, emptied or dismissed — and rings again next time', () => {
  const bell = createCartBell();
  assert.deepEqual(bell.check(['T1', 'T2'], 0).ring, ['T1', 'T2']);
  bell.quiet('T1'); // nhân viên mở bàn T1 xem
  assert.deepEqual(bell.check(['T1', 'T2'], CART_BELL_REPEAT_MS).ring, ['T2'], 'T1 đã mở xem → thôi kêu, T2 vẫn nhắc');
  assert.deepEqual(bell.check(['T1'], 2 * CART_BELL_REPEAT_MS).ring, [], 'T1 vẫn chớp nhưng không kêu');
  bell.check([], 2 * CART_BELL_REPEAT_MS + 10_000); // khách gửi món / giỏ trống / bấm Tắt → hết báo
  assert.deepEqual(bell.check(['T1', 'T2'], 3 * CART_BELL_REPEAT_MS).ring, ['T1', 'T2'], 'lần báo sau là lượt mới, kêu lại');
  bell.quiet('T9'); // mở bàn không có báo → không ảnh hưởng gì
  assert.deepEqual(bell.check(['T9'], 4 * CART_BELL_REPEAT_MS).ring, ['T9'], 'mở bàn trước lúc đủ 5 phút không chặn chuông về sau');
});

test('bell waits while the browser blocks sound (nobody touched the page yet), then rings right after a touch', () => {
  const bell = createCartBell();
  assert.deepEqual(bell.check(['T1'], 0, { canRing: false }), { ring: [], blocked: true });
  assert.deepEqual(bell.check(['T1'], 60_000, { canRing: false }), { ring: [], blocked: true }, 'không tính là đã kêu');
  assert.deepEqual(bell.check(['T1'], 70_000, { canRing: true }), { ring: ['T1'], blocked: false }, 'chạm trang xong kêu ngay');
  assert.deepEqual(bell.check(['T1'], 80_000, { canRing: false }), { ring: [], blocked: false }, 'chưa tới lượt kêu thì không báo chặn');
  bell.quiet('T1');
  assert.deepEqual(bell.check(['T1'], 10 * 60_000, { canRing: false }), { ring: [], blocked: false });
});

// ── Trang Bàn: ô bàn ────────────────────────────────────────────────────────
test('table card says "N món · M phút" (not "khách"), blinks the whole card even with reduced motion, and rings the shared bell', () => {
  const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/app/admin/tables/tables.css', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /custCart\.count\}\s*khách/, 'số trong giỏ là số món, không phải số khách');
  assert.equal(page.match(/🛒 \{custCart\.count\}&nbsp;món · \{cartMinutesText\(custCart\.ageMs\)\}/g)?.length, 2, 'ô bàn điện thoại + PC');
  assert.equal(page.match(/Quên gửi \{custCart\.forgotCount\}&nbsp;món · \{cartMinutesText\(custCart\.ageMs\)\}/g)?.length, 2);
  assert.equal(page.match(/onClick=\{\(\) => \{ quietCartBell\(table\.id\); setSelectedTable\(table\)/g)?.length, 2, 'mở bàn (điện thoại + PC) → thôi kêu');
  assert.match(page, /if \(ring\.length\) ringBell\(\);/, 'dùng lại chuông đơn mới của trang');
  assert.match(page, /\['touchend', 'click', 'keydown'\]/, 'chạm trang lần đầu thì mở tiếng');

  const blink = css.match(/@keyframes cartForgotBlink \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(blink, /background: #facc15/, 'cả ô bàn vàng lên (cả nền gradient), không chỉ viền');
  assert.match(css, /\.cart-forgot-blink \{\s*animation: cartForgotBlink [^;]*infinite/);
  for (const block of css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || []) {
    assert.doesNotMatch(block, /cart-forgot-blink/, 'máy bật "giảm hiệu ứng" vẫn phải chớp');
  }
});

// ── SQL ─────────────────────────────────────────────────────────────────────
const report = async (key, table, items) =>
  (await db.query('SELECT public.report_customer_cart($1, $2, $3::jsonb) AS r', [key, table, JSON.stringify(items)])).rows[0].r;
const rows = async () => (await db.query('SELECT * FROM customer_cart_drafts ORDER BY table_id')).rows;
const carts = async () => (await db.query('SELECT * FROM public.get_customer_carts()')).rows;

test('report_customer_cart keeps only real dishes and sane portions', async () => {
  const r = await report(KEY_A, T1, [
    { id: OC, q: 2, o: 'Xào bơ' },
    { id: BIA, q: 1, g: true },
    { id: id(999), q: 1 },        // không có trong thực đơn
    { id: 'không-phải-mã', q: 1 },
    { id: OC, q: 100 },
    { id: OC, q: '1; DROP' },
    'chuỗi',
    { id: BIA, q: 3, o: { x: 1 } },
  ]);
  assert.deepEqual(r, { ok: true, count: 6 });
  const [row] = await rows();
  assert.equal(row.table_id, T1);
  assert.equal(row.item_count, 6);
  assert.deepEqual(row.items, [{ id: OC, q: 2, o: 'Xào bơ' }, { id: BIA, q: 1, g: true }, { id: BIA, q: 3 }]);
  assert.match(row.device_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.device_hash, KEY_A, 'máy chủ chỉ giữ sha256, không giữ mã của máy khách');
});

test('same cart again keeps the clock; a changed cart restarts it; moving table restarts first_added_at', async () => {
  await db.exec(`UPDATE customer_cart_drafts SET updated_at = now() - interval '7 minutes', first_added_at = now() - interval '9 minutes'`);
  await report(KEY_A, T1, [{ id: OC, q: 2, o: 'Xào bơ' }, { id: BIA, q: 1, g: true }, { id: BIA, q: 3 }]);
  let [c] = await carts();
  assert.ok(c.idle_ms >= 7 * 60_000 - 1000, 'tải lại trang (giỏ y hệt) không làm mất mốc 5 phút');
  assert.ok(c.age_ms >= 9 * 60_000 - 1000);

  await report(KEY_A, T1, [{ id: OC, q: 3, o: 'Xào bơ' }]);
  [c] = await carts();
  assert.ok(c.idle_ms < 5000, 'khách vừa sửa giỏ → đếm lại từ đầu');
  assert.ok(c.age_ms >= 9 * 60_000 - 1000, 'cùng bàn thì giữ giờ bỏ món đầu tiên');
  assert.equal(c.item_count, 3);

  await report(KEY_A, T2, [{ id: OC, q: 3, o: 'Xào bơ' }]);
  [c] = await carts();
  assert.equal(c.table_id, T2);
  assert.ok(c.age_ms < 5000, 'đổi bàn thì là giỏ mới');
});

test('empty cart, takeaway, no table or a bad key never leave an alert', async () => {
  assert.deepEqual(await report(KEY_A, T2, []), { ok: true, count: 0 });
  assert.equal((await rows()).length, 0);
  assert.deepEqual(await report(KEY_A, TW, [{ id: OC, q: 1 }]), { ok: true, count: 0 });
  assert.deepEqual(await report(KEY_A, null, [{ id: OC, q: 1 }]), { ok: true, count: 0 });
  assert.deepEqual(await report(KEY_A, T1, { not: 'array' }), { ok: true, count: 0 });
  assert.deepEqual(await report('ngắn', T1, [{ id: OC, q: 1 }]), { ok: false, reason: 'bad_key' });
  assert.equal((await rows()).length, 0);
});

test('get_customer_carts drops carts from before the table was paid, older than 2 hours, or on takeaway', async () => {
  await report(KEY_A, T1, [{ id: OC, q: 1 }]);
  await report(KEY_B, SAT, [{ id: BIA, q: 2 }]);
  assert.deepEqual((await carts()).map(c => c.table_id).sort(), [T1, SAT].sort());

  await db.exec(`UPDATE tables SET last_payment_at = now() + interval '1 second' WHERE id = '${HOST}'`);
  assert.deepEqual((await carts()).map(c => c.table_id), [T1], 'bàn gộp thanh toán ở bàn chính → giỏ ở bàn phụ cũng hết');
  await db.exec(`UPDATE tables SET last_payment_at = now() - interval '1 minute' WHERE id = '${HOST}'`);
  assert.equal((await carts()).length, 2, 'giỏ chọn SAU lúc thanh toán (khách mới) vẫn báo');

  await db.exec(`UPDATE customer_cart_drafts SET updated_at = now() - interval '121 minutes' WHERE table_id = '${T1}'`);
  assert.deepEqual((await carts()).map(c => c.table_id), [SAT]);
  await db.exec(`UPDATE customer_cart_drafts SET updated_at = now() - interval '25 hours' WHERE table_id = '${T1}'`);
  await report(KEY_B, SAT, [{ id: BIA, q: 3 }]);
  assert.deepEqual((await rows()).map(r => r.table_id), [SAT], 'giỏ bỏ quên quá 1 ngày bị dọn');
});

test('dismiss_customer_carts turns off only that table', async () => {
  await report(KEY_A, T1, [{ id: OC, q: 1 }]);
  const gone = (await db.query(`SELECT public.dismiss_customer_carts('${SAT}') AS n`)).rows[0].n;
  assert.equal(gone, 1);
  assert.deepEqual((await rows()).map(r => r.table_id), [T1]);
});

test('one table takes at most 12 phones with a cart (spam guard)', async () => {
  for (let i = 0; i < 11; i++) assert.equal((await report(`k${String(i).padStart(31, '0')}`, T1, [{ id: OC, q: 1 }])).ok, true);
  assert.deepEqual(await report('z'.repeat(32), T1, [{ id: OC, q: 1 }]), { ok: false, reason: 'too_many' });
  assert.equal((await report(KEY_A, T1, [{ id: OC, q: 2 }])).ok, true, 'máy đã có giỏ vẫn sửa được');
  await db.exec('DELETE FROM customer_cart_drafts');
});

test('the browser key can read carts but only change them through the functions', async () => {
  await db.exec('SET ROLE anon');
  try {
    await assert.rejects(db.query(`INSERT INTO customer_cart_drafts(device_hash, table_id, item_count) VALUES ('${'0'.repeat(64)}', '${T1}', 1)`), /permission denied/);
    await assert.rejects(db.query('DELETE FROM customer_cart_drafts'), /permission denied/);
    const r = (await db.query('SELECT public.report_customer_cart($1, $2, $3::jsonb) AS r', [KEY_A, T1, JSON.stringify([{ id: OC, q: 1 }])])).rows[0].r;
    assert.equal(r.ok, true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM customer_cart_drafts')).rows[0].n, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.get_customer_carts()')).rows[0].n, 1);
    assert.equal((await db.query(`SELECT public.dismiss_customer_carts('${T1}') AS n`)).rows[0].n, 1);
  } finally {
    await db.exec('RESET ROLE');
  }
});
