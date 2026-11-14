import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  applyOrderRefusal, customerOrderLines, initialOptionSelection, selectionToItemOptions, toggleMultiChoice,
} from '../src/lib/draftCart.mjs';

// submit_customer_order_menu_check.sql: đơn khách gửi lên được đối chiếu với thực đơn — giá theo
// menu_items (kể cả giá lựa chọn), món / lựa chọn đang tắt bị từ chối, và quà chỉ nhận khi là quà
// "8 tặng 1" đủ suất. Từ chối thì không ghi gì.
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const db = new PGlite();
after(() => db.close());
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE settings(key text PRIMARY KEY, value text);
  CREATE TABLE tables(id uuid PRIMARY KEY, status text, occupied_at timestamptz, merged_with uuid, table_type text DEFAULT 'normal');
  CREATE TABLE menu_items(id uuid PRIMARY KEY, name text, price integer, is_available boolean DEFAULT true,
    hidden_until timestamptz, options jsonb, is_gift_item boolean DEFAULT false, counts_for_promotion boolean DEFAULT false);
  CREATE TABLE orders(id uuid PRIMARY KEY, table_id uuid REFERENCES tables, customer_id uuid, customer_name text,
    customer_phone text, status text, total_amount numeric, delivery_address text, customer_note text,
    created_at timestamptz DEFAULT now());
  CREATE TABLE order_items(id uuid DEFAULT gen_random_uuid() PRIMARY KEY, order_id uuid REFERENCES orders,
    menu_item_id uuid, quantity integer, unit_price integer, item_options jsonb, note text, is_gift boolean);
`);
await db.exec(migration('submit_customer_order_atomic.sql'));
await db.exec(migration('submit_customer_order_menu_check.sql'));

const LOAI = { name: 'LOẠI', choices: ['Nướng mỡ hành', 'Rang muối', 'Hấp sả'], prices: [120000, 150000, null], hiddenChoices: [false, false, false] };
const THEM = { name: 'THÊM', choices: ['Bánh mì', 'Rau'], prices: [5000, 3000], hiddenChoices: [false, false] };
const KHAU_VI = { name: 'KHẨU VỊ', choices: ['Cay', 'Không cay'], prices: [null, null], hiddenChoices: [false, false] };
const OC = id(20), GHE = id(21), BIA = id(22), NUOC = id(23), SO = id(24), TOM = id(25);

async function reset() {
  await db.exec(`TRUNCATE order_items, orders, tables, menu_items, settings CASCADE`);
  await db.query(`INSERT INTO tables(id,status,merged_with,table_type) VALUES ($1,'available',NULL,'normal'), ($2,'occupied',$1,'normal'),
    ($3,'available',NULL,'takeaway')`, [id(1), id(2), id(3)]);
  await db.query(`INSERT INTO settings VALUES ('promotion_enabled','true'), ('promotion_threshold','8')`);
  await db.query(`INSERT INTO menu_items(id,name,price,options,counts_for_promotion,is_gift_item,is_available,hidden_until) VALUES
    ($1,'Ốc hương',0,$7,true,false,true,NULL),
    ($2,'Ghẹ rang me',350000,$8,true,false,true,now() + interval '3 hours'),
    ($3,'Bia',20000,'[]',false,false,true,NULL),
    ($4,'Nước sâm',15000,'[]',false,true,true,NULL),
    ($5,'Sò điệp',60000,$9,true,false,true,NULL),
    ($6,'Tôm hùm',900000,'[]',false,true,false,NULL)`,
  [OC, GHE, BIA, NUOC, SO, TOM, JSON.stringify([LOAI, THEM, KHAU_VI]), JSON.stringify([KHAU_VI]),
    JSON.stringify([{ ...KHAU_VI, promoDivisors: ['', ''] }, { __promo_divisor: 2 }])]);
}

const line = (menuItem, quantity, unitPrice, extra = {}) => ({ menu_item_id: menuItem, quantity, unit_price: unitPrice, item_options: [], is_gift: false, ...extra });
const gift = (menuItem, extra = {}) => line(menuItem, 1, 0, { is_gift: true, ...extra });
async function submit(orderId, items, { table = id(1), phone = '0900000000' } = {}) {
  const { rows } = await db.query('SELECT submit_customer_order_atomic($1,$2,NULL,$3,$4,NULL,NULL,$5) AS r',
    [orderId, table, 'Khách', phone, JSON.stringify(items)]);
  return rows[0].r;
}
const count = async table => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const savedLines = async orderId => (await db.query(
  'SELECT menu_item_id, quantity, unit_price, is_gift FROM order_items WHERE order_id = $1 ORDER BY unit_price DESC, menu_item_id', [orderId])).rows;
const openBill = async (orderId, items, { table = id(1), phone = '0911111111', createdAt = 'now()' } = {}) => {
  await db.query(`INSERT INTO orders(id,table_id,customer_phone,status,created_at) VALUES ($1,$2,$3,'pending',${createdAt})`, [orderId, table, phone]);
  for (const i of items) {
    await db.query('INSERT INTO order_items(order_id,menu_item_id,quantity,unit_price,item_options,note,is_gift) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orderId, i.menu_item_id, i.quantity, i.unit_price, JSON.stringify(i.item_options || []), i.note || null, !!i.is_gift]);
  }
};

test('the reviewer case: an old cart price and a switched-off dish marked as a 0đ gift are both refused, nothing is written', async () => {
  await reset();
  await db.query(`UPDATE menu_items SET hidden_until = NULL WHERE id = $1`, [GHE]);
  await db.query(`UPDATE menu_items SET options = '[]' WHERE id = $1`, [GHE]);
  const r = await submit(id(10), [line(GHE, 2, 290000), gift(TOM)]);
  assert.equal(r.rejected, true);
  assert.equal(r.order_id, null);
  assert.deepEqual(r.lines.map(l => [l.index, l.problem, l.price ?? null]), [[0, 'price', 350000], [1, 'off', null]]);
  assert.equal(r.reason, 'item_off');
  assert.equal(await count('orders'), 0);
  assert.equal((await db.query('SELECT status FROM tables WHERE id = $1', [id(1)])).rows[0].status, 'available');
});

test('a dish switched off until later, or off for good, is refused with its name', async () => {
  await reset();
  const r = await submit(id(10), [line(BIA, 1, 20000), line(GHE, 1, 350000, { item_options: [{ name: 'KHẨU VỊ', choice: 'Cay' }] })]);
  assert.deepEqual(r.lines, [{ index: 1, menu_item_id: GHE, name: 'Ghẹ rang me', problem: 'off' }]);
  await db.query(`UPDATE menu_items SET hidden_until = now() - interval '1 minute' WHERE id = $1`, [GHE]);
  assert.equal((await submit(id(11), [line(GHE, 1, 350000, { item_options: [{ name: 'KHẨU VỊ', choice: 'Cay' }] })])).already_submitted, false);
  await db.query(`UPDATE menu_items SET is_available = false WHERE id = $1`, [BIA]);
  assert.equal((await submit(id(12), [line(BIA, 1, 20000)])).reason, 'item_off');
});

test('the unit price comes from the menu, with the chosen LOẠI and every extra that has a price', async () => {
  await reset();
  const opts = [{ name: 'LOẠI', choice: 'Rang muối' }, { name: 'THÊM', choice: 'Bánh mì, Rau' }, { name: 'KHẨU VỊ', choice: 'Cay' }];
  const wrong = await submit(id(10), [line(OC, 2, 150000, { item_options: opts })]);
  assert.deepEqual(wrong.lines.map(l => [l.problem, l.price]), [['price', 158000]]);
  const ok = await submit(id(10), [line(OC, 2, 158000, { item_options: opts }), line(BIA, 3, 20000)]);
  assert.equal(ok.already_submitted, false);
  assert.equal(Number(ok.total), 2 * 158000 + 3 * 20000);
  // Tên lựa chọn có dấu phẩy vẫn tách đúng khi khách chọn nhiều (trang ghép bằng ", ").
  await db.query('UPDATE menu_items SET options = $2 WHERE id = $1', [OC, JSON.stringify([LOAI,
    { ...THEM, choices: ['Bánh mì', 'Rau, giá'], prices: [5000, 4000] }])]);
  const comma = [{ name: 'LOẠI', choice: 'Rang muối' }, { name: 'THÊM', choice: 'Rau, giá, Bánh mì' }];
  assert.equal((await submit(id(12), [line(OC, 1, 159000, { item_options: comma })])).already_submitted, false);
  // Lựa chọn không đặt giá (Hấp sả) → giá món (0đ = theo thời giá, nhân viên nhập sau).
  assert.equal((await submit(id(11), [line(OC, 1, 0, { item_options: [{ name: 'LOẠI', choice: 'Hấp sả' }] })])).already_submitted, false);
  assert.equal((await db.query('SELECT status FROM tables WHERE id = $1', [id(1)])).rows[0].status, 'occupied');
});

test('a switched-off or removed choice is refused, an expired switch-off is not', async () => {
  await reset();
  const loai = hidden => JSON.stringify([{ ...LOAI, hiddenChoices: [false, hidden, false] }]);
  await db.query('UPDATE menu_items SET options = $2 WHERE id = $1', [OC, loai(true)]);
  const rang = [{ name: 'LOẠI', choice: 'Rang muối' }];
  assert.deepEqual((await submit(id(10), [line(OC, 1, 150000, { item_options: rang })])).lines,
    [{ index: 0, menu_item_id: OC, name: 'Ốc hương', choice: 'Rang muối', problem: 'off' }]);
  await db.query(`UPDATE menu_items SET options = $2 WHERE id = $1`, [OC, loai(new Date(Date.now() + 3600000).toISOString())]);
  assert.equal((await submit(id(10), [line(OC, 1, 150000, { item_options: rang })])).reason, 'item_off');
  assert.equal((await submit(id(10), [line(OC, 1, 150000, { item_options: [{ name: 'LOẠI', choice: 'Xào bơ' }] })])).reason, 'item_off');
  await db.query(`UPDATE menu_items SET options = $2 WHERE id = $1`, [OC, loai(new Date(Date.now() - 60000).toISOString())]);
  assert.equal((await submit(id(10), [line(OC, 1, 150000, { item_options: rang })])).already_submitted, false);
});

test('a retry after a lost reply still returns the first order, even if the menu changed meanwhile', async () => {
  await reset();
  assert.equal((await submit(id(10), [line(BIA, 2, 20000)])).already_submitted, false);
  await db.query(`UPDATE menu_items SET price = 25000 WHERE id = $1`, [BIA]);
  assert.equal((await submit(id(10), [line(BIA, 2, 20000)])).already_submitted, true);
  assert.equal(await count('orders'), 1);
  assert.deepEqual(await savedLines(id(10)), [{ menu_item_id: BIA, quantity: 2, unit_price: 20000, is_gift: false }]);
});

test('a 0đ "gift" of a dish that is not a gift item is refused', async () => {
  await reset();
  await openBill(id(9), [line(SO, 16, 60000)]);
  const r = await submit(id(10), [gift(BIA)]);
  assert.deepEqual([r.reason, r.lines[0].problem], ['gift_not_allowed', 'gift']);
  // Ghi chú "quà vòng xoay" không được dùng để lách suất quà.
  assert.equal((await submit(id(11), [gift(NUOC, { note: 'Quà tặng từ vòng quay may mắn' })])).reason, 'gift_not_allowed');
});

test('the 8-for-1 gift is accepted when the table group has earned it, and only that many', async () => {
  await reset();
  // 6 món ở bàn host + 2 món ở bàn gộp (bàn 2) = 8 → 1 suất. Quà vòng xoay đã có không trừ suất.
  await openBill(id(8), [line(OC, 6, 120000, { item_options: [{ name: 'LOẠI', choice: 'Nướng mỡ hành' }] }),
    { ...gift(NUOC), note: 'Quà tặng từ vòng quay may mắn' }]);
  await openBill(id(9), [line(OC, 2, 120000, { item_options: [{ name: 'LOẠI', choice: 'Nướng mỡ hành' }] })], { table: id(2) });
  assert.equal((await submit(id(10), [gift(NUOC), gift(NUOC)])).reason, 'gift_not_allowed', 'two gifts for one slot');
  const ok = await submit(id(10), [gift(NUOC, { note: 'ít đá' })]);
  assert.equal(ok.already_submitted, false);
  assert.deepEqual(await savedLines(id(10)), [{ menu_item_id: NUOC, quantity: 1, unit_price: 0, is_gift: true }]);
  assert.equal((await submit(id(11), [gift(NUOC)])).reason, 'gift_not_allowed', 'the slot is used now');
  // Món trong chính đơn này cũng tính: thêm 8 món → được thêm 1 quà.
  assert.equal((await submit(id(11), [line(BIA, 1, 20000), line(OC, 8, 120000, { item_options: [{ name: 'LOẠI', choice: 'Nướng mỡ hành' }] }), gift(NUOC)])).already_submitted, false);
});

test('half-portion dishes count half, and no gift is accepted while the promotion is off', async () => {
  await reset();
  await openBill(id(9), [line(SO, 15, 60000)]); // SL/1 KM = 2 → 7,5 món
  assert.equal((await submit(id(10), [gift(NUOC)])).reason, 'gift_not_allowed');
  assert.equal((await submit(id(10), [line(SO, 1, 60000), gift(NUOC)])).already_submitted, false, '8 món');
  await db.query(`UPDATE settings SET value = 'false' WHERE key = 'promotion_enabled'`);
  await openBill(id(11), [line(SO, 16, 60000)]);
  assert.equal((await submit(id(12), [gift(NUOC)])).reason, 'gift_not_allowed');
});

test('open bills from before midnight still count; takeaway counts only the same phone since 5 am', async () => {
  await reset();
  await openBill(id(9), [line(BIA, 1, 20000), line(SO, 16, 60000)], { createdAt: `now() - interval '20 hours'` });
  assert.equal((await submit(id(10), [gift(NUOC)])).already_submitted, false, 'dine-in: an unpaid bill counts whatever its day');
  await openBill(id(11), [line(SO, 16, 60000)], { table: id(3), phone: '0922222222' });
  await openBill(id(12), [line(SO, 16, 60000)], { table: id(3), phone: '0933333333', createdAt: `now() - interval '2 days'` });
  assert.equal((await submit(id(13), [gift(NUOC)], { table: id(3), phone: '0933333333' })).reason, 'gift_not_allowed');
  assert.equal((await submit(id(13), [gift(NUOC)], { table: id(3), phone: '0922222222' })).already_submitted, false);
});

test('a gift with LOẠI + tastes picked in the gift window is accepted; the old letter-split taste was the "hết" refusal', async () => {
  // Bàn 10: đủ suất quà, khách chọn món quà có KHẨU VỊ và bấm thêm khẩu vị → máy chủ báo "hết".
  await reset();
  const OC_MON = id(26);
  const options = [{ name: 'LOẠI', choices: ['Nướng mỡ hành', 'Nướng phô mai'], prices: [50000, 50000], hiddenChoices: [false, false] },
    { name: 'KHẨU VỊ', choices: ['Bình Thường', 'Làm Cay', 'Không Cay'], prices: [null, null, null], hiddenChoices: [false, false, false] }];
  await db.query(`INSERT INTO menu_items(id,name,price,options,counts_for_promotion,is_gift_item) VALUES ($1,'Ốc Môn',50000,$2,true,true)`,
    [OC_MON, JSON.stringify(options)]);
  await openBill(id(9), [line(SO, 16, 60000)]); // 8 món → 1 suất
  // Cũ: bảng quà giữ KHẨU VỊ là chữ "Bình Thường", bấm "Làm Cay" → [...'Bình Thường', 'Làm Cay'].
  const old = [{ name: 'LOẠI', choice: 'Nướng mỡ hành' }, { name: 'KHẨU VỊ', choice: [...'Bình Thường', 'Làm Cay'].join(', ') }];
  const refused = await submit(id(10), customerOrderLines([], [{ id: OC_MON, _options: old }]));
  assert.deepEqual([refused.reason, refused.lines[0].problem, refused.lines[0].choice], ['item_off', 'off', 'B']);
  assert.match(applyOrderRefusal([], [{ id: OC_MON, name: 'Ốc Môn' }], refused.lines).message, /Món đã hết \/ tạm ngưng.*Ốc Môn · B/);
  // Mới: cùng các bước bấm, qua đúng hàm trang gọi món dùng.
  let sel = initialOptionSelection(options);
  sel = { ...sel, 'KHẨU VỊ': toggleMultiChoice(sel['KHẨU VỊ'], 'Làm Cay') };
  sel = { ...sel, 'KHẨU VỊ': toggleMultiChoice(sel['KHẨU VỊ'], 'Không Cay') };
  const ok = await submit(id(10), customerOrderLines([], [{ id: OC_MON, _options: selectionToItemOptions(sel) }]));
  assert.equal(ok.already_submitted, false);
  assert.deepEqual(await savedLines(id(10)), [{ menu_item_id: OC_MON, quantity: 1, unit_price: 0, is_gift: true }]);
  assert.deepEqual((await db.query('SELECT item_options FROM order_items WHERE order_id = $1', [id(10)])).rows[0].item_options,
    [{ name: 'LOẠI', choice: 'Nướng mỡ hành' }, { name: 'KHẨU VỊ', choice: 'Làm Cay, Không Cay' }]);
});
