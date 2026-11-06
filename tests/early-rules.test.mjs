// Luật đi trễ có công tắc (tắt = được phép đi trễ) và luật về sớm cài được như đi trễ, cho cả quán hoặc từng người, áp dụng
// từ một ngày. Dòng luật cũ chưa cài về sớm: về sớm từ 30 phút trừ theo phút như trước.
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
import { staffData } from '../src/lib/dailyInsights.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const { computeSalary, fineSuggestions, monthTallies } = payroll;
// Ca 22:00 → 02:00 (240 phút) như CÔ 7, lương 1 ngày 120.000đ = 500đ/phút.
const SHIFT_RULES = rules.normalizeRules({ hours_from: '2026-10-25' }, [{ staff_id: 'a', valid_from: '2026-11-01', start_time: '22:00', end_time: '02:00' }],
  [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }]);
const DAILY = [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 120000, unit: 'day' }];
const at = (day, hm, next = false) => new Date(Date.parse(`${day}T${hm}:00+07:00`) + (next ? 86400000 : 0)).toISOString();
const ses = (day, inHm, outHm) => ({ id: `s${day}`, staff_id: 'a', date: day, clock_in: at(day, inHm), clock_out: at(day, outHm, outHm < '12:00') });
const rule = extra => [{ scope: 'a', valid_from: '2026-11-04', allowed_minutes: 10, per_minute: false, fixed_amount: 50000, use_shop: false, ...extra }];
const pay = (sessions, lateRules, hourlyRates = DAILY) => computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: { base_salary: 0, overtime_rate: 0 },
  rules: SHIFT_RULES, hourlyRates, lateRules });

test('late on/off: off means late is allowed — recorded, never cut, no fine suggestion', () => {
  const day = [ses('2026-11-05', '22:47', '02:00')];
  const on = pay(day, rule());
  assert.deepEqual([on.lateAmt, on.byDay['2026-11-05'], on.lateFree], [50000, 70000, []], '47 minutes late: 50.000đ once');
  const off = pay(day, rule({ late_on: false }));
  assert.deepEqual([off.lateAmt, off.byDay['2026-11-05'], off.lateFree, off.daily[0].late], [0, 120000, ['2026-11-05'], 47]);
  const tallies = monthTallies({ sessions: day, rules: SHIFT_RULES, key: '2026-11' });
  assert.equal(fineSuggestions({ staffId: 'a', tallies, autoLateDays: off.lateFree }).length, 0, 'allowed to be late: no "late over 30 minutes" fine to suggest');
});

test('leaving early: allowed minutes, per minute and a fixed amount each time, or allowed; old rules keep "from 30 minutes, per minute"', () => {
  const leftAt = out => [ses('2026-11-05', '22:00', out)];
  const early = extra => pay(leftAt('01:20'), rule({ early_on: true, early_allowed_minutes: 30, early_per_minute: false, early_fixed_amount: 30000, ...extra }));
  // Về 01:20: sớm 40 phút.
  assert.deepEqual([early().earlyAmt, early().byDay['2026-11-05']], [30000, 90000], 'over 30 minutes: 30.000đ once');
  assert.deepEqual([early({ early_per_minute: true }).earlyAmt], [30000 + 40 * 500], 'plus 40 minutes × 500đ');
  assert.equal(early({ early_allowed_minutes: 45 }).earlyAmt, 0, 'within the 45 minutes allowed');
  assert.equal(early({ early_on: false }).earlyAmt, 0, 'allowed to leave early');
  // Dòng luật chưa cài về sớm: như cũ (từ 30 phút, theo phút).
  assert.equal(pay(leftAt('01:20'), rule()).earlyAmt, 40 * 500);
  assert.equal(pay(leftAt('01:35'), rule()).earlyAmt, 0, '25 minutes early: nothing, as before');
  // Trễ + về sớm cùng ngày (22:47 → 00:30, dưới nửa ca = nửa ngày 60.000đ): trễ 50.000đ, về sớm chỉ còn 10.000đ — không trừ
  // quá tiền ngày đó.
  const both = pay([ses('2026-11-05', '22:47', '00:30')], rule({ early_on: true, early_allowed_minutes: 0, early_per_minute: false, early_fixed_amount: 100000 }));
  assert.deepEqual([both.lateAmt, both.earlyAmt, both.byDay['2026-11-05']], [50000, 10000, 0]);
});

test('paid by the hour: leaving early already loses the minutes; only the fixed amount is added', () => {
  const hourly = [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 30000, unit: 'hour' }];
  const c = pay([ses('2026-11-05', '22:00', '01:00')], rule({ early_on: true, early_allowed_minutes: 10, early_per_minute: true, early_fixed_amount: 20000 }), hourly);
  assert.deepEqual([c.hourly.minutes, c.earlyAmt, c.byDay['2026-11-05']], [180, 20000, 90000 - 20000]);
});

test('the daily report says "trừ lương" for leaving early only when the rule of that person cuts it', () => {
  const sessions = [{ id: 'x', staff_id: 'a', date: '2026-11-05', clock_in: at('2026-11-05', '22:00'), clock_out: at('2026-11-05', '01:20', true) }];
  const base = { sessions, settings: { hours_from: '2026-10-25' }, shifts: [{ staff_id: 'a', valid_from: '2026-11-01', start_time: '22:00', end_time: '02:00' }],
    hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }], staffNames: { a: 'A' }, date: '2026-11-05' };
  assert.equal(staffData({ ...base }).people[0].cut, true, 'no rule: as before, 40 minutes early is cut');
  assert.equal(staffData({ ...base, lateRules: rule({ early_on: false, early_allowed_minutes: 30, early_per_minute: true, early_fixed_amount: 0 }) }).people[0].cut, false);
});

// ---- Lưu luật qua máy chủ ----
const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const CO7 = '00000000-0000-4000-8000-00000000c007';
test('the owner saves a late / early rule from a chosen day this month; later rules of the same person give way', async () => {
  const now = Date.UTC(2026, 10, 6, 9, 0);
  class FixedDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const state = { payroll_late_rules: [
    { scope: CO7, valid_from: '2026-11-04', allowed_minutes: 10, per_minute: false, fixed_amount: 50000, use_shop: false },
    { scope: CO7, valid_from: '2026-11-05', allowed_minutes: 10, per_minute: false, fixed_amount: 50000, use_shop: false },
  ] };
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  const api = vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, ...roles, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
    Date: FixedDate, nowMs: () => now, refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true }), closeForgottenSessions: async () => {},
    console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) } },
    getStaffSession: async () => ({ code: 200, user: OWNER }), staffDatabase: () => fakeDb(state),
  });
  const post = async body => JSON.parse(JSON.stringify(await api.POST({ json: async () => body, headers: new Map() })));
  const full = { scope: CO7, late_on: false, allowed_minutes: 10, per_minute: false, fixed_amount: 50000, early_on: true, early_allowed_minutes: 15, early_per_minute: true, early_fixed_amount: 0 };
  assert.equal((await post({ action: 'save_late_rule', ...full, valid_from: '2026-10-31' })).status, 400, 'not before this month');
  assert.equal((await post({ action: 'save_late_rule', ...full, valid_from: '2026-11-07' })).status, 400, 'not in the future');
  assert.equal((await post({ action: 'save_late_rule', ...full, early_allowed_minutes: 700, valid_from: '2026-11-04' })).status, 400);
  assert.equal((await post({ action: 'save_late_rule', ...full, valid_from: '2026-11-04' })).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(state.payroll_late_rules.map(r => [r.valid_from, r.late_on, r.early_on, r.early_allowed_minutes, r.early_per_minute, r.early_fixed_amount]))),
    [['2026-11-04', false, true, 15, true, 0]], 'from 04/11 on: the 05/11 rule is gone');
  const r = payroll.lateRuleOn(state.payroll_late_rules, CO7, '2026-11-05');
  assert.deepEqual([r.on, r.early], [false, { on: true, allowed: 15, perMinute: true, fixed: 0 }]);
  // Trang cũ (không gửi phần về sớm): giữ như cũ, ngày hôm nay.
  assert.equal((await post({ action: 'save_late_rule', scope: 'shop', allowed_minutes: 10, per_minute: true, fixed_amount: 50000 })).status, 200);
  const shop = state.payroll_late_rules.find(x => x.scope === 'shop');
  assert.deepEqual([shop.valid_from, 'early_allowed_minutes' in shop], ['2026-11-06', false]);
});
