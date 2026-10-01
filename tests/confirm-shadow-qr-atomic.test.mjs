import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
const account = '00000000-0000-4000-8000-000000000001';
await db.exec(`
  CREATE TABLE payment_transactions(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    transaction_code text UNIQUE, order_ids text, total_amount numeric,
    account_id uuid, status text);
  CREATE TABLE bank_daily_totals(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    account_id uuid, date date, total_amount numeric, UNIQUE(account_id,date));
`);
await db.exec(readFileSync(new URL('../supabase/migrations/confirm_shadow_qr_atomic.sql', import.meta.url), 'utf8'));

test('retries never double count a custom QR transfer', async () => {
  await db.query('INSERT INTO payment_transactions(transaction_code,order_ids,total_amount,account_id,status) VALUES ($1,$2,$3,$4,$5)',
    ['QR-200K','shadow_qr',200000,account,'pending']);
  const call = async () => (await db.query('SELECT confirm_shadow_qr_atomic($1,$2,$3) AS result',
    ['QR-200K',200000,account])).rows[0].result;
  assert.equal((await call()).already_completed,false);
  assert.equal((await call()).already_completed,true);
  assert.equal(Number((await db.query('SELECT total_amount FROM bank_daily_totals')).rows[0].total_amount),200000);
  await assert.rejects(db.query('SELECT confirm_shadow_qr_atomic($1,$2,$3)',
    ['QR-200K',20000,account]));
});
