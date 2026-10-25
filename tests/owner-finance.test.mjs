import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { costParts, monthBounds, noteCost, summarizeMonth, vnDate } from '../src/lib/ownerFinance.mjs';
import * as finance from '../src/lib/ownerFinance.mjs';

test('daily summary splits revenue, counts Sổ tay purchases with debt, entries, wages from attendance and a fixed daily share', () => {
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
      // Lương nhập tay kiểu cũ: không tính nữa (lương lấy từ chấm công).
      { kind: 'salary', entry_date: '2026-10-23', amount: 999999, label: 'Lan' },
      { kind: 'fixed', entry_date: '2026-10-01', amount: 3100000, category: 'rent' },
    ],
    // Lương theo chấm công: ngày 22 nằm trước ngày bắt đầu sổ nên không vào ngày nào; thưởng − phạt cả tháng 40.000đ.
    wages: { byDay: { '2026-10-22': 1, '2026-10-23': 250000, '2026-10-24': 250000 }, monthExtra: 40000 },
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
  assert.deepEqual([s.totals.salary, s.totals.salaryExtra], [540000, 40000], 'month salary = days + bonus/fines');
  assert.equal(s.totals.profit, d23.profit + d24.profit - 40000);
  assert.equal(summarizeMonth({ month: '2026-10', today: '2026-10-24', startDate: '2026-10-23', entries: [{ kind: 'salary', entry_date: '2026-10-23', amount: 5 }] }).days[0].salary, 0,
    'no attendance data → no salary, typed salaries are ignored');
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

test('Sổ tay prices are read like the Sổ tay page and prices under 1.000đ are flagged', async () => {
  const { parseNotePrice, suspiciousNoteItems } = await import('../src/lib/ownerFinance.mjs');
  assert.equal(parseNotePrice('250k'), 250000);
  assert.equal(parseNotePrice('1.5k'), 1500);
  assert.equal(parseNotePrice('250'), 250);
  assert.equal(parseNotePrice('250.000'), 250, 'the Sổ tay page reads a dotted price as 250đ too');
  assert.deepEqual(suspiciousNoteItems([
    { name: 'Ốc', price: '250' }, { name: 'Hàu', price: '300k' }, { name: 'Tiền rau', price: '' }, { name: 'Mực', price: '250.000' },
  ]).map(i => i.name), ['Ốc', 'Mực']);
});

test('a day close compares counted cash and bank money with the ledger', () => {
  const s = summarizeMonth({
    month: '2026-10', today: '2026-10-25', startDate: '2026-10-23',
    revenue: [
      { business_date: '2026-10-23', amount: 500000, payment_method: 'cash' },
      { business_date: '2026-10-23', amount: 300000, payment_method: 'transfer', account_id: 'A' },
    ],
    notes: [{ note_type: 'expense', created_at: '2026-10-24T02:00:00Z', amount: 250, debt: 0,
      content: JSON.stringify({ type: 'structured_expense', items: [{ name: 'Ốc', price: '250' }] }) }],
    closes: [
      { business_date: '2026-10-23', cash_counted: 480000, bank_counted: { A: 300000 }, closed_by_name: 'Chủ' },
      { business_date: '2026-10-24', cash_counted: null, bank_counted: { A: 50000 } },
    ],
  });
  const [d23, d24, d25] = s.days;
  assert.deepEqual([d23.close.cashDiff, d23.close.bankDiffs.A, d23.close.closedBy], [-20000, 0, 'Chủ']);
  assert.equal(d24.close.cashDiff, null, 'cash not counted is not a difference');
  assert.equal(d24.close.bankDiffs.A, 50000);
  assert.equal(d24.suspiciousNotes, 1);
  assert.equal(d25.close, null);
});

test('the day close table is only reachable by the server', async () => {
  const db = await financeDb();
  try {
    await db.exec('SET ROLE anon');
    await assert.rejects(db.query('SELECT * FROM finance_day_closes'), /permission denied/);
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

test('the migration can be run again without dropping the existing trigger', async () => {
  const db = await financeDb();
  try {
    await db.exec(readFileSync(new URL('../supabase/migrations/owner_finance.sql', import.meta.url), 'utf8'));
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'capture_finance_revenue'`);
    assert.equal(rows[0].n, 1);
    await db.exec(`UPDATE orders SET status='paid', payment_method='cash', paid_at=now() WHERE customer_phone='0900';`);
    assert.equal((await db.query('SELECT 1 FROM finance_revenue_ledger')).rows.length, 1, 'recorded once, not twice');
  } finally { await db.close(); }
});

test('the daily Zalo report lists money per card, costs, profit and anything that needs a look', () => {
  const day = { date: '2026-10-24', revenue: 1200000, bills: 10, paperBills: 1, cash: 500000, byAccount: { a: 700000 },
    purchases: 400000, drinks: 100000, salary: 0, fixedShare: 50000, customTotal: 0, profit: 650000, suspiciousNotes: 1,
    close: { cashDiff: -20000, bankDiffs: { a: 0 } } };
  const text = finance.dailyReportText({ day, monthTotals: { revenue: 2000000, profit: -100000 }, accounts: [{ id: 'a', name: 'VCB' }], alerts: { missingPhoto: 2, unchecked: 0 } });
  assert.match(text, /T7 24\/10\/2026/);
  assert.match(text, /Doanh thu: 1\.200\.000đ \(10 bill \+ 1 bill giấy\)/);
  assert.match(text, /• CK VCB: 700\.000đ/);
  assert.match(text, /Chi: 550\.000đ \(đi chợ 400\.000đ, trong ngày 100\.000đ, cố định 50\.000đ\)/);
  assert.match(text, /Lãi ngày: \+650\.000đ/);
  assert.match(text, /Tháng 10 tới nay: thu 2\.000\.000đ · lỗ 100\.000đ/);
  assert.match(text, /⚠ Tiền mặt thiếu 20\.000đ/);
  assert.match(text, /⚠ 2 bill CK chưa có ảnh/);
  assert.match(text, /⚠ 1 phiếu Sổ tay/);
  assert.doesNotMatch(text, /VCB (thiếu|dư)|chưa đối chiếu|Chưa chốt/);
  const quiet = finance.dailyReportText({ day: { ...day, suspiciousNotes: 0, close: { cashDiff: 0, bankDiffs: {} } } });
  assert.match(quiet, /✓ Không có gì bất thường/);
  assert.match(finance.dailyReportText({ day: { ...day, close: null } }), /Máy chưa kiểm tra ngày này/);
  assert.doesNotMatch(finance.dailyReportText({ day: { ...day, close: null }, today: '2026-10-24' }), /chưa kiểm tra/i, 'today is still open');
  // Máy đã tự kiểm tra: không nhắc chốt sổ, kèm kết quả kiểm tra (phiếu Sổ tay chỉ báo một lần, trong kết quả).
  const checked = finance.dailyReportText({ day: { ...day, close: null, check: { ok: false, problems: 1 } },
    check: { ok: false, problems: 1, issues: [{ key: 'ck_no_photo', title: 'Bill chuyển khoản chưa có ảnh', count: 2, amount: 300000 }] } });
  assert.doesNotMatch(checked, /chưa kiểm tra|chốt sổ|⚠ 1 phiếu Sổ tay/i);
  assert.match(checked, /🤖 Máy tự kiểm tra: 1 việc cần xem\n• Bill chuyển khoản chưa có ảnh: 2 \(300\.000đ\)/);
});

test('a day of spending splits into: during the day, shopping, wages, fixed (shared out per day)', () => {
  const categories = [{ id: 'gas', scope: 'tab', schedule: 'daily' }, { id: 'loan', scope: 'tab', schedule: 'monthly' }];
  const day = { drinks: 350000, purchases: 1200000, salary: 900000, fixedShare: 300000, custom: { gas: 120000, loan: 50000 } };
  assert.deepEqual(costParts(day, categories), { daily: 470000, purchases: 1200000, salary: 900000, fixed: 350000 });
  assert.deepEqual(costParts({ drinks: 0, purchases: 0, salary: 0, fixedShare: 0 }), { daily: 0, purchases: 0, salary: 0, fixed: 0 });
});
