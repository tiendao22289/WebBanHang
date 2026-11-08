// Mục Duyệt trên /thongke: một chỗ gom mọi việc chờ chủ quán (đơn, sửa giờ, giờ ngoài ca, chi hộ, báo lỗi, gợi ý phạt, lỗi chưa định
// tiền, thưởng chuyên cần) để duyệt ngay, không cần sang trang Lương.
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


test('the Duyệt inbox gathers everything waiting for the owner, skipping people whose month is closed', async () => {
  const S = '00000000-0000-4000-8000-000000000051';
  const state = {
    staff: [OWNER, AN, BINH], payroll_config: [{ staff_id: AN.id, base_salary: 6000000, overtime_rate: 30000 }, { staff_id: BINH.id, base_salary: 6000000, overtime_rate: 30000 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }],
    payroll_fine_rules: [{ id: '00000000-0000-4000-9000-000000000003', name: 'Đi trễ quá 30 phút', amount: 50000, kind: 'late', active: true, sort: 0 }],
    // An vào 15:10 ngày 05/11 (ca 14:00): trễ 70 phút → gợi ý phạt trễ.
    attendance_sessions: [{ id: S, staff_id: AN.id, date: '2026-11-05', clock_in: '2026-11-05T08:10:00Z', clock_out: '2026-11-05T16:00:00Z' }],
    payroll_requests: [{ id: '00000000-0000-4000-8000-0000000000a1', staff_id: AN.id, request_type: 'advance', amount: 200000, reason: 'việc nhà', month: 11, year: 2026, status: 'pending', created_at: '2026-11-08T03:00:00Z' }],
    attendance_fix_requests: [{ id: '00000000-0000-4000-8000-0000000000f1', staff_id: AN.id, attendance_id: S, clock_out: '2026-11-05T16:30:00Z', reason: 'quên bấm', status: 'pending', created_at: '2026-11-06T01:00:00Z' }],
    payroll_expense_claims: [{ id: '00000000-0000-4000-8000-0000000000c1', staff_id: AN.id, spent_on: '2026-11-07', item: 'Xăng', amount: 50000, payout: 'salary', status: 'pending', created_at: '2026-11-07T10:00:00Z' }],
    payroll_peer_reports: [{ id: '00000000-0000-4000-8000-0000000000e1', reporter_id: AN.id, staff_id: BINH.id, report_date: '2026-11-07', reason: 'Làm vỡ ly', suggested_amount: 20000, status: 'pending', reporter_name: 'An', created_at: '2026-11-07T12:00:00Z' }],
    payroll_violations: [
      { id: '00000000-0000-4000-8000-0000000000b1', staff_id: AN.id, amount: 0, reason: 'Làm đổ nồi lẩu', month: 11, year: 2026 },
      { id: '00000000-0000-4000-8000-0000000000b2', staff_id: BINH.id, amount: 0, reason: 'Quên lau bàn', month: 11, year: 2026 },
    ],
    payroll_violation_meta: [{ violation_id: '00000000-0000-4000-8000-0000000000b1', staff_id: AN.id, fine_date: '2026-11-06', self_reported: true, note: 'bàn 3' }],
    // Lương tháng 11 của Bình đã chốt: lỗi của Bình không hiện (định tiền vào tháng đã chốt thì không trừ được).
    payroll_closes: [{ year: 2026, month: 11, staff_id: BINH.id, snapshot: { net: 1 } }],
  };
  const wf = api(state);
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  env.user = AN;
  assert.equal(plain(await wf.GET({ url: 'http://x/api/admin/workforce?inbox=1' })).status, 403);
  env.user = OWNER;
  const box = plain(await wf.GET({ url: 'http://x/api/admin/workforce?inbox=1' })).body;
  assert.deepEqual(box.requests.map(r => [r.name, r.type, r.amount]), [['An', 'advance', 200000]]);
  assert.deepEqual(box.fixes.map(f => [f.name, f.current?.id, f.reason]), [['An', S, 'quên bấm']]);
  assert.deepEqual(box.claims.map(c => [c.name, c.item, c.payout]), [['An', 'Xăng', 'salary']]);
  assert.deepEqual(box.peers.map(p => [p.name, p.reporter, p.suggested]), [['Bình', 'An', 20000]]);
  assert.deepEqual(box.fines.map(x => [x.name, x.kind, x.day, x.suggested, x.attendance_id]), [['An', 'late', '2026-11-05', 50000, S]]);
  assert.deepEqual(box.unpriced.map(v => [v.name, v.reason, v.date, v.self, v.note]), [['An', 'Làm đổ nồi lẩu', '2026-11-06', true, 'bàn 3']]);
  assert.equal(box.count, 6);

  // Duyệt từ mục này dùng đúng các thao tác của trang Lương: gợi ý phạt → khoản phạt, rồi biến khỏi danh sách.
  const fined = plain(await wf.POST({ json: async () => ({ action: 'decide_fine', attendance_id: S, kind: 'late', status: 'fined', amount: 50000 }), headers: new Map() }));
  assert.equal(fined.status, 200);
  const after = plain(await wf.GET({ url: 'http://x/api/admin/workforce?inbox=1' })).body;
  assert.deepEqual([after.fines.length, after.count], [0, 5]);
});

test('the inbox still works before the new tables exist', async () => {
  const state = { staff: [OWNER, AN], payroll_config: [], checkin_settings: [{ id: 1, enforce: false }], __noTable: ['payroll_expense_claims', 'payroll_peer_reports'] };
  const wf = api(state);
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  env.user = OWNER;
  const r = plain(await wf.GET({ url: 'http://x/api/admin/workforce?inbox=1' }));
  assert.deepEqual([r.status, r.body.claims, r.body.peers, r.body.count], [200, [], [], 0]);
});
