import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Sổ thu chi (finance_ledger_checkout_sum.sql): các dòng sổ của 1 lần đóng bàn cộng lại đúng bằng
// tiền thu, kể cả khi dòng giảm giá làm bill cũ nhất của nhóm bàn bị âm.
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const db = new PGlite();
after(() => db.close());
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE tables(id uuid PRIMARY KEY, table_number int, merged_with uuid, status text, occupied_at timestamptz);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid, status text, customer_phone text, customer_name text,
    total_amount numeric, payment_method text, paid_at timestamptz, paid_by_id uuid, paid_by_name text,
    created_at timestamptz DEFAULT now(), is_hidden_from_stats boolean);
  CREATE TABLE menu_items(id uuid PRIMARY KEY, name text);
  CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, menu_item_id uuid, item_name text,
    quantity int, unit_price numeric, item_options jsonb, is_gift boolean DEFAULT false);
  CREATE TABLE bank_accounts(id uuid PRIMARY KEY, is_active boolean, is_visible boolean);
  CREATE TABLE bank_daily_totals(id uuid DEFAULT gen_random_uuid(), account_id uuid, date date, total_amount numeric, UNIQUE(account_id, date));
  CREATE TABLE payment_transactions(transaction_code text, order_ids text, status text, account_id uuid, total_amount numeric);
`);
await db.exec(migration('owner_finance.sql'));
await db.exec(migration('complete_table_payment_atomic.sql'));

const ledger = async () => (await db.query('SELECT order_id, amount::int AS amount FROM finance_revenue_ledger ORDER BY order_id')).rows;
const ledgerSum = async () => (await ledger()).reduce((s, r) => s + r.amount, 0);

async function reset() {
  await db.exec('TRUNCATE order_items, orders, tables, finance_revenue_ledger, bank_daily_totals, payment_transactions');
  // Bàn 4 + bàn 5 gộp vào. Bill A (cũ nhất) = khách quét QR gọi 2 bia; bill B = nhân viên gọi đồ ăn.
  await db.query(`INSERT INTO tables VALUES ($1,4,NULL,'occupied',now()), ($2,5,$1,'occupied',now())`, [id(1), id(2)]);
  await db.query(`INSERT INTO orders(id,table_id,status,customer_phone,customer_name,created_at) VALUES
    ($1,$2,'pending','0901234567','Lan', now() - interval '1 hour'), ($3,$4,'pending','Quản lý','Admin', now())`,
  [id(10), id(1), id(11), id(2)]);
  await db.query(`INSERT INTO order_items(order_id,menu_item_id,quantity,unit_price) VALUES ($1,$2,2,20000), ($3,$4,4,150000)`,
    [id(10), id(30), id(11), id(31)]);
  // "Giảm 10%" của cả bàn (640k) ghi vào bill cũ nhất A → A = 40k − 64k = −24k.
  await db.query(`INSERT INTO order_items(order_id,menu_item_id,item_name,quantity,unit_price) VALUES ($1,NULL,'Giảm 10%',1,-64000)`, [id(10)]);
}
const pay = async (total, method = 'cash') => (await db.query('SELECT complete_table_payment_atomic($1,$2,$3,$4) AS r',
  [id(1), [id(10), id(11)], total, method])).rows[0].r;

test('before the fix: a negative oldest bill makes the finance book record more than was collected', async () => {
  await reset();
  assert.equal((await pay(576000)).success, true);
  assert.equal(await ledgerSum(), 600000, 'owner_finance.sql alone records 0 + 600k for a 576k checkout');
});

test('the discount moves onto the biggest bill so the checkout sums to the money collected', async () => {
  await db.exec(migration('finance_ledger_checkout_sum.sql'));
  await reset();
  assert.equal((await pay(576000)).success, true);
  assert.deepEqual(await ledger(), [{ order_id: id(10), amount: 0 }, { order_id: id(11), amount: 576000 }]);
});

test('a discount bigger than the biggest bill spills over to the next bill', async () => {
  await reset();
  await db.query(`INSERT INTO orders(id,table_id,status,customer_phone,created_at) VALUES ($1,$2,'pending','x', now())`, [id(12), id(2)]);
  await db.query(`INSERT INTO order_items(order_id,menu_item_id,quantity,unit_price) VALUES ($1,$2,1,500000)`, [id(12), id(32)]);
  // Bill A: 40k − 64k − 700k (voucher + giảm tay) = −724k; B = 600k; C = 500k → thu 376k.
  await db.query(`INSERT INTO order_items(order_id,menu_item_id,item_name,quantity,unit_price) VALUES ($1,NULL,'Giảm giá',1,-700000)`, [id(10)]);
  const r = (await db.query('SELECT complete_table_payment_atomic($1,$2,$3,$4) AS r', [id(1), [id(10), id(11), id(12)], 376000, 'cash'])).rows[0].r;
  assert.equal(r.success, true);
  assert.deepEqual(await ledger(), [{ order_id: id(10), amount: 0 }, { order_id: id(11), amount: 0 }, { order_id: id(12), amount: 376000 }]);
});

test('bills without a negative line are recorded exactly as before', async () => {
  await reset();
  await db.query(`DELETE FROM order_items WHERE unit_price < 0`);
  assert.equal((await pay(640000)).success, true);
  assert.deepEqual(await ledger(), [{ order_id: id(10), amount: 40000 }, { order_id: id(11), amount: 600000 }]);
});

test('reopening the discounted bill gives the other bill its full amount back', async () => {
  await reset();
  assert.equal((await pay(576000)).success, true);
  await db.query(`UPDATE orders SET status = 'pending' WHERE id = $1`, [id(10)]);
  assert.deepEqual(await ledger(), [{ order_id: id(11), amount: 600000 }]);
});

test('old checkouts recorded too high are repaired when the migration runs, and a re-run changes nothing', async () => {
  await reset();
  await db.query(`DELETE FROM order_items WHERE unit_price < 0`);
  // Như sổ thật trước khi sửa: bill A âm ghi 0đ, bill B ghi đủ 600k.
  const paidAt = '2026-11-03T15:00:00Z';
  const items = total => JSON.stringify([{ name: 'x', quantity: 1, unit_price: total }]);
  await db.query(`INSERT INTO finance_revenue_ledger(order_id, paid_at, business_date, payment_method, amount, items) VALUES
    ($1,$3,'2026-11-03','cash',0,$4), ($2,$3,'2026-11-03','cash',600000,$5),
    ($6,$3,'2026-11-03','transfer',90000,$7), ($8,$3,'2026-11-03','cash',150000,'[]')`,
  [id(50), id(51), paidAt, items(-24000), items(600000), id(52), items(90000), id(53)]);
  await db.exec(migration('finance_ledger_checkout_sum.sql'));
  const after = Object.fromEntries((await ledger()).map(r => [r.order_id, r.amount]));
  // 0 + 576k + 150k (dòng cũ không có món: giữ nguyên) = tiền mặt; lần thu chuyển khoản không đổi.
  assert.deepEqual([after[id(50)], after[id(51)], after[id(52)], after[id(53)]], [0, 576000, 90000, 150000]);
  await db.exec(migration('finance_ledger_checkout_sum.sql'));
  assert.equal(after[id(51)], Object.fromEntries((await ledger()).map(r => [r.order_id, r.amount]))[id(51)]);
});
