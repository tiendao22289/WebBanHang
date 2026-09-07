// Real PostgreSQL engine in WASM; isolated fixtures, no connection to Supabase.
// npm ci && npm run test:lucky
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE settings(key text PRIMARY KEY, value text);
  CREATE TABLE tables(id uuid PRIMARY KEY, merged_with uuid, table_type text DEFAULT 'normal');
  CREATE TABLE orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid REFERENCES tables,
    status text DEFAULT 'pending', customer_phone text DEFAULT '0900000000',
    created_at timestamptz DEFAULT now(), total_amount integer DEFAULT 0);
  CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES orders ON DELETE CASCADE,
    menu_item_id uuid, item_name text, quantity integer, unit_price integer, is_gift boolean DEFAULT false,
    item_options jsonb, note text);
  CREATE TABLE lucky_spins(id uuid PRIMARY KEY, host_table_id uuid, customer_phone text,
    status text, prize_type text, prize_value numeric, applied_order_id uuid REFERENCES orders,
    applied_item_id uuid, created_at timestamptz DEFAULT now(), session_started_at timestamptz,
    bill_total integer DEFAULT 0, discount_amount integer DEFAULT 0);
`);
const migration = readFileSync(new URL('../supabase/migrations/lucky_wheel_dynamic_percent.sql', import.meta.url), 'utf8');
await db.exec(migration);

async function fixture({ type = 'percent', takeaway = false, claim = true } = {}) {
  await db.exec(`TRUNCATE lucky_spins, order_items, orders, tables, settings CASCADE;
    INSERT INTO settings VALUES ('lucky_wheel_max','10000');
    INSERT INTO tables(id,table_type) VALUES ('${id(1)}','${takeaway ? 'takeaway' : 'normal'}');
    INSERT INTO orders(id, table_id) VALUES ('${id(10)}','${id(1)}');
    INSERT INTO order_items(id, order_id, quantity, unit_price) VALUES ('${id(20)}','${id(10)}',1,150000);
    INSERT INTO lucky_spins(id, host_table_id, customer_phone, status, prize_type, prize_value, applied_order_id)
      VALUES ('${id(30)}','${id(1)}','0900000000','applied','${type}',2,'${id(10)}');`);
  if (claim) await refresh();
}
async function refresh() { return db.query('SELECT refresh_lucky_percent_reward($1) AS result', [id(30)]); }
async function state() {
  const { rows: [r] } = await db.query(`SELECT s.discount_amount AS discount, s.applied_item_id AS item,
    s.discount_max_amount AS cap, s.bill_total AS subtotal,
    (SELECT COALESCE(SUM(total_amount),0)::integer FROM orders WHERE status IN ('pending','preparing','completed')) AS total,
    (SELECT COUNT(*)::integer FROM order_items WHERE item_name LIKE 'Vòng xoay%') AS lines
    FROM lucky_spins s WHERE id=$1`, [id(30)]);
  return r;
}
async function addOrder(n, amount, table = 1, phone = '0900000000') {
  await db.query('INSERT INTO orders(id,table_id,customer_phone,total_amount) VALUES($1,$2,$3,$4)', [id(n),id(table),phone,amount]);
  await db.query('INSERT INTO order_items(order_id,quantity,unit_price) VALUES($1,1,$2)', [id(n),amount]);
}

test('150k → 3k; another submitted order makes 250k → 5k on the same bill', async () => {
  await fixture();
  assert.equal((await state()).discount, 3000);
  await addOrder(11, 100000);
  assert.deepEqual(await state(), { discount: 5000, item: id(30), cap: 10000, subtotal: 250000, total: 245000, lines: 1 });
});
test('quantity, price, deletion, and zero subtotal reprice without claiming again', async () => {
  await fixture();
  await db.query('UPDATE order_items SET quantity=2 WHERE id=$1', [id(20)]);
  assert.equal((await state()).discount, 6000);
  await db.query('UPDATE order_items SET unit_price=100000 WHERE id=$1', [id(20)]);
  assert.equal((await state()).discount, 4000);
  await db.query('DELETE FROM order_items WHERE id=$1', [id(20)]);
  assert.equal((await state()).discount, 0);
  assert.equal((await state()).total, 0);
});
test('cap is preserved even when settings change; shrinking bill lowers discount', async () => {
  await fixture();
  await db.exec("UPDATE settings SET value='50000' WHERE key='lucky_wheel_max'");
  await addOrder(11, 850000);
  assert.equal((await state()).discount, 10000);
  await db.query('DELETE FROM order_items WHERE order_id=$1', [id(11)]);
  assert.equal((await state()).discount, 3000);
});
test('stale client total writes are corrected at commit, and retries do not compound', async () => {
  await fixture();
  await db.exec(`BEGIN; UPDATE order_items SET quantity=2 WHERE id='${id(20)}';
    UPDATE orders SET total_amount=297000 WHERE id='${id(10)}'; COMMIT;`);
  for (let n=0; n<10; n++) await refresh();
  assert.equal((await state()).total, 294000);
  assert.equal((await state()).lines, 1);
});
test('all submitted orders in a merged table group count, unrelated tables do not', async () => {
  await fixture();
  await db.exec(`INSERT INTO tables(id,merged_with) VALUES('${id(2)}','${id(1)}');
    INSERT INTO tables(id) VALUES('${id(3)}');`);
  await addOrder(11, 100000, 2);
  await addOrder(12, 900000, 3);
  assert.equal((await state()).discount, 5000);
});
test('takeaway rewards are scoped to the same customer phone', async () => {
  await fixture({ takeaway:true });
  await addOrder(11, 100000, 1, '0911111111');
  assert.equal((await state()).discount, 3000);
  await addOrder(12, 100000);
  assert.equal((await state()).discount, 5000);
});
test('free gifts do not earn discount and other discounts cannot make the total negative', async () => {
  await fixture();
  await db.exec(`INSERT INTO order_items(order_id,quantity,unit_price,is_gift) VALUES('${id(10)}',1,100000,true);
    DELETE FROM order_items WHERE is_gift;
    INSERT INTO order_items(order_id,quantity,unit_price) VALUES('${id(10)}',1,-149000);`);
  assert.equal((await state()).discount, 1000);
  assert.equal((await state()).total, 0);
});
test('cancelling a later order reduces the discount', async () => {
  await fixture(); await addOrder(11,100000);
  await db.query("UPDATE orders SET status='cancelled',total_amount=0 WHERE id=$1", [id(11)]);
  assert.equal((await state()).discount, 3000);
  assert.equal((await state()).total, 147000);
});
test('paid bill and next visit cannot increase or change the old reward', async () => {
  await fixture();
  await db.query("UPDATE orders SET status='paid' WHERE id=$1", [id(10)]);
  await addOrder(11, 100000);
  assert.equal((await state()).discount, 3000);
  assert.equal((await refresh()).rows[0].result, null);
  assert.equal((await state()).total, 100000);
});
test('amount and gift rewards are not recalculated by item edits', async () => {
  for (const type of ['amount','gift_drink']) {
    await fixture({type,claim:false});
    await addOrder(11,100000);
    assert.equal((await state()).discount, 0);
    assert.equal((await state()).item, null);
  }
});
test('original session continues across midnight, earlier visits are excluded', async () => {
  await fixture();
  await db.exec(`UPDATE orders SET created_at=now()-interval '25 hours' WHERE id='${id(10)}';
    UPDATE lucky_spins SET session_started_at=now()-interval '26 hours',created_at=now()-interval '24 hours';`);
  await addOrder(11,100000);
  assert.equal((await state()).discount, 5000);
  await db.exec(`INSERT INTO orders(id,table_id,created_at) VALUES('${id(12)}','${id(1)}',now()-interval '48 hours');
    INSERT INTO order_items(order_id,quantity,unit_price) VALUES('${id(12)}',1,900000);`);
  assert.equal((await state()).discount, 5000);
});
test('old discount line without receipt is adopted rather than duplicated', async () => {
  await fixture({claim:false});
  await db.exec(`INSERT INTO order_items(id,order_id,item_name,quantity,unit_price)
    VALUES('${id(40)}','${id(10)}','Vòng xoay may mắn: giảm 2%',1,-3000);`);
  await refresh(); await addOrder(11,100000);
  assert.equal((await state()).item,id(40));
  assert.equal((await state()).lines,1);
  assert.equal((await state()).discount,5000);
});
test('merge RPC preserves reward identity and future additions still reprice', async () => {
  await fixture(); await addOrder(11,100000);
  const items=(await db.query('SELECT * FROM order_items')).rows;
  // Consolidate into a DIFFERENT order to exercise applied_order_id migration.
  await db.query('SELECT merge_bills_atomic($1,$2,$3,$4,$5)', [[id(10),id(11)],id(11),[id(10)],245000,JSON.stringify(items)]);
  assert.equal((await state()).lines,1);
  assert.equal((await state()).discount,5000);
  await addOrder(12,100000);
  assert.equal((await state()).discount,7000);
  assert.equal((await state()).total,343000);
});
test('failed transaction rolls back both added items and recalculated reward', async () => {
  await fixture();
  await db.exec('BEGIN');
  await db.query('UPDATE order_items SET quantity=2 WHERE id=$1',[id(20)]);
  await db.exec('ROLLBACK');
  assert.equal((await state()).discount,3000);
  assert.equal((await state()).total,147000);
});
test('migration is repeatable and RPC is not callable by anonymous customers', async () => {
  await fixture(); await db.exec(migration);
  assert.equal((await state()).lines,1);
  const {rows:[row]}=await db.query("SELECT has_function_privilege('anon','refresh_lucky_percent_reward(uuid)','execute') AS allowed");
  assert.equal(row.allowed,false);
});
