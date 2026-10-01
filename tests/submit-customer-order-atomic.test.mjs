import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
await db.exec(`
  CREATE TABLE tables(id uuid PRIMARY KEY, status text, occupied_at timestamptz);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables,
    customer_id uuid, customer_name text, customer_phone text, status text,
    total_amount numeric, delivery_address text, customer_note text);
  CREATE TABLE order_items(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id uuid REFERENCES orders, menu_item_id uuid, quantity integer,
    unit_price numeric, item_options jsonb, note text, is_gift boolean);
  INSERT INTO tables(id,status) VALUES ('${id(1)}','available');
`);
await db.exec(readFileSync(new URL('../supabase/migrations/submit_customer_order_atomic.sql', import.meta.url), 'utf8'));

const items = JSON.stringify([
  { menu_item_id:id(20), quantity:1, unit_price:150000, item_options:[], is_gift:false },
  { menu_item_id:id(21), quantity:1, unit_price:0, item_options:[], is_gift:true },
]);
async function submit(orderId, itemPayload=items) {
  const { rows } = await db.query('SELECT submit_customer_order_atomic($1,$2,$3,$4,$5,$6,$7,$8)',
    [orderId,id(1),null,'Khách','0900000000',null,null,itemPayload]);
  return rows[0].submit_customer_order_atomic;
}

test('retry uses the same order and items, and the table is occupied', async () => {
  assert.equal((await submit(id(10))).already_submitted, false);
  assert.equal((await submit(id(10))).already_submitted, true);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM orders')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM order_items')).rows[0].n,2);
  assert.equal((await db.query('SELECT status FROM tables WHERE id=$1',[id(1)])).rows[0].status,'occupied');
});

test('bad item aborts the whole order and leaves the table unchanged', async () => {
  await assert.rejects(submit(id(11),JSON.stringify([{menu_item_id:id(20),quantity:0,unit_price:10000}])));
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM orders')).rows[0].n,1);
});
