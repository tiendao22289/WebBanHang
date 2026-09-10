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
      gte(k, v) { conditions.push(r => r[k] >= v); return q; },
      or() { return q; }, order() { return q; },
      limit(n) { max = n; return q; },
      update(v) { op = 'update'; values = v; return q; },
      insert(v) { op = 'insert'; values = v; return q; },
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
            if (state[table].some(r => r.id === values.id)) return resolve({ data: null, error: { code: '23505' } });
            rows = [structuredClone(values)]; state[table].push(rows[0]);
          } else if (op === 'update') rows.forEach(r => Object.assign(r, structuredClone(values)));
          const result = structuredClone(rows);
          if (table === 'order_items') result.forEach(r => { r.menu_item = state.menu_items.find(m => m.id === r.menu_item_id); });
          resolve({ data: single ? result[0] ?? null : result, error: null });
        } catch (error) { reject(error); }
      },
    };
    return q;
  }, rpc: async () => ({ data: null, error: { code: 'NETWORK_TEST', message: 'rpc offline' } }) };
  const print = vm.runInNewContext(`(${printerFn})`, { console: { log() {}, error() {} } });
  const funcs = vm.runInNewContext(`${source}\n({ finalizeGiftItem, completeLuckySpin, applyLuckySpin, pickGiftItem, tryApplyLuckyByTiming, tryApplyLuckyForSpin, grantLuckySpinManually })`, {
    ...wheel, sendGiftItemPrintJob: print, console: { log() {}, error() {} }, Date, Set,
  });
  return { state, fail, db, ...funcs };
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

test('printer outage does not acknowledge success; retry queues the original gift', async () => {
  const h = database();
  h.fail.set('print_jobs:insert', 1);
  await assert.rejects(h.completeLuckySpin(h.db, spinTemplate));
  assert.equal(h.state.lucky_spins[0].applied_item_id, null);
  await h.completeLuckySpin(h.db, spinTemplate);
  assert.equal(h.state.order_items.filter(r => r.is_gift).length, 1);
  assert.equal(h.state.print_jobs.length, 1);
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
