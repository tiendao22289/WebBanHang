import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

test('history hides kitchen calls in archives, cancelled bills and legacy paid bills', async () => {
  const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
  const handler = page.slice(page.indexOf('  async function syncTableHistory()'), page.indexOf('\n  useEffect(', page.indexOf('  async function syncTableHistory()')));
  for (const legacy of [false, true]) {
    const call = { id: 'call', customer_phone: 'BAO_BEP', created_at: new Date().toISOString() };
    const food = { id: 'food', customer_phone: null, created_at: call.created_at, order_items: [{ item_name: null, menu_item: null }] };
    let history;
    const context = {
      showTableHistory: { id: 'table' },
      setTableHistoryLoading() {}, setTableOpenLogLoading() {}, setTableOpenLog() {}, setHistorySynced() {},
      setTableHistoryData(value) { history = value; },
      Swal: { fire() { assert.fail('Unexpected error'); } }, console,
      supabase: { from(table) {
        const result = table === 'table_bill_history'
          ? legacy ? { error: { code: 'PGRST205' } } : { data: [call, food].map(snapshot => ({ snapshot })) }
          : { data: table === 'orders' ? [call, food] : [] };
        const query = {};
        for (const method of ['select', 'eq', 'gte', 'contains', 'gt']) query[method] = () => query;
        query.order = () => Promise.resolve(result);
        return query;
      } },
    };
    await vm.runInNewContext(`(${handler.trim()})`, context)();
    assert.ok(history.length > 0);
    assert.ok(history.every(order => order.id === 'food'));
    assert.equal(history[0].order_items[0].menu_item, null);
  }
});

test('capture skips kitchen calls, saves real bills and never blocks payment on history failure', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE tables(id uuid PRIMARY KEY, merged_with uuid, table_number int);
      CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid, status text, customer_phone text, paid_at timestamptz);
      CREATE TABLE menu_items(id uuid PRIMARY KEY, name text);
      CREATE TABLE order_items(id uuid, order_id uuid, menu_item_id uuid, item_name text);
      CREATE TABLE payment_transactions(transaction_code text, order_ids text, status text);
      CREATE TABLE table_bill_history(order_id uuid PRIMARY KEY, table_id uuid, table_ids uuid[], paid_at timestamptz, expires_at timestamptz, snapshot jsonb);
    `);
    await db.exec(readFileSync(new URL('../supabase/migrations/table_bill_history_best_effort.sql', import.meta.url), 'utf8'));
    await db.exec(`
      CREATE TRIGGER capture AFTER UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION capture_table_bill_history();
      INSERT INTO tables VALUES ('00000000-0000-0000-0000-000000000001', NULL, 2);
      INSERT INTO orders VALUES
        ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'completed', 'BAO_BEP', NULL),
        ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'pending', NULL, NULL);
      UPDATE orders SET status='paid';
    `);
    const { rows } = await db.query('SELECT order_id, extract(epoch FROM expires_at - paid_at)::int AS ttl_seconds FROM table_bill_history');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].order_id, '00000000-0000-0000-0000-000000000003');
    assert.equal(rows[0].ttl_seconds, 36000);
    await db.exec(`
      TRUNCATE table_bill_history;
      ALTER TABLE table_bill_history ADD CONSTRAINT forced_failure CHECK (false);
      UPDATE orders SET status='pending';
      UPDATE orders SET status='paid';
    `);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM orders WHERE status='paid'")).rows[0].n, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM table_bill_history')).rows[0].n, 0);
  } finally { await db.close(); }
});
