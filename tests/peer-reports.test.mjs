// Báo lỗi chéo: nhân viên / quản lý báo lỗi đồng nghiệp ở mục Đơn từ. Chưa trừ tiền: chủ quán phạt (tự định số tiền) hoặc bỏ qua;
// phạt thì thành một khoản ở Vi phạm của người bị báo. Người bị báo không thấy tên người báo.
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
const CUONG = { id: '00000000-0000-4000-8000-00000000dddd', full_name: 'Cường', role: 'staff', created_at: '2026-08-01T00:00:00Z' };
const GLASS = '00000000-0000-4000-9000-000000000001', PHONE = '00000000-0000-4000-9000-000000000002', LATE = '00000000-0000-4000-9000-000000000003';
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


test('a colleague reports a mistake; nothing is cut until the owner fines or dismisses it, and the reporter stays hidden', async () => {
  const state = {
    staff: [OWNER, AN, BINH, CUONG], staff_departures: [{ staff_id: CUONG.id, last_day: '2026-09-30' }],
    payroll_config: [{ staff_id: BINH.id, base_salary: 7000000, overtime_rate: 30000 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_fine_rules: [
      { id: GLASS, name: 'Làm vỡ ly, chén, dĩa', amount: 20000, kind: null, active: true, sort: 1 },
      { id: PHONE, name: 'Dùng điện thoại trong giờ làm', amount: 0, kind: null, active: true, sort: 2 },
      { id: LATE, name: 'Đi trễ quá 30 phút', amount: 50000, kind: 'late', active: true, sort: 0 },
    ],
    payroll_peer_reports: [], payroll_violations: [], payroll_violation_meta: [], payroll_requests: [], attendance_sessions: [],
  };
  const wf = api(state);
  const at = Date.UTC(2026, 10, 8, 5, 0); // 12:00 ngày 08/11 giờ VN
  const post = async (user, body) => { env.user = user; env.now = at; return plain(await wf.POST({ json: async () => body, headers: new Map() })); };
  const get = async (user, q) => { env.user = user; env.now = at; return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };

  const me = (await get(AN, 'me=1')).body;
  assert.deepEqual([me.peer.ready, me.peer.colleagues.map(c => c.name)], [true, ['Bình']], 'not yourself, not the owner, not someone who left');

  for (const [body, why] of [
    [{ staff_id: AN.id, rule_id: GLASS }, 'own mistakes go to self reports'],
    [{ staff_id: OWNER.id, rule_id: GLASS }, 'not the owner'],
    [{ staff_id: CUONG.id, rule_id: GLASS }, 'not someone who left'],
    [{ staff_id: BINH.id, rule_id: LATE }, 'lateness comes from attendance'],
    [{ staff_id: BINH.id, reason: '  ' }, 'needs a reason'],
    [{ staff_id: BINH.id, rule_id: GLASS, date: '2026-10-25' }, 'only the last 7 days'],
    [{ staff_id: BINH.id, rule_id: GLASS, date: '2026-11-10' }, 'not the future'],
  ]) assert.equal((await post(AN, { action: 'report_peer', ...body })).status, 400, why);

  const glass = await post(AN, { action: 'report_peer', staff_id: BINH.id, rule_id: GLASS, note: 'bàn 5, 2 cái ly', amount: 1 });
  assert.equal(glass.status, 200);
  assert.equal((await post(AN, { action: 'report_peer', staff_id: BINH.id, rule_id: GLASS, note: 'bàn 5, 2 cái ly' })).body.duplicate, true);
  const slow = await post(AN, { action: 'report_peer', staff_id: BINH.id, reason: 'Để khách chờ lâu', date: '2026-11-07' });
  assert.deepEqual([slow.status, slow.body.date], [200, '2026-11-07']);
  assert.deepEqual(plain(state.payroll_peer_reports.map(r => [r.reporter_id, r.staff_id, r.reason, r.suggested_amount, r.status, r.reporter_name])), [
    [AN.id, BINH.id, 'Làm vỡ ly, chén, dĩa', 20000, 'pending', 'An'], [AN.id, BINH.id, 'Để khách chờ lâu', 0, 'pending', 'An']]);
  assert.equal(state.payroll_violations.length, 0, 'nothing is cut yet');

  // Người bị báo không huỷ / duyệt được; người báo huỷ được lần báo còn chờ.
  assert.equal((await post(BINH, { action: 'cancel_request', kind: 'peer', id: glass.body.id })).status, 404);
  assert.equal((await post(BINH, { action: 'decide_peer', id: glass.body.id, status: 'rejected' })).status, 403);
  assert.equal((await post(AN, { action: 'cancel_request', kind: 'peer', id: slow.body.id })).status, 200);
  assert.equal(state.payroll_peer_reports.length, 1);

  const inbox = (await get(OWNER, 'peer=1')).body;
  assert.deepEqual(inbox.reports.map(r => [r.reporter_name, r.staff_id, r.reason, r.suggested_amount, r.status]), [['An', BINH.id, 'Làm vỡ ly, chén, dĩa', 20000, 'pending']]);
  assert.equal((await get(AN, 'peer=1')).status, 403);

  // Lương tháng của ngày bị báo đã chốt: không phạt được (khoản phạt sẽ không trừ vào đâu) — mở chốt rồi phạt.
  state.payroll_closes = [{ year: 2026, month: 11, staff_id: BINH.id, snapshot: {} }];
  const closedTry = await post(OWNER, { action: 'decide_peer', id: glass.body.id, status: 'approved', amount: '30.000' });
  assert.equal(closedTry.status, 409);
  assert.match(closedTry.body.error, /đã chốt/);
  assert.equal(state.payroll_violations.length, 0);
  state.payroll_closes = [];

  // Chủ phạt 30.000đ: thành khoản phạt của Bình đúng ngày bị báo, không chép tên hay ghi chú của người báo.
  const fined = await post(OWNER, { action: 'decide_peer', id: glass.body.id, status: 'approved', amount: '30.000' });
  assert.equal(fined.status, 200);
  assert.equal((await post(OWNER, { action: 'decide_peer', id: glass.body.id, status: 'approved' })).status, 409, 'once');
  const day = state.payroll_peer_reports[0].report_date;
  assert.deepEqual(plain(state.payroll_violations.map(v => [v.staff_id, v.amount, v.reason, v.month, v.year])), [[BINH.id, 30000, 'Làm vỡ ly, chén, dĩa', 11, 2026]]);
  assert.deepEqual(plain(state.payroll_violation_meta.map(m => [m.violation_id, m.fine_date, m.rule_id, m.recorded_by, m.note, m.self_reported ?? false])),
    [[fined.body.violation_id, day, GLASS, 'Chủ quán', null, false]]);
  const binh = await get(BINH, 'me=1');
  assert.deepEqual(binh.body.violations.map(v => [v.reason, v.amount, v.note, v.self]), [['Làm vỡ ly, chén, dĩa', 30000, null, false]]);
  assert.equal(binh.body.salary.vioAmt, 30000);
  assert.ok(!/An|bàn 5/.test(JSON.stringify(binh.body.violations)), 'the fined person sees neither the reporter nor their note');
  assert.equal((await get(OWNER, 'peer=1')).body.reports[0].note, 'bàn 5, 2 cái ly', 'the owner still reads the note');
  const mine = (await get(AN, 'me=1')).body.peer.list;
  assert.deepEqual(mine.map(r => [r.staff_name, r.status, 'amount' in r]), [['Bình', 'approved', false]], 'the reporter sees it was handled, not the money');

  // Bỏ qua: không ghi gì. Phạt không điền tiền: theo tiền gợi ý (lỗi 0đ thì ghi lỗi, định tiền sau).
  const phone = await post(AN, { action: 'report_peer', staff_id: BINH.id, rule_id: PHONE });
  assert.equal((await post(OWNER, { action: 'decide_peer', id: phone.body.id, status: 'rejected', admin_note: 'Đang nghỉ giữa ca' })).status, 200);
  assert.equal(state.payroll_violations.length, 1);
  const other = await post(AN, { action: 'report_peer', staff_id: BINH.id, reason: 'Quên lau bàn 3' });
  assert.equal((await post(OWNER, { action: 'decide_peer', id: other.body.id, status: 'approved' })).status, 200);
  assert.deepEqual(plain(state.payroll_violations.map(v => v.amount)), [30000, 0]);
});

test('before the table exists the report part hides itself and says the web is updating', async () => {
  const state = { staff: [OWNER, AN, BINH], payroll_config: [], checkin_settings: [{ id: 1, enforce: false }], __noTable: ['payroll_peer_reports'] };
  const wf = api(state);
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  env.user = AN;
  assert.deepEqual(plain(await wf.GET({ url: 'http://x/api/admin/workforce?me=1' })).body.peer, { ready: false, colleagues: [], list: [], workDay: '2026-11-08' });
  assert.equal(plain(await wf.POST({ json: async () => ({ action: 'report_peer', staff_id: BINH.id, reason: 'x' }), headers: new Map() })).status, 503);
  env.user = OWNER;
  assert.deepEqual(plain(await wf.GET({ url: 'http://x/api/admin/workforce?peer=1' })).body, { ready: false, reports: [] });
});
