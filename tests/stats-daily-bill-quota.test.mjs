import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE settings(key text PRIMARY KEY, value text);
  CREATE TABLE tables(id uuid PRIMARY KEY, merged_with uuid, status text, occupied_at timestamptz,
    table_type text DEFAULT 'normal');
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables,
    status text, total_amount numeric, payment_method text, paid_at timestamptz,
    paid_by_id uuid, paid_by_name text, created_at timestamptz DEFAULT now(),
    is_hidden_from_stats boolean, customer_name text, customer_phone text,
    customer_rating integer, customer_feedback text);
  CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders ON DELETE CASCADE,
    quantity integer, unit_price numeric, menu_item_id uuid, is_gift boolean DEFAULT false,
    item_name text, item_options jsonb, note text);
  CREATE TABLE bank_accounts(id uuid PRIMARY KEY, is_active boolean, is_visible boolean,
    daily_limit numeric, sort_order integer);
  CREATE TABLE bank_daily_totals(account_id uuid REFERENCES bank_accounts,
    date date, total_amount numeric, UNIQUE(account_id,date));
  CREATE TABLE payment_transactions(transaction_code text PRIMARY KEY, status text,
    order_ids text, total_amount numeric, account_id text);
  CREATE TABLE print_jobs(id uuid PRIMARY KEY, order_id uuid REFERENCES orders ON DELETE CASCADE,
    order_ids uuid[], status text);
  CREATE TABLE customer_reviews(id uuid DEFAULT gen_random_uuid(), table_id uuid,
    order_id uuid REFERENCES orders ON DELETE SET NULL,
    customer_name text, customer_phone text, rating integer, feedback text,
    created_at timestamptz DEFAULT now());
  CREATE TABLE lucky_spins(id uuid PRIMARY KEY, host_table_id uuid, customer_phone text,
    status text, prize_type text, prize_value numeric, applied_order_id uuid REFERENCES orders ON DELETE SET NULL,
    applied_item_id uuid, created_at timestamptz DEFAULT now(), session_started_at timestamptz,
    bill_total integer DEFAULT 0, discount_amount integer DEFAULT 0);
`);
for (const file of ['lucky_wheel_dynamic_percent.sql', 'complete_table_payment_atomic.sql', 'protect_settled_order_items.sql',
  'order_total_follows_items.sql', 'stats_daily_bill_quota.sql']) {
  await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
}

async function reset(enabled = true) {
  await db.exec(`TRUNCATE order_items, orders, tables, bank_daily_totals, bank_accounts,
    payment_transactions, print_jobs, customer_reviews, stats_daily_quotas, stats_bill_allocations,
    lucky_spins, settings CASCADE;
    UPDATE stats_quota_config SET enabled=${enabled}, start_hour=0, end_hour=1;`);
  await db.query('INSERT INTO bank_accounts VALUES ($1,true,true,5000000,1),($2,true,false,5000000,2),($3,true,false,5000000,3)',
    [id(40), id(41), id(42)]);
}

async function seedQuota(cash = 0, transfer = 0, target = 5000000) {
  // Use a finished test window, independent of the machine's current timezone.
  await db.query(`INSERT INTO stats_daily_quotas(date,account_id,base_amount,target_amount,
    cash_amount,transfer_amount,start_hour,end_hour)
    VALUES ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,$1,5000000,$2,$3,$4,-2,-1)`,
  [id(40), target, cash, transfer]);
}

async function openBill(n = 1, amount = 300000, parent = null) {
  await db.query('INSERT INTO tables(id,status,merged_with,occupied_at) VALUES ($1,$2,$3,now())',
    [id(n), 'occupied', parent ? id(parent) : null]);
  await db.query('INSERT INTO orders(id,table_id,status,total_amount) VALUES ($1,$2,$3,$4)',
    [id(n + 100), id(n), 'completed', amount]);
  await db.query('INSERT INTO order_items(id,order_id,quantity,unit_price,menu_item_id) VALUES ($1,$2,1,$3,$4)',
    [id(n + 200), id(n + 100), amount, id(30)]);
}

async function prepare(n = 1, amount = 300000, method = 'transfer', orderNumbers = [n]) {
  return (await db.query('SELECT prepare_stats_payment($1,$2,$3,$4) AS result',
    [id(n), orderNumbers.map(n => id(n + 100)), amount, method])).rows[0].result;
}
async function settle(n = 1, amount = 300000, method = 'cash', account = null, code = null, orderNumbers = [n]) {
  return (await db.query('SELECT complete_table_payment_atomic($1,$2,$3,$4,$5,false,NULL,NULL,$6) AS result',
    [id(n), orderNumbers.map(n => id(n + 100)), amount, method, account, code])).rows[0].result;
}
async function transaction(n, amount, account, code = 'VALID001') {
  await db.query('INSERT INTO payment_transactions VALUES ($1,$2,$3,$4,$5)',
    [code, 'pending', id(n + 100), amount, account]);
}
async function quota() { return (await db.query('SELECT * FROM stats_daily_quotas')).rows[0]; }

test('daily budget opens gradually in Vietnam time and is fully open at 23:00', async () => {
  const at = async time => Number((await db.query(`SELECT stats_quota_allowance(6000000,16,23,$1) AS n`,
    [`2026-10-03T${time}:00+07:00`])).rows[0].n);
  assert.equal(await at('15:00'), 0);
  assert.ok(await at('16:00') < 500000);
  assert.ok(await at('18:00') <= 2000000);
  assert.equal(await at('23:00'), 6000000);
});

test('disabled mode preserves original cash and bank behavior', async () => {
  await reset(false); await openBill();
  assert.deepEqual(await prepare(), { enabled: false });
  assert.equal((await settle()).success, true);
  assert.equal((await db.query('SELECT status FROM orders')).rows[0].status, 'paid');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stats_daily_quotas')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_daily_totals')).rows[0].n, 0);
});

test('cash and transfers use one budget, but cash is not a bank receipt', async () => {
  await reset(); await seedQuota(); await openBill();
  const cash = await settle();
  assert.equal(cash.selected_for_stats, true);
  assert.equal(Number((await quota()).cash_amount), 300000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_daily_totals')).rows[0].n, 0);
  await openBill(2, 200000);
  const allocation = await prepare(2, 200000);
  assert.equal(allocation.selected, true);
  assert.equal(allocation.account_id, id(40));
  await transaction(2, 200000, allocation.account_id);
  assert.equal((await settle(2, 200000, 'transfer', id(40), 'VALID001')).selected_for_stats, true);
  const q = await quota();
  assert.equal(Number(q.cash_amount) + Number(q.transfer_amount), 500000);
  assert.equal(Number((await db.query('SELECT total_amount FROM bank_daily_totals')).rows[0].total_amount), 200000);
});

test('excluded transfer goes to B, removes bill/items/QR, and preserves bank total', async () => {
  await reset(); await seedQuota(5000000); await openBill();
  const allocation = await prepare();
  assert.equal(allocation.selected, false);
  assert.equal(allocation.account_id, id(41));
  await transaction(1, 300000, allocation.account_id);
  const paid = await settle(1, 300000, 'transfer', allocation.account_id, 'VALID001');
  assert.equal(paid.success, true);
  assert.equal(paid.selected_for_stats, false);
  for (const name of ['orders', 'order_items', 'payment_transactions', 'stats_bill_allocations']) {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n, 0);
  }
  assert.equal((await db.query('SELECT status FROM tables')).rows[0].status, 'available');
  assert.ok((await db.query('SELECT last_payment_at FROM tables')).rows[0].last_payment_at);
  const bank = (await db.query('SELECT * FROM bank_daily_totals')).rows[0];
  assert.equal(bank.account_id, id(41)); assert.equal(Number(bank.total_amount), 300000);
  assert.equal(Number((await quota()).cash_amount), 5000000);
  await assert.rejects(settle(1, 300000, 'transfer', allocation.account_id, 'VALID001'));
  assert.equal(Number((await db.query('SELECT total_amount FROM bank_daily_totals')).rows[0].total_amount), 300000);
});

test('excluded cash does not add to A or any bank account', async () => {
  await reset(); await seedQuota(5000000); await openBill();
  assert.equal((await settle()).selected_for_stats, false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_daily_totals')).rows[0].n, 0);
  assert.equal(Number((await quota()).cash_amount), 5000000);
});

test('the first available-table realtime event already has the payment marker', async () => {
  await reset(); await seedQuota(5000000); await openBill();
  await db.exec(`
    CREATE TEMP TABLE checkout_events(status text, last_payment_at timestamptz);
    CREATE FUNCTION observe_checkout_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO checkout_events VALUES (NEW.status, NEW.last_payment_at); RETURN NEW; END $$;
    CREATE TRIGGER observe_checkout_event AFTER UPDATE ON tables
      FOR EACH ROW EXECUTE FUNCTION observe_checkout_event();
  `);
  await settle();
  const { rows } = await db.query('SELECT * FROM checkout_events');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'available');
  assert.ok(rows[0].last_payment_at);
  await db.exec('DROP TRIGGER observe_checkout_event ON tables; DROP FUNCTION observe_checkout_event(); DROP TABLE checkout_events');
});

test('backup rotation skips full and disabled cards and never falls back to A', async () => {
  await reset(); await seedQuota(5000000); await openBill();
  await db.query(`INSERT INTO bank_daily_totals VALUES ($1,(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,5100000)`, [id(41)]);
  assert.equal((await prepare()).account_id, id(42));
  await db.exec('DELETE FROM stats_bill_allocations');
  await db.query('UPDATE bank_accounts SET is_active=false WHERE id=$1', [id(42)]);
  assert.equal((await prepare()).account_id, id(41)); // only remaining B is full
  await db.exec('DELETE FROM stats_bill_allocations');
  await db.query('UPDATE bank_accounts SET is_active=false WHERE id=$1', [id(41)]);
  await assert.rejects(prepare(), /Khong co tai khoan/);
});

test('reopening a matching bill never randomizes again or holds a second reservation', async () => {
  await reset(); await seedQuota(); await openBill();
  const first = await prepare();
  assert.deepEqual(await prepare(), first);
  assert.deepEqual(await prepare(), first);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stats_bill_allocations')).rows[0].n, 1);
  await db.query('UPDATE stats_daily_quotas SET target_amount=1');
  assert.deepEqual(await prepare(), { ...first, target: 1 });
});

test('reservations from another table count toward the shared cap', async () => {
  await reset(); await seedQuota(4500000); await openBill(1, 400000); await openBill(2, 400000);
  assert.equal((await prepare(1, 400000)).selected, true);
  const second = await prepare(2, 400000);
  assert.equal(second.selected, false);
  assert.equal(second.account_id, id(41));
});

test('cancelled or changed reservations release budget for other tables', async () => {
  await reset(); await seedQuota(4500000); await openBill(1, 400000); await openBill(2, 400000);
  assert.equal((await prepare(1, 400000)).selected, true);
  await db.query('UPDATE orders SET status=$1 WHERE id=$2', ['cancelled', id(101)]);
  assert.equal((await prepare(2, 400000)).selected, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stats_bill_allocations')).rows[0].n, 1);
});

test('wrong QR rolls back all changes; updated amounts cannot use the previous QR', async () => {
  await reset(); await seedQuota(); await openBill();
  await prepare(); await transaction(1, 200000, id(40));
  await assert.rejects(settle(1, 300000, 'transfer', id(40), 'VALID001'), /QR/);
  assert.equal((await db.query('SELECT status FROM orders')).rows[0].status, 'completed');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_daily_totals')).rows[0].n, 0);
  assert.equal(Number((await quota()).transfer_amount), 0);
  await db.query('UPDATE order_items SET unit_price=400000 WHERE order_id=$1', [id(101)]);
  await assert.rejects(settle(1, 400000, 'transfer', id(40), 'VALID001'), /QR/);
});

test('selected financial details and item rows cannot be changed or deleted, feedback can', async () => {
  await reset(); await seedQuota(); await openBill(); await settle();
  await assert.rejects(db.query('UPDATE orders SET payment_method=$1 WHERE id=$2', ['transfer', id(101)]));
  await assert.rejects(db.query('UPDATE orders SET status=$1 WHERE id=$2', ['pending', id(101)]));
  await assert.rejects(db.query('UPDATE orders SET is_hidden_from_stats=true WHERE id=$1', [id(101)]));
  await assert.rejects(db.query('DELETE FROM orders WHERE id=$1', [id(101)]));
  await assert.rejects(db.query('UPDATE order_items SET unit_price=400000 WHERE order_id=$1', [id(101)]));
  await assert.rejects(db.query('DELETE FROM order_items WHERE order_id=$1', [id(101)]));
  await db.query('UPDATE orders SET customer_rating=5,customer_feedback=$1 WHERE id=$2', ['Good', id(101)]);
  assert.equal((await db.query('SELECT customer_rating FROM orders')).rows[0].customer_rating, 5);
});

test('purging preserves feedback, never deletes historical hidden bills', async () => {
  await reset(); await seedQuota(5000000); await openBill();
  await db.query('UPDATE orders SET customer_rating=5,customer_feedback=$1 WHERE id=$2', ['Good', id(101)]);
  await db.query(`INSERT INTO orders(id,status,total_amount,is_hidden_from_stats) VALUES ($1,'paid',900000,true)`, [id(900)]);
  await settle();
  assert.deepEqual((await db.query('SELECT id FROM orders')).rows.map(o => o.id), [id(900)]);
  const review = (await db.query('SELECT * FROM customer_reviews')).rows[0];
  assert.equal(review.rating, 5); assert.equal(review.feedback, 'Good'); assert.equal(review.order_id, null);
  assert.equal((await db.query('SELECT purge_unselected_quota_bills() AS n')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM customer_reviews')).rows[0].n, 1);
});

test('pending or failed printing retains the excluded bill until printing succeeds', async () => {
  await reset(); await seedQuota(5000000); await openBill();
  await db.query('INSERT INTO print_jobs VALUES ($1,$2,$3,$4)', [id(500), id(101), [id(101)], 'pending']);
  assert.equal((await settle()).selected_for_stats, false);
  assert.equal((await db.query('SELECT status FROM orders')).rows[0].status, 'paid');
  await db.query('UPDATE print_jobs SET status=$1', ['failed']);
  assert.equal((await db.query('SELECT purge_unselected_quota_bills() AS n')).rows[0].n, 0);
  await db.query('UPDATE print_jobs SET status=$1', ['done']);
  assert.equal((await db.query('SELECT purge_unselected_quota_bills() AS n')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM print_jobs')).rows[0].n, 0);
});

test('merged tables settle together without splitting their account/decision', async () => {
  await reset(); await seedQuota(); await openBill(1, 300000); await openBill(2, 200000, 1);
  const allocation = await prepare(2, 500000, 'transfer', [2, 1]);
  assert.equal(allocation.selected, true);
  const paid = await settle(2, 500000, 'transfer', allocation.account_id, null, [2, 1]);
  assert.equal(paid.success, true);
  assert.deepEqual((await db.query('SELECT status FROM orders ORDER BY id')).rows.map(o => o.status), ['paid', 'paid']);
  assert.deepEqual((await db.query('SELECT status FROM tables ORDER BY id')).rows.map(o => o.status), ['available', 'available']);
  assert.equal(Number((await quota()).transfer_amount), 500000);
});

test('existing wheel discount triggers remain correct for both kept and deleted bills', async () => {
  for (const baseline of [0, 5000000]) {
    await reset(); await seedQuota(baseline); await openBill();
    await db.query(`INSERT INTO settings VALUES ('lucky_wheel_max','50000')`);
    await db.query(`INSERT INTO lucky_spins(id,host_table_id,status,prize_type,prize_value,applied_order_id)
      VALUES ($1,$2,'applied','percent',2,$3)`, [id(600), id(1), id(101)]);
    await db.query('SELECT refresh_lucky_percent_reward($1)', [id(600)]);
    assert.equal(Number((await db.query('SELECT total_amount FROM orders')).rows[0].total_amount), 294000);
    assert.equal((await settle(1, 294000)).selected_for_stats, baseline === 0);
    const spin = (await db.query('SELECT * FROM lucky_spins')).rows[0];
    assert.equal(spin.status, 'applied');
    assert.equal(spin.discount_amount, 6000);
    if (baseline === 0) {
      assert.equal(Number((await quota()).cash_amount), 294000);
      await db.query('SELECT refresh_lucky_percent_reward($1)', [id(600)]);
      assert.equal(Number((await db.query('SELECT total_amount FROM orders')).rows[0].total_amount), 294000);
    } else {
      assert.equal(spin.applied_order_id, null);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0);
    }
  }
});

test('random day target is stable, within bounds, and includes existing cash as baseline', async () => {
  await reset(); await openBill();
  await db.query(`INSERT INTO orders(id,status,total_amount,payment_method) VALUES ($1,'paid',900000,'cash')`, [id(900)]);
  await prepare();
  const q = await quota();
  assert.ok(Number(q.target_amount) >= 4000000 && Number(q.target_amount) <= 7000000);
  assert.equal(Number(q.cash_amount), 900000);
  assert.equal((await quota()).target_amount, q.target_amount);
});

test('migration can be reapplied without replacing the legacy function with its wrapper', async () => {
  await db.exec(readFileSync(new URL('../supabase/migrations/stats_daily_bill_quota.sql', import.meta.url), 'utf8'));
  await reset(false); await openBill();
  assert.equal((await settle()).success, true);
});
