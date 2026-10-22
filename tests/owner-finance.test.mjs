import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { monthBounds, noteCost, summarizeMonth, vnDate } from '../src/lib/ownerFinance.mjs';

test('daily summary splits revenue, counts Sổ tay purchases with debt, entries and a fixed daily share', () => {
  const s = summarizeMonth({
    month: '2026-10', today: '2026-10-24', startDate: '2026-10-23',
    revenue: [
      { business_date: '2026-10-22', amount: 999, payment_method: 'cash' },
      { business_date: '2026-10-23', amount: 300000, payment_method: 'cash' },
      { business_date: '2026-10-23', amount: 200000, payment_method: 'transfer', account_id: 'A' },
      { business_date: '2026-10-24', amount: 100000, payment_method: 'transfer', account_id: 'B' },
    ],
    notes: [
      { note_type: 'expense', created_at: '2026-10-23T01:00:00Z', amount: 150000, debt: 50000 },
      { note_type: 'repair', created_at: '2026-10-23T02:00:00Z', amount: 70000, debt: 0 },
      // 23:30 ngày 23 giờ VN = 16:30Z → vẫn là ngày 23
      { note_type: 'expense', created_at: '2026-10-23T16:30:00Z', amount: 10000, debt: 0 },
    ],
    entries: [
      { kind: 'drink', entry_date: '2026-10-23', amount: 80000 },
      { kind: 'salary', entry_date: '2026-10-23', amount: 250000, label: 'Lan' },
      { kind: 'salary', entry_date: '2026-10-24', amount: 250000, label: 'Lan' },
      { kind: 'fixed', entry_date: '2026-10-01', amount: 3100000, category: 'rent' },
    ],
  });
  assert.deepEqual(s.days.map(d => d.date), ['2026-10-23', '2026-10-24']);
  const [d23, d24] = s.days;
  assert.equal(d23.revenue, 500000);
  assert.equal(d23.cash, 300000);
  assert.equal(d23.transfer, 200000);
  assert.deepEqual(d23.byAccount, { A: 200000 });
  assert.equal(d23.purchases, 210000);
  assert.equal(d23.drinks, 80000);
  assert.equal(d23.salary, 250000);
  assert.equal(d23.fixedShare, 100000);
  assert.equal(d23.profit, 500000 - 210000 - 80000 - 250000 - 100000);
  assert.equal(d24.profit, 100000 - 250000 - 100000);
  assert.equal(s.fixedMonthTotal, 3100000);
  assert.equal(s.totals.revenue, 600000);
  assert.equal(s.totals.fixedShare, 200000);
  assert.deepEqual(s.totals.byAccount, { A: 200000, B: 100000 });
});

test('months before the start date or in the future have no days', () => {
  assert.equal(summarizeMonth({ month: '2026-09', today: '2026-10-24' }).days.length, 0);
  assert.equal(summarizeMonth({ month: '2026-11', today: '2026-10-24' }).days.length, 0);
  assert.equal(monthBounds('2026-02').daysInMonth, 28);
  assert.equal(vnDate('2026-10-22T17:00:00Z'), '2026-10-23');
  assert.equal(noteCost({ note_type: 'stock', amount: 5 }), 0);
});

async function financeDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE tables(id uuid PRIMARY KEY, table_number int);
    CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid, status text, customer_phone text, customer_name text,
      payment_method text, paid_at timestamptz);
    CREATE TABLE menu_items(id uuid PRIMARY KEY, name text);
    CREATE TABLE order_items(id uuid PRIMARY KEY, order_id uuid, menu_item_id uuid, item_name text, quantity int,
      unit_price numeric, item_options jsonb, is_gift boolean);
    CREATE TABLE payment_transactions(transaction_code text, order_ids text, status text, account_id uuid);
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/owner_finance.sql', import.meta.url), 'utf8'));
  await db.exec(`
    INSERT INTO tables VALUES ('00000000-0000-0000-0000-000000000001', 4);
    INSERT INTO menu_items VALUES ('00000000-0000-0000-0000-0000000000a1', 'Ốc hương');
    INSERT INTO orders VALUES
      ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'completed', '0900', 'Lan', NULL, NULL),
      ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'completed', 'BAO_BEP', 'Bếp', NULL, NULL);
    INSERT INTO order_items VALUES
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', NULL, 2, 120000, '[]', false),
      ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000011', NULL, 'GIẢM VÒNG XOAY', 1, -40000, NULL, false);
    INSERT INTO payment_transactions VALUES ('HD1', '00000000-0000-0000-0000-000000000011', 'pending', '00000000-0000-0000-0000-0000000000c1');
  `);
  return db;
}

test('paying a bill records its real amount and account, and the record outlives the bill', async () => {
  const db = await financeDb();
  try {
    await db.exec(`UPDATE orders SET status='paid', payment_method='transfer', paid_at='2026-10-23T16:30:00Z';`);
    let { rows } = await db.query('SELECT order_id, business_date::text, table_number, amount::int, account_id, jsonb_array_length(items) AS n FROM finance_revenue_ledger');
    assert.equal(rows.length, 1, 'kitchen calls are not revenue');
    assert.deepEqual(rows[0], { order_id: '00000000-0000-0000-0000-000000000011', business_date: '2026-10-23',
      table_number: '4', amount: 200000, account_id: '00000000-0000-0000-0000-0000000000c1', n: 2 });
    await db.exec(`DELETE FROM order_items; DELETE FROM payment_transactions; DELETE FROM orders;`);
    ({ rows } = await db.query('SELECT amount::int FROM finance_revenue_ledger'));
    assert.deepEqual(rows, [{ amount: 200000 }]);
  } finally { await db.close(); }
});

test('reopening a paid bill removes it from the ledger and paying again re-records it', async () => {
  const db = await financeDb();
  try {
    await db.exec(`UPDATE orders SET status='paid', payment_method='cash', paid_at=now() WHERE customer_phone='0900';`);
    await db.exec(`UPDATE orders SET status='pending' WHERE customer_phone='0900';`);
    assert.equal((await db.query('SELECT 1 FROM finance_revenue_ledger')).rows.length, 0);
    await db.exec(`UPDATE orders SET status='paid', payment_method='cash', paid_at=now() WHERE customer_phone='0900';`);
    const { rows } = await db.query('SELECT payment_method, account_id FROM finance_revenue_ledger');
    assert.deepEqual(rows, [{ payment_method: 'cash', account_id: null }]);
  } finally { await db.close(); }
});

test('a ledger failure never blocks payment', async () => {
  const db = await financeDb();
  try {
    await db.exec(`ALTER TABLE finance_revenue_ledger ADD CONSTRAINT never CHECK (amount < 0);`);
    await db.exec(`UPDATE orders SET status='paid', payment_method='cash', paid_at=now() WHERE customer_phone='0900';`);
    assert.equal((await db.query(`SELECT status FROM orders WHERE customer_phone='0900'`)).rows[0].status, 'paid');
    assert.equal((await db.query('SELECT 1 FROM finance_revenue_ledger')).rows.length, 0);
  } finally { await db.close(); }
});

test('the browser roles cannot read or write the finance tables', async () => {
  const db = await financeDb();
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM finance_revenue_ledger'), /permission denied/);
      await assert.rejects(db.query(`INSERT INTO finance_entries(entry_date, kind, label, amount) VALUES ('2026-10-23', 'drink', 'x', 1)`), /permission denied/);
      await db.exec('RESET ROLE');
    }
  } finally { await db.close(); }
});
