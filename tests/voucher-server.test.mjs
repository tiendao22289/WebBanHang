import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueNextVisitVoucher, issueWheelVoucher, sendVoucherZalo, sendPendingVouchers, activeVouchersForPhones,
  voucherMessage, zaloSendErrorText,
} from '../src/lib/voucherServer.mjs';

// DB giả kiểu supabase-js, đủ cho src/lib/voucherServer.mjs. Ràng buộc UNIQUE như vouchers.sql.
const UNIQUE = { vouchers: ['code', 'issue_key'] };
function fakeDb(state) {
  let seq = 0;
  return { from(table) {
    let op = 'read', values, maybe = false, max = Infinity;
    const conds = [];
    const q = {
      select() { return q; },
      eq(k, v) { conds.push(r => r[k] === v); return q; },
      in(k, vs) { conds.push(r => vs.includes(r[k])); return q; },
      is(k, v) { conds.push(r => (r[k] ?? null) === v); return q; },
      gt(k, v) { conds.push(r => r[k] > v); return q; },
      lte(k, v) { conds.push(r => r[k] <= v); return q; },
      contains(k, vs) { conds.push(r => vs.every(v => (r[k] || []).includes(v))); return q; },
      order() { return q; },
      limit(n) { max = n; return q; },
      maybeSingle() { maybe = true; return q; },
      insert(v) { op = 'insert'; values = v; return q; },
      update(v) { op = 'update'; values = v; return q; },
      then(ok, ko) { return Promise.resolve().then(run).then(ok, ko); },
    };
    function run() {
      state[table] ||= [];
      if (op === 'insert') {
        if ((UNIQUE[table] || []).some(k => values[k] != null && state[table].some(r => r[k] === values[k]))) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { id: `v-${++seq}`, status: 'active', sent_at: null, send_error: null, message: null, ...values };
        state[table].push(row);
        return { data: structuredClone(row), error: null };
      }
      const rows = state[table].filter(r => conds.every(c => c(r)));
      if (op === 'update') {
        rows.forEach(r => Object.assign(r, values));
        return { data: structuredClone(maybe ? rows[0] ?? null : rows), error: null };
      }
      const out = rows.slice(0, max);
      return { data: structuredClone(maybe ? out[0] ?? null : out), error: null };
    }
    return q;
  } };
}

const NOW = Date.parse('2026-10-29T22:00:00+07:00');
const settings = (extra = {}) => Object.entries({ voucher_next_enabled: 'true', voucher_next_min_bill: '300000',
  voucher_next_value: '30000', voucher_next_use_min_bill: '200000', voucher_next_days: '14', ...extra }).map(([key, value]) => ({ key, value }));
const paidBills = () => [
  { id: 'o2', customer_phone: '0901111111', customer_name: 'An', total_amount: 150000, status: 'paid', created_at: '2026-10-29T13:00:00Z' },
  { id: 'o1', customer_phone: '+84 902 222 222', customer_name: 'Bình', total_amount: 250000, status: 'paid', created_at: '2026-10-29T12:00:00Z' },
];
const seqRandom = () => { let i = 0; return () => ((i++ * 7) % 31) / 31; };

test('thanh toán xong: tặng 1 mã lần sau cho SĐT gọi nhiều nhất, dùng từ 5h sáng mai', async () => {
  const state = { settings: settings(), orders: paidBills(), vouchers: [] };
  const db = fakeDb(state);
  const r = await issueNextVisitVoucher(db, { orderIds: ['o2', 'o1'], nowMs: NOW });
  assert.equal(r.created, true);
  const v = r.voucher;
  assert.match(v.code, /^BK-[A-Z2-9]{6}$/);
  assert.deepEqual([v.source, v.customer_phone, v.customer_name, v.discount_value, v.min_bill, v.issue_key],
    ['next_visit', '0902222222', 'Bình', 30000, 200000, 'pay:o1']);
  assert.equal(v.valid_from, new Date(Date.parse('2026-10-30T05:00:00+07:00')).toISOString());
  assert.equal(v.valid_until, new Date(Date.parse('2026-11-13T05:00:00+07:00')).toISOString());
  assert.deepEqual(v.issued_order_ids, ['o1', 'o2']);

  // Trang Bàn gửi lại (mạng chập chờn) → đúng mã cũ, không tặng thêm.
  const again = await issueNextVisitVoucher(db, { orderIds: ['o1', 'o2'], nowMs: NOW });
  assert.deepEqual([again.created, again.voucher.code], [false, v.code]);
  assert.equal(state.vouchers.length, 1);
});

test('không tặng khi: tắt, bill nhỏ, chưa thanh toán, không có SĐT, đang giữ mã lần sau còn hạn', async () => {
  const run = async (state, ids = ['o1', 'o2']) => (await issueNextVisitVoucher(fakeDb(state), { orderIds: ids, nowMs: NOW })).skipped;
  assert.equal(await run({ settings: settings({ voucher_next_enabled: 'false' }), orders: paidBills() }), 'off');
  assert.equal(await run({ settings: settings({ voucher_next_min_bill: '500000' }), orders: paidBills() }), 'small_bill');
  assert.equal(await run({ settings: settings(), orders: paidBills().map(o => ({ ...o, status: 'pending' })) }), 'not_paid');
  assert.equal(await run({ settings: settings(), orders: paidBills().map(o => ({ ...o, customer_phone: 'BAO_BEP' })) }), 'no_phone');
  assert.equal(await run({ settings: settings(), orders: paidBills() }, []), 'no_bill');
  const holding = { settings: settings(), orders: paidBills(), vouchers: [{ id: 'old', code: 'BK-OLDOLD', source: 'next_visit',
    status: 'active', customer_phone: '0902222222', valid_until: new Date(NOW + 86400000).toISOString() }] };
  assert.equal(await run(holding), 'has_active');
  assert.equal(holding.vouchers.length, 1, 'không cộng dồn nhiều mã lần sau');
});

test('mã lần sau cũ đã hết hạn / đã dùng thì vẫn tặng mã mới; tắt "tặng tiếp" thì bill dùng voucher không được tặng', async () => {
  const old = [
    { id: 'exp', code: 'BK-EXPEXP', source: 'next_visit', status: 'active', customer_phone: '0902222222', valid_until: new Date(NOW - 1000).toISOString() },
    { id: 'used', code: 'BK-USEDUS', source: 'next_visit', status: 'used', customer_phone: '0902222222', used_order_id: 'o1', valid_until: new Date(NOW + 86400000).toISOString() },
  ];
  const state = { settings: settings(), orders: paidBills(), vouchers: structuredClone(old) };
  assert.equal((await issueNextVisitVoucher(fakeDb(state), { orderIds: ['o1', 'o2'], nowMs: NOW })).created, true);
  const noRepeat = { settings: settings({ voucher_next_repeat: 'false' }), orders: paidBills(), vouchers: structuredClone(old) };
  assert.equal((await issueNextVisitVoucher(fakeDb(noRepeat), { orderIds: ['o1', 'o2'], nowMs: NOW })).skipped, 'used_voucher');
});

test('mã trùng (hiếm) thì tự đổi mã khác', async () => {
  const state = { settings: settings({ voucher_next_min_bill: '0' }), orders: paidBills(), vouchers: [{ id: 'x', code: 'BK-222222', source: 'gift', status: 'used' }] };
  const r = await issueNextVisitVoucher(fakeDb(state), { orderIds: ['o1'], nowMs: NOW, random: () => 0 })
    .catch(e => e);
  assert.ok(r instanceof Error, 'random luôn ra cùng mã → báo lỗi sau vài lần, không ghi đè mã cũ');
  const ok = await issueNextVisitVoucher(fakeDb(state), { orderIds: ['o1'], nowMs: NOW, random: seqRandom() });
  assert.notEqual(ok.voucher.code, 'BK-222222');
});

test('trúng vòng xoay: 1 lượt quay = 1 mã, gọi lại trả đúng mã', async () => {
  const state = { settings: settings({ voucher_next_days: '7' }), vouchers: [] };
  const spin = { id: 'spin-1', prize_value: 50000, customer_phone: '0903333333', customer_name: 'Chi', applied_order_id: 'o9' };
  const a = await issueWheelVoucher(fakeDb(state), spin, { nowMs: NOW });
  const b = await issueWheelVoucher(fakeDb(state), spin, { nowMs: NOW });
  assert.equal(a.code, b.code);
  assert.equal(state.vouchers.length, 1);
  assert.deepEqual([a.source, a.discount_value, a.min_bill, a.issued_spin_id], ['wheel', 50000, 200000, 'spin-1']);
  assert.match(voucherMessage(a), /trúng voucher giảm 50\.000đ cho lần ghé tới[\s\S]*Mã: BK-/);
  await assert.rejects(issueWheelVoucher(fakeDb(state), { ...spin, id: 'spin-2', prize_value: 0 }));
});

test('nhắn Zalo đúng 1 lần; Zalo từ chối thì nhả cờ, ghi lý do dễ hiểu', async () => {
  const v = { id: 'v1', code: 'BK-AAAAAA', source: 'gift', customer_phone: '0904444444', customer_name: 'Dũng', discount_type: 'amount',
    discount_value: 30000, min_bill: 0, valid_from: '2026-10-29T08:00:00Z', valid_until: '2026-11-12T22:00:00Z', status: 'active', sent_at: null };
  const sent = [];
  const okSend = async (_db, uid, text) => { sent.push([uid, text]); return { ok: true }; };

  const none = { vouchers: [structuredClone(v)], customers: [], zalo_followers: [] };
  assert.equal((await sendVoucherZalo(fakeDb(none), v, { send: okSend })).reason, 'no_zalo');

  const state = { vouchers: [structuredClone(v)], customers: [{ phone: '0904444444', zalo_user_id: 'uid-d' }], zalo_followers: [] };
  assert.deepEqual(await sendVoucherZalo(fakeDb(state), v, { send: okSend }), { ok: true });
  assert.ok(state.vouchers[0].sent_at);
  assert.deepEqual(await sendVoucherZalo(fakeDb(state), v, { send: okSend }), { ok: true, already: true });
  assert.equal(sent.length, 1, 'không nhắn trùng');
  assert.equal(sent[0][0], 'uid-d');
  assert.match(sent[0][1], /BK-AAAAAA/);
  await sendVoucherZalo(fakeDb(state), v, { send: okSend, force: true });
  assert.equal(sent.length, 2, 'chủ quán bấm "Gửi lại" thì gửi lại');

  const fail = { vouchers: [structuredClone(v)], customers: [], zalo_followers: [{ zalo_user_id: 'uid-old', phone: '0904444444', unfollowed_at: '2026-01-01' }, { zalo_user_id: 'uid-f', phone: '0904444444' }] };
  const r = await sendVoucherZalo(fakeDb(fail), v, { send: async () => ({ ok: false, detail: { error: -230, message: 'User has not interacted with the OA in the last 7 days' } }) });
  assert.equal(r.ok, false);
  assert.equal(fail.vouchers[0].sent_at, null, 'lần sau còn thử lại được');
  assert.match(fail.vouchers[0].send_error, /lâu rồi chưa nhắn/);
  const thrown = await sendVoucherZalo(fakeDb(fail), v, { send: async () => { throw new Error('network down'); } });
  assert.equal(thrown.ok, false);
  assert.equal(fail.vouchers[0].sent_at, null);
  assert.match(zaloSendErrorText({ message: 'User has not followed OA' }), /chưa quan tâm/);
});

test('khách nhắn SĐT cho OA → gửi mã chưa nhắn được; người lạ nhắn SĐT của khách khác thì không gửi', async () => {
  const base = { source: 'next_visit', status: 'active', sent_at: null, customer_phone: '0905555555', discount_type: 'amount', discount_value: 30000,
    valid_from: '2026-10-30T22:00:00Z', valid_until: new Date(NOW + 5 * 86400000).toISOString() };
  const vouchers = () => [
    { ...base, id: 'a', code: 'BK-AAAAAA' },
    { ...base, id: 'b', code: 'BK-BBBBBB', source: 'gift' },
    { ...base, id: 'c', code: 'BK-CCCCCC', source: 'wheel' },                       // có tin chúc mừng riêng
    { ...base, id: 'd', code: 'BK-DDDDDD', status: 'used' },
    { ...base, id: 'e', code: 'BK-EEEEEE', valid_until: new Date(NOW - 1000).toISOString() },
    { ...base, id: 'f', code: 'BK-FFFFFF', sent_at: '2026-10-29T15:00:00Z' },
  ];
  const sent = [];
  const send = async (_db, uid, text) => { sent.push([uid, text.match(/BK-\w+/)[0]]); return { ok: true }; };

  const owner = { vouchers: vouchers(), customers: [{ phone: '0905555555', zalo_user_id: 'uid-e' }], zalo_followers: [] };
  assert.equal(await sendPendingVouchers(fakeDb(owner), '0905555555', 'uid-e', { send, nowMs: NOW }), 2);
  assert.deepEqual(sent.map(s => s[1]).sort(), ['BK-AAAAAA', 'BK-BBBBBB']);

  sent.length = 0;
  const stranger = { vouchers: vouchers(), customers: [{ phone: '0905555555', zalo_user_id: 'uid-e' }], zalo_followers: [] };
  assert.equal(await sendPendingVouchers(fakeDb(stranger), '0905555555', 'uid-stranger', { send, nowMs: NOW }), 0);
  assert.equal(sent.length, 0);

  const firstLink = { vouchers: vouchers(), customers: [], zalo_followers: [] };
  assert.equal(await sendPendingVouchers(fakeDb(firstLink), '0905555555', 'uid-new', { send, nowMs: NOW }), 2, 'SĐT chưa nối Zalo nào → nối lần đầu');
  assert.equal(await sendPendingVouchers(fakeDb(firstLink), null, 'uid-new', { send, nowMs: NOW }), 0);
});

test('trang Bàn: chỉ hiện mã đang dùng được của SĐT trên bill, kèm thông tin khách để đối chiếu', async () => {
  const at = ms => new Date(NOW + ms).toISOString();
  const state = {
    vouchers: [
      { id: '1', code: 'BK-OKOKOK', status: 'active', customer_phone: '0906666666', valid_from: at(-3600000), valid_until: at(86400000) },
      { id: '2', code: 'BK-TMRWAA', status: 'active', customer_phone: '0906666666', valid_from: at(3600000), valid_until: at(86400000) },
      { id: '3', code: 'BK-EXPAAA', status: 'active', customer_phone: '0906666666', valid_from: at(-9e8), valid_until: at(-1000) },
      { id: '4', code: 'BK-USEDAA', status: 'used', customer_phone: '0906666666', valid_from: at(-3600000), valid_until: at(86400000) },
      { id: '5', code: 'BK-OTHERA', status: 'active', customer_phone: '0907777777', valid_from: at(-3600000), valid_until: at(86400000) },
    ],
    customers: [{ phone: '0906666666', name: 'Giang', visit_count: 4, last_visit_at: '2026-10-12T12:00:00Z' }],
  };
  const list = await activeVouchersForPhones(fakeDb(state), ['+84906666666', 'BAO_BEP', null], NOW);
  assert.deepEqual(list.map(v => v.code), ['BK-OKOKOK']);
  assert.equal(list[0].customer.name, 'Giang');
  assert.deepEqual(await activeVouchersForPhones(fakeDb(state), [], NOW), []);
});
