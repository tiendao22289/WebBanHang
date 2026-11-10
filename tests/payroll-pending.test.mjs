// Số trên biểu tượng ví ở thanh menu admin = số "Chờ duyệt" ở Lương → Yêu cầu: cùng định nghĩa (src/lib/payrollPending.mjs),
// máy chủ đếm từ đúng các nguồn tab Yêu cầu đang đọc.
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
import * as pending from '../src/lib/payrollPending.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const {
  OPEN_REQUESTS_KEEP_MS, PAYROLL_REQUESTS_HREF, PENDING_KINDS, askOpenRequests, isPendingRequest, pendingBadgeText, pendingRequestCounts,
  requestKind, takeOpenRequests, walletHref, wantsRequestsTab,
} = pending;

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../src/app/api/admin/workforce/route.js').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin', created_at: '2026-10-01T00:00:00Z' };
const AN = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'An', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const BINH = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Bình', role: 'manager', created_at: '2026-10-01T00:00:00Z' };
const env = { now: 0, user: null };
function api(state) {
  class FixedDate extends Date { constructor(...a) { super(...(a.length ? a : [env.now])); } static now() { return env.now; } }
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, ...roles, ...pending,
    createHmac, randomUUID, timingSafeEqual, Buffer, URL, URLSearchParams, Number, Math, String, JSON, Promise,
    Date: FixedDate, nowMs: () => env.now, refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true }),
    closeForgottenSessions: async () => {}, console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) } },
    getStaffSession: async () => (env.user ? { code: 200, user: env.user } : { code: 401 }), staffDatabase: () => fakeDb(state),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));
const get = async (wf, q) => plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` }));
const zero = Object.fromEntries([...PENDING_KINDS, 'total'].map(k => [k, 0]));

test('only rows still waiting count, per kind, and missing lists count as none', () => {
  assert.deepEqual(pendingRequestCounts(), zero);
  assert.deepEqual(pendingRequestCounts({ requests: null, claims: undefined }), zero);
  const counts = pendingRequestCounts({
    requests: [
      { request_type: 'advance', status: 'pending' }, { request_type: 'advance', status: 'approved' },
      { request_type: 'absent', status: 'pending' }, { request_type: 'absent', status: 'pending' }, { request_type: 'absent', status: 'rejected' },
    ],
    claims: [{ status: 'pending' }, { status: 'approved' }, { status: 'rejected' }],
    peers: [{ status: 'pending' }, { status: 'approved' }],
    fixes: [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }],
    // Máy chủ chỉ gửi ca ngoài ca chưa duyệt / ca sai mặt còn chờ: không có cột status vẫn là chờ duyệt.
    extras: [{ attendance_id: 'a' }, { attendance_id: 'b' }],
    faceReviews: [{ attendance_id: 'c', status: 'pending' }],
  });
  assert.deepEqual(counts, { advance: 1, absent: 2, claim: 1, peer: 1, fix: 2, extra: 2, face: 1, total: 10 });
  assert.equal(isPendingRequest('extra', {}), true);
  assert.equal(isPendingRequest('face', null), true);
  assert.equal(isPendingRequest('claim', { status: 'approved' }), false);
  assert.equal(isPendingRequest('peer', undefined), false);
  assert.equal(requestKind({ request_type: 'advance' }), 'advance');
  assert.equal(requestKind({ request_type: 'absent' }), 'absent');
});

test('the wallet badge hides at 0, caps at 99+, and opens Lương → Yêu cầu only while something waits', () => {
  for (const v of [0, -2, NaN, null, undefined, 'x']) assert.equal(pendingBadgeText(v), '', String(v));
  assert.equal(pendingBadgeText(1), '1');
  assert.equal(pendingBadgeText(99), '99');
  assert.equal(pendingBadgeText(100), '99+');
  assert.equal(walletHref(3), PAYROLL_REQUESTS_HREF);
  assert.equal(walletHref(0), '/admin/payroll');
  assert.equal(wantsRequestsTab(new URL(PAYROLL_REQUESTS_HREF, 'http://x').search), true);
  assert.equal(wantsRequestsTab('?tab=salary'), false);
  assert.equal(wantsRequestsTab(''), false);
});

test('a wallet tap while Lương still asks for the PIN is remembered for a short while, once', () => {
  const t = 1_800_000_000_000;
  assert.equal(takeOpenRequests(t), false);
  askOpenRequests(t);
  assert.equal(takeOpenRequests(t + 5000), true, 'PIN nhập xong trong 2 phút → mở tab Yêu cầu');
  assert.equal(takeOpenRequests(t + 6000), false, 'chỉ một lần');
  askOpenRequests(t);
  assert.equal(takeOpenRequests(t + OPEN_REQUESTS_KEEP_MS + 1), false, 'quá 2 phút thì thôi');
});

// Mỗi loại một đơn còn chờ, kèm đơn đã xử lý / quá hạn / ca đã xoá không được đếm.
function shop() {
  const S1 = '00000000-0000-4000-8000-000000000051', S2 = '00000000-0000-4000-8000-000000000052', S3 = '00000000-0000-4000-8000-000000000053';
  return {
    staff: [OWNER, AN, BINH], payroll_config: [{ staff_id: AN.id, base_salary: 6000000, overtime_rate: 30000 }, { staff_id: BINH.id, base_salary: 6000000, overtime_rate: 30000 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }],
    checkin_face_settings: [{ id: 1, enabled: true, level: 'normal' }],
    attendance_sessions: [
      // 28/10 (trước khi giờ ngoài ca tự tính): An vào 12:00, ca 14:00 → 2 giờ ngoài ca chờ duyệt.
      { id: S1, staff_id: AN.id, date: '2026-10-28', clock_in: '2026-10-28T05:00:00Z', clock_out: '2026-10-28T16:00:00Z' },
      { id: S2, staff_id: AN.id, date: '2026-11-05', clock_in: '2026-11-05T07:00:00Z', clock_out: '2026-11-05T16:00:00Z' },
      { id: S3, staff_id: BINH.id, date: '2026-11-06', clock_in: '2026-11-06T07:00:00Z', clock_out: '2026-11-06T16:00:00Z' },
    ],
    attendance_extra_reviews: [],
    payroll_requests: [
      { id: '00000000-0000-4000-8000-0000000000a1', staff_id: AN.id, request_type: 'advance', amount: 200000, month: 11, year: 2026, status: 'pending', created_at: '2026-11-08T03:00:00Z' },
      { id: '00000000-0000-4000-8000-0000000000a2', staff_id: BINH.id, request_type: 'absent', days: 1, month: 11, year: 2026, status: 'pending', created_at: '2026-11-07T03:00:00Z' },
      { id: '00000000-0000-4000-8000-0000000000a3', staff_id: AN.id, request_type: 'advance', amount: 100000, month: 11, year: 2026, status: 'approved', created_at: '2026-11-02T03:00:00Z' },
    ],
    attendance_fix_requests: [
      { id: '00000000-0000-4000-8000-0000000000f1', staff_id: AN.id, attendance_id: S2, clock_out: '2026-11-05T16:30:00Z', status: 'pending', created_at: '2026-11-06T01:00:00Z' },
      { id: '00000000-0000-4000-8000-0000000000f2', staff_id: AN.id, attendance_id: S2, clock_out: '2026-11-05T16:10:00Z', status: 'rejected', created_at: '2026-11-06T00:00:00Z' },
      // Quá 45 ngày: tab Yêu cầu không còn hiện → ví cũng không đếm.
      { id: '00000000-0000-4000-8000-0000000000f3', staff_id: AN.id, attendance_id: S2, clock_out: '2026-09-01T16:10:00Z', status: 'pending', created_at: '2026-09-02T00:00:00Z' },
    ],
    payroll_expense_claims: [
      { id: '00000000-0000-4000-8000-0000000000c1', staff_id: AN.id, spent_on: '2026-11-07', item: 'Xăng', amount: 50000, payout: 'salary', status: 'pending', created_at: '2026-11-07T10:00:00Z' },
      { id: '00000000-0000-4000-8000-0000000000c2', staff_id: AN.id, spent_on: '2026-11-03', item: 'Đá', amount: 30000, payout: 'cash', status: 'approved', created_at: '2026-11-03T10:00:00Z' },
    ],
    payroll_peer_reports: [
      { id: '00000000-0000-4000-8000-0000000000e1', reporter_id: AN.id, staff_id: BINH.id, report_date: '2026-11-07', reason: 'Làm vỡ ly', suggested_amount: 20000, status: 'pending', created_at: '2026-11-07T12:00:00Z' },
      { id: '00000000-0000-4000-8000-0000000000e2', reporter_id: AN.id, staff_id: BINH.id, report_date: '2026-11-04', reason: 'Đi trễ', status: 'rejected', created_at: '2026-11-04T12:00:00Z' },
    ],
    attendance_face_reviews: [
      { attendance_id: S3, clocked: 'in', staff_id: BINH.id, status: 'pending', created_at: '2026-11-06T07:00:00Z' },
      // Ca đã bị xoá: tab không hiện → không đếm.
      { attendance_id: '00000000-0000-4000-8000-000000000059', clocked: 'in', staff_id: BINH.id, status: 'pending', created_at: '2026-11-06T07:00:00Z' },
      { attendance_id: S2, clocked: 'out', staff_id: AN.id, status: 'approved', created_at: '2026-11-05T16:00:00Z' },
    ],
  };
}

test('?pending=1 gives the owner the same count the Yêu cầu tab shows from its own lists', async () => {
  const state = shop();
  const wf = api(state);
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  env.user = OWNER;
  const badge = await get(wf, 'pending=1');
  assert.equal(badge.status, 200);
  assert.deepEqual(badge.body, { advance: 1, absent: 1, claim: 1, peer: 1, fix: 1, extra: 1, face: 1, total: 7 });

  // Trang Lương đọc: payroll_requests (khoá web, mọi dòng), ?checkin=1 (sửa giờ, ngoài ca), ?faces=1, ?claims=1, ?peer=1.
  const [checkin, faces, claims, peers] = await Promise.all(['checkin=1', 'faces=1', 'claims=1', 'peer=1'].map(q => get(wf, q)));
  const tab = pendingRequestCounts({ requests: state.payroll_requests, fixes: checkin.body.fixes, extras: checkin.body.extras, faceReviews: faces.body.reviews,
    claims: claims.body.claims, peers: peers.body.reports });
  assert.deepEqual(badge.body, tab);

  // Chủ bỏ qua báo lỗi → số trên ví giảm theo.
  const r = plain(await wf.POST({ json: async () => ({ action: 'decide_peer', id: '00000000-0000-4000-8000-0000000000e1', status: 'rejected' }), headers: new Map() }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await get(wf, 'pending=1');
  assert.deepEqual([after.body.peer, after.body.total], [0, 6]);
});

test('only the owner gets the count; staff, managers and logged-out tabs do not', async () => {
  const wf = api(shop());
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  for (const user of [AN, BINH]) {
    env.user = user;
    assert.equal((await get(wf, 'pending=1')).status, 403, user.role);
  }
  env.user = null;
  assert.equal((await get(wf, 'pending=1')).status, 401);
});

test('the count still works before the claims, peer-report and face tables exist', async () => {
  const state = { ...shop(), __noTable: ['payroll_expense_claims', 'payroll_peer_reports', 'checkin_face_settings', 'attendance_face_reviews'] };
  const wf = api(state);
  env.now = Date.UTC(2026, 10, 8, 5, 0);
  env.user = OWNER;
  const r = await get(wf, 'pending=1');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.claim, r.body.peer, r.body.face, r.body.total], [0, 0, 0, 4]);
});

test('the tab and the menu both use the shared count', () => {
  const page = read('../src/app/admin/payroll/page.js');
  const layout = read('../src/app/admin/layout.js');
  assert.match(page, /badge: reqPending\.total/, 'nút tab Yêu cầu dùng pendingRequestCounts');
  assert.match(page, /pendingRequestCounts\(\{ requests, fixes: checkin\?\.fixes, extras: checkin\?\.extras, faceReviews: faces\?\.reviews, claims: claims\.claims, peers: peers\.reports \}\)/);
  assert.match(layout, /usePayrollPending\(user\?\.role === 'admin'\)/, 'chỉ chủ quán thấy số trên ví');
  assert.match(layout, /walletHref\(payrollPending\)/);
});
