// Giả lập trọn tháng 11/2026 qua đúng code máy chủ (máy quầy, quét mã, bấm nút, tự đóng ca, sửa từ phiếu lương,
// ứng / phạt / thưởng, kết toán người nghỉ, chốt lương), rồi so từng phiếu, số tính lại, trang Lương, Thống kê và
// Sổ thu chi với số tính tay.
// Quán 14:00 → 00:00, cho lệch 10 phút. Luật trễ của quán (như migration) từ 4/11: cho 10 phút, quá thì 50.000đ + theo phút.
// Lương tháng 7.800.000đ = 300.000đ/ngày = 500đ/phút; tăng ca 30.000đ/giờ = 500đ/phút.
// Quán nghỉ âm lịch mùng 1 (9/11) và rằm (23/11, chủ bấm mở cửa 20/11); chủ thêm tay 17/11.
//   An    — lương tháng, quét mã: trễ 35' trước khi có luật (2/11), trễ 8' (4/11), trễ 25' (5/11), về sớm 20' (6/11),
//           về sớm 45' (7/11), vào sớm + ở lại (8/11), quán nghỉ 9/11 được gọi vào 16–20h, quét đúp (10/11),
//           quét nhầm ngày nghỉ 3/11 (chủ xoá), vào sớm 1 tiếng 18/11 chủ bấm "Không tính"; ứng 1.000.000 + 500.000.
//   Bình  — lương tháng, bấm nút trên máy quầy: dọn quán sau nửa đêm 8→9/11 (rơi vào ngày quán nghỉ), quên ra ca 12/11
//           (chủ phạt 30.000), bấm đúp 15/11.
//   Cường — theo giờ 30.000đ, ca riêng 18:00 → 02:00 (qua nửa đêm): trễ 20', vào sớm + ở lại, dọn sau 2h, quét nhầm
//           ra rồi vào lại sau 5 phút (10/11), quên quét cả ca 11/11 (chủ thêm ca), về sớm 1 tiếng.
//   Dũng  — theo ngày 240.000đ: nửa ngày + về sớm, trễ 20', đi làm ngày quán nghỉ 9/11 nửa ca, ở lại 1 tiếng.
//   Em    — lương tháng tới 15/11, từ 16/11 theo ngày 260.000đ; trễ 30' ngày 19/11.
//   Hoa   — lương tháng, mẫu mực: thưởng chuyên cần 300.000, phạt làm vỡ ly 50.000.
//   Phát  — vào làm 12/11 (chủ tạo tài khoản), lương tháng, ứng 300.000.
//   Giang — lương 7.000.000đ (số lẻ), trễ 15' (12/11), ứng 2.000.000, nghỉ việc sau 15/11, kết toán sáng 16/11.
//   Khoa  — tài khoản cũ, nghỉ việc 20/10, chủ bấm "Đi làm lại" 19/11; chủ sửa một lượt quét nhầm 24/11 thành ca 22/11.
// Số mong đợi là số ĐÚNG theo luật chủ chọn. Các lỗi giả lập này tìm ra (đã sửa 2026-11-04):
//   - An: ngày quán nghỉ 9/11 được gọi vào 16:00 từng bị tính "trễ 2 giờ" → gợi ý phạt + mất thưởng chuyên cần.
//   - Cường: 10/11 quét nhầm 18:00–18:05 rồi vào lại 18:09 → từng tính 485 phút (đếm 18:00–18:05 hai lần), dư 2.500đ.
//   - Khoa: từng được 2 ngày quán nghỉ (9/11, 17/11) trước khi đi làm lại; ca sửa sang 22/11 từng giữ date 24/11 → tính
//     vào 23/11 thành 10 giờ tăng ca, mất 1 ngày công.
//   - Sổ thu chi của Giang (lương 7.000.000đ) từng dư 3đ so với phiếu (làm tròn từng ngày).
// Chạy riêng: node --test tests/november-payroll-simulation.test.mjs   (SIM_DUMP=1 để in số từng người)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const REPO = new URL('../', import.meta.url);
const lib = p => import(new URL(p, REPO).href);
const pin = await lib('src/lib/staffPin.mjs');
const token = await lib('src/lib/checkinToken.mjs');
const rules = await lib('src/lib/attendanceRules.mjs');
const payroll = await lib('src/lib/payroll.mjs');
const payrollMonth = await lib('src/lib/payrollMonth.mjs');
const clockApply = await lib('src/lib/clockApply.mjs');
const faceCheck = await lib('src/lib/faceCheck.mjs');
const departure = await lib('src/lib/staffDeparture.mjs');
const staffRoles = await lib('src/lib/staffRoles.mjs');
const { punctuality } = await lib('src/lib/clockMessages.mjs');
const { fakeDb } = await lib('tests/helpers/fakeSupabase.mjs');

const SECRET = 'service-role-test-key'.repeat(2);
const SHOP_IP = '113.161.1.2';
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n, name, role = 'staff') => ({ id: uid(n), full_name: name, role, phone: `ph_${name.toLowerCase()}`.padEnd(24, 'x'), created_at: '2026-10-01T00:00:00.000Z' });
const OWNER = person(1, 'Chu', 'admin');
const AN = person(2, 'An'), BINH = person(3, 'Binh'), CUONG = person(4, 'Cuong'), DUNG = person(5, 'Dung'), EM = person(6, 'Em'), HOA = person(7, 'Hoa'), GIANG = person(8, 'Giang');
// Khoa: tài khoản cũ (tạo 2025), nghỉ việc 20/10, chủ bấm "Đi làm lại" 19/11.
const KHOA = { ...person(9, 'Khoa'), created_at: '2025-06-01T00:00:00.000Z' };
const PHAT = { id: null, full_name: 'Phat', role: 'staff', phone: 'ph_phat'.padEnd(24, 'x') };
const STAFF = [AN, BINH, CUONG, DUNG, EM, HOA, GIANG, KHOA];
const T = (day, hm) => { const next = hm.endsWith('+1') ? 1 : 0; const [h, m] = hm.replace('+1', '').split(':').map(Number); return Date.UTC(2026, 10, day + next, h - 7, m); };
const iso = t => new Date(t).toISOString();
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const strip = url => readFileSync(new URL(url, REPO), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
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
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, ...staffRoles, punctuality,
    createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
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

// So sánh nhiều số một lượt: gom hết chỗ lệch rồi mới báo.
const diffs = [];
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) diffs.push(`${label}\n    expected ${e}\n    actual   ${a}`);
};

test('November 2026, nine people, every case: slips, live numbers, pay page, stats and finance book all match the hand count', async () => {
  const state = {
    staff: [OWNER, ...STAFF].map(({ phone, ...p }) => p),
    payroll_config: STAFF.map(p => ({ staff_id: p.id, base_salary: p === CUONG || p === DUNG ? 0 : p === GIANG ? 7000000 : 7800000, overtime_rate: p === KHOA ? null : 30000, pay_day: 5 })),
    checkin_settings: [{ id: 1, enforce: true, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_fine_rules: [
      { id: uid(901), name: 'Đi trễ quá 30 phút', amount: 50000, kind: 'late', active: true, sort: 1 },
      { id: uid(902), name: 'Quên bấm ra ca', amount: 30000, kind: 'forgot', active: true, sort: 2 },
    ],
    payroll_late_rules: [{ scope: 'shop', valid_from: '2026-11-04', allowed_minutes: 10, per_minute: true, fixed_amount: 50000, use_shop: false }],
    shop_closed_rules: [{ valid_from: '2026-11-01', lunar_days: [1, 15] }],
    shop_closed_days: [], payroll_holiday_pay: [], checkin_tap_staff: [], staff_departures: [{ staff_id: KHOA.id, last_day: '2026-10-20', reason: 'nghỉ' }],
    __clock: () => env.now,
  };
  const api = compile('src/app/api/admin/workforce/route.js', state);
  const kioskApi = compile('src/app/api/checkin/kiosk/route.js', state);
  const plain = v => JSON.parse(JSON.stringify(v));
  const as = (user, time) => { env.user = user; env.now = time; };
  const ownerPost = async (time, body) => { as(OWNER, time); const r = plain(await api.POST({ json: async () => body, headers: new Map() })); assert.equal(r.status, 200, `${body.action}: ${r.body.error}`); return r.body; };
  const ownerGet = async (time, query) => { as(OWNER, time); return plain(await api.GET({ url: `http://x/api/admin/workforce?${query}` })).body; };
  const staffPost = async (p, time, body) => {
    as(p, time);
    return plain(await api.POST({ json: async () => body, headers: new Map([['cf-connecting-ip', SHOP_IP]]), cookies: { get: k => (k === token.DEVICE_COOKIE ? { value: p.phone } : undefined) } }));
  };
  as(OWNER, T(1, '08:00'));
  const activated = await kioskApi.POST({ json: async () => ({ action: 'activate', name: 'Quầy' }), headers: new Map([['cf-connecting-ip', SHOP_IP]]), url: 'https://x' });
  const kioskCookie = activated.setCookies[token.KIOSK_COOKIE];
  const kioskReq = body => ({ json: async () => body, url: 'https://x/api/checkin/kiosk', headers: new Map([['cf-connecting-ip', SHOP_IP]]),
    cookies: { get: k => (k === token.KIOSK_COOKIE ? { value: kioskCookie } : undefined) } });
  const qr = async time => { as(null, time); return plain(await kioskApi.GET(kioskReq(null))).body; };
  const failed = [], rejected = [];
  const scan = async (p, time, expectReject = false) => {
    const t = (await qr(time)).token;
    const r = await staffPost(p, time, { action: 'clock', token: t });
    if (expectReject) rejected.push([p.full_name, iso(time), r.status, r.body.error]);
    else if (r.status !== 200) failed.push([p.full_name, iso(time), r.body.error]);
    return r;
  };
  const tap = async (p, time, expectReject = false) => {
    const open = (await qr(time)).tap.open.includes(p.id);
    as(null, time);
    const r = plain(await kioskApi.POST(kioskReq({ action: 'tap_clock', staff_id: p.id, expect: open ? 'out' : 'in' })));
    if (expectReject) rejected.push([p.full_name, iso(time), r.status, r.body.error]);
    else if (r.status !== 200) failed.push([p.full_name, iso(time), r.body.error]);
    return r;
  };
  const events = [];
  const add = (time, fn) => events.push({ time, fn });
  const work = (fn, p, day, pairs) => { for (const [a, b] of pairs) { add(T(day, a), () => fn(p, T(day, a))); if (b) add(T(day, b), () => fn(p, T(day, b))); } };
  const sessionOf = (p, day, hm) => state.attendance_sessions.find(s => s.staff_id === p.id && s.clock_in === iso(T(day, hm)));

  // ── Chủ cài đặt
  add(T(1, '09:00'), () => ownerPost(T(1, '09:00'), { action: 'save_tap_staff', staff_id: BINH.id, enabled: true, label: 'Chị Bình' }));
  add(T(1, '09:01'), () => ownerPost(T(1, '09:01'), { action: 'save_shift', staff_id: CUONG.id, start_time: '18:00', end_time: '02:00' }));
  add(T(1, '09:02'), () => ownerPost(T(1, '09:02'), { action: 'save_hourly', staff_id: CUONG.id, hourly_rate: '30.000', unit: 'hour', valid_from: '2026-11-01' }));
  add(T(1, '09:03'), () => ownerPost(T(1, '09:03'), { action: 'save_hourly', staff_id: DUNG.id, hourly_rate: '240.000', unit: 'day', valid_from: '2026-11-01' }));
  add(T(1, '09:04'), () => ownerPost(T(1, '09:04'), { action: 'save_bonus_settings', bonus_amount: '300.000', bonus_min_days: 22 }));
  // Chủ xoá lượt An quét nhầm sáng 3/11 (ngày nghỉ của An).
  add(T(4, '10:00'), async () => {
    const s = sessionOf(AN, 3, '10:00');
    assert.ok(s?.clock_out, 'An mis-scan exists');
    await ownerPost(T(4, '10:00'), { action: 'delete_attendance', id: s.id, note: 'quét nhầm' });
  });
  add(T(10, '10:00'), () => ownerPost(T(10, '10:00'), { action: 'add_advance', staff_id: GIANG.id, amount: '2.000.000', date: '2026-11-10', reason: 'ứng' }));
  // Phát vào làm 12/11: chủ tạo tài khoản rồi nhập lương.
  add(T(12, '10:00'), async () => {
    const r = await ownerPost(T(12, '10:00'), { action: 'create_account', full_name: 'Phat', phone: '0901234567', pin: '1234', role: 'staff' });
    PHAT.id = r.id;
    await ownerPost(T(12, '10:01'), { action: 'save_config', staff_id: PHAT.id, base_salary: '7.800.000', overtime_rate: '30.000', pay_day: 5 });
  });
  // Cường quên quét cả ca 11/11: chủ thêm ca 18:00 → 02:00.
  add(T(12, '10:05'), () => ownerPost(T(12, '10:05'), { action: 'add_attendance', staff_id: CUONG.id, clock_in: iso(T(11, '18:00')), clock_out: iso(T(11, '02:00+1')), note: 'quên quét' }));
  add(T(13, '10:00'), () => ownerPost(T(13, '10:00'), { action: 'staff_depart', staff_id: GIANG.id, last_day: '2026-11-15', reason: 'về quê' }));
  add(T(15, '09:00'), () => ownerPost(T(15, '09:00'), { action: 'save_closed_day', day: '2026-11-17', note: 'sửa điện' }));
  add(T(15, '10:00'), () => ownerPost(T(15, '10:00'), { action: 'add_advance', staff_id: AN.id, amount: '1.000.000', date: '2026-11-15' }));
  add(T(16, '09:00'), () => ownerPost(T(16, '09:00'), { action: 'save_hourly', staff_id: EM.id, hourly_rate: '260.000', unit: 'day', valid_from: '2026-11-16' }));
  // Kết toán Giang sáng 16/11.
  let giangSettled = null;
  add(T(16, '09:30'), async () => {
    await ownerPost(T(16, '09:30'), { action: 'close_month', year: 2026, month: 11, staff_id: GIANG.id });
    giangSettled = structuredClone(state.payroll_closes.find(c => c.staff_id === GIANG.id).snapshot);
  });
  add(T(19, '10:00'), async () => {
    const s = sessionOf(AN, 18, '13:00');
    const r = await ownerPost(T(19, '10:00'), { action: 'decide_extra', attendance_id: s.id, status: 'rejected' });
    assert.equal(r.minutes, 0);
  });
  add(T(20, '09:00'), () => ownerPost(T(20, '09:00'), { action: 'skip_closed_day', day: '2026-11-23' }));
  add(T(20, '11:00'), async () => {
    for (const [p, amount] of [[AN, '500.000'], [PHAT, '300.000']]) {
      const r = await staffPost(p, T(20, '11:00'), { action: 'request', type: 'advance', amount, reason: 'ứng lương' });
      assert.equal(r.status, 200, r.body.error);
    }
  });
  add(T(20, '12:00'), async () => {
    for (const r of state.payroll_requests.filter(x => x.status === 'pending')) await ownerPost(T(20, '12:00'), { action: 'decide_request', id: r.id, status: 'approved' });
  });
  add(T(20, '12:05'), () => ownerPost(T(20, '12:05'), { action: 'add_violation', staff_id: HOA.id, date: '2026-11-20', reason: 'Làm vỡ ly', amount: '50.000' }));

  // ── Chấm công
  const shop = [['14:00', '00:00+1']];
  // An
  work(scan, AN, 2, [['14:35', '00:00+1']]);
  work(scan, AN, 3, [['10:00', '10:04']]);           // quét nhầm, chủ xoá
  work(scan, AN, 4, [['14:08', '00:00+1']]);
  work(scan, AN, 5, [['14:25', '00:00+1']]);
  work(scan, AN, 6, [['14:00', '23:40']]);
  work(scan, AN, 7, [['14:00', '23:15']]);
  work(scan, AN, 8, [['13:30', '00:30+1']]);
  work(scan, AN, 9, [['16:00', '20:00']]);            // quán nghỉ, chủ gọi vào
  work(scan, AN, 10, shop);
  add(T(10, '14:02'), () => scan(AN, T(10, '14:02'), true)); // quét đúp
  for (const d of [...range(11, 16), ...range(19, 28)]) work(scan, AN, d, shop);
  work(scan, AN, 18, [['13:00', '00:00+1']]);         // vào sớm 1 tiếng, chủ bấm không tính
  // Bình (nút trên máy quầy)
  for (const d of [...range(2, 7), 10, 11, ...range(13, 16), ...range(18, 29)]) work(tap, BINH, d, shop);
  work(tap, BINH, 8, [['14:00', '23:55'], ['00:20+1', '00:50+1']]);
  work(tap, BINH, 12, [['14:00', null]]);             // quên ra ca
  add(T(15, '14:01'), () => tap(BINH, T(15, '14:01'), true)); // bấm đúp
  // Cường (theo giờ, ca riêng 18:00 → 02:00)
  const night = [['18:00', '02:00+1']];
  work(scan, CUONG, 4, night);
  work(scan, CUONG, 5, [['18:20', '02:00+1']]);
  work(scan, CUONG, 6, [['17:30', '02:30+1']]);
  work(scan, CUONG, 7, [['18:00', '01:50+1'], ['02:20+1', '02:50+1']]);
  work(scan, CUONG, 10, [['18:00', '18:05'], ['18:09', '02:00+1']]);
  for (const d of [...range(12, 16), ...range(18, 23)]) work(scan, CUONG, d, night);
  work(scan, CUONG, 24, [['18:00', '01:00+1']]);
  work(scan, CUONG, 25, [['18:05', '01:55+1']]);
  // Dũng (theo ngày 240.000)
  work(scan, DUNG, 3, shop);
  work(scan, DUNG, 4, [['14:00', '18:30']]);
  work(scan, DUNG, 5, [['14:20', '00:00+1']]);
  work(scan, DUNG, 9, [['14:00', '18:00']]);
  for (const d of [...range(10, 16), ...range(18, 23), ...range(25, 28)]) work(scan, DUNG, d, shop);
  work(scan, DUNG, 24, [['14:00', '01:00+1']]);
  // Em (tháng → ngày từ 16/11)
  for (const d of [...range(2, 8), ...range(10, 16), 18, ...range(20, 28)]) work(scan, EM, d, shop);
  work(scan, EM, 19, [['14:30', '00:00+1']]);
  // Hoa
  for (const d of [...range(2, 8), ...range(10, 16), ...range(18, 28)]) work(scan, HOA, d, shop);
  // Phát (từ 13/11)
  for (const d of [...range(13, 16), ...range(18, 28)]) work(scan, PHAT, d, shop);
  // Khoa: đi làm lại từ 20/11. 22/11 quên quét cả ca; 24/11 lỡ quét 10:00–10:05, chủ sửa lượt đó thành ca 22/11
  // (Sửa giờ, đổi cả ngày) thay vì xoá + thêm lượt.
  add(T(19, '10:00'), () => ownerPost(T(19, '10:00'), { action: 'staff_return', staff_id: KHOA.id }));
  for (const d of [20, 21, ...range(23, 28)]) work(scan, KHOA, d, shop);
  work(scan, KHOA, 24, [['10:00', '10:05']]);
  add(T(25, '10:00'), async () => {
    const s = sessionOf(KHOA, 24, '10:00');
    await ownerPost(T(25, '10:00'), { action: 'edit_attendance', id: s.id, clock_in: iso(T(22, '14:00')), clock_out: iso(T(22, '00:00+1')), note: 'quên quét 22/11' });
  });
  // Giang (tới 15/11)
  for (const d of [...range(2, 8), 10, 11, ...range(13, 15)]) work(scan, GIANG, d, shop);
  work(scan, GIANG, 12, [['14:15', '00:00+1']]);
  // Máy quầy mở cả đêm: hỏi mã lúc 4 giờ sáng (đóng ca quên ra ca).
  for (const d of range(1, 30)) add(T(d, '04:00+1'), () => qr(T(d, '04:00+1')));

  // Giữa tháng: lương tạm tính của chính người đó (?me=1) phải bằng số tính lại từ dữ liệu lúc đó.
  const meChecks = [];
  const meAt = (p, time) => add(time, async () => {
    as(p, time);
    const me = plain(await api.GET({ url: 'http://x/api/admin/workforce?me=1' })).body.salary;
    const today = new Date(time + 7 * 3600000).toISOString().slice(0, 10);
    const m = await payrollMonth.loadPayrollMonth(fakeDb(state), 2026, 11, today);
    const live = payroll.computeSalary({ year: 2026, month: 11, staffId: p.id, sessions: m.sessions.filter(s => s.staff_id === p.id), config: m.configs.find(c => c.staff_id === p.id),
      requests: m.requests.filter(r => r.staff_id === p.id), violations: m.violations.filter(v => v.staff_id === p.id), bonuses: m.bonuses.filter(b => b.staff_id === p.id), rules: m.rules,
      reviews: m.reviews, hourlyRates: m.hourlyRates.filter(r => r.staff_id === p.id), lateRules: payroll.lateRulesOf(m.lateRules, p.id), ...payroll.holidayArgs(p, m) });
    meChecks.push([p.full_name, today, me, live]);
  });
  meAt(AN, T(10, '12:00'));
  meAt(EM, T(20, '12:30'));
  meAt(CUONG, T(20, '12:30'));
  meAt(DUNG, T(20, '12:30'));
  meAt(BINH, T(13, '12:00'));

  events.sort((a, b) => a.time - b.time);
  for (const e of events) await e.fn();
  check('scans that failed', failed, []);
  check('double scan / tap rejected with 409', rejected.map(r => r[2]), [409, 409]);
  for (const [name, today, me, live] of meChecks) {
    const pick = s => ({ net: s.net, basePay: s.basePay, workUnits: s.workUnits, holidayDays: s.holidayDays, lateAmt: s.lateAmt, earlyAmt: s.earlyAmt, otAmt: s.otAmt, advAmt: s.advAmt });
    check(`?me=1 ${name} on ${today} equals live numbers`, pick(me), pick(live));
  }
  check('An mis-scan deleted', state.attendance_sessions.filter(s => s.staff_id === AN.id && s.date === '2026-11-03').length, 0);
  const binhForgot = sessionOf(BINH, 12, '14:00');
  check('Bình 12/11 auto-closed at shift end', binhForgot?.clock_out, iso(T(12, '00:00+1')));
  check('Bình taps all marked tap', [...new Set(state.checkin_scans.filter(s => s.staff_id === BINH.id).map(s => s.method))], ['tap']);

  // ── Sáng 1/12: xử lý gợi ý phạt, duyệt thưởng, chốt lương.
  const DEC1 = Date.UTC(2026, 11, 1, 1, 0);  // 08:00 giờ VN
  const pre = await ownerGet(DEC1, 'stats=1&year=2026&month=11');
  const pName = name => pre.people.find(p => p.name === name);
  check('fine suggestions before decisions (An late 35 on 2/11, Bình forgot 12/11)', pre.people.map(p => [p.name, p.fineSuggestions]).filter(x => x[1]),
    [['An', 1], ['Binh', 1]]);
  check('bonus eligibility', pre.people.filter(p => p.bonus.eligible).map(p => p.name), ['Hoa']);
  check('Phát reasons', pName('Phat').bonus.reasons, ['16/22 ngày công']);
  await ownerPost(DEC1, { action: 'decide_fine', attendance_id: binhForgot.id, kind: 'forgot', status: 'fined', amount: '30.000' });
  await ownerPost(DEC1, { action: 'decide_fine', attendance_id: sessionOf(AN, 2, '14:35').id, kind: 'late', status: 'skipped' });
  await ownerPost(DEC1 + 60000, { action: 'decide_bonus', staff_id: HOA.id, year: 2026, month: 11, amount: '300.000' });
  const CLOSE = DEC1 + 3600000;
  check('close_month closed count (Giang settled earlier)', (await ownerPost(CLOSE, { action: 'close_month', year: 2026, month: 11 })).closed, 8);

  // ── Số tính tay
  const W = 300000;
  const expected = {
    An: { workUnits: 26, holidayDays: 1, dayUnits: 26, basePay: 26 * W, lateAmt: 62500, earlyAmt: 22500, otAmt: 30000, bonusAmt: 0, advAmt: 1500000, vioAmt: 0, net: 26 * W - 62500 - 22500 + 30000 - 1500000 },
    Binh: { workUnits: 28, holidayDays: 2, dayUnits: 28, basePay: 28 * W, lateAmt: 0, earlyAmt: 0, otAmt: 15000, bonusAmt: 0, advAmt: 0, vioAmt: 30000, net: 28 * W + 15000 - 30000 },
    // 9.040 phút trong ca × 500đ; trễ 20' (5/11) chỉ trừ 50.000; tăng ca 60' (6/11) + 30' (7/11).
    Cuong: { workUnits: 19, holidayDays: 0, dayUnits: 0, basePay: 9040 * 500, lateAmt: 50000, earlyAmt: 0, otAmt: 45000, bonusAmt: 0, advAmt: 0, vioAmt: 0, net: 9040 * 500 - 50000 + 45000 },
    // 21 ngày công × 240.000; về sớm 4/11 còn 270/600 ngày (trừ 12.000); trễ 20' = 50.000 + 8.000; ở lại 1 tiếng 24/11.
    Dung: { workUnits: 21, holidayDays: 0, dayUnits: 0, basePay: 21 * 240000, lateAmt: 58000, earlyAmt: 12000, otAmt: 30000, bonusAmt: 0, advAmt: 0, vioAmt: 0, net: 21 * 240000 - 58000 - 12000 + 30000 },
    // 13 ngày + 9/11 theo tháng = 14 × 300.000; 12 ngày × 260.000 từ 16/11; trễ 30' 19/11 = 50.000 + 13.000.
    Em: { workUnits: 26, holidayDays: 1, dayUnits: 14, basePay: 14 * W + 12 * 260000, lateAmt: 63000, earlyAmt: 0, otAmt: 0, bonusAmt: 0, advAmt: 0, vioAmt: 0, net: 14 * W + 12 * 260000 - 63000 },
    Hoa: { workUnits: 27, holidayDays: 2, dayUnits: 27, basePay: 27 * W, lateAmt: 0, earlyAmt: 0, otAmt: 0, bonusAmt: 300000, advAmt: 0, vioAmt: 50000, net: 27 * W + 300000 - 50000 },
    Phat: { workUnits: 16, holidayDays: 1, dayUnits: 16, basePay: 16 * W, lateAmt: 0, earlyAmt: 0, otAmt: 0, bonusAmt: 0, advAmt: 300000, vioAmt: 0, net: 16 * W - 300000 },
    // 7.000.000 × 14 / 26 = 3.769.231; trễ 15' = 6.731 + 50.000.
    // Khoa: 20–28/11 = 9 ngày (22/11 do chủ sửa lượt); không có 9/11, 17/11 (lúc đó chưa đi làm lại).
    Khoa: { workUnits: 9, holidayDays: 0, dayUnits: 9, basePay: 9 * W, lateAmt: 0, earlyAmt: 0, otAmt: 0, bonusAmt: 0, advAmt: 0, vioAmt: 0, net: 9 * W },
    Giang: { workUnits: 14, holidayDays: 1, dayUnits: 14, basePay: 3769231, lateAmt: 56731, earlyAmt: 0, otAmt: 0, bonusAmt: 0, advAmt: 2000000, vioAmt: 0, net: 3769231 - 56731 - 2000000 },
  };
  const keys = Object.keys(expected.An);
  const pick = s => Object.fromEntries(keys.map(k => [k, s?.[k]]));
  const slip = name => state.payroll_closes.find(c => c.snapshot.name === name)?.snapshot;
  for (const name of Object.keys(expected)) check(`slip ${name}`, pick(slip(name)), expected[name]);
  check('Cường hourly block', slip('Cuong')?.hourly, { minutes: 9040, amount: 4520000, rates: [30000] });
  check('Dũng day wage block', slip('Dung')?.dayWage, { days: 21, amount: 5040000, rates: [240000] });
  check('Em day wage block', slip('Em')?.dayWage, { days: 12, amount: 3120000, rates: [260000] });
  check('Giang settled 16/11 equals her slip after month close', pick(giangSettled), pick(slip('Giang')));

  // ── Số đã chốt = số tính lại bây giờ (máy chủ) = số trang Lương tự tính.
  const m = await payrollMonth.loadPayrollMonth(fakeDb(state), 2026, 11, '2026-12-01');
  const everyone = [...STAFF, PHAT];
  const liveOf = p => payroll.computeSalary({ year: 2026, month: 11, staffId: p.id, sessions: m.sessions.filter(s => s.staff_id === p.id), config: m.configs.find(c => c.staff_id === p.id),
    requests: m.requests.filter(r => r.staff_id === p.id), violations: m.violations.filter(v => v.staff_id === p.id), bonuses: m.bonuses.filter(b => b.staff_id === p.id), rules: m.rules,
    reviews: m.reviews, hourlyRates: m.hourlyRates.filter(r => r.staff_id === p.id), lateRules: payroll.lateRulesOf(m.lateRules, p.id),
    ...payroll.holidayArgs(m.staff.find(x => x.id === p.id), m) });
  const full = s => { const { byDay, daily, name, ...rest } = s; return rest; };
  for (const p of everyone) check(`snapshot = live ${p.full_name}`, full(slip(p.full_name)), JSON.parse(JSON.stringify(full(liveOf(p)))));

  // Trang Lương: dữ liệu ?payroll=1 + ?checkin=1 + các bảng trang đọc thẳng, cùng calcSalary như page.js.
  const pm = await ownerGet(CLOSE + 60000, 'payroll=1&year=2026&month=11');
  const ck = await ownerGet(CLOSE + 60000, 'checkin=1');
  const pageRules = ck.settings, reviewList = [...(ck.reviews || []), ...(pm.reviews || [])];
  const vnTodayPage = '2026-12-01';
  const monthClosedDays = payroll.shopClosedDays({ rules: pm.closedRules, rows: pm.closedRows, from: '2026-11-01', to: '2026-11-30' < vnTodayPage ? '2026-11-30' : vnTodayPage });
  const attendanceRows = state.attendance_sessions.filter(a => a.date >= '2026-11-01' && a.date <= '2026-12-01');
  const attendance = attendanceRows.filter(a => rules.workDayOf(a, pageRules).slice(0, 7) === '2026-11');
  const pageCalc = id => payroll.computeSalary({ year: 2026, month: 11, staffId: id, sessions: attendance.filter(a => a.staff_id === id), config: state.payroll_config.find(c => c.staff_id === id) || null,
    requests: state.payroll_requests.filter(r => r.staff_id === id), violations: state.payroll_violations.filter(v => v.staff_id === id && v.month === 11 && v.year === 2026),
    bonuses: pm.bonuses.filter(b => b.staff_id === id), rules: pageRules, reviews: reviewList, hourlyRates: pm.hourlyRates.filter(r => r.staff_id === id),
    lateRules: payroll.lateRulesOf(pm.lateRules, id),
    ...payroll.holidayArgs(state.staff.find(x => x.id === id) || { id }, { closedDays: monthClosedDays, holidayPay: pm.holidayPay, departures: ck.departures || [], returns: pm.returns || [] }) });
  for (const p of everyone) check(`page calc = snapshot ${p.full_name}`, JSON.parse(JSON.stringify(full(pageCalc(p.id)))), full(slip(p.full_name)));

  // ── Thống kê sau khi chốt.
  const stats = await ownerGet(CLOSE + 120000, 'stats=1&year=2026&month=11');
  const sumNet = Object.values(expected).reduce((a, x) => a + x.net, 0);
  check('stats net total', stats.totals.net, sumNet);
  check('stats pending fines after decisions', stats.pending.fines, 0);
  check('stats advances', stats.totals.advances, 1500000 + 300000 + 2000000);

  // ── Sổ thu chi: tiền từng ngày cả quán = tổng phiếu (không tính ứng), thưởng − phạt ở monthExtra.
  const cost = payroll.payrollCost({ year: 2026, month: 11, ...m });
  const book = Object.values(cost.byDay).reduce((a, x) => a + x, 0);
  const gross = Object.values(expected).reduce((a, x) => a + x.basePay - x.lateAmt - x.earlyAmt + x.otAmt, 0);
  check('finance book days = Σ(basePay − late − early + OT)', book, gross);
  // Từng người: tiền các ngày trong Sổ thu chi = phiếu của người đó (không tính ứng / thưởng / phạt).
  for (const p of everyone) {
    const live = liveOf(p), days = Object.values(live.byDay).reduce((a, x) => a + x, 0);
    check(`finance book days = slip gross, ${p.full_name}`, days, live.basePay - live.lateAmt - live.earlyAmt + live.otAmt);
  }
  check('finance book monthExtra = bonus − fines', cost.monthExtra, 300000 - 30000 - 50000);
  check('finance book + extra = Σ(net + advances)', book + cost.monthExtra, Object.values(expected).reduce((a, x) => a + x.net + x.advAmt, 0));
  // Từng ngày một số ngày đặc biệt.
  check('book 9/11 (closed): An 300k, Bình 300k, Em 300k, Hoa 300k, Giang 269.231, Dũng 120k',
    cost.byDay['2026-11-09'], 4 * W + 269231 + 120000);
  check('book 17/11 (manual closed): An, Bình, Hoa, Phát monthly', cost.byDay['2026-11-17'], 4 * W);
  check('book 10/11: An, Bình, Em, Hoa 300k; Giang 269.231; Dũng 240k; Cường 485 or 480 min', cost.byDay['2026-11-10'], 4 * W + 269231 + 240000 + 480 * 500);

  if (diffs.length) console.log(`\n${diffs.length} mismatch(es):\n  ${diffs.join('\n  ')}`);
  if (process.env.SIM_DUMP) {
    console.log('Khoa daily', JSON.stringify(liveOf(KHOA).daily.filter(d => ['2026-11-09', '2026-11-17', '2026-11-22', '2026-11-23'].includes(d.day)).map(d => ({ day: d.day, holiday: d.holiday, early: d.early, inShiftMin: d.inShiftMin, extraMin: d.extraMin, pay: d.pay }))));
    console.log('Khoa row', JSON.stringify(state.attendance_sessions.find(s => s.staff_id === KHOA.id && s.clock_in === iso(T(22, '14:00')))));
    for (const p of everyone) console.log(p.full_name, JSON.stringify(pick(slip(p.full_name))));
    console.log('byDay', JSON.stringify(cost.byDay));
  }
  assert.deepEqual(diffs, []);
});
