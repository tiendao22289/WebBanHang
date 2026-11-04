// Giả lập 4–7/11/2026 qua đúng code máy chủ (máy quầy, quét mã, sửa giờ, chốt lương) với luật đi trễ và giờ
// ngoài ca tự tính, rồi so lương từng người, tiền từng ngày (Sổ thu chi) với số tính tay.
// Quán 14:00 → 00:00, cho lệch 10 phút. Lương 7.800.000đ = 300.000đ/ngày = 500đ/phút ca 10 tiếng; tăng ca 30.000đ/giờ.
// Luật đi trễ của quán từ 4/11: cho trễ 10 phút; quá thì trừ 50.000đ mỗi lần + trừ theo phút.
//   Hoa   — theo luật quán: trễ 11 phút, trễ đúng 10 phút, vào sớm + ở lại, về sớm 40 phút.
//   Khánh — luật riêng từ 4/11 (cho trễ 30 phút, chỉ trừ 50.000đ), từ 6/11 quay về theo quán.
//   Lộc   — trả theo giờ 30.000đ, ca riêng 14:30 → 00:00: trễ 15 phút (mất phút + 50.000đ), ở lại 40 phút.
//   Mai   — ra rồi vào lại sau nửa đêm để dọn quán; hôm sau quên quét lúc đến, chủ sửa giờ vào.
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
import { fakeDb } from './helpers/fakeSupabase.mjs';

const SECRET = 'service-role-test-key'.repeat(2);
const SHOP_IP = '113.161.1.2';
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n, name, role = 'staff') => ({ id: uid(n), full_name: name, role, phone: `ph_${name.toLowerCase()}`.padEnd(24, 'x') });
const OWNER = person(1, 'Chu', 'admin');
const HOA = person(2, 'Hoa'), KHANH = person(3, 'Khanh'), LOC = person(4, 'Loc'), MAI = person(5, 'Mai');
const STAFF = [HOA, KHANH, LOC, MAI];
const T = (day, hm) => { const next = hm.endsWith('+1') ? 1 : 0; const [h, m] = hm.replace('+1', '').split(':').map(Number); return Date.UTC(2026, 10, day + next, h - 7, m); };
const iso = t => new Date(t).toISOString();

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
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
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

test('late rules and automatic overtime over four real days: every slip and every day of the finance book match the hand count', async () => {
  const state = {
    staff: [OWNER, ...STAFF].map(({ phone, ...p }) => p),
    payroll_config: STAFF.map(p => ({ staff_id: p.id, base_salary: 7800000, overtime_rate: 30000 })),
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_fine_rules: [
      { id: uid(901), name: 'Đi trễ quá 30 phút', amount: 50000, kind: 'late', active: true, sort: 1 },
      { id: uid(902), name: 'Quên bấm ra ca', amount: 30000, kind: 'forgot', active: true, sort: 2 },
    ],
    // Như migration payroll_late_rules.sql: mặc định của quán từ 4/11.
    payroll_late_rules: [{ scope: 'shop', valid_from: '2026-11-04', allowed_minutes: 10, per_minute: true, fixed_amount: 50000, use_shop: false }],
    __clock: () => env.now,
  };
  const api = compile('../src/app/api/admin/workforce/route.js', state);
  const kioskApi = compile('../src/app/api/checkin/kiosk/route.js', state);
  const plain = v => JSON.parse(JSON.stringify(v));
  const as = (user, time) => { env.user = user; env.now = time; };
  const ownerPost = async (time, body) => { as(OWNER, time); return plain(await api.POST({ json: async () => body, headers: new Map() })); };
  const ownerGet = async (time, query) => { as(OWNER, time); return plain(await api.GET({ url: `http://x/api/admin/workforce?${query}` })).body; };
  const staffPost = async (p, time, body) => {
    as(p, time);
    return plain(await api.POST({ json: async () => body, headers: new Map([['cf-connecting-ip', SHOP_IP]]), cookies: { get: k => (k === token.DEVICE_COOKIE ? { value: p.phone } : undefined) } }));
  };
  as(OWNER, T(4, '08:00'));
  const activated = await kioskApi.POST({ json: async () => ({ action: 'activate', name: 'Quầy' }), headers: new Map([['cf-connecting-ip', SHOP_IP]]), url: 'https://x' });
  const kioskCookie = activated.setCookies[token.KIOSK_COOKIE];
  const qr = async time => {
    as(null, time);
    return plain(await kioskApi.GET({ url: 'https://x/api/checkin/kiosk', headers: new Map([['cf-connecting-ip', SHOP_IP]]),
      cookies: { get: k => (k === token.KIOSK_COOKIE ? { value: kioskCookie } : undefined) } })).body.token;
  };
  const failed = [];
  const scan = async (p, time) => { const r = await staffPost(p, time, { action: 'clock', token: await qr(time) }); if (r.status !== 200) failed.push([p.full_name, iso(time), r.body.error]); return r; };
  const events = [];
  const add = (time, fn) => events.push({ time, fn });
  const work = (p, day, pairs) => { for (const [a, b] of pairs) { add(T(day, a), () => scan(p, T(day, a))); if (b) add(T(day, b), () => scan(p, T(day, b))); } };

  // Chủ cài đặt sáng 4/11: Khánh luật riêng, Lộc ca riêng 14:30 → 00:00 trả theo giờ 30.000đ.
  add(T(4, '09:00'), async () => assert.equal((await ownerPost(T(4, '09:00'), { action: 'save_late_rule', scope: KHANH.id, allowed_minutes: 30, per_minute: false, fixed_amount: '50.000' })).status, 200));
  add(T(4, '09:01'), async () => assert.equal((await ownerPost(T(4, '09:01'), { action: 'save_shift', staff_id: LOC.id, start_time: '14:30', end_time: '00:00' })).status, 200));
  add(T(4, '09:02'), async () => assert.equal((await ownerPost(T(4, '09:02'), { action: 'save_hourly', staff_id: LOC.id, hourly_rate: '30.000', valid_from: '2026-11-04' })).status, 200));
  // Sáng 6/11 Khánh quay về luật của quán.
  add(T(6, '10:00'), async () => assert.equal((await ownerPost(T(6, '10:00'), { action: 'save_late_rule', scope: KHANH.id, use_shop: true })).status, 200));

  work(HOA, 4, [['14:00', '00:00+1']]);
  work(HOA, 5, [['14:11', '00:00+1']]);
  work(HOA, 6, [['13:30', '00:30+1']]);
  work(HOA, 7, [['14:10', '23:20']]);
  work(KHANH, 4, [['14:25', '00:00+1']]);
  work(KHANH, 5, [['14:31', '00:00+1']]);
  work(KHANH, 6, [['14:20', '00:00+1']]);
  work(LOC, 4, [['14:30', '00:00+1']]);
  work(LOC, 5, [['14:45', '00:00+1']]);
  work(LOC, 6, [['14:30', '00:40+1']]);
  work(MAI, 5, [['14:00', '23:50'], ['00:20+1', '00:50+1']]);
  work(MAI, 6, [['00:31+1', null]]); // quên quét lúc đến: lần quét lúc về thành "vào ca"
  // Sáng 7/11 chủ sửa lượt của Mai: vào 14:05 ngày 6, ra 00:31.
  add(T(7, '10:00'), async () => {
    const s = state.attendance_sessions.find(x => x.staff_id === MAI.id && x.clock_in === iso(T(6, '00:31+1')));
    assert.ok(s && !s.clock_out, 'Mai\'s single scan is an open clock-in');
    assert.equal((await ownerPost(T(7, '10:00'), { action: 'edit_attendance', id: s.id, clock_in: iso(T(6, '14:05')), clock_out: iso(T(6, '00:31+1')), note: 'quên quét lúc đến' })).status, 200);
  });
  for (const d of [4, 5, 6, 7]) add(T(d, '04:00+1'), () => qr(T(d, '04:00+1')));
  events.sort((a, b) => a.time - b.time);
  for (const e of events) await e.fn();
  assert.deepEqual(failed, []);

  // Không còn gì chờ duyệt giờ ngoài ca; không gợi ý phạt trễ cho ngày đã tự trừ (Khánh trễ 31 phút ngày 5/11).
  const DEC1 = Date.UTC(2026, 11, 1, 2, 0);
  assert.deepEqual((await ownerGet(DEC1, 'checkin=1')).extras, []);
  const stats = await ownerGet(DEC1, 'stats=1&year=2026&month=11');
  assert.deepEqual([stats.pending.extras, stats.pending.fines], [0, 0]);

  // Lộc tự xem lương (7/11): thấy khoản trừ trễ.
  as(LOC, T(7, '12:00'));
  const locMe = plain(await api.GET({ url: 'http://x/api/admin/workforce?me=1' })).body.salary;
  assert.deepEqual([locMe.net, locMe.lateList.map(x => [x.day, x.minutes, x.amount])], [817500, [['2026-11-05', 15, 50000]]]);

  const closed = await ownerPost(DEC1 + 60000, { action: 'close_month', year: 2026, month: 11 });
  assert.equal(closed.status, 200);
  const slip = p => state.payroll_closes.find(c => c.staff_id === p.id)?.snapshot;
  const show = s => ({ units: s.workUnits, basePay: s.basePay, lateAmt: s.lateAmt, earlyAmt: s.earlyAmt, otAmt: s.otAmt, pendingH: s.pendingH, net: s.net });
  // Chi tiết từng ngày không lưu; tiền từng ngày (cho Sổ thu chi) lưu cùng số đã chốt và cộng đúng bằng phiếu.
  assert.equal('daily' in slip(HOA), false, 'per-day details are not stored in the closed slip');
  assert.equal(Object.values(slip(HOA).byDay).reduce((a, x) => a + x, 0), 1154500, 'the day pay kept for the finance book adds up to the slip');
  // Hoa: 4 ngày = 1.200.000đ; trễ 11 phút 5/11 = 50.000 + 5.500; trễ 10 phút 7/11 không trừ; về sớm 40 phút = 20.000; sớm 30 + ở lại 30 = 30.000.
  assert.deepEqual(show(slip(HOA)), { units: 4, basePay: 1200000, lateAmt: 55500, earlyAmt: 20000, otAmt: 30000, pendingH: 0, net: 1154500 });
  assert.deepEqual(slip(HOA).lateList, [{ day: '2026-11-05', minutes: 11, amount: 55500, perMinute: 5500, fixed: 50000 }]);
  // Khánh: 4/11 trễ 25 phút (luật riêng cho 30) không trừ; 5/11 trễ 31 phút trừ 50.000; 6/11 theo quán trễ 20 = 50.000 + 10.000.
  assert.deepEqual(show(slip(KHANH)), { units: 3, basePay: 900000, lateAmt: 110000, earlyAmt: 0, otAmt: 0, pendingH: 0, net: 790000 });
  // Lộc: 570 + 555 + 570 phút × 500đ = 847.500; trễ 15 phút đã mất phút, chỉ trừ 50.000; ở lại 40 phút = 20.000.
  assert.deepEqual(show(slip(LOC)), { units: 3, basePay: 847500, lateAmt: 50000, earlyAmt: 0, otAmt: 20000, pendingH: 0, net: 817500 });
  assert.deepEqual(slip(LOC).hourly, { minutes: 1695, amount: 847500, rates: [30000] });
  // Mai: 5/11 về 23:50 (trong 10 phút cho lệch) + dọn 00:20–00:50 = 30 phút tăng ca; 6/11 sửa vào 14:05 (trễ 5 phút, không trừ), ở lại 31 phút.
  assert.deepEqual(show(slip(MAI)), { units: 2, basePay: 600000, lateAmt: 0, earlyAmt: 0, otAmt: 30500, pendingH: 0, net: 630500 });

  // Sổ thu chi: lương từng ngày của cả quán cộng đúng bằng tổng các phiếu lương.
  const cost = payroll.payrollCost({ year: 2026, month: 11, ...await payrollMonth.loadPayrollMonth(fakeDb(state), 2026, 11) });
  assert.deepEqual(cost.byDay, {
    '2026-11-04': 300000 + 300000 + 285000,
    '2026-11-05': 244500 + 250000 + 227500 + 315000,
    '2026-11-06': 330000 + 240000 + 305000 + 315500,
    '2026-11-07': 280000,
  });
  const book = Object.values(cost.byDay).reduce((a, x) => a + x, 0);
  assert.equal(book, 1154500 + 790000 + 817500 + 630500);
  assert.equal(stats.totals.gross, book);
  assert.equal(stats.totals.lateCuts, 55500 + 110000 + 50000);
});
