import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TABLE tables(id uuid PRIMARY KEY, status text, occupied_at timestamptz);
  CREATE TABLE orders(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, table_id uuid REFERENCES tables,
    customer_name text, customer_phone text, status text, total_amount numeric,
    created_by_id uuid, created_by_name text);
  CREATE TABLE order_items(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, order_id uuid REFERENCES orders,
    menu_item_id uuid, quantity integer, unit_price numeric, item_options jsonb, note text,
    item_name text, added_by_id uuid, added_by_name text, is_gift boolean DEFAULT false);
  INSERT INTO tables(id, status) VALUES ('${id(1)}', 'available'), ('${id(2)}', 'available');
`);
await db.exec(readFileSync(new URL('../supabase/migrations/confirm_draft_order_lines.sql', import.meta.url), 'utf8'));

const STAFF = id(90);
const NGHEU = id(20), BIA = id(21);
const line = (menuItem, qty, price, extra = {}) => ({ menu_item_id: menuItem, quantity: qty, unit_price: price, item_options: [], note: '', ...extra });
async function confirm(table, items) {
  const { rows } = await db.query('SELECT confirm_draft_order($1, $2, $3, $4) AS r', [table, JSON.stringify(items), STAFF, 'NV']);
  return rows[0].r;
}
const items = async table => (await db.query(
  `SELECT i.menu_item_id, i.quantity, i.unit_price::int AS price, i.is_gift FROM order_items i JOIN orders o ON o.id = i.order_id
   WHERE o.table_id = $1 ORDER BY i.is_gift, i.unit_price`, [table])).rows;

test('gửi lại cùng dòng nháp (mất phản hồi) không cộng món 2 lần', async () => {
  const draft = [line(BIA, 2, 17000, { line_id: id(100) })];
  const first = await confirm(id(1), draft);
  const again = await confirm(id(1), draft);
  assert.equal(again.order_id, first.order_id);
  assert.equal(again.skipped_lines, 1);
  assert.deepEqual(await items(id(1)), [{ menu_item_id: BIA, quantity: 2, price: 17000, is_gift: false }]);
  assert.equal((await db.query('SELECT status FROM tables WHERE id = $1', [id(1)])).rows[0].status, 'occupied');
});

test('gửi lại kèm món mới: chỉ ghi món mới', async () => {
  await confirm(id(1), [line(BIA, 2, 17000, { line_id: id(100) }), line(BIA, 1, 17000, { line_id: id(101) })]);
  assert.deepEqual(await items(id(1)), [{ menu_item_id: BIA, quantity: 3, price: 17000, is_gift: false }]);
});

test('món trả tiền không cộng vào dòng quà 0đ cùng món', async () => {
  const { order_id } = await confirm(id(2), [line(BIA, 1, 17000, { line_id: id(200) })]);
  await db.query(`INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price, item_options, note, added_by_id, is_gift)
    VALUES ($1, $2, 1, 0, '[]', '', $3, true)`, [order_id, NGHEU, STAFF]);
  const r = await confirm(id(2), [line(NGHEU, 2, 60000, { line_id: id(201) })]);
  assert.deepEqual((await items(id(2))).filter(i => i.menu_item_id === NGHEU), [
    { menu_item_id: NGHEU, quantity: 2, price: 60000, is_gift: false },
    { menu_item_id: NGHEU, quantity: 1, price: 0, is_gift: true },
  ]);
  assert.equal(Number(r.new_total), 17000 + 120000);
});

test('khác giá thì tách dòng, cùng giá thì cộng dồn', async () => {
  await confirm(id(2), [line(BIA, 1, 20000, { line_id: id(202) }), line(BIA, 1, 17000, { line_id: id(203) })]);
  assert.deepEqual((await items(id(2))).filter(i => i.menu_item_id === BIA), [
    { menu_item_id: BIA, quantity: 2, price: 17000, is_gift: false },
    { menu_item_id: BIA, quantity: 1, price: 20000, is_gift: false },
  ]);
});

test('số lượng < 1 hoặc giá âm bị từ chối, không ghi gì', async () => {
  const before = await items(id(2));
  await assert.rejects(confirm(id(2), [line(BIA, -4, 17000, { line_id: id(204) })]), /không hợp lệ/);
  await assert.rejects(confirm(id(2), [line(BIA, 1, -5000, { line_id: id(205) })]), /không hợp lệ/);
  assert.deepEqual(await items(id(2)), before);
});

test('trang cũ chưa gửi line_id vẫn ghi được', async () => {
  await confirm(id(2), [line(NGHEU, 1, 60000)]);
  assert.equal((await items(id(2))).find(i => i.menu_item_id === NGHEU && !i.is_gift).quantity, 3);
});
