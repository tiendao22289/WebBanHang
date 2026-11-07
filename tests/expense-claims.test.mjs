// Khoản chi hộ quán: nhân viên / quản lý tự bỏ tiền chi cho quán, ghi ở trang Lương rồi gửi chủ duyệt; tự chọn nhận lại bằng tiền
// mặt hay cộng vào lương. Duyệt → vào Sổ thu chi (Chi trong ngày, đúng ngày chi); cộng lương thì vào lương tháng duyệt (và lần trả
// theo kỳ kế tiếp), lấy tiền mặt thì không đụng tới lương.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as pin from '../src/lib/staffPin.mjs';
import * as token from '../src/lib/checkinToken.mjs';
import * as rules from '../src/lib/attendanceRules.mjs';
import * as payroll from '../src/lib/payroll.mjs';
import * as payrollMonth from '../src/lib/payrollMonth.mjs';
import * as clockApply from '../src/lib/clockApply.mjs';
import * as faceCheck from '../src/lib/faceCheck.mjs';
import * as departure from '../src/lib/staffDeparture.mjs';
import * as roles from '../src/lib/staffRoles.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const { computeSalary, cycleDue, cycleDueTo, payoutDetail, payoutPartOfMonth, salaryClaims } = payroll;

test('an approved claim paid with salary adds to that month only; cash, pending and other months do not', () => {
  const claims = [
    { id: 'a', status: 'approved', payout: 'salary', year: 2026, month: 11, amount: 50000 },
    { id: 'b', status: 'approved', payout: 'cash', year: 2026, month: 11, amount: 30000 },
    { id: 'c', status: 'pending', payout: 'salary', year: null, month: null, amount: 70000 },
    { id: 'd', status: 'approved', payout: 'salary', year: 2026, month: 10, amount: 90000 },
  ];
  assert.deepEqual(salaryClaims(claims, 2026, 11).map(c => c.id), ['a']);
  const base = { year: 2026, month: 11, staffId: 's', config: { base_salary: 6000000, overtime_rate: 0 } };
  const without = computeSalary(base), withClaims = computeSalary({ ...base, claims });
  assert.equal(withClaims.claimAmt, 50000);
  assert.equal(withClaims.net - without.net, 50000);
  assert.equal(without.claimAmt, 0);
});

test('people paid every few days get the claim with the next payout, exactly once', () => {
  const cycle = { every_days: 7, start_day: '2026-11-01' };
  const months = [{ key: '2026-11', byDay: { '2026-11-02': 300000 }, advances: [], fines: [], bonus: 0, claims: [{ id: 'x', amount: 50000 }] }];
  const due = cycleDue({ cycle, payouts: [], months, to: '2026-11-07', periodStart: '2026-11-01' });
  assert.deepEqual(due.claims, [{ id: 'x', key: '2026-11', amount: 50000 }]);
  assert.equal(due.amount, 350000);
  assert.equal(cycleDueTo(due, '2026-11-07', '2026-11-01').amount, 350000);
  const paid = { from_day: '2026-11-01', to_day: '2026-11-07', amount: 350000, detail: payoutDetail(due) };
  assert.deepEqual(paid.detail.claims, [{ id: 'x', key: '2026-11', amount: 50000 }]);
  assert.equal(payoutPartOfMonth([paid], '2026-11'), 350000, 'the month table counts the claim as already paid');
  const after = cycleDue({ cycle, payouts: [paid], months, to: '2026-11-08', periodStart: '2026-11-08' });
  assert.deepEqual([after.claims, after.amount], [[], 0], 'not paid twice');
  // Chủ xoá khoản đã trả theo kỳ: lần trả sau trừ lại.
  const removed = cycleDue({ cycle, payouts: [paid], months: [{ ...months[0], claims: [] }], to: '2026-11-08', periodStart: '2026-11-08' });
  assert.equal(removed.amount, -50000);
});

const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin', created_at: '2026-10-01T00:00:00Z' };
const AN = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'An', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const BINH = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Bình', role: 'manager', created_at: '2026-10-01T00:00:00Z' };
const env = { now: 0, user: null };
function api(state) {
  class FixedDate extends Date { constructor(...a) { super(...(a.length ? a : [env.now])); } static now() { return env.now; } }
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, ...roles, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
    Date: FixedDate, nowMs: () => env.now, refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true }),
    closeForgottenSessions: async () => {}, console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) } },
    getStaffSession: async () => (env.user ? { code: 200, user: env.user } : { code: 401 }), staffDatabase: () => fakeDb(state),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));

test('staff log what they paid for the shop, pick cash or salary, and the owner approves it into the book and the pay', async () => {
  const state = {
    staff: [OWNER, AN, BINH], payroll_config: [{ staff_id: AN.id, base_salary: 6000000, overtime_rate: 30000 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_requests: [], payroll_violations: [], attendance_sessions: [], finance_entries: [], payroll_expense_claims: [], payroll_closes: [],
  };
  const wf = api(state);
  let at = Date.UTC(2026, 10, 8, 5, 0); // 12:00 ngày 08/11 giờ VN
  const post = async (user, body) => { env.user = user; env.now = at; return plain(await wf.POST({ json: async () => body, headers: new Map() })); };
  const get = async (user, q) => { env.user = user; env.now = at; return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };

  const before = (await get(AN, 'me=1')).body;
  assert.deepEqual([before.claims.ready, before.claims.list.length, before.salary.claimAmt], [true, 0, 0]);

  // Phải chọn cách nhận lại tiền; số tiền từ 1.000đ; ngày chi không sau hôm nay, không quá 31 ngày.
  const gas = { action: 'claim_expense', item: 'Xăng đi chợ', amount: '50.000', spent_on: '2026-11-07', note: 'đổ xăng xe máy', payout: 'salary' };
  assert.equal((await post(AN, { ...gas, payout: '' })).status, 400);
  assert.equal((await post(AN, { ...gas, amount: 500 })).status, 400);
  assert.equal((await post(AN, { ...gas, spent_on: '2026-11-09' })).status, 400);
  assert.equal((await post(AN, { ...gas, spent_on: '2026-09-30' })).status, 400);
  assert.equal((await post(AN, { ...gas, item: '  ' })).status, 400);
  const g = await post(AN, gas);
  assert.equal(g.status, 200);
  assert.equal((await post(AN, gas)).body.duplicate, true, 'a double tap does not log it twice');
  const ice = await post(BINH, { action: 'claim_expense', item: 'Đá', amount: 30000, payout: 'cash' });
  assert.equal(ice.status, 200, 'managers log their own too');
  const wrong = await post(AN, { action: 'claim_expense', item: 'Gas', amount: 400000, payout: 'salary' });
  assert.deepEqual(plain(state.payroll_expense_claims.map(c => [c.staff_id, c.item, c.amount, c.spent_on, c.payout, c.status, c.created_by_name])), [
    [AN.id, 'Xăng đi chợ', 50000, '2026-11-07', 'salary', 'pending', 'An'],
    [BINH.id, 'Đá', 30000, '2026-11-08', 'cash', 'pending', 'Bình'],
    [AN.id, 'Gas', 400000, '2026-11-08', 'salary', 'pending', 'An'],
  ]);

  // Chỉ người ghi huỷ được khoản còn chờ duyệt; nhân viên không tự duyệt.
  assert.equal((await post(BINH, { action: 'cancel_request', kind: 'claim', id: wrong.body.id })).status, 404);
  assert.equal((await post(AN, { action: 'decide_claim', id: g.body.id, status: 'approved' })).status, 403);
  assert.equal((await post(AN, { action: 'cancel_request', kind: 'claim', id: wrong.body.id })).status, 200);
  assert.equal(state.payroll_expense_claims.length, 2);

  const pending = (await get(OWNER, 'claims=1')).body;
  assert.deepEqual(pending.claims.map(c => [c.item, c.status]).sort(), [['Xăng đi chợ', 'pending'], ['Đá', 'pending']]);
  assert.equal((await get(AN, 'claims=1')).status, 403);

  // Duyệt khoản cộng lương: vào Sổ thu chi đúng ngày chi, cộng vào lương tháng 11.
  const ok = await post(OWNER, { action: 'decide_claim', id: g.body.id, status: 'approved' });
  assert.deepEqual([ok.status, ok.body.month, ok.body.year], [200, 11, 2026]);
  assert.equal((await post(OWNER, { action: 'decide_claim', id: g.body.id, status: 'approved' })).status, 409, 'not twice');
  assert.deepEqual(plain(state.finance_entries.map(e => [e.entry_date, e.kind, e.label, e.amount, e.created_by_name])), [['2026-11-07', 'drink', 'Xăng đi chợ', 50000, 'Chủ quán']]);
  assert.match(state.finance_entries[0].note, /Chi hộ: An · cộng vào lương tháng 11\/2026 · đổ xăng xe máy/);
  const claim = state.payroll_expense_claims.find(c => c.id === g.body.id);
  assert.deepEqual([claim.status, claim.year, claim.month, claim.finance_entry_id, claim.decided_by], ['approved', 2026, 11, state.finance_entries[0].id, 'Chủ quán']);

  const me = (await get(AN, 'me=1')).body;
  assert.equal(me.salary.claimAmt, 50000);
  assert.equal(me.salary.net - before.salary.net, 50000);
  assert.deepEqual(me.claims.list.map(c => [c.item, c.status, c.month]), [['Xăng đi chợ', 'approved', 11]]);
  assert.deepEqual((await get(OWNER, 'payroll=1&year=2026&month=11')).body.claims.map(c => c.item), ['Xăng đi chợ'], 'the pay page adds it too');

  // Lấy tiền mặt: vào Sổ thu chi, không đụng tới lương.
  assert.equal((await post(OWNER, { action: 'decide_claim', id: ice.body.id, status: 'approved' })).status, 200);
  assert.deepEqual(plain(state.finance_entries.map(e => [e.entry_date, e.label, e.amount])), [['2026-11-07', 'Xăng đi chợ', 50000], ['2026-11-08', 'Đá', 30000]]);
  assert.match(state.finance_entries[1].note, /Chi hộ: Bình · đã đưa tiền mặt/);
  assert.equal((await get(BINH, 'me=1')).body.salary?.claimAmt || 0, 0);

  // Từ chối: không ghi gì vào sổ, nhân viên thấy lý do.
  const toll = await post(AN, { action: 'claim_expense', item: 'Gửi xe', amount: 5000, payout: 'cash' });
  assert.equal((await post(OWNER, { action: 'decide_claim', id: toll.body.id, status: 'rejected', admin_note: 'Xe của bạn' })).status, 200);
  assert.equal(state.finance_entries.length, 2);
  const rejected = (await get(AN, 'me=1')).body.claims.list.find(c => c.item === 'Gửi xe');
  assert.deepEqual([rejected.status, rejected.admin_note], ['rejected', 'Xe của bạn']);

  // Chốt lương: số chốt có khoản chi hộ; đã chốt thì không xoá khoản cộng lương được tới khi mở chốt.
  assert.equal((await post(OWNER, { action: 'close_month', year: 2026, month: 11 })).status, 200);
  assert.equal(state.payroll_closes.find(c => c.staff_id === AN.id).snapshot.claimAmt, 50000);
  assert.equal((await post(OWNER, { action: 'delete_claim', id: g.body.id })).status, 409);
  assert.equal((await post(OWNER, { action: 'reopen_month', year: 2026, month: 11 })).status, 200);
  assert.equal((await post(OWNER, { action: 'delete_claim', id: g.body.id })).status, 200);
  assert.deepEqual(plain(state.finance_entries.map(e => e.label)), ['Đá'], 'the book line goes with it');
  assert.equal((await get(AN, 'me=1')).body.salary.claimAmt, 0);
});

test('before the table exists the claims part hides itself and says the web is updating', async () => {
  const state = { staff: [OWNER, AN], payroll_config: [], checkin_settings: [{ id: 1, enforce: false }], __noTable: ['payroll_expense_claims'] };
  const wf = api(state);
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  env.user = AN;
  const me = plain(await wf.GET({ url: 'http://x/api/admin/workforce?me=1' }));
  assert.deepEqual(me.body.claims, { ready: false, list: [] });
  const r = plain(await wf.POST({ json: async () => ({ action: 'claim_expense', item: 'Xăng', amount: 50000, payout: 'cash' }), headers: new Map() }));
  assert.equal(r.status, 503);
  env.user = OWNER;
  assert.deepEqual(plain(await wf.GET({ url: 'http://x/api/admin/workforce?claims=1' })).body, { ready: false, claims: [] });
});
