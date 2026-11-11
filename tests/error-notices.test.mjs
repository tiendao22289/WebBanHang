// 🔔 Thông báo lỗi của nhân viên: lần bị báo lỗi chủ đã xử lý (phạt → trừ lương, bỏ qua → nhắc nhở, vẫn lưu) và tháng chốt lương có
// phạt. Nhân viên bấm "Tôi đã xem" → máy chủ ghi giờ một lần; chủ thấy giờ đó trong bảng lương / tab Yêu cầu. Không lộ người báo.
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
import * as notices from '../src/lib/errorNotices.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const { buildNotices, closeNotice, closeNoticeText, peerNotice, peerNoticeText, sortNotices, unseenCount, NOTICES_HREF } = notices;

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../src/app/api/admin/workforce/route.js').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin', created_at: '2026-10-01T00:00:00Z' };
const AN = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Người-Báo-X', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const BINH = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Bình', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const env = { now: 0, user: null };
function api(state) {
  class FixedDate extends Date { constructor(...a) { super(...(a.length ? a : [env.now])); } static now() { return env.now; } }
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, ...roles, ...pending, ...notices,
    createHmac, randomUUID, timingSafeEqual, Buffer, URL, URLSearchParams, Number, Math, String, JSON, Promise,
    Date: FixedDate, nowMs: () => env.now, refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true }),
    closeForgottenSessions: async () => {}, console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) } },
    // Link ảnh làm chứng ký tạm (như kho ảnh thật).
    signReceiptImages: async (db, paths) => Object.fromEntries(paths.filter(Boolean).map(p => [p, `/img/${p}`])),
    getStaffSession: async () => (env.user ? { code: 200, user: env.user } : { code: 401 }), staffDatabase: () => fakeDb(state),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));
const get = async (wf, user, q) => { env.user = user; return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };
const post = async (wf, user, body) => { env.user = user; return plain(await wf.POST({ json: async () => body, headers: new Map() })); };
const at = iso => Date.parse(iso);

test('each handled report becomes one notice: fined, priced later, fine removed, or a warning', () => {
  const rep = { id: 'r1', report_date: '2026-11-07', reason: 'Làm vỡ ly', status: 'approved', violation_id: 'v1', amount: 30000, decided_at: '2026-11-10T03:00:00Z' };
  const fined = peerNotice(rep, { id: 'v1', amount: 50000, month: 11, year: 2026 });
  assert.deepEqual([fined.outcome, fined.amount, fined.month, fined.year], ['fined', 50000, 11, 2026], 'tiền theo khoản phạt hiện tại (chủ sửa sau)');
  assert.equal(peerNoticeText(fined), 'Bị phạt 50.000đ — trừ vào lương tháng 11/2026');
  const later = peerNotice({ ...rep, amount: 0 }, { id: 'v1', amount: 0, month: 11, year: 2026 });
  assert.equal(later.outcome, 'unpriced');
  assert.equal(peerNoticeText(later), 'Chủ quán ghi lỗi — số tiền phạt sẽ định sau');
  const dropped = peerNotice(rep, null);
  assert.deepEqual([dropped.outcome, dropped.amount], ['dropped', 0], 'chủ đã xoá khoản phạt');
  assert.equal(peerNoticeText(dropped), 'Chủ quán đã bỏ khoản phạt — không trừ tiền');
  const warned = peerNotice({ ...rep, status: 'rejected', violation_id: null });
  assert.deepEqual([warned.outcome, warned.amount], ['warn', 0]);
  assert.equal(peerNoticeText(warned), 'Nhắc nhở — không trừ tiền');
  assert.equal(warned.at, '2026-11-10T03:00:00Z');
});

test('a closed month notice lists every fine and the total; no fines, no notice', () => {
  assert.equal(closeNotice({ year: 2026, month: 9 }, []), null);
  const n = closeNotice({ year: 2026, month: 10, closed_at: '2026-11-01T02:00:00Z', fines_seen_at: null }, [
    { id: 'b', date: '2026-10-21', reason: 'Quên lau bàn', amount: '20000', self: true },
    { id: 'a', date: '2026-10-20', reason: 'Làm vỡ ly', amount: 50000, peer: true },
  ]);
  assert.deepEqual([n.count, n.total, n.fines.map(f => f.id)], [2, 70000, ['a', 'b']]);
  assert.equal(closeNoticeText(n), 'Lương tháng 10/2026 đã chốt: 2 lỗi, trừ 70.000đ');
});

test('unseen notices come first, then the newest; the count is what is still unseen', () => {
  const list = sortNotices([
    { key: 'a', at: '2026-11-01T00:00:00Z', seen_at: null },
    { key: 'b', at: '2026-11-09T00:00:00Z', seen_at: '2026-11-09T01:00:00Z' },
    { key: 'c', at: '2026-11-05T00:00:00Z', seen_at: null },
  ]);
  assert.deepEqual(list.map(x => x.key), ['c', 'a', 'b']);
  assert.equal(unseenCount(list), 2);
  assert.equal(unseenCount(null), 0);
  // Lần còn chờ chủ duyệt chưa thành thông báo.
  assert.equal(buildNotices({ reports: [{ id: 'p', status: 'pending', report_date: '2026-11-01' }] }).length, 0);
});

// Bình bị báo 3 lần tháng 11 (một lần còn chờ), 1 lần tháng 10 (đã phạt); tháng 10 đã chốt có 2 lỗi; tháng 9 chốt không lỗi.
const R = n => `00000000-0000-4000-8000-0000000000e${n}`;
function shop() {
  return {
    staff: [OWNER, AN, BINH],
    payroll_config: [{ staff_id: AN.id, base_salary: 6000000, overtime_rate: 30000 }, { staff_id: BINH.id, base_salary: 6000000, overtime_rate: 30000 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }],
    payroll_peer_reports: [
      { id: R(1), reporter_id: AN.id, reporter_name: AN.full_name, staff_id: BINH.id, report_date: '2026-11-07', reason: 'Làm vỡ ly', note: 'ghi-chu-nguoi-bao',
        suggested_amount: 30000, status: 'pending', photo_path: '2026-11/peer-1.jpg', created_at: '2026-11-07T12:00:00Z' },
      { id: R(2), reporter_id: AN.id, reporter_name: AN.full_name, staff_id: BINH.id, report_date: '2026-11-08', reason: 'Để khách chờ lâu', note: 'ghi-chu-nguoi-bao',
        suggested_amount: 0, status: 'pending', created_at: '2026-11-08T12:00:00Z' },
      { id: R(3), reporter_id: AN.id, reporter_name: AN.full_name, staff_id: BINH.id, report_date: '2026-11-09', reason: 'Quên đổ rác', status: 'pending', created_at: '2026-11-09T12:00:00Z' },
      { id: R(4), reporter_id: AN.id, reporter_name: AN.full_name, staff_id: BINH.id, report_date: '2026-10-20', reason: 'Làm vỡ chén', status: 'approved', amount: 50000,
        violation_id: 'v-oct-1', decided_at: '2026-10-21T03:00:00Z', created_at: '2026-10-20T12:00:00Z' },
    ],
    payroll_violations: [
      { id: 'v-oct-1', staff_id: BINH.id, amount: 50000, reason: 'Làm vỡ chén', month: 10, year: 2026, created_at: '2026-10-21T03:00:00Z' },
      { id: 'v-oct-2', staff_id: BINH.id, amount: 20000, reason: 'Quên lau bàn', month: 10, year: 2026, created_at: '2026-10-22T03:00:00Z' },
      { id: 'v-oct-an', staff_id: AN.id, amount: 10000, reason: 'của người khác', month: 10, year: 2026, created_at: '2026-10-22T03:00:00Z' },
    ],
    payroll_violation_meta: [
      { violation_id: 'v-oct-1', staff_id: BINH.id, fine_date: '2026-10-20' },
      { violation_id: 'v-oct-2', staff_id: BINH.id, fine_date: '2026-10-21', self_reported: true },
    ],
    payroll_closes: [
      { year: 2026, month: 10, staff_id: BINH.id, snapshot: { net: 5930000, vioAmt: 70000 }, closed_at: '2026-11-01T02:00:00Z' },
      { year: 2026, month: 9, staff_id: BINH.id, snapshot: { net: 6000000, vioAmt: 0 }, closed_at: '2026-10-01T02:00:00Z' },
      { year: 2026, month: 6, staff_id: BINH.id, snapshot: { net: 6000000, vioAmt: 0 }, closed_at: '2026-07-01T02:00:00Z' },
    ],
  };
}

test('the reported person sees each handled report and the closed month with fines, never who reported', async () => {
  const state = shop();
  const wf = api(state);
  env.now = at('2026-11-10T03:00:00Z');
  const fined = await post(wf, OWNER, { action: 'decide_peer', id: R(1), status: 'approved', amount: 30000 });
  assert.equal(fined.status, 200, JSON.stringify(fined.body));
  env.now = at('2026-11-10T04:00:00Z');
  assert.equal((await post(wf, OWNER, { action: 'decide_peer', id: R(2), status: 'rejected', admin_note: 'lần đầu, nhắc' })).status, 200);

  env.now = at('2026-11-11T05:00:00Z');
  const r = await get(wf, BINH, 'notices=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.ready, true);
  assert.deepEqual(r.body.list.map(n => [n.kind, n.outcome || null, n.date || `${n.month}/${n.year}`]), [
    ['peer', 'warn', '2026-11-08'],
    ['peer', 'fined', '2026-11-07'],
    ['close', null, '10/2026'],
    ['peer', 'fined', '2026-10-20'],
  ], 'lần còn chờ (R3) chưa hiện; tháng 9 chốt không lỗi, tháng 6 quá 100 ngày: không có thông báo');
  const nov = r.body.list[1];
  assert.deepEqual([nov.amount, nov.month, nov.year, nov.photo, nov.seen_at], [30000, 11, 2026, '/img/2026-11/peer-1.jpg', null]);
  const close = r.body.list[2];
  assert.deepEqual([close.count, close.total, close.fines.map(f => [f.reason, f.amount, !!f.peer, !!f.self])],
    [2, 70000, [['Làm vỡ chén', 50000, true, false], ['Quên lau bàn', 20000, false, true]]]);
  assert.equal(r.body.unseen, 4);
  const text = JSON.stringify(r.body);
  for (const secret of [AN.full_name, AN.id, 'ghi-chu-nguoi-bao', 'reporter', 'lần đầu, nhắc', 'của người khác']) assert.ok(!text.includes(secret), `không lộ: ${secret}`);

  // Số đỏ trên thanh menu: chỉ số chưa xem, không ký link ảnh.
  assert.deepEqual((await get(wf, BINH, 'notices=1&count=1')).body, { ready: true, unseen: 4, list: [] });
  // Người báo không có thông báo nào (mình không bị báo).
  assert.deepEqual((await get(wf, AN, 'notices=1&count=1')).body.unseen, 0);
});

test('"Tôi đã xem" is recorded once for the person\'s own notices and the owner sees when', async () => {
  const state = shop();
  const wf = api(state);
  env.now = at('2026-11-10T03:00:00Z');
  await post(wf, OWNER, { action: 'decide_peer', id: R(1), status: 'approved', amount: 30000 });
  await post(wf, OWNER, { action: 'decide_peer', id: R(2), status: 'rejected' });

  env.now = at('2026-11-11T05:00:00Z');
  const first = await post(wf, BINH, { action: 'notice_seen', kind: 'peer', id: R(1) });
  assert.deepEqual([first.status, first.body.seen_at], [200, '2026-11-11T05:00:00.000Z']);
  env.now = at('2026-11-12T08:00:00Z');
  const again = await post(wf, BINH, { action: 'notice_seen', kind: 'peer', id: R(1) });
  assert.deepEqual([again.status, again.body.seen_at], [200, '2026-11-11T05:00:00.000Z'], 'bấm lại không đổi giờ đã xem');
  // Không phải của mình / còn chờ duyệt / tháng không có chốt: không ghi.
  assert.equal((await post(wf, AN, { action: 'notice_seen', kind: 'peer', id: R(2) })).status, 404);
  assert.equal((await post(wf, BINH, { action: 'notice_seen', kind: 'peer', id: R(3) })).status, 404);
  assert.equal((await post(wf, BINH, { action: 'notice_seen', kind: 'close', year: 2026, month: 8 })).status, 404);
  assert.equal((await post(wf, BINH, { action: 'notice_seen', kind: 'close', year: 2026, month: 13 })).status, 400);
  assert.equal((await post(wf, BINH, { action: 'notice_seen', kind: 'other' })).status, 400);
  assert.equal(state.payroll_peer_reports.find(x => x.id === R(2)).seen_at ?? null, null);

  const closeSeen = await post(wf, BINH, { action: 'notice_seen', kind: 'close', year: 2026, month: 10 });
  assert.deepEqual([closeSeen.status, closeSeen.body.seen_at], [200, '2026-11-12T08:00:00.000Z']);
  assert.equal(state.payroll_closes.find(c => c.month === 10).fines_seen_at, '2026-11-12T08:00:00.000Z');
  assert.equal((await get(wf, BINH, 'notices=1&count=1')).body.unseen, 2, 'còn: lần bỏ qua tháng 11 + lần phạt tháng 10');

  // Chủ quán: bảng lương tháng 11 lưu cả lần phạt (đã xem) và lần bỏ qua (chưa xem); tab Yêu cầu cũng có giờ xem.
  const month = (await get(wf, OWNER, 'payroll=1&year=2026&month=11')).body;
  assert.deepEqual(month.peerFines.map(p => [p.reporter, p.seen_at]), [[AN.full_name, '2026-11-11T05:00:00.000Z']]);
  assert.deepEqual(month.peerDismissed.map(p => [p.staff_id, p.date, p.reason, p.reporter, p.seen_at]), [[BINH.id, '2026-11-08', 'Để khách chờ lâu', AN.full_name, null]]);
  const peer = (await get(wf, OWNER, 'peer=1')).body.reports;
  assert.equal(peer.find(p => p.id === R(1)).seen_at, '2026-11-11T05:00:00.000Z');

  // Phiếu lương của nhân viên đánh dấu khoản phạt do bị báo.
  const me = (await get(wf, BINH, 'me=1')).body.violations;
  assert.deepEqual(me.map(v => [v.reason, v.amount, v.peer]), [['Làm vỡ ly', 30000, true]]);

  // Chủ xoá khoản phạt sau đó: thông báo đổi thành "đã bỏ khoản phạt".
  const vid = state.payroll_peer_reports.find(x => x.id === R(1)).violation_id;
  state.payroll_violations = state.payroll_violations.filter(v => v.id !== vid);
  const after = (await get(wf, BINH, 'notices=1')).body.list.find(n => n.id === R(1));
  assert.deepEqual([after.outcome, after.amount, after.seen_at], ['dropped', 0, '2026-11-11T05:00:00.000Z']);
});

test('before the migration runs the notices are hidden and "Tôi đã xem" says the web is updating', async () => {
  const state = { ...shop(), __noTable: ['payroll_peer_reports'] };
  const wf = api(state);
  env.now = at('2026-11-11T05:00:00Z');
  assert.deepEqual((await get(wf, BINH, 'notices=1')).body, { ready: false, unseen: 0, list: [] });
  const st2 = { ...shop(), __noColumn: { payroll_peer_reports: 'seen_at', payroll_closes: 'fines_seen_at' } };
  st2.payroll_peer_reports[0].status = 'rejected';
  const wf2 = api(st2);
  assert.equal((await post(wf2, BINH, { action: 'notice_seen', kind: 'peer', id: R(1) })).status, 503);
  assert.equal((await post(wf2, BINH, { action: 'notice_seen', kind: 'close', year: 2026, month: 10 })).status, 503);
  assert.equal((await get(wf2, null, 'notices=1')).status, 401);
});

test('staff and managers get the 🔔 Thông báo lỗi menu item; the owner does not', () => {
  const layout = read('../src/app/admin/layout.js');
  assert.match(layout, /\{ href: NOTICES_HREF, label: 'Thông báo lỗi', icon: Bell, staffOnly: true \}/);
  assert.match(layout, /usePolledCount\('\/api\/admin\/workforce\?notices=1&count=1', !!user && user\.role !== 'admin'/);
  for (const role of ['staff', 'manager']) assert.equal(roles.canOpenPath(role, NOTICES_HREF), true, role);
});
