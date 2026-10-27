import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { kitchenPrinterFor, resolvePrintCategory } from '../src/lib/kitchenTicket.mjs';

const db = new PGlite();
after(() => db.close());
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

const CAT_NUONG = id(1), CAT_XAO = id(2), CAT_BIA = id(3);
const P_QUAY = id(11), P_NUONG = id(12), P_XAO = id(13);
const OC = id(21), SO_DIEP = id(22), BIA = id(23), KHAN = id(24);
const OC_OPTIONS = [{ name: 'Kiểu', choices: ['Hấp', 'Nướng'], choiceCategories: [CAT_XAO, CAT_NUONG] }];
const TABLE = id(31), TABLE_QR = id(32), TABLE_OLD = id(33);
const STAFF = id(90);

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TABLE tables(id uuid PRIMARY KEY, status text, occupied_at timestamptz);
  CREATE TABLE orders(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, table_id uuid REFERENCES tables,
    customer_name text, customer_phone text, status text, total_amount numeric,
    created_by_id uuid, created_by_name text);
  CREATE TABLE order_items(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, order_id uuid REFERENCES orders,
    menu_item_id uuid, quantity integer, unit_price numeric, item_options jsonb DEFAULT '[]', note text,
    item_name text, added_by_id uuid, added_by_name text, is_gift boolean DEFAULT false,
    created_at timestamptz DEFAULT now());
  CREATE TABLE menu_items(id uuid PRIMARY KEY, category_id uuid, name text, options jsonb DEFAULT '[]');
  CREATE TABLE printers(id uuid PRIMARY KEY, name text, is_active boolean DEFAULT true, is_default boolean DEFAULT false,
    is_bill_printer boolean DEFAULT false, sort_order integer DEFAULT 0);
  CREATE TABLE printer_categories(printer_id uuid, category_id uuid, PRIMARY KEY (printer_id, category_id));
  CREATE TABLE print_jobs(id bigserial PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders, status text DEFAULT 'pending',
    printer_id uuid, filter_category_ids uuid[], order_ids uuid[], only_item_ids uuid[], created_at timestamptz DEFAULT now());

  INSERT INTO printers VALUES ('${P_QUAY}', 'Nước + Bia + Hoá Đơn', true, true, true, 1),
    ('${P_NUONG}', 'In Món Nướng', true, false, false, 2), ('${P_XAO}', 'In Món Xào Hấp + Cháo', true, false, false, 30);
  INSERT INTO printer_categories VALUES ('${P_QUAY}', '${CAT_BIA}'), ('${P_NUONG}', '${CAT_NUONG}'), ('${P_XAO}', '${CAT_XAO}');
  INSERT INTO menu_items VALUES ('${OC}', NULL, 'Ốc hương', '${JSON.stringify(OC_OPTIONS)}'),
    ('${SO_DIEP}', '${CAT_NUONG}', 'Sò điệp nướng', '[]'), ('${BIA}', '${CAT_BIA}', 'Bia Tiger', '[]'), ('${KHAN}', NULL, 'Khăn', '[]');
  INSERT INTO tables(id, status) VALUES ('${TABLE}', 'available'), ('${TABLE_QR}', 'occupied'), ('${TABLE_OLD}', 'occupied');
`);
await db.exec(migration('protect_settled_order_items.sql'));

// Bàn đang ăn từ trước khi cài: 1 bill đang mở (món nhân viên báo miệng) + 1 bill đã trả.
const OLD_OPEN = id(41), OLD_PAID = id(42);
await db.exec(`
  INSERT INTO orders(id, table_id, customer_name, status, total_amount) VALUES
    ('${OLD_OPEN}', '${TABLE_OLD}', 'Admin', 'pending', 60000), ('${OLD_PAID}', '${TABLE_OLD}', 'Khách', 'pending', 60000);
  INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price) VALUES
    ('${OLD_OPEN}', '${SO_DIEP}', 1, 60000), ('${OLD_PAID}', '${SO_DIEP}', 1, 60000);
  UPDATE orders SET status = 'paid' WHERE id = '${OLD_PAID}';
`);
await db.exec(migration('kitchen_tickets.sql'));
await db.exec(migration('confirm_draft_order_lines.sql'));

const oc = choice => ({ menu_item_id: OC, item_options: [{ name: 'Kiểu', choice }] });
const line = (menu, qty, price, lineId, extra = {}) => ({ line_id: lineId, menu_item_id: menu, quantity: qty, unit_price: price, item_options: [], note: '', ...extra });
async function confirm(table, items) {
  const { rows } = await db.query('SELECT confirm_draft_order($1, $2, $3, $4) AS r', [table, JSON.stringify(items), STAFF, 'NV']);
  return rows[0].r;
}
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const itemsOf = async order => (await db.query(
  `SELECT i.id, i.menu_item_id, i.item_options->0->>'choice' AS kieu, i.quantity, i.kitchen_sent_at IS NOT NULL AS sent
   FROM order_items i WHERE i.order_id = $1 ORDER BY i.created_at, i.menu_item_id, i.quantity`, [order])).rows;
const jobsOf = async order => (await db.query(
  `SELECT printer_id, only_item_ids FROM print_jobs WHERE order_id = $1 ORDER BY id`, [order])).rows;

test('cài lần đầu: món đang trên bàn coi như đã báo bếp; chạy lại không xoá dấu "chưa báo" thật', async () => {
  assert.equal((await one(`SELECT kitchen_sent_at IS NOT NULL AS sent FROM order_items WHERE order_id = $1`, [OLD_OPEN])).sent, true);
  assert.equal((await one(`SELECT kitchen_sent_at IS NOT NULL AS sent FROM order_items WHERE order_id = $1`, [OLD_PAID])).sent, false);
  await db.query(`INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price) VALUES ($1, $2, 1, 60000)`, [OLD_OPEN, SO_DIEP]);
  await db.exec(migration('kitchen_tickets.sql'));
  const rows = await itemsOf(OLD_OPEN);
  assert.deepEqual(rows.map(r => r.sent), [true, false]);
});

test('nhân viên gửi món: mỗi máy bếp 1 phiếu đúng các dòng vừa gửi; bia, khăn không in', async () => {
  const r = await confirm(TABLE, [
    line(OC, 1, 50000, id(101), oc('Hấp')), line(OC, 2, 50000, id(102), oc('Nướng')),
    line(SO_DIEP, 1, 60000, id(103)), line(BIA, 2, 17000, id(104)), line(KHAN, 1, 2000, id(105)),
  ]);
  assert.equal(r.kitchen_items, 3);
  assert.equal(r.print_jobs, 2);
  assert.equal(r.print_error, null);
  const rows = await itemsOf(r.order_id);
  const byKey = Object.fromEntries(rows.map(x => [`${x.menu_item_id}${x.kieu || ''}`, x]));
  const jobs = await jobsOf(r.order_id);
  const nuongJob = jobs.find(j => j.printer_id === P_NUONG);
  assert.deepEqual([...nuongJob.only_item_ids].sort(), [byKey[`${OC}Nướng`].id, byKey[SO_DIEP].id].sort());
  assert.deepEqual(jobs.find(j => j.printer_id === P_XAO).only_item_ids, [byKey[`${OC}Hấp`].id]);
  assert.equal(jobs.length, 2);
  assert.deepEqual(rows.filter(x => x.sent).map(x => x.menu_item_id).sort(), [OC, OC, SO_DIEP].sort());
});

test('gửi thêm cùng món bếp: dòng mới + phiếu chỉ in phần mới; bia cộng dồn, không in; gửi lại không in lại', async () => {
  const { order_id } = await confirm(TABLE, [line(SO_DIEP, 1, 60000, id(110)), line(BIA, 1, 17000, id(111))]);
  const rows = await itemsOf(order_id);
  const soDiep = rows.filter(x => x.menu_item_id === SO_DIEP);
  assert.equal(soDiep.length, 2);
  assert.deepEqual(rows.filter(x => x.menu_item_id === BIA).map(x => x.quantity), [3]);
  const last = (await jobsOf(order_id)).at(-1);
  assert.deepEqual(last, { printer_id: P_NUONG, only_item_ids: [soDiep[1].id] });

  const before = (await jobsOf(order_id)).length;
  const again = await confirm(TABLE, [line(SO_DIEP, 1, 60000, id(110))]);
  assert.equal(again.skipped_lines, 1);
  assert.equal((await jobsOf(order_id)).length, before);
});

test('phiếu khách QR theo danh mục chỉ đóng dấu món danh mục đó; hoá đơn / tạm tính không đóng dấu', async () => {
  const order = (await one(`INSERT INTO orders(table_id, customer_name, status, total_amount) VALUES ($1, 'Khách', 'pending', 0) RETURNING id`, [TABLE_QR])).id;
  await db.query(`INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price, item_options) VALUES
    ($1, $2, 1, 50000, '[{"name":"Kiểu","choice":"Nướng"}]'), ($1, $2, 1, 50000, '[{"name":"Kiểu","choice":"Hấp"}]'), ($1, $3, 1, 60000, '[]')`,
  [order, OC, SO_DIEP]);
  await db.query(`INSERT INTO print_jobs(order_id, printer_id, order_ids) VALUES ($1, $2, ARRAY[$1]::uuid[])`, [order, P_QUAY]);
  assert.deepEqual((await itemsOf(order)).map(x => x.sent), [false, false, false]);
  await db.query(`INSERT INTO print_jobs(order_id, printer_id, filter_category_ids) VALUES ($1, $2, ARRAY[$3]::uuid[])`, [order, P_NUONG, CAT_NUONG]);
  const sent = (await itemsOf(order)).filter(x => x.sent).map(x => `${x.menu_item_id}${x.kieu || ''}`).sort();
  assert.deepEqual(sent, [`${OC}Nướng`, SO_DIEP].sort());
});

test('nút In bếp: chỉ in món chưa báo, bấm 2 lần không in trùng', async () => {
  const order = (await one(`SELECT id FROM orders WHERE table_id = $1 AND customer_name = 'Khách'`, [TABLE_QR])).id;
  const hap = (await itemsOf(order)).find(x => x.kieu === 'Hấp');
  const all = (await itemsOf(order)).map(x => x.id);
  assert.equal((await one(`SELECT queue_kitchen_tickets($1, $2::uuid[]) AS n`, [order, `{${all.join(',')}}`])).n, 1);
  assert.deepEqual((await jobsOf(order)).at(-1), { printer_id: P_XAO, only_item_ids: [hap.id] });
  assert.equal((await one(`SELECT queue_kitchen_tickets($1, $2::uuid[]) AS n`, [order, `{${hap.id}}`])).n, 0);
});

test('bấm "+" món bếp đã báo: dòng mới + phiếu riêng; món chưa báo hoặc bia thì cộng vào dòng', async () => {
  const { order_id } = await confirm(TABLE, [line(KHAN, 1, 2000, id(120))]);
  const rows = await itemsOf(order_id);
  const soDiep = rows.find(x => x.menu_item_id === SO_DIEP);
  const r = (await one(`SELECT add_item_portion($1, 2, $2, 'NV') AS r`, [soDiep.id, STAFF])).r;
  assert.equal(r.new_line, true);
  assert.equal(r.print_jobs, 1);
  assert.equal((await one(`SELECT quantity FROM order_items WHERE id = $1`, [soDiep.id])).quantity, 1);
  assert.deepEqual((await jobsOf(order_id)).at(-1), { printer_id: P_NUONG, only_item_ids: [r.item_id] });
  assert.equal((await one(`SELECT quantity, kitchen_sent_at IS NOT NULL AS sent FROM order_items WHERE id = $1`, [r.item_id])).quantity, 2);

  const bia = rows.find(x => x.menu_item_id === BIA);
  const b = (await one(`SELECT add_item_portion($1, 1) AS r`, [bia.id])).r;
  assert.equal(b.new_line, false);
  assert.equal((await one(`SELECT quantity FROM order_items WHERE id = $1`, [bia.id])).quantity, 4);

  const unsent = (await one(`INSERT INTO order_items(order_id, menu_item_id, quantity, unit_price) VALUES ($1, $2, 1, 60000) RETURNING id`, [order_id, SO_DIEP])).id;
  assert.equal((await one(`SELECT add_item_portion($1, 1) AS r`, [unsent])).r.new_line, false);
  assert.equal((await one(`SELECT quantity FROM order_items WHERE id = $1`, [unsent])).quantity, 2);
  await assert.rejects(db.query(`SELECT add_item_portion($1, 0)`, [soDiep.id]), /không hợp lệ/);
});

test('in lại phiếu của bill đã trả tiền không bị lỗi (không đụng món của bill đã chốt)', async () => {
  await db.query(`INSERT INTO print_jobs(order_id, printer_id) VALUES ($1, $2)`, [OLD_PAID, P_NUONG]);
  assert.equal((await one(`SELECT kitchen_sent_at IS NOT NULL AS sent FROM order_items WHERE order_id = $1`, [OLD_PAID])).sent, false);
});

test('tạo phiếu lỗi thì món vẫn vào bill, còn dấu "chưa báo bếp"', async () => {
  await db.exec(`ALTER TABLE print_jobs ADD CONSTRAINT test_no_jobs CHECK (false) NOT VALID`);
  try {
    const r = await confirm(TABLE, [line(SO_DIEP, 1, 60000, id(130))]);
    assert.equal(r.print_jobs, 0);
    assert.match(r.print_error, /test_no_jobs/);
    const added = (await itemsOf(r.order_id)).filter(x => x.menu_item_id === SO_DIEP).at(-1);
    assert.equal(added.sent, false);
  } finally {
    await db.exec(`ALTER TABLE print_jobs DROP CONSTRAINT test_no_jobs`);
  }
});

test('máy chủ và trang Bàn chọn cùng máy bếp cho mọi món', async () => {
  const printers = (await db.query(`SELECT p.*, COALESCE(json_agg(json_build_object('category_id', pc.category_id))
    FILTER (WHERE pc.category_id IS NOT NULL), '[]') AS printer_categories
    FROM printers p LEFT JOIN printer_categories pc ON pc.printer_id = p.id GROUP BY p.id`)).rows;
  const cases = [
    { menu: OC, category: null, options: OC_OPTIONS, item_options: [{ name: 'Kiểu', choice: 'Hấp' }] },
    { menu: OC, category: null, options: OC_OPTIONS, item_options: [{ name: 'Kiểu', choice: 'Nướng' }] },
    { menu: OC, category: null, options: OC_OPTIONS, item_options: [] },
    { menu: SO_DIEP, category: CAT_NUONG, options: [], item_options: [] },
    { menu: BIA, category: CAT_BIA, options: [], item_options: [] },
    { menu: KHAN, category: null, options: [], item_options: [] },
  ];
  for (const c of cases) {
    const sql = (await one(`SELECT kitchen_printer_for($1, $2) AS p`, [c.menu, JSON.stringify(c.item_options)])).p;
    const js = kitchenPrinterFor(resolvePrintCategory({ menu_item: { category_id: c.category }, item_options: c.item_options }, c.options), printers);
    assert.equal(sql, js?.id ?? null, JSON.stringify(c.item_options));
  }
});
