import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
await db.exec(`
  CREATE TABLE orders(id uuid PRIMARY KEY, status text, total_amount numeric);
  CREATE TABLE order_items(id uuid PRIMARY KEY, order_id uuid REFERENCES orders,
    quantity integer, unit_price numeric);
`);
const sql = readFileSync(new URL('../supabase/migrations/order_total_follows_items.sql', import.meta.url), 'utf8');
await db.exec(sql);
const orderId = '00000000-0000-4000-8000-000000000001';
const itemId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('added, changed, and removed items determine the bill even after stale total writes', async () => {
  await db.query('INSERT INTO orders VALUES ($1,$2,$3)', [orderId, 'pending', 0]);
  await db.query('INSERT INTO order_items VALUES ($1,$2,$3,$4)', [itemId(2), orderId, 1, 150000]);
  await db.query('INSERT INTO order_items VALUES ($1,$2,$3,$4)', [itemId(3), orderId, 2, 50000]);
  await db.query('UPDATE orders SET total_amount=150000 WHERE id=$1', [orderId]);
  let result = await db.query('SELECT total_amount FROM orders WHERE id=$1', [orderId]);
  assert.equal(Number(result.rows[0].total_amount), 250000);

  await db.query('UPDATE order_items SET quantity=3 WHERE id=$1', [itemId(3)]);
  result = await db.query('SELECT total_amount FROM orders WHERE id=$1', [orderId]);
  assert.equal(Number(result.rows[0].total_amount), 300000);

  await db.query('DELETE FROM order_items WHERE id=$1', [itemId(2)]);
  result = await db.query('SELECT total_amount FROM orders WHERE id=$1', [orderId]);
  assert.equal(Number(result.rows[0].total_amount), 150000);
});
