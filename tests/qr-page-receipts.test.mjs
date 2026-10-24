import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vnDate } from '../src/lib/ownerFinance.mjs';

// Trang Mã QR (/admin/qr): mỗi lần thu tiền DB tự ghi 1 bill giấy vào Sổ thu chi.
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const SHADOW = '00000000-0000-4000-8000-0000000000aa';
const CASH_ID = '00000000-0000-4000-8000-0000000000c1';

const db = new PGlite();
after(() => db.close());
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE tables(id uuid PRIMARY KEY, table_number int);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid, status text, customer_phone text, customer_name text,
    payment_method text, paid_at timestamptz);
  CREATE TABLE menu_items(id uuid PRIMARY KEY, name text);
  CREATE TABLE order_items(id uuid PRIMARY KEY, order_id uuid, menu_item_id uuid, item_name text, quantity int,
    unit_price numeric, item_options jsonb, is_gift boolean);
  -- Như bảng thật trên máy quán: khoá là transaction_code, không có cột id, account_id kiểu text.
  CREATE TABLE payment_transactions(transaction_code varchar PRIMARY KEY, order_ids text NOT NULL,
    created_at timestamptz DEFAULT now(), account_id text, total_amount numeric, status varchar DEFAULT 'pending');
  CREATE TABLE bank_daily_totals(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, account_id uuid, date date,
    total_amount numeric, UNIQUE(account_id, date));
`);
await db.exec(migration('custom_cash_receipts.sql'));
await db.exec(migration('confirm_custom_qr_payment.sql'));
await db.exec(migration('owner_finance.sql'));

const paper = async () => (await db.query(`SELECT source, business_date::text AS date, amount::int AS amount, payment_method,
  account_id, image_path, created_by_name, note FROM finance_manual_receipts ORDER BY source`)).rows;
const newQr = (code, amount) => db.query(`INSERT INTO payment_transactions(transaction_code, order_ids, account_id, total_amount, status)
  VALUES ($1, 'shadow_qr', $2, $3, 'pending')`, [code, SHADOW, amount]);
const confirm = (code, amount) => db.query('SELECT confirm_custom_qr_payment($1, $2, $3) AS r', [code, amount, SHADOW]);
const cash = (id, amount) => db.query('SELECT record_custom_cash_receipt($1, $2) AS r', [id, amount]);

test('a confirmed QR transfer lands in the finance book once, on the hidden card, with no bill photo yet', async () => {
  await newQr('QRAB1234', 350000);
  assert.deepEqual(await paper(), [], 'nothing while the customer has not paid');
  await confirm('QRAB1234', 350000);
  await confirm('QRAB1234', 350000); // bấm lại / mạng chập chờn
  assert.deepEqual(await paper(), [{
    source: 'qr:QRAB1234', date: vnDate(Date.now()), amount: 350000, payment_method: 'transfer',
    account_id: SHADOW, image_path: null, created_by_name: 'Trang Mã QR', note: 'Mã QR QRAB1234',
  }]);
  await db.exec('DELETE FROM finance_manual_receipts');
});

test('a cancelled QR code is never counted', async () => {
  await newQr('QRCANCEL', 90000);
  await db.exec(`UPDATE payment_transactions SET status = 'failed' WHERE transaction_code = 'QRCANCEL'`);
  assert.deepEqual(await paper(), []);
});

test('cash taken on the QR page lands in the finance book once', async () => {
  await cash(CASH_ID, 120000);
  await cash(CASH_ID, 120000);
  const rows = await paper();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    source: `cash:${CASH_ID}`, date: vnDate(Date.now()), amount: 120000, payment_method: 'cash',
    account_id: null, image_path: null, created_by_name: 'Trang Mã QR', note: null,
  });
  await db.exec('DELETE FROM finance_manual_receipts');
});

test('a broken finance book never blocks taking the money', async () => {
  await db.exec('ALTER TABLE finance_manual_receipts ADD CONSTRAINT never CHECK (amount < 0)');
  await newQr('QRBROKEN', 50000);
  assert.equal((await confirm('QRBROKEN', 50000)).rows[0].r.success, true);
  assert.equal((await cash('00000000-0000-4000-8000-0000000000c2', 40000)).rows[0].r.success, true);
  assert.equal((await db.query(`SELECT status FROM payment_transactions WHERE transaction_code = 'QRBROKEN'`)).rows[0].status, 'completed');
  assert.deepEqual(await paper(), []);
  await db.exec('ALTER TABLE finance_manual_receipts DROP CONSTRAINT never');
});

test('installing the finance book again keeps one trigger each and never double counts', async () => {
  await db.exec(migration('owner_finance.sql'));
  const triggers = (await db.query(`SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE tgname = 'capture_qr_page_receipt' ORDER BY 1`)).rows;
  assert.deepEqual(triggers.map(r => r.t), ['custom_cash_receipts', 'payment_transactions']);
  await newQr('QRAGAIN1', 70000);
  await confirm('QRAGAIN1', 70000);
  assert.equal((await paper()).length, 1);
});

test('table bills paid by QR are not touched (only the QR page code "shadow_qr")', async () => {
  await db.exec('DELETE FROM finance_manual_receipts');
  await db.query(`INSERT INTO payment_transactions(transaction_code, order_ids, account_id, total_amount, status)
    VALUES ('TABLE001', '00000000-0000-0000-0000-000000000011', $1, 200000, 'pending')`, [SHADOW]);
  await db.exec(`UPDATE payment_transactions SET status = 'completed' WHERE transaction_code = 'TABLE001'`);
  assert.deepEqual(await paper(), []);
});
