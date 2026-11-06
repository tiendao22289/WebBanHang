// Nhân viên tự ghi lỗi của mình: tiền theo danh sách lỗi chủ đặt (không tự gõ tiền), lỗi khác 0đ chờ chủ định tiền, chỉ ghi
// cho chính mình vào ngày làm hôm nay; ghi xong không tự sửa / xoá được — chỉ chủ quán.
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
const BINH = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Bình', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const GLASS = '00000000-0000-4000-9000-000000000001', PHONE = '00000000-0000-4000-9000-000000000002', LATE = '00000000-0000-4000-9000-000000000003', OLD = '00000000-0000-4000-9000-000000000004';
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

test('staff log their own mistakes at the listed price, cannot change them, and the owner sees and prices them', async () => {
  const state = {
    staff: [OWNER, AN, BINH], payroll_config: [{ staff_id: AN.id, base_salary: 6000000, overtime_rate: 30000 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_fine_rules: [
      { id: GLASS, name: 'Làm vỡ ly, chén, dĩa', amount: 20000, kind: null, active: true, sort: 1 },
      { id: PHONE, name: 'Dùng điện thoại trong giờ làm', amount: 0, kind: null, active: true, sort: 2 },
      { id: LATE, name: 'Đi trễ quá 30 phút', amount: 50000, kind: 'late', active: true, sort: 0 },
      { id: OLD, name: 'Lỗi cũ', amount: 10000, kind: null, active: false, sort: 3 },
    ],
    payroll_violations: [], payroll_violation_meta: [], payroll_requests: [], attendance_sessions: [],
  };
  const wf = api(state);
  // 7/11 lúc 00:30 (dọn quán sau nửa đêm): ngày làm vẫn là 6/11.
  const at = Date.UTC(2026, 10, 6, 17, 30);
  const post = async (user, body) => { env.user = user; env.now = at; return plain(await wf.POST({ json: async () => body, headers: new Map() })); };
  const get = async (user, q) => { env.user = user; env.now = at; return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };

  // Danh sách lỗi để tự ghi: không có lỗi máy tự gợi ý (trễ / quên ra ca) và lỗi đã ẩn.
  const me0 = (await get(AN, 'me=1')).body;
  assert.deepEqual(me0.fineRules.map(r => [r.name, r.amount]), [['Làm vỡ ly, chén, dĩa', 20000], ['Dùng điện thoại trong giờ làm', 0]]);

  const glass = await post(AN, { action: 'report_violation', rule_id: GLASS, amount: 1, note: 'bàn 12, 2 cái ly', staff_id: BINH.id });
  assert.deepEqual([glass.status, glass.body.amount, glass.body.date], [200, 20000, '2026-11-06'], 'price from the list, not typed; own record only');
  const other = await post(AN, { action: 'report_violation', reason: 'Làm đổ nồi lẩu' });
  assert.deepEqual([other.status, other.body.amount], [200, 0], 'another mistake waits for the owner to price it');
  assert.equal((await post(AN, { action: 'report_violation', rule_id: LATE })).status, 400, 'lateness comes from attendance, not self reports');
  assert.equal((await post(AN, { action: 'report_violation', rule_id: OLD })).status, 400, 'a hidden rule is refused');
  assert.equal((await post(AN, { action: 'report_violation', reason: '   ' })).status, 400);

  assert.deepEqual(plain(state.payroll_violations.map(v => [v.staff_id, v.reason, v.amount, v.month, v.year])),
    [[AN.id, 'Làm vỡ ly, chén, dĩa', 20000, 11, 2026], [AN.id, 'Làm đổ nồi lẩu', 0, 11, 2026]]);
  assert.deepEqual(plain(state.payroll_violation_meta.map(m => [m.staff_id, m.fine_date, m.self_reported, m.note, m.recorded_by])),
    [[AN.id, '2026-11-06', true, 'bàn 12, 2 cái ly', 'An'], [AN.id, '2026-11-06', true, null, 'An']]);

  // Không tự sửa / xoá / ghi phạt người khác được.
  const id = glass.body.id;
  for (const body of [{ action: 'edit_violation', id, amount: 1000 }, { action: 'delete_violation', id }, { action: 'add_violation', staff_id: BINH.id, amount: 5000, reason: 'x', date: '2026-11-06' }]) {
    assert.equal((await post(AN, body)).status, 403, body.action);
  }
  assert.equal(state.payroll_violations.length, 2);

  // Nhân viên thấy lỗi của mình (kể cả 0đ chờ định tiền), phiếu lương trừ 20.000đ.
  const me = (await get(AN, 'me=1')).body;
  assert.deepEqual(me.violations.map(v => [v.reason, v.amount, v.self, v.note]).sort(), [['Làm vỡ ly, chén, dĩa', 20000, true, 'bàn 12, 2 cái ly'], ['Làm đổ nồi lẩu', 0, true, null]]);
  assert.equal(me.salary.vioAmt, 20000);

  // Chủ quán thấy khoản tự ghi (trang Lương đọc ngày / ghi chú ở violationMeta) và định tiền khoản lỗi khác.
  const month = (await get(OWNER, 'payroll=1&year=2026&month=11')).body;
  assert.equal(month.violationMeta.filter(m => m.self_reported).length, 2);
  assert.equal((await post(OWNER, { action: 'edit_violation', id: other.body.id, amount: '100.000' })).status, 200);
  assert.equal((await get(AN, 'me=1')).body.salary.vioAmt, 120000);
  assert.equal((await post(OWNER, { action: 'delete_violation', id })).status, 200, 'the owner can still remove a mistaken one');

  // Bấm liên tục: tối đa 20 khoản tự ghi một ngày.
  for (let i = 0; i < 19; i += 1) await post(AN, { action: 'report_violation', rule_id: GLASS });
  const tooMany = await post(AN, { action: 'report_violation', rule_id: GLASS });
  assert.equal(tooMany.status, 429);
});
