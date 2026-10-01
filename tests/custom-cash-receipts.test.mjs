import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
await db.exec(readFileSync(new URL('../supabase/migrations/custom_cash_receipts.sql', import.meta.url), 'utf8'));
const id = '00000000-0000-4000-8000-000000000001';

test('same cash confirmation writes one receipt and rejects a changed amount', async () => {
  await db.query('SELECT record_custom_cash_receipt($1,$2)',[id,200000]);
  await db.query('SELECT record_custom_cash_receipt($1,$2)',[id,200000]);
  await assert.rejects(db.query('SELECT record_custom_cash_receipt($1,$2)',[id,20000]));
  const { rows } = await db.query('SELECT amount FROM custom_cash_receipts');
  assert.equal(rows.length,1);
  assert.equal(Number(rows[0].amount),200000);
});
