import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
await db.exec(`
  CREATE TABLE tables(id uuid PRIMARY KEY, merged_with uuid, status text,
    occupied_at timestamptz);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables,
    status text, total_amount numeric, payment_method text, paid_at timestamptz,
    paid_by_id uuid, paid_by_name text, created_at timestamptz DEFAULT now(),
    is_hidden_from_stats boolean);
  CREATE TABLE order_items(id uuid PRIMARY KEY, order_id uuid REFERENCES orders,
    quantity integer, unit_price numeric, menu_item_id uuid, is_gift boolean DEFAULT false);
  CREATE TABLE bank_accounts(id uuid PRIMARY KEY, is_active boolean, is_visible boolean);
  CREATE TABLE bank_daily_totals(id uuid DEFAULT gen_random_uuid(), account_id uuid,
    date date, total_amount numeric, UNIQUE(account_id, date));
  CREATE TABLE payment_transactions(transaction_code text PRIMARY KEY, status text,
    order_ids text, total_amount numeric, account_id uuid);
`);
await db.exec(readFileSync(new URL('../supabase/migrations/complete_table_payment_atomic.sql', import.meta.url), 'utf8'));

async function reset() {
  await db.exec('TRUNCATE order_items, orders, tables, bank_daily_totals, bank_accounts, payment_transactions CASCADE');
  await db.query('INSERT INTO tables(id,status) VALUES ($1,$2),($3,$4)', [id(1),'occupied',id(2),'occupied']);
  await db.query('UPDATE tables SET merged_with=$1 WHERE id=$2', [id(1),id(2)]);
  await db.query('INSERT INTO orders(id,table_id,status,total_amount) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)',
    [id(10),id(1),'pending',100000,id(11),id(2),'completed',50000]);
  await db.query('INSERT INTO order_items(id,order_id,quantity,unit_price,menu_item_id) VALUES ($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',
    [id(20),id(10),1,100000,id(30),id(21),id(11),1,50000,id(31)]);
}
async function pay(amount, method='cash', account=null, code=null) {
  const { rows } = await db.query('SELECT complete_table_payment_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id(2),[id(10),id(11)],amount,method,account,false,null,null,code]);
  return rows[0].complete_table_payment_atomic;
}

test('changed amount does not pay either merged bill or release either table', async () => {
  await reset();
  const result = await pay(100000);
  assert.equal(result.success, false);
  assert.equal(result.reason, 'amount_changed');
  assert.deepEqual((await db.query('SELECT status FROM orders ORDER BY id')).rows.map(r => r.status), ['pending','completed']);
  assert.deepEqual((await db.query('SELECT status FROM tables ORDER BY id')).rows.map(r => r.status), ['occupied','occupied']);
});

test('cash closes both bills once without adding a bank transfer', async () => {
  await reset();
  assert.equal((await pay(150000)).success, true);
  assert.deepEqual((await db.query('SELECT status FROM orders ORDER BY id')).rows.map(r => r.status), ['paid','paid']);
  assert.deepEqual((await db.query('SELECT status FROM tables ORDER BY id')).rows.map(r => r.status), ['available','available']);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM bank_daily_totals')).rows[0].n, 0);
  assert.equal((await pay(150000)).success, false);
});

test('transfer records the actual QR account in the same transaction', async () => {
  await reset();
  await db.query('INSERT INTO bank_accounts VALUES ($1,true,true)', [id(40)]);
  assert.equal((await pay(150000,'transfer',id(40))).success, true);
  const { rows } = await db.query('SELECT account_id,total_amount FROM bank_daily_totals');
  assert.equal(rows[0].account_id,id(40));
  assert.equal(Number(rows[0].total_amount),150000);
});

test('wrong QR reference rolls back both paid statuses and bank total', async () => {
  await reset();
  await db.query('INSERT INTO bank_accounts VALUES ($1,true,true)', [id(40)]);
  await db.query('INSERT INTO payment_transactions VALUES ($1,$2,$3,$4,$5)',
    ['OLD-CODE','pending',`${id(10)},${id(11)}`,100000,id(40)]);
  await assert.rejects(pay(150000,'transfer',id(40),'OLD-CODE'), /Mã QR không còn khớp/);
  assert.deepEqual((await db.query('SELECT status FROM orders ORDER BY id')).rows.map(r => r.status), ['pending','completed']);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM bank_daily_totals')).rows[0].n, 0);
});

test('valid QR code settles the bill, transaction and bank ledger exactly once', async () => {
  await reset();
  await db.query('INSERT INTO bank_accounts VALUES ($1,true,true)', [id(40)]);
  await db.query('INSERT INTO payment_transactions VALUES ($1,$2,$3,$4,$5)',
    ['VALID-CODE','pending',`${id(10)},${id(11)}`,150000,id(40)]);
  assert.equal((await pay(150000,'transfer',id(40),'VALID-CODE')).success, true);
  assert.equal((await db.query('SELECT status FROM payment_transactions')).rows[0].status, 'completed');
  assert.deepEqual((await db.query('SELECT status FROM orders ORDER BY id')).rows.map(r => r.status), ['paid','paid']);
  assert.equal((await pay(150000,'transfer',id(40),'VALID-CODE')).success, false);
  assert.equal(Number((await db.query('SELECT total_amount FROM bank_daily_totals')).rows[0].total_amount),150000);
});
