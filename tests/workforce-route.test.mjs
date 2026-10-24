import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as pin from '../src/lib/staffPin.mjs';
import * as token from '../src/lib/checkinToken.mjs';
import * as rules from '../src/lib/attendanceRules.mjs';
import * as payroll from '../src/lib/payroll.mjs';
import * as departure from '../src/lib/staffDeparture.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const SECRET = 'service-role-test-key'.repeat(2);
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Phát', role: 'staff' };
const LAN = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Lan', role: 'staff' };
const KIOSK = '00000000-0000-4000-8000-00000000eeee';
const SHOP_IP = '113.161.1.2';

// `now`: chạy route ở một giờ cố định (ca qua nửa đêm, quên ra ca).
function load(state, user, { now } = {}) {
  const NextResponse = { json: (body, init = {}) => {
    const res = { status: init.status || 200, body, cookies: {} };
    Object.defineProperty(res, 'cookies', { value: { set: (k, v) => { res.setCookies = { ...res.setCookies, [k]: v }; } }, enumerable: false });
    return res;
  } };
  const at = now ?? Date.now();
  class FixedDate extends Date {
    constructor(...a) { super(...(a.length ? a : [at])); }
    static now() { return at; }
  }
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...departure, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
    Date: now ? FixedDate : Date,
    readKioskQrToken: (t, s) => token.readKioskQrToken(t, s, at),
    onKioskNetwork: (ip, k) => rules.onKioskNetwork(ip, k, at),
    closeForgottenSessions: (db, c, id) => rules.closeForgottenSessions(db, c, id, at),
    console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: SECRET } },
    getStaffSession: async () => (user ? { code: 200, user } : { code: 401 }), staffDatabase: () => fakeDb(state),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));
const post = async (api, body, headers = new Map()) => plain(await api.POST({ json: async () => body, headers }));
// Yêu cầu từ điện thoại: địa chỉ mạng + cookie nhận diện máy.
const phone = (ip, device) => ({
  headers: new Map([['cf-connecting-ip', ip], ['user-agent', 'Mozilla/5.0 (iPhone)']]),
  cookies: { get: k => (k === token.DEVICE_COOKIE && device ? { value: device } : undefined) },
});
const scan = async (api, qr, ip = SHOP_IP, device = 'D'.repeat(24)) => {
  const r = phone(ip, device);
  const res = await api.POST({ json: async () => ({ action: 'clock', token: qr }), ...r });
  return { ...plain(res), setCookies: res.setCookies };
};
const shop = (extra = {}) => ({
  attendance_sessions: [], checkin_nonces: [], checkin_scans: [], staff_checkin_devices: [], attendance_changes: [],
  checkin_settings: [{ id: 1, enforce: false, closing_time: '23:00' }],
  checkin_kiosks: [{ id: KIOSK, name: 'Quầy', revoked_at: null, recent_ips: [{ ip: SHOP_IP, at: new Date().toISOString() }] }],
  staff: [{ ...STAFF }, { ...LAN }],
  ...extra,
});
const ago = ms => new Date(Date.now() - ms).toISOString();

test('staff clock in only with a fresh QR from a kiosk, and each QR works once', async () => {
  const state = shop();
  const staff = load(state, STAFF);
  assert.equal((await scan(staff, undefined)).status, 403, 'no QR');
  assert.equal((await scan(staff, String(Math.floor(Date.now() / 300000)))).status, 403, 'the old guessable token is refused');
  const forged = token.kioskQrToken('another-secret'.repeat(4), KIOSK);
  assert.equal((await scan(staff, forged)).status, 403, 'a QR not signed by this server is refused');
  assert.equal((await scan(staff, token.kioskQrToken(SECRET, KIOSK, Date.now() - 3 * 60000))).status, 403, 'a QR older than 2 minutes is refused');

  const qr = token.kioskQrToken(SECRET, KIOSK);
  const inRes = await scan(staff, qr);
  assert.deepEqual([inRes.status, inRes.body.clocked], [200, 'in']);
  assert.ok(inRes.setCookies === undefined, 'phone already had a device cookie');
  assert.equal((await scan(load(state, LAN), qr, SHOP_IP, 'L'.repeat(24))).status, 409, 'a photo of the same QR sent to a friend does not work');
  assert.equal(state.attendance_sessions.length, 1);
  assert.deepEqual(plain(state.checkin_scans.map(s => [s.action, s.warnings])), [['in', []]]);
  assert.equal(state.staff_checkin_devices[0].device_id, 'D'.repeat(24), 'first clock registers the phone');

  const again = await scan(staff, token.kioskQrToken(SECRET, KIOSK));
  assert.equal(again.status, 409, 'scanning twice in a row does not clock out at once');
  assert.match(again.body.error, /vừa vào ca/);
  state.attendance_sessions[0].clock_in = ago(4 * 3600000);
  const out = await scan(staff, token.kioskQrToken(SECRET, KIOSK));
  assert.deepEqual([out.status, out.body.clocked], [200, 'out']);

  state.checkin_kiosks[0].revoked_at = new Date().toISOString();
  state.attendance_sessions[0].clock_out = ago(3600000);
  assert.equal((await scan(staff, token.kioskQrToken(SECRET, KIOSK))).status, 403, 'a switched-off kiosk no longer works');
});

test('trial mode only records other wifi and other phones; enforce mode blocks them', async () => {
  const state = shop({ staff_checkin_devices: [{ staff_id: STAFF.id, device_id: 'D'.repeat(24) }] });
  const staff = load(state, STAFF);
  const home = await scan(staff, token.kioskQrToken(SECRET, KIOSK), '14.0.0.9');
  assert.deepEqual([home.status, home.body.warnings], [200, ['other_network']]);

  state.checkin_settings[0].enforce = true;
  state.attendance_sessions[0].clock_in = ago(3600000);
  const qr = token.kioskQrToken(SECRET, KIOSK);
  const blocked = await scan(staff, qr, '14.0.0.9');
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /wifi quán/);
  assert.equal(state.checkin_nonces.length, 1, 'a blocked try does not use up the QR');
  assert.equal((await scan(staff, qr, SHOP_IP, 'X'.repeat(24))).status, 403, 'another phone is refused');
  const lanOnStaffPhone = await scan(load(state, LAN), qr, SHOP_IP, 'D'.repeat(24));
  assert.equal(lanOnStaffPhone.status, 403, 'logging a friend in on your phone to clock for them is refused');
  assert.match(lanOnStaffPhone.body.error, /người khác/);
  const ok = await scan(staff, qr, SHOP_IP, 'D'.repeat(24));
  assert.deepEqual([ok.status, ok.body.clocked], [200, 'out'], 'the same QR still works from the right phone on shop wifi');
  assert.deepEqual(plain(state.checkin_scans.map(s => s.action)), ['in', 'blocked', 'blocked', 'blocked', 'out']);

  // IPv6: mỗi máy trong nhà một địa chỉ riêng nhưng chung dải /64.
  state.checkin_kiosks[0].recent_ips = [{ ip: '2405:4802:1:2::a', at: new Date().toISOString() }];
  state.attendance_sessions.forEach(s => { s.clock_out = ago(3600000); });
  assert.equal((await scan(staff, token.kioskQrToken(SECRET, KIOSK), '2405:4802:1:2:abcd::9')).status, 200);
});

test('a new phone gets a device cookie and admins can let staff change phones', async () => {
  const state = shop();
  const first = await scan(load(state, STAFF), token.kioskQrToken(SECRET, KIOSK), SHOP_IP, null);
  assert.equal(first.status, 200);
  const cookie = first.setCookies?.[token.DEVICE_COOKIE];
  assert.ok(token.validDeviceId(cookie));
  assert.equal(state.staff_checkin_devices[0].device_id, cookie);
  assert.equal((await post(load(state, STAFF), { action: 'reset_device', staff_id: STAFF.id })).status, 403);
  assert.equal((await post(load(state, ADMIN), { action: 'reset_device', staff_id: STAFF.id })).status, 200);
  assert.equal(state.staff_checkin_devices.length, 0);
});

test('admins clock without a QR but it is recorded', async () => {
  const state = shop();
  const r = await post(load(state, ADMIN), { action: 'clock' });
  assert.deepEqual([r.status, r.body.clocked], [200, 'in']);
  assert.deepEqual(plain(state.checkin_scans[0].warnings), ['admin_no_qr']);
});

test('a shift past midnight is closed by the next scan, a forgotten one is closed at closing time', async () => {
  // 00:30 ngày 25/10 giờ VN; vào ca 20:00 ngày 24 → ra ca bình thường, không tạo ca mới.
  const now = Date.parse('2026-10-24T17:30:00Z');
  const state = shop({ attendance_sessions: [{ id: '00000000-0000-4000-8000-000000000001', staff_id: STAFF.id, date: '2026-10-24', clock_in: '2026-10-24T13:00:00Z', clock_out: null, note: null }] });
  state.checkin_kiosks[0].recent_ips[0].at = new Date(now).toISOString();
  const out = await scan(load(state, STAFF, { now }), token.kioskQrToken(SECRET, KIOSK, now));
  assert.deepEqual([out.status, out.body.clocked], [200, 'out']);
  assert.equal(state.attendance_sessions.length, 1);
  assert.equal(state.attendance_sessions[0].clock_out, new Date(now).toISOString());

  // Quên ra ca hôm 23: chiều 24 quét → ca 23 tự đóng lúc 23:00 VN, rồi vào ca mới.
  const later = Date.parse('2026-10-24T09:00:00Z');
  const st2 = shop({ attendance_sessions: [{ id: '00000000-0000-4000-8000-000000000002', staff_id: STAFF.id, date: '2026-10-23', clock_in: '2026-10-23T09:00:00Z', clock_out: null, note: null }] });
  st2.checkin_kiosks[0].recent_ips[0].at = new Date(later).toISOString();
  const r = await scan(load(st2, STAFF, { now: later }), token.kioskQrToken(SECRET, KIOSK, later));
  assert.deepEqual([r.status, r.body.clocked], [200, 'in']);
  assert.equal(st2.attendance_sessions[0].clock_out, '2026-10-23T16:00:00.000Z');
  assert.match(st2.attendance_changes[0].note, /Quên ra ca/);
  const me = JSON.parse(JSON.stringify(await load(st2, STAFF, { now: later }).GET({ url: 'http://x/api/admin/workforce?me=1' })));
  assert.deepEqual(me.body.auto_closed, [st2.attendance_sessions[0].id], 'staff see which shift was closed for them');
  assert.equal(st2.attendance_changes[0].changed_by, rules.AUTO_CLOSE_BY);
  assert.equal(st2.attendance_sessions[1].date, '2026-10-24');
});

test('staff ask to fix their own hours and the owner approves it with a log', async () => {
  const id = '00000000-0000-4000-8000-000000000003';
  const state = shop({ attendance_sessions: [{ id, staff_id: STAFF.id, date: '2026-10-23', clock_in: '2026-10-23T09:00:00.000Z', clock_out: '2026-10-23T16:00:00.000Z', note: 'Quên ra ca — máy tự tính ra ca lúc 23:00' }], attendance_fix_requests: [] });
  const staff = load(state, STAFF);
  assert.equal((await post(load(state, LAN), { action: 'request_fix', attendance_id: id, clock_out: '2026-10-23T16:45:00.000Z', reason: 'x' })).status, 404, 'not your shift');
  assert.equal((await post(staff, { action: 'request_fix', attendance_id: id, clock_out: '2026-10-23T08:00:00.000Z', reason: 'x' })).status, 400, 'out before in');
  assert.equal((await post(staff, { action: 'request_fix', attendance_id: id, clock_out: '2026-10-23T16:45:00.000Z', reason: 'dọn quán tới 23:45' })).status, 200);
  assert.equal((await post(staff, { action: 'request_fix', attendance_id: id, clock_out: '2026-10-23T16:50:00.000Z', reason: 'lại' })).status, 409, 'one pending request per shift');
  const fix = state.attendance_fix_requests[0];
  assert.equal((await post(staff, { action: 'decide_fix', id: fix.id, status: 'approved' })).status, 403);
  assert.equal(state.attendance_sessions[0].clock_out, '2026-10-23T16:00:00.000Z', 'nothing changes before the owner approves');
  assert.equal((await post(load(state, ADMIN), { action: 'decide_fix', id: fix.id, status: 'approved' })).status, 200);
  assert.equal(state.attendance_sessions[0].clock_out, '2026-10-23T16:45:00.000Z');
  assert.equal(state.attendance_fix_requests[0].status, 'approved');
  assert.match(state.attendance_changes.at(-1).changed_by, /duyệt đơn/);
  assert.equal((await post(load(state, ADMIN), { action: 'decide_fix', id: fix.id, status: 'rejected' })).status, 409, 'cannot decide twice');
});

test('only admins see the kiosk page data and change check-in settings', async () => {
  const state = shop();
  assert.equal(plain(await load(state, STAFF).GET({ url: 'http://x/api/admin/workforce?checkin=1' })).status, 403);
  const me = plain(await load(state, STAFF).GET({ url: 'http://x/api/admin/workforce?me=1' }));
  assert.deepEqual([me.status, me.body.open, rules.hoursOn(me.body.rules, '2026-10-25').closing, 'enforce' in me.body.rules], [200, null, '23:00', false], 'staff are not told whether blocking is on');
  for (const body of [{ action: 'save_checkin_settings', enforce: true }, { action: 'revoke_kiosk', id: KIOSK }]) {
    assert.equal((await post(load(state, STAFF), body)).status, 403, body.action);
  }
  const admin = load(state, ADMIN);
  assert.equal((await post(admin, { action: 'save_checkin_settings', closing_time: '25:00' })).status, 400);
  assert.equal((await post(admin, { action: 'save_checkin_settings', grace_minutes: 90 })).status, 400);
  assert.equal((await post(admin, { action: 'save_checkin_settings', opening_time: '23:00' })).status, 400, 'opening and closing cannot be the same');
  const saved = await post(admin, { action: 'save_checkin_settings', enforce: true, opening_time: '15:00', closing_time: '00:30', grace_minutes: 5 });
  const s = saved.body.settings;
  const nowHours = rules.hoursOn(s, new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10));
  assert.deepEqual([s.enforce, nowHours.opening, nowHours.closing, nowHours.grace], [true, '15:00', '00:30', 5]);
  assert.deepEqual(plain(state.checkin_hours.map(h => h.valid_from)), [new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10)], 'new hours start today; older days keep the old hours');
  const overview = plain(await admin.GET({ url: 'http://x/api/admin/workforce?checkin=1' }));
  assert.deepEqual([overview.status, overview.body.kiosks.length], [200, 1]);
});

test('outside-shift time waits for the owner, and changing the hours asks again', async () => {
  const id = '00000000-0000-4000-8000-000000000004';
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const at = hm => new Date(`${today}T${hm}:00+07:00`).toISOString();
  const state = shop({ attendance_sessions: [{ id, staff_id: STAFF.id, date: today, clock_in: at('13:10'), clock_out: at('23:45') }], attendance_extra_reviews: [] });
  state.checkin_settings[0] = { id: 1, enforce: false, hours_from: today };
  state.checkin_hours = [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }];
  const admin = load(state, ADMIN);
  const overview = async () => plain(await admin.GET({ url: 'http://x/api/admin/workforce?checkin=1' })).body;
  assert.deepEqual((await overview()).extras.map(x => [x.attendance_id, x.early_minutes, x.stay_minutes]), [[id, 50, 45]]);
  assert.equal((await post(load(state, STAFF), { action: 'decide_extra', attendance_id: id, status: 'approved' })).status, 403);
  const ok = await post(admin, { action: 'decide_extra', attendance_id: id, status: 'approved' });
  assert.deepEqual([ok.status, ok.body.minutes], [200, 95]);
  const after = await overview();
  assert.deepEqual([after.extras.length, after.reviews[0].status, after.reviews[0].minutes], [0, 'approved', 95]);
  const me = plain(await load(state, STAFF).GET({ url: 'http://x/api/admin/workforce?me=1' })).body;
  assert.deepEqual(me.reviews.map(r => r.minutes), [95], 'staff see that it was counted');

  await post(admin, { action: 'edit_attendance', id, clock_in: at('13:30'), clock_out: at('23:45') });
  assert.equal(state.attendance_extra_reviews.length, 0);
  assert.deepEqual((await overview()).extras.map(x => [x.early_minutes, x.stay_minutes]), [[30, 45]]);
  await post(admin, { action: 'decide_extra', attendance_id: id, status: 'rejected' });
  assert.deepEqual(plain(state.attendance_extra_reviews.map(r => [r.status, r.minutes])), [['rejected', 0]]);
});

test('owner sets a shift per person from today, or goes back to the shop hours', async () => {
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  // Ca riêng từ trước: ngày cũ giữ ca đó.
  const state = shop({ staff_shifts: [{ staff_id: STAFF.id, valid_from: '2026-01-01', start_time: '16:00', end_time: '23:00' }] });
  assert.equal((await post(load(state, STAFF), { action: 'save_shift', staff_id: STAFF.id, start_time: '17:00', end_time: '23:00' })).status, 403);
  const admin = load(state, ADMIN);
  assert.equal((await post(admin, { action: 'save_shift', staff_id: STAFF.id, start_time: '17:00', end_time: '17:00' })).status, 400);
  assert.equal((await post(admin, { action: 'save_shift', staff_id: STAFF.id, start_time: '17:00', end_time: '23:00' })).status, 200);
  assert.equal((await post(admin, { action: 'save_shift', staff_id: STAFF.id, start_time: '18:00', end_time: '01:00' })).status, 200, 'changing again today replaces today\'s row');
  assert.deepEqual(plain(state.staff_shifts.map(s => [s.valid_from, s.start_time, s.end_time])), [['2026-01-01', '16:00', '23:00'], [today, '18:00', '01:00']]);
  const me = plain(await load(state, STAFF).GET({ url: 'http://x/api/admin/workforce?me=1' })).body;
  assert.deepEqual([rules.shiftOf(me.rules, STAFF.id, today).start, rules.shiftOf(me.rules, STAFF.id, '2026-06-01').start], ['18:00', '16:00']);
  const lan = plain(await load(state, LAN).GET({ url: 'http://x/api/admin/workforce?me=1' })).body;
  assert.deepEqual(lan.rules.shifts, {}, 'staff only see their own shift');
  assert.equal((await post(admin, { action: 'save_shift', staff_id: STAFF.id, clear: true })).status, 200);
  const after = (await load(state, ADMIN).GET({ url: 'http://x/api/admin/workforce?checkin=1' })).body.settings;
  assert.deepEqual([rules.shiftOf(after, STAFF.id, today).own, rules.shiftOf(after, STAFF.id, '2026-06-01').start], [false, '16:00'], 'from today back to the shop hours');
});

test('closing a month saves each person\'s salary; closing again replaces it; reopening clears it', async () => {
  const state = shop({
    payroll_config: [{ staff_id: STAFF.id, base_salary: 5200000, overtime_rate: 30000 }],
    attendance_sessions: [{ id: 's1', staff_id: STAFF.id, date: '2026-11-02', clock_in: '2026-11-02T07:00:00Z', clock_out: '2026-11-02T16:00:00Z' }],
    payroll_requests: [], payroll_violations: [], attendance_extra_reviews: [], payroll_closes: [],
  });
  state.checkin_settings[0] = { id: 1, enforce: false, hours_from: '2026-10-25' };
  assert.equal((await post(load(state, STAFF), { action: 'close_month', year: 2026, month: 11 })).status, 403);
  const admin = load(state, ADMIN);
  assert.equal((await post(admin, { action: 'close_month', year: 2026, month: 13 })).status, 400);
  const r = await post(admin, { action: 'close_month', year: 2026, month: 11 });
  assert.deepEqual([r.status, r.body.closed], [200, 1], 'only people with salary data are saved');
  const snap = state.payroll_closes[0].snapshot;
  assert.deepEqual([snap.name, snap.rule, snap.workUnits, snap.basePay, snap.net], ['Phát', 'days', 1, 200000, 200000]);
  assert.equal(state.payroll_closes[0].closed_by, 'Chủ quán');
  assert.equal(plain(await admin.GET({ url: 'http://x/api/admin/workforce?payroll=1&year=2026&month=11' })).body.closes.length, 1);
  assert.equal(plain(await load(state, STAFF).GET({ url: 'http://x/api/admin/workforce?payroll=1&year=2026&month=11' })).status, 403);
  await post(admin, { action: 'close_month', year: 2026, month: 11 });
  assert.equal(state.payroll_closes.length, 1);
  assert.equal((await post(admin, { action: 'reopen_month', year: 2026, month: 11 })).status, 200);
  assert.equal(state.payroll_closes.length, 0);
});

test('a leave request carries its dates and belongs to the month of those dates', async () => {
  const state = { payroll_requests: [], payroll_leave_days: [] };
  const staff = load(state, STAFF);
  const monthAfter = n => { const d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
  const ym = monthAfter(1), ym2 = monthAfter(2);
  const ask = body => post(staff, { action: 'request', type: 'absent', reason: 'về quê', ...body });
  assert.equal((await ask({})).status, 400, 'dates are required');
  assert.equal((await ask({ from_date: `${ym}-03`, to_date: `${ym}-02` })).status, 400, 'to before from');
  assert.equal((await ask({ from_date: '2026-02-30', to_date: '2026-02-30' })).status, 400, 'not a real date');
  assert.equal((await ask({ from_date: `${ym}-28`, to_date: `${ym2}-01` })).status, 400, 'one request per month');
  assert.equal((await ask({ from_date: `${ym}-02`, to_date: `${ym}-03` })).status, 200);
  const req = state.payroll_requests[0];
  assert.deepEqual([req.request_type, req.days, req.month, req.year], ['absent', 2, Number(ym.slice(5)), Number(ym.slice(0, 4))]);
  assert.deepEqual(plain(state.payroll_leave_days.map(l => [l.request_id, l.staff_id, l.from_date, l.to_date])), [[req.id, STAFF.id, `${ym}-02`, `${ym}-03`]]);
  const me = plain(await staff.GET({ url: 'http://x/api/admin/workforce?me=1' })).body;
  assert.equal(me.leave_days.length, 1);
});

test('staff cancel their own pending requests, but not approved ones or someone else\'s', async () => {
  const fixId = '00000000-0000-4000-8000-0000000000f1';
  const state = { payroll_requests: [], payroll_leave_days: [],
    attendance_fix_requests: [{ id: fixId, staff_id: STAFF.id, attendance_id: 'x', reason: 'quên', status: 'pending' }] };
  const staff = load(state, STAFF);
  const d = new Date(Date.now() + 7 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const ym = d.toISOString().slice(0, 7);
  await post(staff, { action: 'request', type: 'advance', amount: '300.000', reason: 'ứng' });
  await post(staff, { action: 'request', type: 'absent', from_date: `${ym}-05`, to_date: `${ym}-05`, reason: 'ốm' });
  const [advance, leave] = state.payroll_requests;
  assert.equal((await post(load(state, LAN), { action: 'cancel_request', id: advance.id })).status, 404, 'not your request');
  assert.equal((await post(staff, { action: 'cancel_request', id: leave.id })).status, 200);
  assert.deepEqual([state.payroll_requests.length, state.payroll_leave_days.length], [1, 0], 'the leave dates go too');
  state.payroll_requests[0].status = 'approved';
  assert.equal((await post(staff, { action: 'cancel_request', id: advance.id })).status, 409, 'approved requests stay');
  assert.equal((await post(staff, { action: 'cancel_request', id: fixId, kind: 'fix' })).status, 200);
  assert.equal(state.attendance_fix_requests.length, 0);
});

test('the same request sent twice in a row (a double tap) is saved once', async () => {
  const state = { payroll_requests: [] };
  const staff = load(state, STAFF);
  const body = { action: 'request', type: 'advance', amount: '300.000', reason: 'ứng' };
  const a = await post(staff, body), b = await post(staff, body);
  assert.deepEqual([a.status, b.status, b.body.duplicate], [200, 200, true]);
  assert.equal(state.payroll_requests.length, 1);
  assert.equal((await post(staff, { ...body, amount: '500.000' })).status, 200);
  assert.equal(state.payroll_requests.length, 2, 'a different amount is a new request');
});

test('staff see only their own salary for this month, or the closed numbers once the owner closes it', async () => {
  const now = new Date(Date.now() + 7 * 3600000), year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;
  const date = `${year}-${String(month).padStart(2, '0')}-01`;
  const state = shop({
    payroll_config: [{ staff_id: STAFF.id, base_salary: 5200000, overtime_rate: 30000 }, { staff_id: LAN.id, base_salary: 9900000 }],
    attendance_sessions: [{ id: 's1', staff_id: STAFF.id, date, clock_in: `${date}T07:00:00Z`, clock_out: `${date}T16:00:00Z` }],
    payroll_requests: [{ id: 'r1', staff_id: STAFF.id, request_type: 'advance', amount: 100000, status: 'approved', month, year }],
    payroll_violations: [{ staff_id: STAFF.id, amount: 20000, reason: 'đi trễ', month, year }, { staff_id: LAN.id, amount: 70000, reason: 'x', month, year }],
    payroll_closes: [],
  });
  const me = plain(await load(state, STAFF).GET({ url: 'http://x/api/admin/workforce?me=1' })).body;
  assert.equal(me.salary.locked, false);
  assert.deepEqual([me.salary.base, me.salary.advAmt, me.salary.vioAmt, me.salary.year, me.salary.month], [5200000, 100000, 20000, year, month]);
  assert.equal(me.salary.net, me.salary.basePay + me.salary.otAmt - 100000 - 20000 - me.salary.absAmt);
  assert.deepEqual(me.violations, [{ amount: 20000, reason: 'đi trễ' }], 'only their own fines');

  state.payroll_closes.push({ year, month, staff_id: STAFF.id, snapshot: { name: 'Phát', net: 123456, rule: 'days' }, closed_at: '2026-11-30T12:00:00Z' });
  const closed = plain(await load(state, STAFF).GET({ url: 'http://x/api/admin/workforce?me=1' })).body.salary;
  assert.deepEqual([closed.locked, closed.net, closed.name], [true, 123456, undefined]);
});

test('a fix request keeps only the times the staff actually changed', async () => {
  const id = '00000000-0000-4000-8000-000000000005';
  const state = shop({ attendance_sessions: [{ id, staff_id: STAFF.id, date: '2026-10-23', clock_in: '2026-10-23T07:05:00.000Z', clock_out: '2026-10-23T16:00:00.000Z' }], attendance_fix_requests: [] });
  const staff = load(state, STAFF);
  assert.equal((await post(staff, { action: 'request_fix', attendance_id: id, clock_in: '2026-10-23T07:05:00.000Z', clock_out: '2026-10-23T16:00:00.000Z', reason: 'x' })).status, 400, 'nothing changed');
  assert.equal((await post(staff, { action: 'request_fix', attendance_id: id, clock_in: '2026-10-23T07:05:00.000Z', clock_out: '2026-10-23T16:30:00.000Z', reason: 'dọn quán' })).status, 200);
  assert.deepEqual([state.attendance_fix_requests[0].clock_in, state.attendance_fix_requests[0].clock_out], [null, '2026-10-23T16:30:00.000Z']);
});

test('the overtime rate can be 0; left empty it is 25.000đ', async () => {
  const state = { payroll_config: [] };
  const admin = load(state, ADMIN);
  await post(admin, { action: 'save_config', staff_id: STAFF.id, base_salary: '5.000.000', overtime_rate: 0 });
  assert.deepEqual([state.payroll_config[0].base_salary, state.payroll_config[0].overtime_rate], [5000000, 0]);
  await post(admin, { action: 'save_config', staff_id: STAFF.id, base_salary: '5.000.000', overtime_rate: '' });
  assert.equal(state.payroll_config[0].overtime_rate, 25000);
});

test('only admins change salary, fines, approvals and accounts', async () => {
  const state = { payroll_requests: [], payroll_config: [], payroll_violations: [], staff: [{ ...ADMIN, pin: 'x' }, { ...STAFF, pin: 'y' }] };
  const staff = load(state, STAFF);
  for (const body of [
    { action: 'save_config', staff_id: STAFF.id, base_salary: 99000000 },
    { action: 'add_violation', staff_id: STAFF.id, amount: 1, reason: 'x', month: 10, year: 2026 },
    { action: 'set_pin', staff_id: ADMIN.id, pin: '1111' },
    { action: 'create_account', full_name: 'X', phone: '0900000000', pin: '1234', role: 'admin' },
    { action: 'delete_account', staff_id: ADMIN.id },
  ]) assert.equal((await post(staff, body)).status, 403, body.action);
  assert.equal((await post(staff, { action: 'request', type: 'advance', amount: '500.000', reason: 'ứng' })).status, 200);
  const req = state.payroll_requests[0];
  assert.deepEqual([req.staff_id, req.amount, req.status], [STAFF.id, 500000, 'pending']);
  assert.equal((await post(staff, { action: 'decide_request', id: req.id, status: 'approved' })).status, 403);
  assert.equal((await post(load(state, ADMIN), { action: 'decide_request', id: req.id, status: 'approved' })).status, 200);
  assert.equal(state.payroll_requests[0].status, 'approved');
});

test('PINs are stored hashed and plain old PINs can be hashed by the server job', async () => {
  const state = { staff: [{ id: STAFF.id, full_name: 'Phát', phone: '0911111111', role: 'staff', pin: '123456' }] };
  const admin = load(state, ADMIN);
  const created = await post(admin, { action: 'create_account', full_name: 'Lan', phone: '0922222222', pin: '4321', role: 'staff' });
  assert.equal(created.status, 200);
  const lan = state.staff.find(s => s.phone === '0922222222');
  assert.ok(pin.isHashedPin(lan.pin) && pin.pinMatches(lan.pin, lan.id, '4321', SECRET));
  assert.equal((await post(admin, { action: 'create_account', full_name: 'Lan 2', phone: '0922222222', pin: '4321' })).status, 409, 'phone must be unique');
  assert.equal((await post(admin, { action: 'set_pin', staff_id: lan.id, pin: '12' })).status, 400, 'PIN is 4–8 digits');

  const nobody = load(state, null);
  assert.equal((await post(nobody, { action: 'hash_all_pins' })).status, 401);
  const key = createHmac('sha256', SECRET).update('staff-maintenance').digest('hex');
  const r = await post(nobody, { action: 'hash_all_pins' }, new Map([['x-server-key', key]]));
  assert.deepEqual([r.status, r.body.hashed], [200, 1]);
  assert.ok(pin.pinMatches(state.staff[0].pin, STAFF.id, '123456', SECRET));
  assert.equal((await post(admin, { action: 'delete_account', staff_id: ADMIN.id })).status, 400, 'cannot delete yourself');
});

test('admin attendance edits are logged and compared by time, not text', async () => {
  const state = { attendance_sessions: [{ id: '00000000-0000-4000-8000-000000000009', staff_id: STAFF.id, date: '2026-10-23', clock_in: '2026-10-23T01:00:00+00:00', clock_out: null }], attendance_changes: [] };
  const admin = load(state, ADMIN);
  const same = await post(admin, { action: 'edit_attendance', id: state.attendance_sessions[0].id, clock_in: '2026-10-23T01:00:00.000Z', clock_out: null });
  assert.equal(same.body.changed, 0, 'same moment written differently is not a change');
  const r = await post(admin, { action: 'edit_attendance', id: state.attendance_sessions[0].id, clock_in: '2026-10-23T01:00:00.000Z', clock_out: '2026-10-23T09:30:00.000Z' });
  assert.equal(r.body.changed, 1);
  assert.equal(state.attendance_sessions[0].clock_out, '2026-10-23T09:30:00.000Z');
  assert.deepEqual(plain(state.attendance_changes.map(l => [l.field_name, l.changed_by])), [['clock_out', 'Chủ quán']]);
});
