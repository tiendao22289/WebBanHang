import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
await db.exec(`
  CREATE TABLE order_items(id uuid PRIMARY KEY, order_id uuid,
    quantity integer, unit_price numeric);
  CREATE TABLE print_jobs(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    order_id uuid, order_ids uuid[], only_item_ids uuid[]);
`);
await db.exec(readFileSync(new URL('../supabase/migrations/print_job_order_snapshot.sql', import.meta.url), 'utf8'));

test('job keeps an immutable view of both merged bill rows at queue time', async () => {
  await db.query('INSERT INTO order_items VALUES ($1,$2,1,100000),($3,$4,1,50000)',
    [id(10),id(1),id(11),id(2)]);
  await db.query('INSERT INTO print_jobs(order_id,order_ids) VALUES ($1,$2)',
    [id(1),[id(1),id(2)]]);
  await db.query('UPDATE order_items SET unit_price=120000 WHERE id=$1',[id(10)]);
  const { rows } = await db.query('SELECT order_items_at_queue FROM print_jobs');
  assert.equal(rows[0].order_items_at_queue.length,2);
  assert.equal(Number(rows[0].order_items_at_queue[0].unit_price),100000);
});
