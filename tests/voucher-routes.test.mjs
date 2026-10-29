import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as voucher from '../src/lib/voucher.mjs';
import * as voucherServer from '../src/lib/voucherServer.mjs';

// Quyền của /api/admin/vouchers (nhân viên dùng mã; chỉ chủ quán tạo / gửi / huỷ / cài đặt)
// và /api/voucher/mine (khách chỉ thấy mã của chính bill / lượt quay của mình).
const strip = file => readFileSync(new URL(file, import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const adminSource = strip('../src/app/api/admin/vouchers/route.js');
const mineSource = strip('../src/app/api/voucher/mine/route.js');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakeDb(state) {
  let seq = 0;
  return {
    async rpc(name, args) { (state.rpc ||= []).push([name, args]); return { data: { ok: true, discount: 30000, order_id: args.p_order_ids[0] }, error: null }; },
    from(table) {
      let op = 'read', values, maybe = false, max = Infinity;
      const conds = [];
      const q = {
        select() { return q; },
        eq(k, v) { conds.push(r => r[k] === v); return q; },
        in(k, vs) { conds.push(r => vs.includes(r[k])); return q; },
        is(k, v) { conds.push(r => (r[k] ?? null) === v); return q; },
        not(k, _op, v) { conds.push(r => (r[k] ?? null) !== v); return q; },
        gt(k, v) { conds.push(r => r[k] > v); return q; },
        gte(k, v) { conds.push(r => r[k] >= v); return q; },
        lte(k, v) { conds.push(r => r[k] <= v); return q; },
        contains(k, vs) { conds.push(r => vs.every(v => (r[k] || []).includes(v))); return q; },
        order() { return q; },
        limit(n) { max = n; return q; },
        maybeSingle() { maybe = true; return q; },
        insert(v) { op = 'insert'; values = v; return q; },
        update(v) { op = 'update'; values = v; return q; },
        upsert(v) { op = 'upsert'; values = v; return q; },
        then(ok, ko) { return Promise.resolve().then(run).then(ok, ko); },
      };
      function run() {
        state[table] ||= [];
        if (op === 'insert') {
          if (state[table].some(r => r.code === values.code)) return { data: null, error: { code: '23505' } };
          const row = { id: id(++seq + 100), status: 'active', sent_at: null, created_at: new Date().toISOString(), ...values };
          state[table].push(row);
          return { data: structuredClone(row), error: null };
        }
        if (op === 'upsert') {
          for (const v of values) {
            const r = state[table].find(x => x.key === v.key);
            if (r) r.value = v.value; else state[table].push({ ...v });
          }
          return { data: null, error: null };
        }
        const rows = state[table].filter(r => conds.every(c => c(r)));
        if (op === 'update') { rows.forEach(r => Object.assign(r, values)); return { data: structuredClone(maybe ? rows[0] ?? null : rows), error: null }; }
        const out = rows.slice(0, max);
        return { data: structuredClone(maybe ? out[0] ?? null : out), error: null };
      }
      return q;
    },
  };
}

const STAFF = { id: id(1), full_name: 'Thu ngân', role: 'staff' };
const ADMIN = { id: id(2), full_name: 'Chủ quán', role: 'admin' };
function loadAdmin(state, user) {
  const sent = [];
  const ctx = {
    NextResponse: { json: (body, init = {}) => ({ status: init.status || 200, body }) },
    getStaffSession: async () => (user ? { code: 200, user } : { code: 401 }),
    statusDatabase: () => fakeDb(state),
    sendOaText: async (_db, uid, text) => { sent.push({ uid, text }); return { ok: true }; },
    ...voucher, ...voucherServer, URL, console: { log() {}, error() {} },
  };
  return { sent, ...vm.runInNewContext(`${adminSource}\n({ GET, POST })`, ctx) };
}
const post = body => ({ json: async () => body, url: 'http://x/api/admin/vouchers' });
const get = view => ({ url: `http://x/api/admin/vouchers?view=${view}` });
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const plusDays = n => new Date(Date.now() + 7 * 3600000 + n * 86400000).toISOString().slice(0, 10);

test('chưa đăng nhập: mọi thao tác bị chặn', async () => {
  const api = loadAdmin({}, null);
  assert.equal((await api.GET(get('list'))).status, 401);
  for (const action of ['lookup', 'redeem', 'create', 'send', 'cancel', 'config']) {
    assert.equal((await api.POST(post({ action }))).status, 401, action);
  }
});

test('nhân viên dùng được mã (ghi tên người bấm), không tạo / gửi / huỷ / cài đặt / xem danh sách được', async () => {
  const state = { vouchers: [], settings: [] };
  const api = loadAdmin(state, STAFF);
  const r = await api.POST(post({ action: 'redeem', code: 'bk 7k3p9x', orderIds: [id(10), 'không-phải-id', id(11)] }));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(state.rpc[0])), ['redeem_voucher', { p_code: 'BK-7K3P9X', p_order_ids: [id(10), id(11)], p_staff_id: STAFF.id, p_staff_name: 'Thu ngân' }]);
  assert.equal((await api.POST(post({ action: 'redeem', code: 'BK-12', orderIds: [id(10)] }))).status, 400);
  assert.equal((await api.POST(post({ action: 'redeem', code: 'BK-7K3P9X', orderIds: [] }))).status, 400);
  assert.equal(state.rpc.length, 1, 'mã / bill sai thì không gọi DB');
  for (const action of ['create', 'send', 'cancel', 'config']) {
    assert.equal((await api.POST(post({ action }))).status, 403, action);
  }
  assert.equal((await api.GET(get('list'))).status, 403);
  assert.equal((await api.GET(get('customers'))).status, 403);
  assert.equal(state.vouchers.length, 0);
});

test('chủ quán tạo mã cho từng khách: SĐT chuẩn hoá, bỏ trùng, lời nhắn điền sẵn mã', async () => {
  const state = { vouchers: [], settings: [] };
  const api = loadAdmin(state, ADMIN);
  const r = await api.POST(post({ action: 'create', batchName: 'Tháng 11', type: 'amount', value: 30000, minBill: 200000,
    fromDay: today(), toDay: plusDays(14), recipients: [{ phone: '+84 901 111 111', name: 'An' }, { phone: '0901111111', name: 'An' }, { phone: 'abc' }, { phone: '0902222222', name: '' }] }));
  assert.equal(r.status, 200);
  assert.equal(r.body.vouchers.length, 2);
  assert.deepEqual(state.vouchers.map(v => [v.customer_phone, v.customer_name, v.source, v.batch_name, v.created_by_name]),
    [['0901111111', 'An', 'gift', 'Tháng 11', 'Chủ quán'], ['0902222222', null, 'gift', 'Tháng 11', 'Chủ quán']]);
  assert.match(state.vouchers[0].message, new RegExp(`tặng An voucher giảm 30\\.000đ[\\s\\S]*Mã: ${state.vouchers[0].code}`));
  assert.match(state.vouchers[1].message, /tặng bạn voucher/);
  assert.notEqual(state.vouchers[0].code, state.vouchers[1].code);

  const blank = await api.POST(post({ action: 'create', type: 'percent', value: 10, max: 50000, fromDay: today(), toDay: plusDays(3), count: 3 }));
  assert.equal(blank.body.vouchers.length, 3);
  assert.ok(blank.body.vouchers.every(v => v.customer_phone === null && v.max_discount === 50000));
});

test('chủ quán tạo mã sai thông tin thì báo lỗi, không tạo gì', async () => {
  const state = { vouchers: [] };
  const api = loadAdmin(state, ADMIN);
  const base = { action: 'create', type: 'amount', value: 30000, fromDay: today(), toDay: plusDays(7), count: 1 };
  for (const bad of [{ value: 500 }, { type: 'percent', value: 120 }, { toDay: '2026-01-01' }, { fromDay: 'x' }, { count: 0 }]) {
    assert.equal((await api.POST(post({ ...base, ...bad }))).status, 400, JSON.stringify(bad));
  }
  assert.equal(state.vouchers.length, 0);
});

test('huỷ mã chỉ khi chưa dùng; gửi Zalo bỏ qua mã không tên / đã dùng', async () => {
  const state = { vouchers: [
    { id: id(50), code: 'BK-AAAAAA', status: 'active', customer_phone: '0903333333', source: 'gift', discount_type: 'amount', discount_value: 1000, valid_from: '2026-10-29T00:00:00Z', valid_until: '2099-01-01T00:00:00Z' },
    { id: id(51), code: 'BK-BBBBBB', status: 'used', customer_phone: '0903333333' },
    { id: id(52), code: 'BK-CCCCCC', status: 'active', customer_phone: null },
  ], customers: [{ phone: '0903333333', zalo_user_id: 'uid-3' }], zalo_followers: [] };
  const api = loadAdmin(state, ADMIN);
  const r = await api.POST(post({ action: 'send', ids: [id(50), id(51), id(52)] }));
  const byId = Object.fromEntries(r.body.results.map(x => [x.id, x.ok]));
  assert.deepEqual(byId, { [id(50)]: true, [id(51)]: false, [id(52)]: false });
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].uid, 'uid-3');
  assert.equal((await api.POST(post({ action: 'cancel', id: id(51) }))).status, 400, 'mã đã dùng không huỷ được');
  assert.equal((await api.POST(post({ action: 'cancel', id: id(50) }))).status, 200);
  assert.equal(state.vouchers[0].status, 'cancelled');
});

test('lưu cài đặt "Hẹn lần sau": kiểm số trước khi lưu', async () => {
  const state = { settings: [] };
  const api = loadAdmin(state, ADMIN);
  assert.equal((await api.POST(post({ action: 'config', config: { enabled: true, type: 'percent', value: 300, days: 14 } }))).status, 400);
  assert.equal(state.settings.length, 0);
  const ok = await api.POST(post({ action: 'config', config: { enabled: true, minBill: 250000, type: 'amount', value: 20000, useMinBill: 150000, days: 10, repeat: false } }));
  assert.equal(ok.status, 200);
  const map = Object.fromEntries(state.settings.map(s => [s.key, s.value]));
  assert.deepEqual(map, { voucher_next_enabled: 'true', voucher_next_min_bill: '250000', voucher_next_type: 'amount', voucher_next_value: '20000',
    voucher_next_max: '0', voucher_next_use_min_bill: '150000', voucher_next_days: '10', voucher_next_repeat: 'false' });
});

test('trang khách chỉ thấy mã của chính mình, không lộ SĐT', async () => {
  const state = {
    orders: [{ id: id(10), customer_phone: '+84 904 444 444' }, { id: id(11), customer_phone: '0905555555' }],
    vouchers: [
      { code: 'BK-NEXTAA', source: 'next_visit', customer_phone: '0904444444', issued_order_ids: [id(10), id(11)], discount_type: 'amount', discount_value: 30000 },
      { code: 'BK-WHEELA', source: 'wheel', customer_phone: '0906666666', issued_spin_id: id(70), discount_type: 'amount', discount_value: 50000 },
    ],
  };
  const { GET } = vm.runInNewContext(`${mineSource}\n({ GET })`, {
    NextResponse: { json: (body, init = {}) => ({ status: init.status || 200, body }) },
    statusDatabase: () => fakeDb(state), normalizePhone: voucher.normalizePhone, URL, Promise,
  });
  const ask = q => GET({ url: `http://x/api/voucher/mine?${q}` });
  const mine = await ask(`orderId=${id(10)}`);
  assert.equal(mine.body.voucher.code, 'BK-NEXTAA');
  assert.equal('customer_phone' in mine.body.voucher, false);
  assert.equal((await ask(`orderId=${id(11)}`)).body.voucher, null, 'người khác cùng bàn gộp không thấy mã');
  assert.equal((await ask(`spinId=${id(70)}`)).body.voucher.code, 'BK-WHEELA');
  assert.equal((await ask(`orderId=${id(99)}`)).body.voucher, null);
  assert.equal((await ask('orderId=0904444444')).status, 400, 'không tra theo SĐT');
});
