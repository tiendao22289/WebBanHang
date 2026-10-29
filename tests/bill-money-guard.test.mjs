import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Khoá phần tiền (bill_money_guard.sql): khoá công khai của trang web không chốt / sửa bill đã thu,
// không xác nhận mã QR, không cộng tiền vào thẻ. Máy chủ (service_role) và pg_cron vẫn làm được.
const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const denied = error => error.code === '42501';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE ROLE authenticator NOINHERIT; GRANT anon, service_role TO authenticator;
  CREATE TABLE settings(key text PRIMARY KEY, value text);
  CREATE TABLE tables(id uuid PRIMARY KEY, merged_with uuid, status text, occupied_at timestamptz,
    table_type text DEFAULT 'normal', table_number integer);
  CREATE TABLE menu_items(id uuid PRIMARY KEY, name text);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables,
    status text DEFAULT 'pending', total_amount numeric, payment_method text, paid_at timestamptz,
    paid_by_id uuid, paid_by_name text, created_at timestamptz DEFAULT now(),
    is_hidden_from_stats boolean, customer_name text, customer_phone text,
    customer_rating integer, customer_feedback text, delivery_address text, kitchen_completed boolean DEFAULT false);
  CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders ON DELETE CASCADE,
    quantity integer, unit_price numeric, menu_item_id uuid, is_gift boolean DEFAULT false,
    item_name text, item_options jsonb, note text);
  CREATE TABLE bank_accounts(id uuid PRIMARY KEY, account_name text, is_active boolean, is_visible boolean,
    daily_limit numeric, sort_order integer);
  CREATE TABLE bank_daily_totals(account_id uuid REFERENCES bank_accounts,
    date date, total_amount numeric, UNIQUE(account_id,date));
  -- Như bảng thật: khoá là transaction_code, account_id kiểu text.
  CREATE TABLE payment_transactions(transaction_code text PRIMARY KEY, status text DEFAULT 'pending',
    order_ids text NOT NULL, total_amount numeric, account_id text, created_at timestamptz DEFAULT now());
  CREATE TABLE print_jobs(id uuid PRIMARY KEY, order_id uuid REFERENCES orders ON DELETE CASCADE,
    order_ids uuid[], status text, order_items_at_queue jsonb);
  CREATE TABLE customer_reviews(id uuid DEFAULT gen_random_uuid(), table_id uuid,
    order_id uuid REFERENCES orders ON DELETE SET NULL,
    customer_name text, customer_phone text, rating integer, feedback text,
    created_at timestamptz DEFAULT now());
  CREATE TABLE lucky_spins(id uuid PRIMARY KEY, host_table_id uuid, customer_phone text,
    status text, prize_type text, prize_value numeric, applied_order_id uuid REFERENCES orders ON DELETE SET NULL,
    applied_item_id uuid, created_at timestamptz DEFAULT now(), session_started_at timestamptz,
    bill_total integer DEFAULT 0, discount_amount integer DEFAULT 0);
  -- Quyền mặc định của Supabase cho khoá công khai trên các bảng cũ.
  GRANT ALL ON tables, menu_items, orders, order_items, bank_accounts, bank_daily_totals, payment_transactions,
    print_jobs, customer_reviews, lucky_spins TO anon, authenticated, service_role;
`);
for (const file of ['lucky_wheel_dynamic_percent.sql', 'complete_table_payment_atomic.sql', 'protect_settled_order_items.sql',
  'order_total_follows_items.sql', 'stats_daily_bill_quota.sql', 'process_bank_payment_rpc.sql',
  'custom_cash_receipts.sql', 'confirm_custom_qr_payment.sql', 'owner_finance.sql']) {
  await db.exec(migration(file));
}
// Như DB thật trước khi cài: hàm cũ còn mở cho khoá công khai.
await db.exec(`GRANT EXECUTE ON FUNCTION complete_table_payment_atomic(uuid, uuid[], numeric, text, uuid, boolean, uuid, text, text),
  confirm_custom_qr_payment(text, numeric, uuid), record_custom_cash_receipt(uuid, numeric), process_bank_payment(integer, date)
  TO anon, authenticated`);
await db.exec(migration('bill_money_guard.sql'));
// Hàm chạy quyền chủ hàm mà ai cũng gọi được (như hàm cũ thuộc supabase_admin chưa thu được quyền).
await db.exec(`CREATE FUNCTION test_mark_paid(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS
  $$ UPDATE orders SET status = 'paid', payment_method = 'cash', paid_at = now() WHERE id = p_id $$;
  GRANT EXECUTE ON FUNCTION test_mark_paid(uuid) TO PUBLIC;`);

// Trang web ghi thẳng bảng qua /rest/v1: PostgREST đổi sang vai trò anon và để JWT anon.
const asWeb = (sql, params = []) => db.transaction(async tx => {
  await tx.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`);
  await tx.query('SET LOCAL ROLE anon');
  return tx.query(sql, params);
});
// Trang web gọi một hàm SECURITY DEFINER: current_user là chủ hàm, chỉ còn JWT nói thật.
const asWebInsideDefiner = (sql, params = []) => db.transaction(async tx => {
  await tx.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`);
  return tx.query(sql, params);
});
// Kết nối PostgREST (authenticator), có hoặc không có JWT. PGlite không trả lại
// SET LOCAL SESSION AUTHORIZATION khi kết thúc giao dịch nên tự trả.
const asPostgrest = async (claims, sql, params = []) => {
  try {
    return await db.transaction(async tx => {
      await tx.query('SET SESSION AUTHORIZATION authenticator');
      if (claims) await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      return tx.query(sql, params);
    });
  } finally {
    await db.exec('SET SESSION AUTHORIZATION postgres'); // RESET không có tác dụng trên PGlite
  }
};
// Máy chủ (/api/admin/receipts) dùng khoá service_role.
const asServer = (sql, params = []) => db.transaction(async tx => {
  await tx.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await tx.query('SET LOCAL ROLE service_role');
  return tx.query(sql, params);
});

const SETTLE = 'SELECT complete_table_payment_atomic($1,$2,$3,$4,$5,false,NULL,NULL,$6) AS result';
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const statusOf = async n => (await one('SELECT status FROM orders WHERE id = $1', [id(n + 100)]))?.status;
const ledger = async () => (await one('SELECT count(*)::int AS n FROM finance_revenue_ledger')).n;

async function reset({ quota = false } = {}) {
  await db.exec(`TRUNCATE order_items, orders, tables, bank_daily_totals, bank_accounts, payment_transactions,
    print_jobs, customer_reviews, stats_daily_quotas, stats_bill_allocations, lucky_spins,
    finance_revenue_ledger, finance_manual_receipts, custom_cash_receipts CASCADE;
    UPDATE stats_quota_config SET enabled = ${quota}, start_hour = 0, end_hour = 1;`);
  await db.query(`INSERT INTO bank_accounts VALUES ($1,'Thẻ A',true,true,5000000,1),($2,'Thẻ B',true,false,5000000,2)`,
    [id(40), id(41)]);
}
async function openBill(n = 1, amount = 300000) {
  await db.query('INSERT INTO tables(id,status,occupied_at) VALUES ($1,$2,now())', [id(n), 'occupied']);
  await db.query('INSERT INTO orders(id,table_id,status,total_amount) VALUES ($1,$2,$3,$4)', [id(n + 100), id(n), 'pending', amount]);
  await db.query('INSERT INTO order_items(id,order_id,quantity,unit_price,menu_item_id) VALUES ($1,$2,1,$3,$4)',
    [id(n + 200), id(n + 100), amount, id(30)]);
}
const serverSettle = (n = 1, amount = 300000, method = 'cash', account = null, code = null) =>
  asServer(SETTLE, [id(n), [id(n + 100)], amount, method, account, code]);

test('khoá công khai không gọi được hàm đóng bàn / xác nhận QR / tiền mặt / cộng thẻ; máy chủ gọi được', async () => {
  const fns = ['complete_table_payment_atomic(uuid,uuid[],numeric,text,uuid,boolean,uuid,text,text)',
    'complete_table_payment_atomic_legacy(uuid,uuid[],numeric,text,uuid,boolean,uuid,text,text)',
    'confirm_custom_qr_payment(text,numeric,uuid)', 'record_custom_cash_receipt(uuid,numeric)',
    'process_bank_payment(integer,date)'];
  for (const fn of fns) {
    const row = await one(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', $1, 'EXECUTE') AS auth, has_function_privilege('service_role', $1, 'EXECUTE') AS server`, [fn]);
    assert.deepEqual(row, { anon: false, auth: false, server: true }, fn);
  }
  await reset(); await openBill();
  await assert.rejects(asWeb(SETTLE, [id(1), [id(101)], 300000, 'cash', null, null]), denied);
  await assert.rejects(asWeb('SELECT process_bank_payment(500000, current_date)'), denied);
  assert.equal(await statusOf(1), 'pending');
});

test('máy chủ vẫn đóng bàn được, bill vào Sổ thu chi', async () => {
  await reset(); await openBill();
  const { rows: [{ result }] } = await serverSettle();
  assert.equal(result.success, true);
  assert.equal(await statusOf(1), 'paid');
  assert.equal(await ledger(), 1);
});

test('khoá công khai không tự chốt bàn mình "đã trả tiền mặt"', async () => {
  await reset(); await openBill();
  await assert.rejects(asWeb(`UPDATE orders SET status = 'paid', payment_method = 'cash' WHERE id = $1`, [id(101)]), denied);
  await assert.rejects(asWeb(`INSERT INTO orders(id, table_id, status, total_amount) VALUES ($1, $2, 'paid', 0)`, [id(150), id(1)]), denied);
  // Hàm chạy quyền chủ hàm (chưa thu được quyền) cũng không chốt hộ được.
  await assert.rejects(asWebInsideDefiner(SETTLE, [id(1), [id(101)], 300000, 'cash', null, null]), denied);
  await assert.rejects(asWebInsideDefiner('SELECT test_mark_paid($1)', [id(101)]), denied);
  // Gọi qua PostgREST chỉ có apikey, không có JWT: vẫn không tin.
  await assert.rejects(asPostgrest(null, 'SELECT test_mark_paid($1)', [id(101)]), denied);
  await assert.rejects(asPostgrest({ role: 'anon' }, 'SELECT test_mark_paid($1)', [id(101)]), denied);
  assert.equal(await statusOf(1), 'pending');
  assert.equal(await ledger(), 0);
  // Cùng đường đó nhưng JWT là service_role (máy chủ) thì được.
  await asPostgrest({ role: 'service_role' }, 'SELECT test_mark_paid($1)', [id(101)]);
  assert.equal(await statusOf(1), 'paid');
});

test('bill đã thu: khoá công khai không mở lại / huỷ / sửa / xoá được, khách vẫn góp ý được', async () => {
  await reset(); await openBill(); await serverSettle();
  for (const change of [`status = 'pending'`, `status = 'cancelled', payment_method = 'cancelled'`,
    `status = 'completed', kitchen_completed = true`, `is_hidden_from_stats = true`,
    `table_id = NULL`, `payment_method = 'transfer'`, `customer_rating = 5, paid_at = now() - interval '1 day'`]) {
    await assert.rejects(asWeb(`UPDATE orders SET ${change} WHERE id = $1`, [id(101)]), denied, change);
  }
  await assert.rejects(asWeb('DELETE FROM orders WHERE id = $1', [id(101)]), denied);
  // Tổng tiền luôn tính lại theo món (order_total_follows_items) nên ghi số khác cũng không đổi được.
  await asWeb('UPDATE orders SET total_amount = 1000 WHERE id = $1', [id(101)]);
  assert.equal(Number((await one('SELECT total_amount FROM orders WHERE id = $1', [id(101)])).total_amount), 300000);
  assert.equal(await statusOf(1), 'paid');
  assert.equal(await ledger(), 1, 'bill vẫn nằm trong Sổ thu chi');

  await asWeb(`UPDATE orders SET customer_rating = 5, customer_feedback = 'Ngon' WHERE id = $1`, [id(101)]);
  await asWeb(`UPDATE orders SET delivery_address = 'Hẻm 3' WHERE id = $1`, [id(101)]);
  // Trang Bàn ghi lại tổng tiền cũ (refreshOrderTotalFromItems) không đổi gì → không báo lỗi.
  await asWeb('UPDATE orders SET total_amount = 300000 WHERE id = $1', [id(101)]);
  const row = await one('SELECT customer_rating, customer_feedback, delivery_address, status FROM orders WHERE id = $1', [id(101)]);
  assert.deepEqual(row, { customer_rating: 5, customer_feedback: 'Ngon', delivery_address: 'Hẻm 3', status: 'paid' });
});

test('việc của nhân viên trên bill đang mở vẫn như cũ', async () => {
  await reset(); await openBill(1); await openBill(2, 120000);
  await asWeb(`INSERT INTO order_items(order_id, quantity, unit_price, menu_item_id) VALUES ($1, 2, 50000, $2)`, [id(101), id(31)]);
  await asWeb('UPDATE order_items SET quantity = 3 WHERE id = $1', [id(201)]);
  await asWeb('UPDATE orders SET total_amount = 1 WHERE id = $1', [id(101)]);
  assert.equal(Number((await one('SELECT total_amount FROM orders WHERE id = $1', [id(101)])).total_amount), 1000000);
  await asWeb('UPDATE orders SET table_id = $1 WHERE id = $2', [id(1), id(102)]);
  await asWeb(`UPDATE orders SET status = 'cancelled', payment_method = 'cancelled' WHERE id = $1 AND status IN ('pending', 'preparing', 'completed')`, [id(102)]);
  await asWeb(`UPDATE orders SET kitchen_completed = true, status = 'completed' WHERE id = $1`, [id(101)]);
  await asWeb(`INSERT INTO orders(id, table_id, status, total_amount, customer_phone) VALUES ($1, $2, 'completed', 0, 'BAO_BEP')`, [id(160), id(1)]);
  assert.equal(await statusOf(1), 'completed');
  assert.equal(await statusOf(2), 'cancelled');
});

test('mã QR: khoá công khai chỉ tạo mã chờ và huỷ mã chờ', async () => {
  await reset();
  await asWeb(`INSERT INTO payment_transactions(transaction_code, order_ids, account_id, total_amount, status)
    VALUES ('QRWEB001', 'shadow_qr', $1, 200000, 'pending')`, [id(41)]);
  await asWeb(`INSERT INTO payment_transactions(transaction_code, order_ids, account_id, total_amount, status)
    VALUES ('QRWEB002', $1, $2, 300000, 'pending')`, [id(101), id(41)]);
  await asWeb(`UPDATE payment_transactions SET status = 'failed' WHERE transaction_code = 'QRWEB002' AND status = 'pending'`);

  await assert.rejects(asWeb(`INSERT INTO payment_transactions(transaction_code, order_ids, total_amount, status)
    VALUES ('QRFAKE01', 'shadow_qr', 900000, 'completed')`), denied);
  await assert.rejects(asWeb(`UPDATE payment_transactions SET status = 'completed' WHERE transaction_code = 'QRWEB001'`), denied);
  await assert.rejects(asWeb(`UPDATE payment_transactions SET total_amount = 1 WHERE transaction_code = 'QRWEB001'`), denied);
  await assert.rejects(asWeb(`UPDATE payment_transactions SET status = 'failed', total_amount = 1 WHERE transaction_code = 'QRWEB001'`), denied);
  await assert.rejects(asWeb(`UPDATE payment_transactions SET status = 'pending' WHERE transaction_code = 'QRWEB002'`), denied);
  await assert.rejects(asWeb(`DELETE FROM payment_transactions WHERE transaction_code = 'QRWEB001'`), denied);
  assert.equal((await one('SELECT count(*)::int AS n FROM finance_manual_receipts')).n, 0, 'không ghi khống vào Sổ thu chi');

  // Nhân viên bấm "Đã nhận tiền" → máy chủ xác nhận → Sổ thu chi + tiền vào thẻ.
  await asServer('SELECT confirm_custom_qr_payment($1, $2, $3)', ['QRWEB001', 200000, id(41)]);
  await asServer('SELECT record_custom_cash_receipt($1, $2)', [id(70), 150000]);
  assert.deepEqual((await db.query('SELECT transaction_code, status FROM payment_transactions ORDER BY 1')).rows,
    [{ transaction_code: 'QRWEB001', status: 'completed' }, { transaction_code: 'QRWEB002', status: 'failed' }]);
  assert.equal((await one('SELECT count(*)::int AS n FROM finance_manual_receipts')).n, 2);
  assert.equal(Number((await one('SELECT total_amount FROM bank_daily_totals WHERE account_id = $1', [id(41)])).total_amount), 200000);
});

test('tiền vào thẻ trong ngày: khoá công khai không ghi / sửa / xoá được', async () => {
  await reset();
  await db.query('INSERT INTO bank_daily_totals VALUES ($1, current_date, 100000)', [id(40)]);
  await assert.rejects(asWeb('INSERT INTO bank_daily_totals VALUES ($1, current_date - 1, 5000000)', [id(41)]), denied);
  await assert.rejects(asWeb('UPDATE bank_daily_totals SET total_amount = 0'), denied);
  await assert.rejects(asWeb('DELETE FROM bank_daily_totals'), denied);
  await assert.rejects(asWebInsideDefiner('UPDATE bank_daily_totals SET total_amount = 0'), denied);
  assert.equal(Number((await one('SELECT total_amount FROM bank_daily_totals')).total_amount), 100000);
  // Chuyển khoản qua máy chủ vẫn cộng vào thẻ.
  await openBill();
  await db.query(`INSERT INTO payment_transactions VALUES ('TX000001', 'pending', $1, 300000, $2)`, [id(101), id(40)]);
  const { rows: [{ result }] } = await serverSettle(1, 300000, 'transfer', id(40), 'TX000001');
  assert.equal(result.success, true);
  assert.equal(Number((await one('SELECT total_amount FROM bank_daily_totals')).total_amount), 400000);
});

test('bill ngoài thống kê vẫn được dọn: lúc đóng bàn (máy chủ) và bằng pg_cron', async () => {
  await reset({ quota: true });
  // Cửa sổ đã qua, đã đủ chỉ tiêu → bill mới không được chọn → dọn ngay khi đóng bàn.
  await db.query(`INSERT INTO stats_daily_quotas(date, account_id, base_amount, target_amount, cash_amount, transfer_amount, start_hour, end_hour)
    VALUES ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, $1, 5000000, 5000000, 5000000, 0, -2, -1)`, [id(40)]);
  await openBill(1);
  const { rows: [{ result }] } = await serverSettle();
  assert.equal(result.selected_for_stats, false);
  assert.equal(await statusOf(1), undefined, 'bill đã dọn');

  // Bill còn phiếu in chưa xong thì để pg_cron dọn sau (chạy bằng postgres, không có JWT).
  await openBill(2, 80000);
  await db.query(`INSERT INTO print_jobs(id, order_id, status) VALUES ($1, $2, 'pending')`, [id(90), id(102)]);
  await serverSettle(2, 80000);
  assert.equal(await statusOf(2), 'paid');
  await db.query(`UPDATE print_jobs SET status = 'done'`);
  assert.equal((await one('SELECT purge_unselected_quota_bills() AS n')).n, 1);
  assert.equal(await statusOf(2), undefined);
});

test('cài lại không tạo trùng trigger, không mở lại quyền', async () => {
  await db.exec(migration('confirm_custom_qr_payment.sql'));
  await db.exec(migration('bill_money_guard.sql'));
  const { rows } = await db.query(`SELECT tgname, count(*)::int AS n FROM pg_trigger
    WHERE tgname IN ('paid_bill_guard', 'payment_transaction_guard', 'bank_total_guard') GROUP BY 1 ORDER BY 1`);
  assert.deepEqual(rows, [{ tgname: 'bank_total_guard', n: 1 }, { tgname: 'paid_bill_guard', n: 1 }, { tgname: 'payment_transaction_guard', n: 1 }]);
  assert.equal((await one(`SELECT has_function_privilege('anon', 'confirm_custom_qr_payment(text,numeric,uuid)', 'EXECUTE') AS ok`)).ok, false);
});
