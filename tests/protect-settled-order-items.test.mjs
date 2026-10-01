import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
await db.exec(`
  CREATE TABLE orders(id uuid PRIMARY KEY, status text);
  CREATE TABLE order_items(id uuid PRIMARY KEY, order_id uuid REFERENCES orders,
    quantity integer);
  INSERT INTO orders VALUES
    ('00000000-0000-4000-8000-000000000001','pending'),
    ('00000000-0000-4000-8000-000000000002','paid');
  INSERT INTO order_items VALUES
    ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',1);
`);
await db.exec(readFileSync(new URL('../supabase/migrations/protect_settled_order_items.sql', import.meta.url), 'utf8'));

test('open bill remains editable, paid bill rejects late items and edits', async () => {
  await db.exec("UPDATE order_items SET quantity=2 WHERE id='00000000-0000-4000-8000-000000000003'");
  await assert.rejects(db.exec("INSERT INTO order_items VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002',1)"));
  await db.exec("UPDATE orders SET status='paid' WHERE id='00000000-0000-4000-8000-000000000001'");
  await assert.rejects(db.exec("UPDATE order_items SET quantity=3 WHERE id='00000000-0000-4000-8000-000000000003'"));
  await assert.rejects(db.exec("DELETE FROM order_items WHERE id='00000000-0000-4000-8000-000000000003'"));
  assert.equal((await db.query('SELECT quantity FROM order_items')).rows[0].quantity,2);
});
