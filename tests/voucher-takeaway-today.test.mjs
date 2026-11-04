import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { takeawayVoucherBills } from '../src/lib/voucherServer.mjs';

// voucher_takeaway_today.sql: bill mang về giao xong vẫn 'completed' và không bao giờ thu tiền. Voucher
// chỉ được trừ / tính mức tối thiểu trên bill mang về HÔM NAY (từ 05:00) chưa giao.
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const db = new PGlite();
after(() => db.close());
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE tables(id uuid PRIMARY KEY, table_number integer, merged_with uuid, table_type text);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables, status text, total_amount numeric DEFAULT 0,
    customer_phone text, created_at timestamptz DEFAULT now());
  CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders ON DELETE CASCADE,
    menu_item_id uuid, item_name text, quantity integer NOT NULL DEFAULT 1, unit_price integer NOT NULL DEFAULT 0,
    is_gift boolean DEFAULT false, note text, added_by_id uuid, added_by_name text);
`);
await db.exec(migration('vouchers.sql'));
await db.exec(migration('voucher_takeaway_today.sql'));
await db.exec(migration('voucher_takeaway_today.sql')); // chạy lại không lỗi
await db.exec("UPDATE voucher_settings SET value = 'true' WHERE key = 'voucher_enabled'");

const DAY_START = `((date_trunc('day', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '5 hours') + interval '5 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
const voucher = (code, minBill = 0) => db.query(`INSERT INTO vouchers(code, source, discount_type, discount_value, min_bill, valid_from, valid_until)
  VALUES ($1,'gift','amount',30000,$2, now() - interval '1 day', now() + interval '1 day')`, [code, minBill]);
const redeem = async (code, orderIds) => (await db.query('SELECT redeem_voucher($1,$2,NULL,$3) AS r', [code, orderIds, 'Khách tự nhập mã'])).rows[0].r;
async function bill(n, table, status, phone, amount, createdAt = 'now()') {
  await db.query(`INSERT INTO orders(id, table_id, status, customer_phone, created_at) VALUES ($1,$2,$3,$4,${createdAt})`, [id(n), table, status, phone]);
  await db.query('INSERT INTO order_items(order_id, menu_item_id, unit_price) VALUES ($1,$2,$3)', [id(n), id(500), amount]);
}

test('the reviewer case: last week\'s delivered takeaway bill neither meets the minimum nor takes the voucher', async () => {
  await db.query("INSERT INTO tables VALUES ($1, 99, NULL, 'takeaway')", [id(4)]);
  await bill(20, id(4), 'completed', '0901111111', 300000, `now() - interval '7 days'`); // đã giao tuần trước
  await bill(21, id(4), 'pending', '0901111111', 50000); // đơn hôm nay
  await voucher('BK-TWAAAA', 200000);
  const r1 = await redeem('BK-TWAAAA', [id(20), id(21)]); // trang cũ còn gửi cả bill cũ
  assert.deepEqual([r1.ok, r1.reason, Number(r1.base)], [false, 'min_bill', 50000]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM order_items WHERE unit_price < 0')).rows[0].n, 0);
  await voucher('BK-TWBBBB', 0);
  const r2 = await redeem('BK-TWBBBB', [id(20), id(21)]);
  assert.deepEqual([r2.ok, r2.order_id], [true, id(21)], 'the discount lands on today\'s bill');
});

test('a takeaway bill already delivered today, or one from before 05:00, does not take a voucher; the next voucher of the phone still works later', async () => {
  await bill(22, id(4), 'completed', '0902222222', 400000); // giao rồi
  await bill(23, id(4), 'pending', '0902222222', 400000, `${DAY_START} - interval '1 hour'`); // tối qua, chưa giao
  await voucher('BK-TWCCCC');
  assert.equal((await redeem('BK-TWCCCC', [id(22), id(23)])).reason, 'no_bill');
  await bill(24, id(4), 'pending', '0902222222', 120000);
  const r = await redeem('BK-TWCCCC', [id(24)]);
  assert.deepEqual([r.ok, r.order_id, r.discount], [true, id(24), 30000]);
});

test('dine-in tables are unchanged: every open bill of the group counts, a completed one included', async () => {
  await db.query("INSERT INTO tables VALUES ($1, 5, NULL, 'normal'), ($2, 6, $1, 'normal')", [id(1), id(2)]);
  await bill(30, id(1), 'completed', '0903333333', 150000, `now() - interval '20 hours'`);
  await bill(31, id(2), 'pending', null, 100000);
  await voucher('BK-DINEAA', 200000);
  const r = await redeem('BK-DINEAA', [id(30), id(31)]);
  assert.deepEqual([r.ok, r.order_id], [true, id(30)]);
  await voucher('BK-DINEBB');
  assert.equal((await redeem('BK-DINEBB', [id(31)])).reason, 'bill_has_voucher', 'one voucher per table group');
});

test('the customer route sends only the customer\'s own takeaway bills of today that are not delivered yet', () => {
  const now = Date.parse('2026-11-04T17:20:00Z'); // 00:20 giờ VN, ngày bán hàng 4/11 bắt đầu 2026-11-03T22:00Z
  const bills = [
    { id: 'mine', customer_phone: '0901111111', status: 'pending', created_at: '2026-11-04T17:00:00Z' },
    { id: 'same-phone', customer_phone: '+84901111111', status: 'preparing', created_at: '2026-11-04T12:00:00Z' },
    { id: 'delivered', customer_phone: '0901111111', status: 'completed', created_at: '2026-11-04T13:00:00Z' },
    { id: 'last-week', customer_phone: '0901111111', status: 'pending', created_at: '2026-10-28T13:00:00Z' },
    { id: 'before-5am', customer_phone: '0901111111', status: 'pending', created_at: '2026-11-03T21:00:00Z' },
    { id: 'other', customer_phone: '0909999999', status: 'pending', created_at: '2026-11-04T17:00:00Z' },
  ];
  assert.deepEqual(takeawayVoucherBills(bills, bills[0], now).map(b => b.id), ['mine', 'same-phone']);
});
