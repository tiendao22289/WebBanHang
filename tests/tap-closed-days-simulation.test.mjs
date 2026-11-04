// Giả lập tháng 11/2026 qua đúng code máy chủ: người không có điện thoại chấm công bằng nút trên máy quầy, quán nghỉ
// theo âm lịch (mùng 1 = 9/11, rằm = 23/11 nhưng chủ bấm "Mở cửa"), ngày nghỉ thêm tay 30/11, người theo giờ được bật
// lương ngày nghỉ giữa tháng; chốt lương 1/12 rồi so từng phiếu và tiền từng ngày Sổ thu chi với số tính tay.
// Quán 14:00 → 00:00, cho lệch 10 phút; lương 7.800.000đ = 300.000đ/ngày = 500đ/phút; tăng ca 30.000đ/giờ.
//   An    — lương tháng, quét mã bằng điện thoại.
//   Bình  — lương tháng, không có điện thoại: bấm nút "Chú Bình" trên máy quầy (trễ 20 phút 1 lần, vào sớm 30 phút 1 lần).
//   Cường — theo giờ 30.000đ, mặc định không có lương ngày nghỉ; chủ bật "có lương" ngày 25/11.
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
import { punctuality } from '../src/lib/clockMessages.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const SECRET = 'service-role-test-key'.repeat(2);
const SHOP_IP = '113.161.1.2';
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n, name, role = 'staff') => ({ id: uid(n), full_name: name, role, phone: `ph_${name.toLowerCase()}`.padEnd(24, 'x'), created_at: '2026-10-01T00:00:00Z' });
const OWNER = person(1, 'Chu', 'admin');
const AN = person(2, 'An'), BINH = person(3, 'Binh'), CUONG = person(4, 'Cuong');
const STAFF = [AN, BINH, CUONG];
const T = (day, hm) => { const next = hm.endsWith('+1') ? 1 : 0; const [h, m] = hm.replace('+1', '').split(':').map(Number); return Date.UTC(2026, 10, day + next, h - 7, m); };

const strip = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const env = { now: 0, user: null };
function compile(file, state) {
  class FixedDate extends Date {
    constructor(...a) { super(...(a.length ? a : [env.now])); }
    static now() { return env.now; }
  }
  const NextResponse = { json: (body, init = {}) => {
    const res = { status: init.status || 200, body };
    Object.defineProperty(res, 'cookies', { value: { set: (k, v) => { res.setCookies = { ...res.setCookies, [k]: v }; } }, enumerable: false });
    return res;
  } };
  return vm.runInNewContext(`${strip(file)}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, punctuality, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
    Date: FixedDate, STATUS_COOKIE: 'local_admin_session',
    kioskQrToken: (s, id) => token.kioskQrToken(s, id, env.now),
    readKioskQrToken: (t, s) => token.readKioskQrToken(t, s, env.now),
    readKioskCookie: (v, s) => token.readKioskCookie(v, s, env.now),
    onKioskNetwork: (ip, k) => rules.onKioskNetwork(ip, k, env.now),
    rememberIp: (list, ip) => rules.rememberIp(list, ip, env.now),
    closeForgottenSessions: (db, r, id) => rules.closeForgottenSessions(db, r, id, env.now),
    nowMs: () => env.now, refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true, checkedAt: null, source: 'test' }),
    console: { error: (...a) => { if (process.env.SIM_DEBUG) console.error(...a); } }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: SECRET } },
    getStaffSession: async () => (env.user ? { code: 200, user: env.user } : { code: 401 }),
    staffDatabase: () => fakeDb(state), statusDatabase: () => fakeDb(state),
  });
}

test('a month with kiosk buttons and lunar closed days: every slip and every day of the finance book match the hand count', async () => {
  const state = {
    staff: [OWNER, ...STAFF].map(({ phone, ...p }) => p),
    payroll_config: STAFF.map(p => ({ staff_id: p.id, base_salary: p === CUONG ? 0 : 7800000, overtime_rate: 30000 })),
    checkin_settings: [{ id: 1, enforce: true, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_late_rules: [{ scope: 'shop', valid_from: '2026-11-04', allowed_minutes: 10, per_minute: true, fixed_amount: 50000, use_shop: false }],
    // Như migration payroll_closed_rules.sql: nghỉ mùng 1 và rằm âm lịch từ 1/11.
    shop_closed_rules: [{ valid_from: '2026-11-01', lunar_days: [1, 15] }],
    shop_closed_days: [], payroll_holiday_pay: [], checkin_tap_staff: [], staff_departures: [],
    __clock: () => env.now,
  };
  const api = compile('../src/app/api/admin/workforce/route.js', state);
  const kioskApi = compile('../src/app/api/checkin/kiosk/route.js', state);
  const plain = v => JSON.parse(JSON.stringify(v));
  const as = (user, time) => { env.user = user; env.now = time; };
  const ownerPost = async (time, body) => { as(OWNER, time); const r = plain(await api.POST({ json: async () => body, headers: new Map() })); assert.equal(r.status, 200, `${body.action}: ${r.body.error}`); return r; };
  const ownerGet = async (time, query) => { as(OWNER, time); return plain(await api.GET({ url: `http://x/api/admin/workforce?${query}` })).body; };
  as(OWNER, T(1, '08:00'));
  const activated = await kioskApi.POST({ json: async () => ({ action: 'activate', name: 'Quầy' }), headers: new Map([['cf-connecting-ip', SHOP_IP]]), url: 'https://x' });
  const kioskCookie = activated.setCookies[token.KIOSK_COOKIE];
  const kioskReq = (body, cookie = kioskCookie) => ({ json: async () => body, url: 'https://x/api/checkin/kiosk', headers: new Map([['cf-connecting-ip', SHOP_IP]]),
    cookies: { get: k => (k === token.KIOSK_COOKIE && cookie ? { value: cookie } : undefined) } });
  const qr = async time => { as(null, time); return plain(await kioskApi.GET(kioskReq(null))).body.token; };
  const failed = [];
  const scan = async (p, time) => {
    const t = await qr(time);
    as(p, time);
    const r = plain(await api.POST({ json: async () => ({ action: 'clock', token: t }), headers: new Map([['cf-connecting-ip', SHOP_IP]]),
      cookies: { get: k => (k === token.DEVICE_COOKIE ? { value: p.phone } : undefined) } }));
    if (r.status !== 200) failed.push([p.full_name, new Date(time).toISOString(), r.body.error]);
  };
  // Bình bấm nút tên trên máy quầy: máy quầy hỏi trạng thái rồi gửi đúng chiều đang hiện.
  const tap = async (p, time) => {
    as(null, time);
    const open = plain(await kioskApi.GET(kioskReq(null))).body.tap.open.includes(p.id);
    const r = plain(await kioskApi.POST(kioskReq({ action: 'tap_clock', staff_id: p.id, expect: open ? 'out' : 'in' })));
    if (r.status !== 200) failed.push([p.full_name, new Date(time).toISOString(), r.body.error]);
  };
  const events = [];
  const add = (time, fn) => events.push({ time, fn });
  const work = (fn, p, day, a, b) => { add(T(day, a), () => fn(p, T(day, a))); add(T(day, b), () => fn(p, T(day, b))); };

  add(T(1, '09:00'), () => ownerPost(T(1, '09:00'), { action: 'save_tap_staff', staff_id: BINH.id, enabled: true, label: 'Chú Bình' }));
  add(T(1, '09:01'), () => ownerPost(T(1, '09:01'), { action: 'save_hourly', staff_id: CUONG.id, hourly_rate: '30.000', valid_from: '2026-11-01' }));
  add(T(20, '09:00'), () => ownerPost(T(20, '09:00'), { action: 'skip_closed_day', day: '2026-11-23' }));     // rằm tháng 10: quán vẫn mở
  add(T(25, '09:00'), () => ownerPost(T(25, '09:00'), { action: 'save_closed_day', day: '2026-11-30', note: 'sửa bếp' }));
  add(T(25, '09:01'), () => ownerPost(T(25, '09:01'), { action: 'save_holiday_pay', staff_id: CUONG.id, paid: true }));

  for (const d of [8, 10, 23, 24]) work(scan, AN, d, '14:00', '00:00+1');
  work(tap, BINH, 8, '14:05', '00:00+1');   // trễ 5 phút: trong 10 phút cho phép
  work(tap, BINH, 10, '14:20', '00:00+1');  // trễ 20 phút: 50.000 + 20 × 500
  work(tap, BINH, 24, '13:30', '00:00+1');  // vào sớm 30 phút: tăng ca 15.000
  for (const d of [8, 10]) work(scan, CUONG, d, '14:00', '00:00+1');
  for (const d of [8, 9, 10, 23, 24, 30]) add(T(d, '04:00+1'), () => qr(T(d, '04:00+1')));
  events.sort((a, b) => a.time - b.time);
  for (const e of events) await e.fn();
  assert.deepEqual(failed, []);

  // Bình chấm 6 lượt, đều bằng nút ở máy quầy; An / Cường quét mã. Từ ngoài máy quầy hay người chưa được phép thì không bấm được.
  assert.deepEqual(state.checkin_scans.filter(s => s.staff_id === BINH.id).map(s => s.method), Array(6).fill('tap'));
  assert.ok(state.checkin_scans.filter(s => s.staff_id !== BINH.id).every(s => !s.method));
  as(null, T(26, '15:00'));
  assert.equal(plain(await kioskApi.POST(kioskReq({ action: 'tap_clock', staff_id: AN.id, expect: 'in' }))).status, 403);
  assert.equal(plain(await kioskApi.POST(kioskReq({ action: 'tap_clock', staff_id: BINH.id, expect: 'in' }, null))).status, 401);

  // Giữa tháng (25/11): ngày nghỉ chưa tới chưa tính — lương tạm tính của An có 9/11, chưa có 30/11.
  as(AN, T(25, '12:00'));
  const mid = plain(await api.GET({ url: 'http://x/api/admin/workforce?me=1' })).body.salary;
  assert.deepEqual([mid.holidayDays, mid.dayUnits], [1, 5], '9/11 paid, 23/11 the shop was open, 30/11 not yet');

  const DEC1 = Date.UTC(2026, 11, 1, 2, 0);
  assert.equal((await ownerPost(DEC1, { action: 'close_month', year: 2026, month: 11 })).body.closed, 3);
  const slip = p => state.payroll_closes.find(c => c.staff_id === p.id).snapshot;
  const show = s => ({ dayUnits: s.dayUnits, holidayDays: s.holidayDays, basePay: s.basePay, lateAmt: s.lateAmt, otAmt: s.otAmt, net: s.net });
  // An: 4 ngày làm + 9/11 và 30/11 quán nghỉ = 6 × 300.000.
  assert.deepEqual(show(slip(AN)), { dayUnits: 6, holidayDays: 2, basePay: 1800000, lateAmt: 0, otAmt: 0, net: 1800000 });
  // Bình: 3 ngày làm + 2 ngày nghỉ = 5 ngày = 1.500.000; trễ 20 phút ngày 10 = 60.000; vào sớm 30 phút = 15.000.
  assert.deepEqual(show(slip(BINH)), { dayUnits: 5, holidayDays: 2, basePay: 1500000, lateAmt: 60000, otAmt: 15000, net: 1455000 });
  // Cường: 2 ngày × 600 phút + 2 ngày nghỉ (bật có lương) × 600 phút = 2.400 phút × 500đ.
  assert.deepEqual(show(slip(CUONG)), { dayUnits: 0, holidayDays: 2, basePay: 1200000, lateAmt: 0, otAmt: 0, net: 1200000 });
  assert.deepEqual(slip(CUONG).hourly, { minutes: 2400, amount: 1200000, rates: [30000] });

  // Sổ thu chi: lương từng ngày cả quán, cộng đúng bằng tổng phiếu lương.
  const cost = payroll.payrollCost({ year: 2026, month: 11, ...await payrollMonth.loadPayrollMonth(fakeDb(state), 2026, 11, '2026-12-01') });
  assert.deepEqual(cost.byDay, {
    '2026-11-08': 300000 + 300000 + 300000,
    '2026-11-09': 300000 + 300000 + 300000,
    '2026-11-10': 300000 + 240000 + 300000,
    '2026-11-23': 300000,
    '2026-11-24': 300000 + 315000,
    '2026-11-30': 300000 + 300000 + 300000,
  });
  assert.equal(Object.values(cost.byDay).reduce((a, x) => a + x, 0), 1800000 + 1455000 + 1200000);
  const stats = await ownerGet(DEC1 + 60000, 'stats=1&year=2026&month=11');
  assert.equal(stats.totals.net, 1800000 + 1455000 + 1200000);
});
