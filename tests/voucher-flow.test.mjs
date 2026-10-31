import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { pgSupabase } from './helpers/pgliteSupabase.mjs';
import * as voucher from '../src/lib/voucher.mjs';
import * as voucherServer from '../src/lib/voucherServer.mjs';
import * as finance from '../src/lib/ownerFinance.mjs';

// TRỌN QUY TRÌNH trên Postgres thật (PGlite) với đúng SQL của quán: trigger tổng bill, chặn sửa bill
// đã chốt, thanh toán complete_table_payment_atomic, gộp bill merge_bills_atomic, và vouchers.sql.
// Code máy chủ (route thanh toán, route voucher của nhân viên / khách) chạy thật qua pgSupabase.
const db = new PGlite();
after(() => db.close());
const sql = f => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

await db.exec(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
  END $$;
  CREATE TABLE settings(key text PRIMARY KEY, value text);
  CREATE TABLE tables(id uuid PRIMARY KEY, table_number integer, merged_with uuid, status text DEFAULT 'occupied',
    occupied_at timestamptz DEFAULT now(), table_type text DEFAULT 'normal', last_payment_at timestamptz);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables, status text DEFAULT 'pending', total_amount numeric DEFAULT 0,
    customer_name text, customer_phone text, payment_method text, paid_at timestamptz, paid_by_id uuid, paid_by_name text,
    created_at timestamptz DEFAULT now(), is_hidden_from_stats boolean);
  CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders ON DELETE CASCADE,
    menu_item_id uuid, item_name text, quantity integer NOT NULL DEFAULT 1, unit_price integer NOT NULL DEFAULT 0,
    is_gift boolean DEFAULT false, note text, added_by_id uuid, added_by_name text);
  CREATE TABLE bank_accounts(id uuid PRIMARY KEY, is_active boolean, is_visible boolean);
  CREATE TABLE bank_daily_totals(id uuid DEFAULT gen_random_uuid(), account_id uuid, date date, total_amount numeric, UNIQUE(account_id, date));
  CREATE TABLE payment_transactions(transaction_code varchar(8) PRIMARY KEY, status text, order_ids text, total_amount numeric, account_id text);
  CREATE TABLE print_jobs(id bigserial PRIMARY KEY, order_id uuid, status text);
  CREATE TABLE lucky_spins(id uuid PRIMARY KEY, applied_order_id uuid, status text);
  CREATE FUNCTION refresh_lucky_percent_for_order(uuid) RETURNS void LANGUAGE sql AS 'SELECT NULL';
  CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text UNIQUE, visit_count integer DEFAULT 0,
    last_visit_at timestamptz, zalo_user_id text);
  CREATE TABLE zalo_followers(zalo_user_id text PRIMARY KEY, phone text, unfollowed_at timestamptz, last_event_at timestamptz);
`);
for (const f of ['order_total_follows_items.sql', 'protect_settled_order_items.sql', 'complete_table_payment_atomic.sql',
  'merge_bills_preserve_live_items.sql', 'vouchers.sql']) await db.exec(sql(f));
await db.exec(`UPDATE voucher_settings SET value = 'true' WHERE key IN ('voucher_enabled', 'voucher_next_enabled')`);

const strip = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const zalo = [];
const sendOaText = async (_db, uid, text) => { zalo.push({ uid, text }); return { ok: true }; };
const STAFF = { id: id(900), full_name: 'Thu ngân', role: 'staff' };
const base = { NextResponse: { json: (body, init = {}) => ({ status: init.status || 200, body }) }, statusDatabase: () => pgSupabase(db),
  getStaffSession: async () => ({ code: 200, user: STAFF }), sendOaText, URL,
  console: { log() {}, error: (...a) => { if (process.env.DEBUG_FLOW) process.stderr.write(`ROUTE ERR ${a.map(x => x?.message || JSON.stringify(x)).join(' ')}\n`); } } };
const receipts = vm.runInNewContext(`${strip('../src/app/api/admin/receipts/route.js')}\n({ POST })`, {
  ...base, ...finance, ...voucherServer, voucherValueText: voucher.voucherValueText, removeReceiptImages: async () => {}, Number, Math, String, Promise, Date, JSON,
});
const staffApi = vm.runInNewContext(`${strip('../src/app/api/admin/vouchers/route.js')}\n({ POST })`, { ...base, ...voucher, ...voucherServer });
const customerApi = vm.runInNewContext(`${strip('../src/app/api/voucher/redeem/route.js')}\n({ POST })`, { ...base, ...voucher, hashVoucherKey: voucherServer.hashVoucherKey, Promise, Date });
const mineApi = vm.runInNewContext(`${strip('../src/app/api/voucher/mine/route.js')}\n({ GET })`, { ...base, normalizePhone: voucher.normalizePhone, hashVoucherKey: voucherServer.hashVoucherKey, Promise });
const bindApi = vm.runInNewContext(`${strip('../src/app/api/voucher/bind/route.js')}\n({ POST })`, { ...base, hashVoucherKey: voucherServer.hashVoucherKey, Promise, Date, Math });
const PHONE_KEY = 'a'.repeat(48);
const bind = async (orderN, tableN, key = PHONE_KEY, ip = '') => json(await bindApi.POST({ json: async () => ({ orderId: id(orderN), tableId: id(tableN), key }),
  headers: { get: h => (h === 'cf-connecting-ip' ? ip : null) } }));
const mine = async (orderN, key = PHONE_KEY) => json(await mineApi.GET({ url: `http://x/api/voucher/mine?orderId=${id(orderN)}`, headers: { get: h => (h === 'x-voucher-key' ? key : null) } })).body.voucher;

const json = o => JSON.parse(JSON.stringify(o));
async function table(n, extra = {}) {
  await db.query('INSERT INTO tables(id, table_number, merged_with, table_type) VALUES ($1,$2,$3,$4)', [id(n), n, extra.mergedWith || null, extra.type || 'normal']);
}
// Như trang gọi món: đăng ký chìa khoá máy cho mã bill TRƯỚC khi gửi món.
async function order(n, tableN, phone, lines, name = 'Khách') {
  await bind(n, tableN);
  await db.query('INSERT INTO orders(id, table_id, customer_phone, customer_name) VALUES ($1,$2,$3,$4)', [id(n), id(tableN), phone, name]);
  for (const [qty, price] of lines) await db.query('INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price) VALUES ($1,$2,$3,$4)', [id(n), id(999), qty, price]);
}
const openBills = async tableN => (await db.query(`SELECT o.id FROM orders o JOIN tables t ON t.id = o.table_id
  WHERE (t.id = $1 OR t.merged_with = $1) AND o.status IN ('pending','preparing','completed') ORDER BY o.id`, [id(tableN)])).rows.map(r => r.id);
const billTotal = async ids => Number((await db.query('SELECT COALESCE(SUM(unit_price*quantity),0) AS t FROM order_items WHERE order_id = ANY($1)', [ids])).rows[0].t);
// Như trang Bàn: chụp danh sách bill + tổng tiền rồi gửi đóng bàn (tiền mặt, không ảnh).
async function pay(tableN, amount = null) {
  const ids = await openBills(tableN);
  const form = { action: 'table_pay', table_id: id(tableN), order_ids: ids.join(','), amount: String(amount ?? await billTotal(ids)), method: 'cash' };
  return json(await receipts.POST({ formData: async () => ({ get: k => form[k] ?? null }) }));
}
const customerRedeem = async (code, tableN, orderN, key = PHONE_KEY) => json(await customerApi.POST({
  json: async () => ({ code, tableId: id(tableN), orderId: id(orderN) }), headers: { get: k => (k === 'x-voucher-key' ? key : null) } })).body;
const staffRedeem = async (code, tableN) => json(await staffApi.POST({ json: async () => ({ action: 'redeem', code, orderIds: await openBills(tableN) }) })).body;
const v = async code => (await db.query('SELECT * FROM vouchers WHERE code = $1', [code])).rows[0];
const tomorrow = code => db.query(`UPDATE vouchers SET valid_from = now() - interval '1 hour' WHERE code = $1`, [code]);

test('trọn quy trình: thanh toán → tặng mã lần sau → hôm sau khách tự nhập mã → trừ đúng tiền → thanh toán đúng số', async () => {
  // Hôm nay: bàn 5, khách gọi 300.000đ, SĐT đã nối Zalo.
  await db.query(`INSERT INTO customers(name, phone, zalo_user_id) VALUES ('Khách A', '0901234567', 'zalo-A')`);
  await table(5);
  // Trang gọi món sinh mã bill rồi đăng ký chìa khoá máy TRƯỚC khi gửi món.
  assert.equal((await bind(10, 5)).body.ok, true);
  await order(10, 5, '0901234567', [[3, 90000], [2, 15000]], 'Khách A');
  assert.equal((await bind(10, 5, 'b'.repeat(48))).status, 409, 'bill đã gửi rồi: người lạ không đăng ký chìa khoá được');
  assert.equal((await bind(10, 5)).body.ok, true, 'chính máy đó gửi lại thì được');
  const paid = await pay(5);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.ok, true);
  const code = paid.body.nextVoucher.code;
  assert.match(code, /^BK-/);
  assert.equal(paid.body.nextVoucher.valueText, '30.000đ');
  await new Promise(r => setTimeout(r, 20)); // tin Zalo gửi sau, không bắt nhân viên chờ
  assert.equal(zalo.length, 1);
  assert.equal(zalo[0].uid, 'zalo-A');
  assert.match(zalo[0].text, new RegExp(`Mã: ${code}[\\s\\S]*📋 Đã gọi`));
  assert.ok((await v(code)).sent_at);

  // Trang khách (bill vừa trả) thấy vé, không lộ SĐT.
  const ticket = await mine(10);
  assert.equal(ticket.code, code);
  assert.equal('customer_phone' in ticket, false);
  // Người ngoài đọc được mã bill bằng khoá công khai nhưng không có chìa khoá máy → không lấy được mã.
  assert.equal(await mine(10, ''), null);
  assert.equal(await mine(10, 'b'.repeat(48)), null);

  // Gọi lại thanh toán (mạng chập chờn) không tặng thêm mã.
  assert.equal((await db.query("SELECT count(*)::int AS n FROM vouchers WHERE source = 'next_visit'")).rows[0].n, 1);

  // Hôm sau: khách ngồi bàn 7, gọi 180.000đ (chưa đủ 200.000đ).
  await table(7);
  await order(20, 7, '0901234567', [[2, 90000]], 'Khách A');
  assert.equal((await customerRedeem(code, 7, 20)).reason, 'not_yet', 'mã lần sau chưa dùng được ngay tối hôm đó');
  await tomorrow(code);
  const short = await customerRedeem(code.toLowerCase(), 7, 20);
  assert.deepEqual([short.ok, short.reason], [false, 'min_bill']);
  assert.match(short.message, /200\.000đ.*180\.000đ/);

  // Gọi thêm → đủ → tự nhập mã → bill giảm 30.000đ, tổng bill tự cập nhật.
  await db.query('INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price) VALUES ($1,$2,1,25000)', [id(20), id(999)]);
  const ok = await customerRedeem(code, 7, 20);
  assert.deepEqual([ok.ok, ok.discount], [true, 30000]);
  assert.equal(Number((await db.query('SELECT total_amount FROM orders WHERE id = $1', [id(20)])).rows[0].total_amount), 175000);
  const line = (await db.query("SELECT * FROM order_items WHERE order_id = $1 AND unit_price < 0", [id(20)])).rows[0];
  assert.deepEqual([line.item_name, line.added_by_name, line.added_by_id], [`Voucher ${code}`, 'Khách tự nhập mã', null]);

  // Mã đã dùng: khách khác / nhân viên dùng lại đều bị chặn; bill không có mã thứ 2.
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, valid_from, valid_until)
    VALUES ('BK-GHFTAA', 'gift', 'amount', 50000, now() - interval '1 day', now() + interval '5 days')`);
  assert.equal((await customerRedeem(code, 7, 20)).message, 'Mã này đã được dùng rồi ạ.');
  assert.equal((await staffRedeem('BK-GHFTAA', 7)).reason, 'bill_has_voucher');

  // Thanh toán đúng số đã trừ; mã còn "đã dùng" và bill đã chốt không xoá được dòng voucher.
  const paid2 = await pay(7);
  assert.equal(paid2.body.ok, true);
  assert.equal(paid2.body.nextVoucher, undefined, 'bill 175.000đ < 300.000đ: không tặng mã mới');
  await assert.rejects(db.query('DELETE FROM order_items WHERE id = $1', [line.id]), /đã chốt/);
  assert.equal((await v(code)).status, 'used');
  // Dọn bill đã trả theo hạn mức thống kê → mã không hồi sinh.
  await db.query('DELETE FROM orders WHERE id = $1', [id(20)]);
  assert.equal((await v(code)).status, 'used');
});

test('khách áp mã lúc nhân viên đang tính tiền: lần thanh toán với số cũ bị trả lại, không thu thiếu / dư', async () => {
  await table(8);
  await order(30, 8, '0907777777', [[3, 100000]]);
  const stale = await billTotal(await openBills(8)); // nhân viên mở phiếu tạm tính: 300.000đ
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, valid_from, valid_until)
    VALUES ('BK-RACEAA', 'gift', 'amount', 40000, now() - interval '1 day', now() + interval '5 days')`);
  assert.equal((await customerRedeem('BK-RACEAA', 8, 30)).ok, true);
  const r = await pay(8, stale);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'amount_changed');
  assert.equal(Number(r.body.total), 260000);
  assert.equal((await pay(8)).body.ok, true);
});

test('gộp bàn + gộp bill: voucher theo nhóm bàn, dòng voucher đi theo bill chính, thanh toán đúng', async () => {
  await table(11);
  await table(12, { mergedWith: id(11) });
  await order(40, 11, '0908888888', [[2, 100000]]);
  await order(41, 12, null, [[1, 120000]]);
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, max_discount, min_bill, valid_from, valid_until)
    VALUES ('BK-PCTAAA', 'gift', 'percent', 10, 25000, 300000, now() - interval '1 day', now() + interval '5 days')`);
  // Khách ở bàn phụ tự nhập: tiền món cả nhóm 320.000đ ≥ 300.000đ; 10% = 32.000 → trần 25.000.
  const r = await customerRedeem('BK-PCTAAA', 12, 41);
  assert.deepEqual([r.ok, r.discount], [true, 25000]);
  await db.query('SELECT merge_bills_atomic($1, $2, $3, 0, $4)', [[id(40), id(41)], id(40), [id(41)], '[]']);
  assert.equal((await v('BK-PCTAAA')).status, 'used', 'gộp bill không trả mã');
  const paid = await pay(11);
  assert.equal(paid.body.ok, true);
  assert.equal(Number((await db.query('SELECT total_amount FROM orders WHERE id = $1', [id(40)])).rows[0].total_amount), 295000);
});

test('xoá dòng voucher / huỷ bill khi bàn còn mở → mã dùng lại được', async () => {
  await table(13);
  await order(50, 13, null, [[1, 250000]]);
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, valid_from, valid_until)
    VALUES ('BK-UNDXAA', 'gift', 'amount', 30000, now() - interval '1 day', now() + interval '5 days')`);
  const first = await staffRedeem('BK-UNDXAA', 13);
  assert.equal(first.ok, true);
  await db.query('DELETE FROM order_items WHERE id = $1', [first.item_id]);
  assert.equal((await v('BK-UNDXAA')).status, 'active');
  assert.equal(Number((await db.query('SELECT total_amount FROM orders WHERE id = $1', [id(50)])).rows[0].total_amount), 250000);
  assert.equal((await staffRedeem('BK-UNDXAA', 13)).ok, true);
  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id(50)]);
  assert.equal((await v('BK-UNDXAA')).status, 'active');
});

test('bill đã có giảm giá tay: voucher không kéo bill về 0đ / âm (bàn vẫn thanh toán được)', async () => {
  await table(14);
  await order(60, 14, null, [[1, 100000]]);
  await db.query("INSERT INTO order_items(order_id, item_name, quantity, unit_price) VALUES ($1, 'Giảm giá: khách quen', 1, -80000)", [id(60)]);
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, valid_from, valid_until)
    VALUES ('BK-CAPAAA', 'gift', 'amount', 50000, now() - interval '1 day', now() + interval '5 days')`);
  const r = await staffRedeem('BK-CAPAAA', 14);
  assert.deepEqual([r.ok, r.discount], [true, 19000]);
  assert.equal(await billTotal([id(60)]), 1000);
  assert.equal((await pay(14)).body.ok, true);

  await table(15);
  await order(61, 15, null, [[1, 50000]]);
  await db.query("INSERT INTO order_items(order_id, item_name, quantity, unit_price) VALUES ($1, 'Giảm giá', 1, -49500)", [id(61)]);
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, valid_from, valid_until)
    VALUES ('BK-ZERXAA', 'gift', 'amount', 50000, now() - interval '1 day', now() + interval '5 days')`);
  assert.equal((await staffRedeem('BK-ZERXAA', 15)).reason, 'zero');
  assert.equal((await v('BK-ZERXAA')).status, 'active');
});

test('khách dò mã: máy đó sai 6 lần là khoá; người ngoài (không có chìa khoá máy) không thử / không khoá được', async () => {
  await table(16);
  const LOCK_KEY = 'c'.repeat(48); // máy riêng của bàn này
  await bind(70, 16, LOCK_KEY);
  await order(70, 16, null, [[1, 300000]]);
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, valid_from, valid_until)
    VALUES ('BK-WCKAAA', 'gift', 'amount', 30000, now() - interval '1 day', now() + interval '5 days')`);
  for (let i = 0; i < 10; i++) assert.equal((await customerRedeem('BK-WCKAAA', 16, 70, 'z'.repeat(48))).reason, 'no_key');
  assert.equal((await v('BK-WCKAAA')).status, 'active', 'người ngoài không dùng được mã trên bill của khách');
  for (let i = 0; i < 6; i++) assert.equal((await customerRedeem(`BK-ZZZZZ${'23456789'[i]}`, 16, 70, LOCK_KEY)).reason, 'not_found');
  assert.equal((await customerRedeem('BK-WCKAAA', 16, 70, LOCK_KEY)).reason, 'too_many');
  assert.equal((await v('BK-WCKAAA')).status, 'active', 'bị khoá thì không chạm vào mã');
  assert.equal((await staffRedeem('BK-WCKAAA', 16)).ok, true, 'nhân viên vẫn dùng được cho khách');
});

test('áp mã rồi bỏ bớt món: lúc thanh toán máy báo voucher chưa đủ điều kiện, xoá dòng voucher thì đóng bàn được', async () => {
  await table(17);
  await order(80, 17, null, [[2, 100000], [1, 50000]]);
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, min_bill, valid_from, valid_until)
    VALUES ('BK-MNMNAA', 'gift', 'amount', 30000, 200000, now() - interval '1 day', now() + interval '5 days')`);
  const r = await staffRedeem('BK-MNMNAA', 17);
  assert.equal(r.ok, true);
  await db.query('DELETE FROM order_items WHERE order_id = $1 AND unit_price = 100000 AND id = (SELECT id FROM order_items WHERE order_id = $1 AND unit_price = 100000 LIMIT 1)', [id(80)]);
  const blocked = await pay(17);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason, 'voucher_min_bill');
  assert.match(blocked.body.error, /BK-MNMNAA.*200\.000đ.*còn 50\.000đ/);
  await db.query('DELETE FROM order_items WHERE id = $1', [r.item_id]);
  assert.equal((await v('BK-MNMNAA')).status, 'active', 'xoá dòng → mã trả lại cho khách');
  assert.equal((await pay(17)).body.ok, true);
});

test('huỷ bill (mã được trả) rồi mở lại: mã còn thì lấy lại; mã đã dùng nơi khác thì không cho mở lại', async () => {
  await table(18);
  await order(90, 18, null, [[1, 300000]]);
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, valid_from, valid_until)
    VALUES ('BK-RPNRPN', 'gift', 'amount', 30000, now() - interval '1 day', now() + interval '5 days')`);
  const r = await staffRedeem('BK-RPNRPN', 18);
  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id(90)]);
  assert.equal((await v('BK-RPNRPN')).status, 'active');
  await db.query("UPDATE orders SET status = 'pending' WHERE id = $1", [id(90)]);
  const back = await v('BK-RPNRPN');
  assert.deepEqual([back.status, back.used_item_id], ['used', r.item_id], 'mở lại → mã gắn lại đúng dòng');

  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id(90)]);
  await table(19);
  await order(91, 19, null, [[1, 300000]]);
  assert.equal((await staffRedeem('BK-RPNRPN', 19)).ok, true, 'mã đã trả được dùng ở bàn khác');
  await assert.rejects(db.query("UPDATE orders SET status = 'pending' WHERE id = $1", [id(90)]), /không mở lại bill/);
});

test('đăng ký chìa khoá: bàn không có / chìa khoá ngắn bị từ chối; rác hàng loạt không chặn được khách thật', async () => {
  assert.equal((await bind(500, 999)).status, 409, 'bàn không tồn tại');
  assert.equal((await bindApi.POST({ json: async () => ({ orderId: id(501), tableId: id(5), key: 'ngan' }) })).status, 400);
  // Ai đó đăng ký rác hàng loạt cho bàn 5 → khách thật ở bàn 5 vẫn đăng ký được.
  await db.query("INSERT INTO voucher_order_keys(order_id, table_id, key_hash) SELECT gen_random_uuid(), $1, 'x' FROM generate_series(1, 500)", [id(5)]);
  assert.equal((await bind(502, 5)).body.ok, true);
  // Một IP (Cloudflare gắn, không giả được) gửi quá 300 lần / giờ thì bị từ chối; IP khác vẫn được.
  let last;
  for (let i = 0; i < 301; i++) last = await bind(600 + i, 5, PHONE_KEY, '203.0.113.9');
  assert.equal(last.status, 429);
  assert.equal((await bind(950, 5, PHONE_KEY, '198.51.100.7')).body.ok, true);
});

test('chủ quán tắt voucher: nhân viên / khách không dùng được mã (không tính là dò mã), thanh toán không tặng mã; bật lại là dùng tiếp', async () => {
  const setSwitch = on => db.query("UPDATE voucher_settings SET value = $1 WHERE key = 'voucher_enabled'", [on ? 'true' : 'false']);
  const nextCodes = async () => (await db.query("SELECT count(*)::int AS n FROM vouchers WHERE source = 'next_visit'")).rows[0].n;
  await table(30);
  await order(300, 30, '0907777777', [[2, 150000]], 'Khách');
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, customer_phone, valid_from, valid_until)
    VALUES ('BK-SWTCHB', 'gift', 'amount', 30000, '0907777777', now() - interval '1 day', now() + interval '5 days')`);
  await table(31);
  await order(310, 31, '0908888888', [[4, 100000]], 'Khách');
  await setSwitch(false);
  try {
    const look = json(await staffApi.POST({ json: async () => ({ action: 'lookup', phones: ['0907777777'] }) })).body;
    assert.deepEqual([look.on, look.vouchers.length], [false, 0]);
    assert.equal((await staffRedeem('BK-SWTCHB', 30)).reason, 'disabled');
    for (let i = 0; i < 8; i++) assert.equal((await customerRedeem('BK-SWTCHB', 30, 300)).reason, 'disabled');
    assert.equal((await v('BK-SWTCHB')).status, 'active');
    assert.equal(await billTotal(await openBills(30)), 300000, 'không ghi dòng giảm nào');

    const before = await nextCodes();
    const paid = await pay(31);
    assert.equal(paid.body.ok, true, 'thanh toán vẫn chạy bình thường');
    assert.equal(paid.body.nextVoucher, undefined);
    assert.equal(await nextCodes(), before, 'tắt thì không tặng mã lần sau');
  } finally {
    await setSwitch(true);
  }
  // Bật lại: mã dùng được ngay, 8 lần bị từ chối lúc tắt không bị tính là dò mã.
  const ok = await customerRedeem('BK-SWTCHB', 30, 300);
  assert.deepEqual([ok.ok, ok.discount], [true, 30000]);
  assert.equal(await billTotal(await openBills(30)), 270000);
});
