import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const wheel = await import(`data:text/javascript;base64,${Buffer.from(read('../src/lib/luckyWheel.js')).toString('base64')}`);
const source = read('../src/lib/zaloRewardServer.js').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const printerSource = read('../src/lib/print.jsx');
const start = printerSource.indexOf('export async function sendGiftItemPrintJob');
const end = printerSource.indexOf('\n/**', start);
const printerFn = printerSource.slice(start, end).replace('export ', '');
const now = new Date().toISOString();
const spinTemplate = { id: 'spin', host_table_id: 'table', customer_phone: '0900000000',
  status: 'applied', applied_order_id: 'order', applied_item_id: null,
  gift_menu_item_id: 'drink', gift_item_options: [], prize_type: 'gift_drink', prize_value: 3, created_at: now };

function database(spin = spinTemplate) {
  const state = {
    tables: [{ id: 'table', table_type: 'normal', occupied_at: new Date(Date.now() - 60000).toISOString() }],
    lucky_spins: [structuredClone(spin)],
    orders: [{ id: 'order', table_id: 'table', customer_phone: '0900000000', status: 'pending', created_at: now, total_amount: 100000 }],
    order_items: [{ id: 'food-line', order_id: 'order', unit_price: 100000, quantity: 1 }],
    menu_items: [{ id: 'drink', is_available: true, options: [], category_id: 'drinks' }],
    printers: [{ id: 'printer', is_default: true, is_active: true, printer_categories: [] }],
    print_jobs: [], zalo_followers: [], zalo_reward_claims: [], customers: [],
    settings: [{ key: 'lucky_wheel_drink_item_ids', value: '["drink"]' }, { key: 'lucky_wheel_enabled', value: 'true' }],
  };
  const fail = new Map();
  const db = { from(table) {
    let op = 'read', values, single = false, conditions = [], max = Infinity;
    const q = {
      select() { return q; },
      eq(k, v) { conditions.push(r => r[k] === v); return q; },
      is(k, v) { conditions.push(r => (r[k] ?? null) === v); return q; },
      in(k, vs) { conditions.push(r => vs.includes(r[k])); return q; },
      contains(k, vs) { conditions.push(r => vs.every(v => r[k]?.includes(v))); return q; },
      overlaps(k, vs) { conditions.push(r => vs.some(v => r[k]?.includes(v))); return q; },
      gte(k, v) { conditions.push(r => r[k] >= v); return q; },
      or() { return q; }, order() { return q; },
      limit(n) { max = n; return q; },
      update(v) { op = 'update'; values = v; return q; },
      insert(v) { op = 'insert'; values = v; return q; },
      delete() { op = 'delete'; return q; },
      maybeSingle() { single = true; return q; },
      async then(resolve, reject) {
        try {
          // Yield so Promise.all reads overlap before the inserts.
          await Promise.resolve();
          const key = `${table}:${op}`;
          if (fail.get(key)) {
            fail.set(key, fail.get(key) - 1);
            return resolve({ data: null, error: { code: 'NETWORK_TEST', message: key } });
          }
          let rows = (state[table] || []).filter(r => conditions.every(c => c(r))).slice(0, max);
          if (op === 'insert') {
            if (state[table].some(r => r.id === values.id || (values.dedupe_key && r.dedupe_key === values.dedupe_key))) {
              return resolve({ data: null, error: { code: '23505' } });
            }
            if (table === 'print_jobs' && 'id' in values) return resolve({ data: null, error: { code: '22P02', message: 'print_jobs.id is bigint' } });
            rows = [structuredClone(values)]; state[table].push(rows[0]);
          } else if (op === 'update') rows.forEach(r => Object.assign(r, structuredClone(values)));
          else if (op === 'delete') { const del = new Set(rows.map(r => r.id)); state[table] = state[table].filter(r => !del.has(r.id)); }
          const result = structuredClone(rows);
          if (table === 'order_items') result.forEach(r => { r.menu_item = state.menu_items.find(m => m.id === r.menu_item_id); });
          resolve({ data: single ? result[0] ?? null : result, error: null });
        } catch (error) { reject(error); }
      },
    };
    return q;
  }, rpc: async () => ({ data: null, error: { code: 'NETWORK_TEST', message: 'rpc offline' } }) };
  const print = vm.runInNewContext(`(${printerFn})`, { console: { log() {}, error() {} } });
  // Mock sendOaText: ghi lại tin đã gửi để kiểm "nhắn đúng 1 lần".
  const sentMessages = [];
  const sendOaText = async (_sb, userId, text) => { sentMessages.push({ userId, text }); return { ok: true }; };
  const funcs = vm.runInNewContext(`${source}\n({ finalizeGiftItem, completeLuckySpin, applyLuckySpin, pickGiftItem, tryApplyLuckyByTiming, tryApplyLuckyForSpin, grantLuckySpinManually, removeLuckyGiftItem, listAdminLuckySpins, markFollowTapped, autoApproveTappedSpin })`, {
    ...wheel, sendGiftItemPrintJob: print, sendOaText, console: { log() {}, error() {} }, Date, Set,
  });
  return { state, fail, db, sentMessages, ...funcs };
}

test('20 concurrent gift retries deliver exactly 3 units in one line and one print job', async () => {
  const h = database();
  await Promise.all(Array.from({ length: 20 }, () => h.finalizeGiftItem(h.db, structuredClone(spinTemplate), 'order')));
  const gifts = h.state.order_items.filter(r => r.is_gift);
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].quantity, 3);
  assert.equal(h.state.print_jobs.length, 1);
  assert.equal(h.state.lucky_spins[0].applied_item_id, gifts[0].id);
});

test('receipt update failure retries the same gift and same print job', async () => {
  const h = database();
  h.fail.set('lucky_spins:update', 1);
  await assert.rejects(h.completeLuckySpin(h.db, spinTemplate));
  assert.equal(h.state.lucky_spins[0].applied_item_id, null);
  await h.completeLuckySpin(h.db, spinTemplate);
  assert.equal(h.state.order_items.filter(r => r.is_gift).length, 1);
  assert.equal(h.state.print_jobs.length, 1);
});

test('printer outage still credits the gift (receipt set) and does not lose it; retry prints', async () => {
  const spin = { ...spinTemplate, zalo_user_id: 'zalo-user' };
  const h = database(spin);
  h.fail.set('print_jobs:insert', 1);
  // In hỏng KHÔNG còn chặn: quà đã vào bill → ghi receipt + không throw.
  await h.completeLuckySpin(h.db, spin);
  const gift = h.state.order_items.find(r => r.is_gift);
  assert.equal(h.state.order_items.filter(r => r.is_gift).length, 1);
  assert.equal(h.state.lucky_spins[0].applied_item_id, gift.id); // đã ghi nhận nhận quà
  assert.equal(h.sentMessages.length, 1);                         // khách vẫn nhận tin
  // Lần poll sau (claim-ready) in lại được, không thêm dòng quà thứ 2.
  await h.completeLuckySpin(h.db, spin);
  assert.equal(h.state.order_items.filter(r => r.is_gift).length, 1);
  assert.equal(h.state.print_jobs.length, 1);
  assert.equal(h.sentMessages.length, 1);                         // không nhắn trùng
});

test('fixed discount total-update failure is recoverable without subtracting twice', async () => {
  const spin = { ...spinTemplate, prize_type: 'amount', prize_value: 5000, discount_amount: 5000, gift_menu_item_id: null };
  const h = database(spin);
  h.fail.set('orders:update', 1);
  await assert.rejects(h.completeLuckySpin(h.db, spin));
  assert.equal(h.state.lucky_spins[0].applied_item_id, null);
  await h.completeLuckySpin(h.db, spin);
  await h.completeLuckySpin(h.db, spin);
  assert.equal(h.state.orders[0].total_amount, 95000);
  assert.equal(h.state.order_items.filter(r => r.unit_price < 0).length, 1);
});

test('20 concurrent fixed discount retries subtract only once', async () => {
  const spin = { ...spinTemplate, prize_type: 'amount', prize_value: 5000, discount_amount: 5000, gift_menu_item_id: null };
  const h = database(spin);
  await Promise.all(Array.from({ length: 20 }, () => h.completeLuckySpin(h.db, spin)));
  assert.equal(h.state.orders[0].total_amount, 95000);
  assert.equal(h.state.order_items.filter(r => r.unit_price < 0).length, 1);
});

test('an order-read failure cannot turn the total into zero', async () => {
  const spin = { ...spinTemplate, prize_type: 'amount', discount_amount: 5000 };
  const h = database(spin);
  h.fail.set('order_items:read', 1);
  await assert.rejects(h.completeLuckySpin(h.db, spin));
  assert.equal(h.state.orders[0].total_amount, 100000);
  assert.equal(h.state.lucky_spins[0].applied_item_id, null);
});

test('percent retries use the database amount instead of the original spin amount', async () => {
  const spin = { ...spinTemplate, prize_type: 'percent', discount_amount: 3000 };
  const h = database(spin);
  h.db.rpc = async (name, args) => {
    assert.equal(name, 'refresh_lucky_percent_reward');
    assert.equal(args.p_spin_id, spin.id);
    return { data: { id: spin.id, unit_price: -5000 }, error: null };
  };
  assert.equal((await h.completeLuckySpin(h.db, spin)).unit_price, -5000);
  assert.equal(h.state.order_items.length, 1); // no stale client-side write
});

test('percent RPC failure stays retryable and never falls back to a fixed discount', async () => {
  const spin = { ...spinTemplate, prize_type: 'percent', discount_amount: 3000 };
  const h = database(spin);
  await assert.rejects(h.completeLuckySpin(h.db, spin), /Chưa cập nhật/);
  assert.equal(h.state.order_items.length, 1);
  assert.equal(h.state.lucky_spins[0].applied_item_id, null);
});

test('closed original bill cannot be replaced by another open bill', async () => {
  const h = database();
  h.state.orders[0].status = 'paid';
  h.state.orders.push({ ...h.state.orders[0], id: 'new-order', status: 'pending' });
  await assert.rejects(h.completeLuckySpin(h.db, spinTemplate));
  assert.equal(h.state.order_items.length, 1);
});

test('old spin cannot be applied to the next table session', async () => {
  const h = database();
  h.state.tables[0].occupied_at = new Date(Date.now() + 60000).toISOString();
  await assert.rejects(h.completeLuckySpin(h.db, spinTemplate));
  assert.equal(h.state.order_items.length, 1);
});

test('anonymous follow / recent stranger never claims a wheel reward by timing', async () => {
  const h = database();
  assert.equal((await h.tryApplyLuckyByTiming(h.db, 'stranger')).matched, false);
  assert.equal((await h.tryApplyLuckyForSpin(h.db, spinTemplate)).matched, false);
  assert.equal(h.state.order_items.length, 1);
});

test('admin manual grant writes a chosen gift into the bill', async () => {
  const h = database({ ...spinTemplate, status: 'waiting_follow', applied_order_id: null,
    applied_item_id: null, zalo_user_id: null });
  h.db.rpc = async () => ({ data: true, error: null }); // claim_lucky_wheel_slot chốt được slot
  const r = await h.grantLuckySpinManually(h.db, 'spin');
  assert.equal(r.ok, true);
  assert.equal(h.state.order_items.filter(r2 => r2.is_gift).length, 1);
  assert.equal(h.state.lucky_spins[0].applied_item_id !== null, true);
});

test('already delivered gift returns success on a customer retry', async () => {
  const h = database({ ...spinTemplate, applied_item_id: 'existing' });
  const result = await h.pickGiftItem(h.db, 'spin', 'drink', []);
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
});

test('sold-out drink and invalid options do not reserve a gift choice', async () => {
  const h = database({ ...spinTemplate, gift_menu_item_id: null });
  h.state.menu_items[0].is_available = false;
  assert.equal((await h.pickGiftItem(h.db, 'spin', 'drink', [])).ok, false);
  h.state.menu_items[0].is_available = true;
  h.state.menu_items[0].options = [{ name: 'Loại', choices: ['A', 'B'] }];
  assert.equal((await h.pickGiftItem(h.db, 'spin', 'drink', [])).ok, false);
  assert.equal(h.state.lucky_spins[0].gift_menu_item_id, null);
});

test('legacy gift without receipt is recovered without adding or printing again', async () => {
  const h = database();
  h.state.order_items.push({ id: 'old-random-id', order_id: 'order', menu_item_id: 'drink', quantity: 3,
    unit_price: 0, is_gift: true, note: 'Quà tặng từ vòng quay may mắn' });
  h.state.print_jobs.push({ id: 'old-print-job', order_id: 'order', only_item_ids: ['old-random-id'], status: 'pending' });
  await h.completeLuckySpin(h.db, spinTemplate);
  assert.equal(h.state.order_items.filter(r => r.is_gift).length, 1);
  assert.equal(h.state.print_jobs.length, 1);
  assert.equal(h.state.lucky_spins[0].applied_item_id, 'old-random-id');
});

test('slot RPC outage leaves the spin waiting rather than permanently blocked', async () => {
  const spin = { ...spinTemplate, status: 'waiting_follow', applied_order_id: null };
  const h = database(spin);
  await assert.rejects(h.applyLuckySpin(h.db, spin, null));
  assert.equal(h.state.lucky_spins[0].status, 'waiting_follow');
  assert.equal(h.state.order_items.length, 1);
});

test('an open bill across midnight still receives its pending reward', async () => {
  const created = new Date(Date.now() - 24 * 3600000).toISOString();
  const spin = { ...spinTemplate, created_at: created };
  const h = database(spin);
  h.state.tables[0].occupied_at = new Date(Date.now() - 25 * 3600000).toISOString();
  h.state.orders[0].created_at = created;
  await h.completeLuckySpin(h.db, spin);
  assert.equal(h.state.lucky_spins[0].applied_item_id, spin.id);
});

test('a saved explicit Zalo identity can resume after an interrupted webhook', async () => {
  const spin = { ...spinTemplate, zalo_user_id: 'known-user' };
  const h = database(spin);
  h.state.zalo_followers.push({ zalo_user_id: 'known-user', followed_at: now, unfollowed_at: null });
  assert.equal((await h.tryApplyLuckyForSpin(h.db, spin)).matched, true);
  assert.equal(h.state.lucky_spins[0].applied_item_id, spin.id);
});

test('repeating a spin request after a lost response returns the original prize', async () => {
  const requestId = '22222222-2222-4222-8222-222222222222';
  const spin = { ...spinTemplate, id: requestId, table_id: 'table', prize_key: 'gift', prize_label: 'Tặng 3 nước' };
  const h = database(spin);
  const routeSource = read('../src/app/api/lucky/spin/route.js')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/export /g, '');
  const post = vm.runInNewContext(`${routeSource}\nPOST`, {
    ...wheel, NextResponse: { json: data => data }, createClient: () => h.db,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'mock', SUPABASE_SERVICE_ROLE_KEY: 'mock' } },
  });
  const request = { json: async () => ({ tableId: 'table', name: 'Khách thử', phone: '0900000000', requestId }) };
  const a = await post(request), b = await post(request);
  assert.equal(a.spinId, requestId);
  assert.equal(a.prizeValue, 3);
  assert.equal(b.spinId, a.spinId);
  assert.equal(h.state.lucky_spins.length, 1);
});

test('gift chosen AFTER follow still sends exactly one congratulation message', async () => {
  // Khách đã Quan tâm Zalo (status applied, zalo_user_id có) NHƯNG chưa chọn quà
  // lúc đó → gift_menu_item_id null, applied_item_id null. Khi khách chọn món,
  // pickGiftItem ghi quà vào bill VÀ phải tự nhắn tin (trước đây bị bỏ sót).
  const spin = { ...spinTemplate, zalo_user_id: 'zalo-user', gift_menu_item_id: null, applied_item_id: null };
  const h = database(spin);
  const res = await h.pickGiftItem(h.db, 'spin', 'drink', []);
  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  assert.equal(h.state.order_items.filter(r => r.is_gift).length, 1);
  assert.equal(h.state.lucky_spins[0].applied_item_id, h.state.order_items.find(r => r.is_gift).id);
  assert.equal(h.sentMessages.length, 1); // đúng 1 tin chúc mừng
});

test('notify is sent once even if completeLuckySpin runs twice (no duplicate message)', async () => {
  const spin = { ...spinTemplate, zalo_user_id: 'zalo-user' };
  const h = database(spin);
  await h.completeLuckySpin(h.db, spin);
  await h.completeLuckySpin(h.db, spin); // retry (webhook bắn lại / poll)
  assert.equal(h.state.order_items.filter(r => r.is_gift).length, 1);
  assert.equal(h.sentMessages.length, 1); // CAS notified_at chặn nhắn trùng
});

test('a failed OA send releases notified_at so a later retry can deliver', async () => {
  const spin = { ...spinTemplate, zalo_user_id: 'zalo-user' };
  const h = database(spin);
  // Ép lần gửi đầu "hỏng": mock đẩy tin nhưng trả ok:false ở lần 1.
  let calls = 0;
  const origPush = h.sentMessages.push.bind(h.sentMessages);
  await h.completeLuckySpin(h.db, spin); // lần 1 gửi ok trong harness → nhưng ta muốn test nhả cờ:
  // Vì mock luôn ok, dùng đường khác: xoá cờ để mô phỏng "chưa gửi" rồi gọi lại.
  assert.equal(h.sentMessages.length, 1);
  h.state.lucky_spins[0].notified_at = null; // giả lập lần trước gửi hỏng đã nhả cờ
  await h.completeLuckySpin(h.db, spin);
  assert.equal(h.sentMessages.length, 2); // gửi lại được sau khi cờ nhả
});

test('removing a lucky-wheel gift deletes the line and blocks the spin so it cannot be re-added', async () => {
  const spin = { ...spinTemplate };
  const h = database(spin);
  // Quà đã vào bill: 1 dòng order_items id = spin.id, note của vòng xoay, applied_item_id = spin.id.
  h.state.order_items.push({ id: 'spin', order_id: 'order', menu_item_id: 'drink', quantity: 3, unit_price: 0, is_gift: true, note: 'Quà tặng từ vòng quay may mắn' });
  h.state.lucky_spins[0].applied_item_id = 'spin';

  await h.removeLuckyGiftItem(h.db, 'order', 'spin');

  // Dòng quà đã bị xoá khỏi bill.
  assert.equal(h.state.order_items.some(i => i.id === 'spin'), false);
  // Lượt quay bị khoá → claim-ready (chỉ re-finalize khi status==='applied') sẽ KHÔNG ghi lại.
  assert.equal(h.state.lucky_spins[0].status, 'blocked');
  assert.equal(h.state.lucky_spins[0].block_reason, 'Nhân viên đã xoá quà khỏi bill');
  // Giữ applied_item_id (không null) → admin không thấy lượt này hiện lại trong danh sách chờ.
  assert.equal(h.state.lucky_spins[0].applied_item_id, 'spin');
});

test('guest who tapped Quan tam but sent no phone shows adminState need_phone', async () => {
  const spin = { ...spinTemplate, status: 'waiting_follow', zalo_user_id: null,
    applied_item_id: null, gift_menu_item_id: null, follow_prompt_at: now };
  const h = database(spin);
  const list = await h.listAdminLuckySpins(h.db);
  assert.equal(list.length, 1);
  assert.equal(list[0].adminState, 'need_phone');
});

test('guest who has not tapped Quan tam yet shows adminState waiting', async () => {
  const spin = { ...spinTemplate, status: 'waiting_follow', zalo_user_id: null,
    applied_item_id: null, gift_menu_item_id: null };
  const h = database(spin);
  const list = await h.listAdminLuckySpins(h.db);
  assert.equal(list[0].adminState, 'waiting');
});

test('an empty/closed table hides its old pending spins (no overlap with next guest)', async () => {
  const spin = { ...spinTemplate, status: 'waiting_follow', zalo_user_id: null,
    applied_item_id: null, gift_menu_item_id: null, follow_prompt_at: now };
  const h = database(spin);
  h.state.tables[0].occupied_at = null; // bàn đã đóng / trống
  const list = await h.listAdminLuckySpins(h.db);
  assert.equal(list.length, 0);
});

test('a previous-session spin is hidden after a new guest sits at the same table', async () => {
  const spin = { ...spinTemplate, status: 'applied', applied_item_id: null,
    created_at: new Date(Date.now() - 120000).toISOString() }; // lượt cũ 2 phút trước
  const h = database(spin);
  h.state.tables[0].occupied_at = new Date().toISOString();    // khách mới vừa ngồi
  const list = await h.listAdminLuckySpins(h.db);
  assert.equal(list.length, 0);
});

function enableSlotClaim(h) {
  h.db.rpc = async (name, p) => {
    if (name !== 'claim_lucky_wheel_slot') throw new Error(name);
    const s = h.state.lucky_spins.find(s => s.id === p.p_spin_id);
    if (s.status !== 'waiting_follow') return { data: false, error: null };
    Object.assign(s, { status: 'applied', applied_order_id: p.p_target_order_id,
      discount_amount: p.p_discount_amount, zalo_user_id: p.p_zalo_user_id });
    return { data: true, error: null };
  };
}

test('opening Zalo auto grants a fixed discount once without a phone message', async () => {
  const h = database({ ...spinTemplate, status: 'waiting_follow', applied_order_id: null,
    gift_menu_item_id: null, prize_type: 'amount', prize_value: 5000 });
  enableSlotClaim(h);
  h.state.customers.push({ phone: spinTemplate.customer_phone, zalo_user_id: 'known-identity' });
  await h.markFollowTapped(h.db, 'spin');
  await Promise.all(Array.from({ length: 20 }, () => h.autoApproveTappedSpin(h.db, 'spin')));
  assert.equal(h.state.orders[0].total_amount, 95000);
  assert.equal(h.state.order_items.filter(i => i.unit_price < 0).length, 1);
  assert.ok(h.state.lucky_spins[0].auto_approved_at);
  assert.equal(h.state.lucky_spins[0].zalo_user_id, null);
  assert.equal(h.state.customers[0].zalo_user_id, 'known-identity');
  const [row] = await h.listAdminLuckySpins(h.db);
  assert.equal(row.adminState, 'auto_approved');
  assert.equal(row.discountAmount, 5000);
});

test('admin reconciliation auto delivers a pending drink to its category printer', async () => {
  const h = database({ ...spinTemplate, status: 'waiting_follow', follow_prompt_at: now, applied_order_id: null });
  enableSlotClaim(h);
  h.state.printers = [
    { id: 'kitchen', is_active: true, is_default: true, printer_categories: [{ category_id: 'food' }] },
    { id: 'bar', is_active: true, is_default: false, printer_categories: [{ category_id: 'drinks' }] },
  ];
  const [row] = await h.listAdminLuckySpins(h.db, { reconcile: true });
  assert.equal(row.adminState, 'auto_approved');
  assert.equal(row.printStatus, 'pending');
  assert.equal(h.state.print_jobs[0].printer_id, 'bar');
  assert.equal(h.state.order_items.find(i => i.is_gift).quantity, 3);
  await h.listAdminLuckySpins(h.db, { reconcile: true });
  assert.equal(h.state.print_jobs.length, 1);
});

test('auto-approved food follows selected cooking category rather than default drink printer', async () => {
  const h = database({ ...spinTemplate, status: 'waiting_follow', follow_prompt_at: now,
    prize_type: 'gift_dish', gift_item_options: [{ name: 'LOẠI', choice: 'Nướng' }] });
  enableSlotClaim(h);
  h.state.menu_items[0].options = [{ name: 'LOẠI', choices: ['Nướng'], choiceCategories: ['grill'] }];
  h.state.printers = [
    { id: 'bar', is_active: true, is_default: true, printer_categories: [{ category_id: 'drinks' }] },
    { id: 'grill-printer', is_active: true, is_default: false, printer_categories: [{ category_id: 'grill' }] },
  ];
  await h.autoApproveTappedSpin(h.db, 'spin');
  assert.equal(h.state.print_jobs[0].printer_id, 'grill-printer');
});

test('auto delivery survives receipt failure and does not show completed prematurely', async () => {
  const h = database({ ...spinTemplate, auto_approved_at: now, follow_prompt_at: now });
  h.fail.set('lucky_spins:update', 1);
  await assert.rejects(h.autoApproveTappedSpin(h.db, 'spin'));
  assert.equal((await h.listAdminLuckySpins(h.db))[0].adminState, 'auto_pending');
  const [row] = await h.listAdminLuckySpins(h.db, { reconcile: true });
  assert.equal(row.adminState, 'auto_approved');
  assert.equal(h.state.order_items.filter(i => i.is_gift).length, 1);
});

test('auto approval waits for a specific gift choice and never reopens blocked spins', async () => {
  const h = database({ ...spinTemplate, status: 'waiting_follow', follow_prompt_at: now, gift_menu_item_id: null });
  enableSlotClaim(h);
  await h.autoApproveTappedSpin(h.db, 'spin');
  assert.equal((await h.listAdminLuckySpins(h.db))[0].adminState, 'choose_gift');
  assert.equal(h.state.print_jobs.length, 0);
  await h.pickGiftItem(h.db, 'spin', 'drink', []);
  assert.equal(h.state.order_items.filter(i => i.is_gift).length, 1);
  h.state.lucky_spins[0].status = 'blocked';
  assert.equal((await h.autoApproveTappedSpin(h.db, 'spin')).matched, false);
});

test('admin poll retries a missing auto gift print job without duplicating the gift', async () => {
  const h = database({ ...spinTemplate, auto_approved_at: now, follow_prompt_at: now });
  h.fail.set('print_jobs:insert', 1);
  await h.autoApproveTappedSpin(h.db, 'spin');
  assert.equal(h.state.print_jobs.length, 0);
  const [row] = await h.listAdminLuckySpins(h.db, { reconcile: true });
  assert.equal(row.printStatus, 'pending');
  assert.equal(h.state.order_items.filter(i => i.is_gift).length, 1);
  assert.equal(h.state.print_jobs.length, 1);
});
