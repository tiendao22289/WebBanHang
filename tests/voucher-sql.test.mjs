import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// supabase/migrations/vouchers.sql chạy trên Postgres thật (PGlite): dùng mã, mỗi mã 1 lần,
// trả mã khi dòng voucher rời bill đang mở, quyền gọi hàm.
const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sql = readFileSync(new URL('../supabase/migrations/vouchers.sql', import.meta.url), 'utf8');

await db.exec(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
  END $$;
  CREATE TABLE settings(key text PRIMARY KEY, value text);
  CREATE TABLE tables(id uuid PRIMARY KEY, table_number integer, merged_with uuid, table_type text);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables, status text, total_amount numeric DEFAULT 0,
    customer_phone text, created_at timestamptz DEFAULT now());
  CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders ON DELETE CASCADE,
    menu_item_id uuid, item_name text, quantity integer NOT NULL DEFAULT 1, unit_price integer NOT NULL DEFAULT 0,
    is_gift boolean DEFAULT false, note text, added_by_id uuid, added_by_name text);
`);
await db.exec(sql);
await db.exec(sql); // chạy lại không lỗi

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
const STAFF = id(900);

async function voucher(code, extra = {}) {
  const v = { source: 'gift', discount_type: 'amount', discount_value: 30000, max_discount: 0, min_bill: 0,
    valid_from: iso(NOW - 3600000), valid_until: iso(NOW + 86400000), status: 'active', ...extra };
  await db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, max_discount, min_bill, valid_from, valid_until, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [code, v.source, v.discount_type, v.discount_value, v.max_discount, v.min_bill, v.valid_from, v.valid_until, v.status]);
}
const redeem = async (code, orders) => (await db.query('SELECT redeem_voucher($1,$2,$3,$4) AS r', [code, orders, STAFF, 'Thu ngân'])).rows[0].r;
const row = async code => (await db.query('SELECT * FROM vouchers WHERE code = $1', [code])).rows[0];
const items = async order => (await db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY unit_price', [order])).rows;

// Bàn 5 (host 1) gộp bàn 6 (2): bill 10 (cũ hơn) + 11. Bàn 7 (3) riêng: bill 12.
beforeEach(async () => {
  await db.exec('TRUNCATE vouchers, order_items, orders, tables CASCADE');
  await db.query('INSERT INTO tables(id, table_number, merged_with) VALUES ($1,5,NULL),($2,6,$1),($3,7,NULL)', [id(1), id(2), id(3)]);
  await db.query(`INSERT INTO orders(id, table_id, status, created_at) VALUES
    ($1,$2,'pending',now() - interval '30 min'), ($3,$4,'completed',now() - interval '10 min'), ($5,$6,'pending',now())`,
  [id(10), id(1), id(11), id(2), id(12), id(3)]);
  await db.query(`INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price, is_gift) VALUES
    ($1,$4,2,100000,false), ($2,$4,1,80000,false), ($2,$4,1,50000,true), ($3,$4,1,150000,false)`, [id(10), id(11), id(12), id(500)]);
});

test('dùng mã: ghi 1 dòng giảm vào bill cũ nhất của nhóm, chốt mã đã dùng', async () => {
  await voucher('BK-AAAAAA');
  const r = await redeem(' bk-aaaaaa ', [id(10), id(11)]);
  assert.equal(r.ok, true);
  assert.equal(r.discount, 30000);
  assert.equal(r.order_id, id(10));
  const line = (await items(id(10)))[0];
  assert.deepEqual([line.item_name, line.unit_price, line.quantity, line.menu_item_id, line.is_gift, line.added_by_name],
    ['Voucher BK-AAAAAA', -30000, 1, null, false, 'Thu ngân']);
  const v = await row('BK-AAAAAA');
  assert.equal(v.status, 'used');
  assert.equal(v.used_item_id, line.id);
  assert.equal(v.used_table_id, id(1));
  assert.equal(v.discount_amount, 30000);
  assert.equal(v.bill_total, 280000, 'tiền món không tính dòng quà');
});

test('mỗi mã chỉ dùng 1 lần — lần 2 báo đã dùng ở bàn nào', async () => {
  await voucher('BK-AAAAAA');
  assert.equal((await redeem('BK-AAAAAA', [id(10), id(11)])).ok, true);
  const again = await redeem('BK-AAAAAA', [id(12)]);
  assert.deepEqual([again.ok, again.reason, again.table_number], [false, 'used', 5]);
  assert.equal((await items(id(12))).length, 1, 'bàn 7 không bị trừ');
});

test('mỗi bill chỉ 1 voucher — gửi thiếu bill của bàn gộp cũng không lách được', async () => {
  await voucher('BK-AAAAAA');
  await voucher('BK-BBBBBB');
  assert.equal((await redeem('BK-AAAAAA', [id(10), id(11)])).ok, true);
  const second = await redeem('BK-BBBBBB', [id(11)]);
  assert.deepEqual([second.ok, second.reason], [false, 'bill_has_voucher']);
  assert.equal((await row('BK-BBBBBB')).status, 'active', 'mã thứ 2 vẫn còn để lần khác dùng');
  assert.equal((await redeem('BK-BBBBBB', [id(10)])).reason, 'bill_has_voucher');
});

test('mang về (chung 1 bàn ảo): mỗi khách 1 voucher cho bill của mình', async () => {
  await db.query("INSERT INTO tables(id, table_number, table_type) VALUES ($1, 99, 'takeaway')", [id(4)]);
  await db.query("INSERT INTO orders(id, table_id, status, customer_phone) VALUES ($1,$3,'pending','0901111111'), ($2,$3,'pending','0902222222'), ($4,$3,'pending','0901111111')", [id(20), id(21), id(4), id(22)]);
  await db.query('INSERT INTO order_items(order_id, menu_item_id, unit_price) VALUES ($1,$4,90000), ($2,$4,90000), ($3,$4,90000)', [id(20), id(21), id(22), id(500)]);
  await voucher('BK-TWAAAA'); await voucher('BK-TWBBBB'); await voucher('BK-TWCCCC');
  assert.equal((await redeem('BK-TWAAAA', [id(20)])).ok, true);
  assert.equal((await redeem('BK-TWBBBB', [id(21)])).ok, true, 'khách khác cùng bàn mang về vẫn dùng được');
  assert.equal((await redeem('BK-TWCCCC', [id(22)])).reason, 'bill_has_voucher', 'bill thứ 2 của cùng khách');
});

test('mã sai / hết hạn / chưa tới ngày / đã huỷ đều bị từ chối, không ghi gì vào bill', async () => {
  await voucher('BK-EXPRED', { valid_from: iso(NOW - 3 * 86400000), valid_until: iso(NOW - 1000) });
  await voucher('BK-NEXTDY', { valid_from: iso(NOW + 3600000) });
  await voucher('BK-CANCEL', { status: 'cancelled' });
  for (const [code, reason] of [['BK-NOPENO', 'not_found'], ['BK-EXPRED', 'expired'], ['BK-NEXTDY', 'not_yet'], ['BK-CANCEL', 'cancelled']]) {
    const r = await redeem(code, [id(12)]);
    assert.deepEqual([r.ok, r.reason], [false, reason], code);
  }
  assert.equal((await items(id(12))).length, 1);
});

test('bill chưa đủ mức tối thiểu thì không dùng được (quà và dòng giảm khác không tính)', async () => {
  await voucher('BK-MINBIL', { min_bill: 200000 });
  await db.query("INSERT INTO order_items(order_id, item_name, quantity, unit_price) VALUES ($1, 'Giảm giá', 1, -20000)", [id(12)]);
  const r = await redeem('BK-MINBIL', [id(12)]);
  assert.deepEqual([r.ok, r.reason, Number(r.min_bill), Number(r.base)], [false, 'min_bill', 200000, 150000]);
  assert.equal((await row('BK-MINBIL')).status, 'active');
});

test('voucher %: làm tròn xuống 1.000đ, chặn trần; voucher tiền không giảm quá tiền món', async () => {
  await voucher('BK-PCTPCT', { discount_type: 'percent', discount_value: 15, max_discount: 30000 });
  await voucher('BK-PCTSML', { discount_type: 'percent', discount_value: 7 });
  await voucher('BK-BIGBIG', { discount_value: 500000 });
  assert.equal((await redeem('BK-PCTPCT', [id(10), id(11)])).discount, 30000); // 15% × 280.000 = 42.000 → trần 30.000
  assert.equal((await redeem('BK-PCTSML', [id(12)])).discount, 10000); // 7% × 150.000 = 10.500 → 10.000
  await db.query('DELETE FROM order_items WHERE order_id = $1 AND unit_price < 0', [id(12)]);
  assert.equal((await redeem('BK-BIGBIG', [id(12)])).discount, 150000, 'bill không âm tiền');
});

test('bill đã thanh toán / khác nhóm bàn / thiếu bill → không trừ', async () => {
  await voucher('BK-AAAAAA');
  assert.equal((await redeem('BK-AAAAAA', [])).reason, 'no_bill');
  assert.equal((await redeem('BK-AAAAAA', [id(10), id(12)])).reason, 'bill_changed', 'bàn 5 và bàn 7 không gộp');
  assert.equal((await redeem('BK-AAAAAA', [id(10), id(999)])).reason, 'bill_changed', 'bill không tồn tại');
  await db.query("UPDATE orders SET status = 'paid' WHERE id = $1", [id(12)]);
  assert.equal((await redeem('BK-AAAAAA', [id(12)])).reason, 'bill_changed');
  assert.equal((await row('BK-AAAAAA')).status, 'active');
});

test('xoá dòng voucher khỏi bill đang mở → mã dùng lại được', async () => {
  await voucher('BK-AAAAAA');
  const r = await redeem('BK-AAAAAA', [id(12)]);
  await db.query('DELETE FROM order_items WHERE id = $1', [r.item_id]);
  const v = await row('BK-AAAAAA');
  assert.deepEqual([v.status, v.used_item_id, v.discount_amount], ['active', null, 0]);
  assert.equal((await redeem('BK-AAAAAA', [id(12)])).ok, true);
});

test('bill đã thanh toán bị dọn khỏi DB → mã vẫn là đã dùng (không hồi sinh)', async () => {
  await voucher('BK-AAAAAA');
  await redeem('BK-AAAAAA', [id(12)]);
  await db.query("UPDATE orders SET status = 'paid' WHERE id = $1", [id(12)]);
  await db.query('DELETE FROM orders WHERE id = $1', [id(12)]);
  assert.equal((await row('BK-AAAAAA')).status, 'used');
});

test('huỷ bill còn dòng voucher → trả mã; gộp bill (dòng chuyển sang bill chính) → mã vẫn đã dùng', async () => {
  await voucher('BK-CANCEL');
  await redeem('BK-CANCEL', [id(12)]);
  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id(12)]);
  assert.equal((await row('BK-CANCEL')).status, 'active');

  // Gộp bill 11 vào 10 như merge_bills_atomic: chuyển dòng rồi mới huỷ bill phụ.
  await voucher('BK-MERGED');
  const r = await redeem('BK-MERGED', [id(11)]);
  assert.equal(r.order_id, id(11));
  await db.query('UPDATE order_items SET order_id = $1 WHERE order_id = $2', [id(10), id(11)]);
  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [id(11)]);
  assert.equal((await row('BK-MERGED')).status, 'used');
});

test('khoá công khai không đọc được bảng mã, không gọi được hàm dùng mã', async () => {
  const { rows: [p] } = await db.query(`SELECT
    has_table_privilege('anon', 'public.vouchers', 'SELECT') AS anon_read,
    has_table_privilege('authenticated', 'public.vouchers', 'UPDATE') AS auth_write,
    has_function_privilege('anon', 'public.redeem_voucher(text,uuid[],uuid,text)', 'EXECUTE') AS anon_exec,
    has_function_privilege('authenticated', 'public.redeem_voucher(text,uuid[],uuid,text)', 'EXECUTE') AS auth_exec,
    has_function_privilege('service_role', 'public.redeem_voucher(text,uuid[],uuid,text)', 'EXECUTE') AS server_exec,
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.vouchers'::regclass) AS rls`);
  assert.deepEqual(p, { anon_read: false, auth_write: false, anon_exec: false, auth_exec: false, server_exec: true, rls: true });
});

test('cài đặt "Hẹn lần sau" mặc định TẮT, chạy lại migration không ghi đè lựa chọn của chủ quán', async () => {
  await db.query("UPDATE settings SET value = 'true' WHERE key = 'voucher_next_enabled'");
  await db.exec(sql);
  const { rows } = await db.query("SELECT key, value FROM settings WHERE key LIKE 'voucher_next_%' ORDER BY key");
  assert.equal(rows.length, 8);
  assert.equal(rows.find(r => r.key === 'voucher_next_enabled').value, 'true');
  await db.query("UPDATE settings SET value = 'false' WHERE key = 'voucher_next_enabled'");
});
