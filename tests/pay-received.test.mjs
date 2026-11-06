// Nhân viên xác nhận đã nhận lương (lương tháng đã chốt + lần trả theo kỳ): chỉ của mình, chỉ khi chủ đã đánh dấu trả,
// không đổi lại được; đã xác nhận thì chủ không bỏ dấu "đã trả" / không bỏ lần trả được. Lỗi tự ghi vào báo cáo hằng ngày.
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
import { staffBlock, staffData } from '../src/lib/dailyInsights.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin', created_at: '2026-10-01T00:00:00Z' };
const AN = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'An', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const BINH = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Bình', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const PAYOUT = '00000000-0000-4000-9000-000000000001';
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

test('staff confirm the pay the owner marked paid; once confirmed the owner cannot take the mark back', async () => {
  const state = {
    staff: [OWNER, AN, BINH], checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    attendance_sessions: [], payroll_requests: [], payroll_violations: [], payroll_violation_meta: [],
    // Lương tháng 10 của An đã chốt (thực lĩnh 5.000.000đ), chủ chưa trả; lần trả theo kỳ 01–07/11 đã trả 900.000đ.
    payroll_closes: [{ year: 2026, month: 10, staff_id: AN.id, snapshot: { net: 5000000 }, closed_at: '2026-11-01T01:00:00Z', paid_at: null, received_at: null }],
    payroll_payouts: [{ id: PAYOUT, staff_id: AN.id, from_day: '2026-11-01', to_day: '2026-11-07', amount: 900000, detail: { days: { '2026-11-03': 900000 } },
      paid_at: '2026-11-07T15:00:00Z', paid_by: 'Chủ quán', received_at: null }],
  };
  const wf = api(state);
  const at = Date.UTC(2026, 10, 8, 3, 0);
  const post = async (user, body) => { env.user = user; env.now = at; return plain(await wf.POST({ json: async () => body, headers: new Map() })); };
  const get = async (user, q) => { env.user = user; env.now = at; return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };

  assert.equal((await post(AN, { action: 'confirm_received', kind: 'month', year: 2026, month: 10 })).status, 409, 'not marked paid yet');
  assert.equal((await post(OWNER, { action: 'mark_paid', year: 2026, month: 10, staff_id: AN.id })).status, 200);

  const me = (await get(AN, 'me=1')).body;
  assert.deepEqual(me.payments.map(p => [p.kind, p.label, p.amount, !!p.received_at]),
    [['month', 'Lương tháng 10/2026', 5000000, false], ['payout', 'Lương 01/11 – 07/11', 900000, false]]);

  assert.equal((await post(BINH, { action: 'confirm_received', kind: 'payout', id: PAYOUT })).status, 404, 'someone else cannot confirm it');
  assert.equal((await post(BINH, { action: 'confirm_received', kind: 'month', year: 2026, month: 10 })).status, 409, 'nor their month');
  const m = await post(AN, { action: 'confirm_received', kind: 'month', year: 2026, month: 10 });
  const p = await post(AN, { action: 'confirm_received', kind: 'payout', id: PAYOUT });
  assert.deepEqual([m.status, p.status, !!state.payroll_closes[0].received_at, !!state.payroll_payouts[0].received_at], [200, 200, true, true]);
  const first = state.payroll_closes[0].received_at;
  env.now = at + 60000;
  assert.equal((await post(AN, { action: 'confirm_received', kind: 'month', year: 2026, month: 10 })).status, 200, 'pressing again changes nothing');
  assert.equal(state.payroll_closes[0].received_at, first);

  // Đã xác nhận: chủ không bỏ dấu "đã trả", không bỏ lần trả, không mở chốt được.
  const unmark = await post(OWNER, { action: 'mark_paid', year: 2026, month: 10, staff_id: AN.id, paid: false });
  assert.equal(unmark.status, 409);
  assert.match(unmark.body.error, /đã xác nhận/);
  assert.equal((await post(OWNER, { action: 'undo_payout', id: PAYOUT })).status, 409);
  assert.equal((await post(OWNER, { action: 'reopen_month', year: 2026, month: 10, staff_id: AN.id })).status, 409);
  assert.ok(state.payroll_closes[0].paid_at && state.payroll_payouts.length === 1);

  // Trang Lương của chủ đọc được dấu xác nhận.
  const month = (await get(OWNER, 'payroll=1&year=2026&month=10')).body;
  assert.ok(month.closes[0].received_at);
});

test('the daily report lists the mistakes staff wrote down themselves', () => {
  const args = { staffNames: { a: 'An', b: 'Bình' }, date: '2026-11-06',
    selfFines: [{ staff_id: 'a', reason: 'Làm vỡ ly, chén, dĩa', amount: 20000, note: 'bàn 12' }, { staff_id: 'b', reason: 'Làm đổ nồi lẩu', amount: 0, note: null }] };
  assert.deepEqual(staffData(args).selfFines, [
    { id: 'a', name: 'An', reason: 'Làm vỡ ly, chén, dĩa', amount: 20000, note: 'bàn 12' },
    { id: 'b', name: 'Bình', reason: 'Làm đổ nồi lẩu', amount: 0, note: '' },
  ]);
  const text = staffBlock(args);
  assert.match(text, /🙋 Nhân viên tự ghi lỗi \(2\):\n• An: Làm vỡ ly, chén, dĩa \(bàn 12\) — 20\.000đ\n• Bình: Làm đổ nồi lẩu — chờ bạn định tiền/);
  assert.doesNotMatch(staffBlock({ staffNames: {}, date: '2026-11-06' }), /tự ghi lỗi/);
});
