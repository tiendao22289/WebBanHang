// Nước / bia nhân viên uống ở quán: nhân viên tự ghi (uống gì, ngày nào, mấy chai, giá 1 chai), trừ thẳng vào lương tháng của ngày
// uống; người ghi không tự xoá được, chủ quán xoá. Người trả lương theo kỳ bị trừ ở lần trả kế tiếp, đúng một lần.
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

const { computeSalary, cycleDue, payoutDetail, payoutPartOfMonth } = payroll;

test('drinks come off the pay of the month they were drunk, listed one by one', () => {
  const drinks = [
    { id: 'b', staff_id: 's', drink_date: '2026-11-07', name: 'Coca', qty: 1, unit_price: 12000, amount: 12000, year: 2026, month: 11, created_at: '2026-11-07T13:00:00Z' },
    { id: 'a', staff_id: 's', drink_date: '2026-11-05', name: 'Bia Tiger', qty: 2, unit_price: 15000, amount: 30000, year: 2026, month: 11, created_at: '2026-11-05T15:30:00Z' },
    { id: 'c', staff_id: 's', drink_date: '2026-10-31', name: 'Sting', qty: 1, unit_price: 10000, amount: 10000, year: 2026, month: 10, created_at: '2026-10-31T15:00:00Z' },
  ];
  const base = { year: 2026, month: 11, staffId: 's', config: { base_salary: 6000000, overtime_rate: 0 } };
  const plainPay = computeSalary(base), s = computeSalary({ ...base, drinks });
  assert.equal(s.drinkAmt, 42000);
  assert.equal(plainPay.net - s.net, 42000);
  assert.deepEqual(JSON.parse(JSON.stringify(s.drinkList)), [
    { id: 'a', day: '2026-11-05', at: '2026-11-05T15:30:00Z', name: 'Bia Tiger', qty: 2, price: 15000, amount: 30000 },
    { id: 'b', day: '2026-11-07', at: '2026-11-07T13:00:00Z', name: 'Coca', qty: 1, price: 12000, amount: 12000 },
  ]);
});

test('the finance book counts wages after drinks are taken off, like fines', () => {
  const staff = [{ id: 's', full_name: 'An' }], configs = [{ staff_id: 's', base_salary: 6000000, overtime_rate: 0 }];
  const drinks = [{ id: 'a', staff_id: 's', drink_date: '2026-11-05', name: 'Bia', qty: 2, unit_price: 15000, amount: 30000, year: 2026, month: 11 }];
  const base = payroll.payrollCost({ year: 2026, month: 11, staff, configs });
  const live = payroll.payrollCost({ year: 2026, month: 11, staff, configs, drinks });
  assert.equal(base.monthExtra - live.monthExtra, 30000);
  // Đã chốt: theo số chốt; số chốt cũ chưa có drinkAmt thì lấy theo bảng.
  const closes = [{ staff_id: 's', snapshot: { byDay: {}, vioAmt: 0, bonusAmt: 0, monthAdjust: 0, drinkAmt: 12000 } }];
  assert.equal(payroll.payrollCost({ year: 2026, month: 11, staff, configs, drinks, closes }).monthExtra, -12000);
  const oldClose = [{ staff_id: 's', snapshot: { byDay: {}, vioAmt: 0, bonusAmt: 0, monthAdjust: 0 } }];
  assert.equal(payroll.payrollCost({ year: 2026, month: 11, staff, configs, drinks, closes: oldClose }).monthExtra, -30000);
});

test('people paid every few days have drinks taken from the next payout, exactly once', () => {
  const cycle = { every_days: 7, start_day: '2026-11-01' };
  const months = [{ key: '2026-11', byDay: { '2026-11-02': 300000 }, advances: [], fines: [], bonus: 0, claims: [], drinks: [{ id: 'd1', amount: 30000 }] }];
  const due = cycleDue({ cycle, payouts: [], months, to: '2026-11-07', periodStart: '2026-11-01' });
  assert.deepEqual(due.drinks, [{ id: 'd1', key: '2026-11', amount: 30000 }]);
  assert.equal(due.amount, 270000);
  const paid = { from_day: '2026-11-01', to_day: '2026-11-07', amount: 270000, detail: payoutDetail(due) };
  assert.deepEqual(paid.detail.drinks, [{ id: 'd1', key: '2026-11', amount: 30000 }]);
  assert.equal(payoutPartOfMonth([paid], '2026-11'), 270000);
  const after = cycleDue({ cycle, payouts: [paid], months, to: '2026-11-08', periodStart: '2026-11-08' });
  assert.deepEqual([after.drinks, after.amount], [[], 0], 'not taken twice');
});

const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin', created_at: '2026-10-01T00:00:00Z' };
const AN = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'An', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
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

test('staff log what they drank; it comes off their pay at once and only the owner can delete it', async () => {
  const state = {
    staff: [OWNER, AN], payroll_config: [{ staff_id: AN.id, base_salary: 6000000, overtime_rate: 0 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_requests: [], payroll_violations: [], attendance_sessions: [], payroll_staff_drinks: [], payroll_closes: [],
  };
  const wf = api(state);
  const at = Date.UTC(2026, 10, 8, 5, 0); // 12:00 ngày 08/11 giờ VN
  const post = async (user, body) => { env.user = user; env.now = at; return plain(await wf.POST({ json: async () => body, headers: new Map() })); };
  const get = async (user, q) => { env.user = user; env.now = at; return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };

  const before = (await get(AN, 'me=1')).body;
  assert.deepEqual([before.drinks.ready, before.drinks.list.length, before.salary.drinkAmt], [true, 0, 0]);

  const beer = { action: 'log_drink', name: 'Bia Tiger', qty: 2, unit_price: '15.000', date: '2026-11-07' };
  for (const [body, why] of [
    [{ ...beer, name: ' ' }, 'what was drunk'], [{ ...beer, qty: 0 }, 'at least one'], [{ ...beer, qty: 101 }, 'at most 100'],
    [{ ...beer, unit_price: 500 }, 'a real price'], [{ ...beer, date: '2026-11-09' }, 'not in the future'], [{ ...beer, date: '2026-10-31' }, 'only the last 7 days'],
  ]) assert.equal((await post(AN, body)).status, 400, why);
  const ok = await post(AN, beer);
  assert.deepEqual([ok.status, ok.body.amount], [200, 30000]);
  assert.equal((await post(AN, beer)).body.duplicate, true, 'a double tap does not log it twice');
  assert.equal((await post(AN, { action: 'log_drink', name: 'Coca', qty: 1, unit_price: 12000 })).status, 200);
  assert.deepEqual(plain(state.payroll_staff_drinks.map(d => [d.name, d.qty, d.unit_price, d.amount, d.drink_date, d.month, d.created_by_name])), [
    ['Bia Tiger', 2, 15000, 30000, '2026-11-07', 11, 'An'], ['Coca', 1, 12000, 12000, '2026-11-08', 11, 'An'],
  ]);

  const me = (await get(AN, 'me=1')).body;
  assert.equal(me.salary.drinkAmt, 42000);
  assert.equal(before.salary.net - me.salary.net, 42000);
  assert.deepEqual(me.salary.drinkList.map(d => [d.day, d.name, d.qty, d.price, d.amount]), [['2026-11-07', 'Bia Tiger', 2, 15000, 30000], ['2026-11-08', 'Coca', 1, 12000, 12000]]);
  assert.deepEqual(me.drinks.list.map(d => d.name), ['Coca', 'Bia Tiger']);
  assert.deepEqual((await get(OWNER, 'payroll=1&year=2026&month=11')).body.drinks.map(d => d.name).sort(), ['Bia Tiger', 'Coca'], 'the owner pay page gets them');

  // Người ghi không tự xoá; chủ xoá được (lương chưa chốt).
  assert.equal((await post(AN, { action: 'delete_drink', id: ok.body.id })).status, 403);
  assert.equal((await post(OWNER, { action: 'delete_drink', id: ok.body.id })).status, 200);
  assert.deepEqual(state.payroll_staff_drinks.map(d => d.name), ['Coca']);

  // Lương tháng đã chốt: không ghi thêm, không xoá được tới khi mở chốt.
  state.payroll_closes.push({ year: 2026, month: 11, staff_id: AN.id, snapshot: { net: 1 } });
  assert.equal((await post(AN, { action: 'log_drink', name: 'Sting', qty: 1, unit_price: 10000 })).status, 409);
  assert.equal((await post(OWNER, { action: 'delete_drink', id: state.payroll_staff_drinks[0].id })).status, 409);
});

test('before the table exists the drinks part hides itself and says the web is updating', async () => {
  const state = { staff: [OWNER, AN], payroll_config: [], checkin_settings: [{ id: 1, enforce: false }], payroll_closes: [], __noTable: ['payroll_staff_drinks'] };
  const wf = api(state);
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  env.user = AN;
  assert.deepEqual(plain(await wf.GET({ url: 'http://x/api/admin/workforce?me=1' })).body.drinks, { ready: false, list: [] });
  const r = plain(await wf.POST({ json: async () => ({ action: 'log_drink', name: 'Coca', qty: 1, unit_price: 12000 }), headers: new Map() }));
  assert.equal(r.status, 503);
});
