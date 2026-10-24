// Giả lập quán chạy trọn tháng 11/2026 với 6 người, qua đúng code máy chủ (máy quầy,
// quét mã, tự đóng ca, duyệt, chốt lương), rồi so lương từng người với số tính tay.
//   An   — mẫu mực: đi đúng giờ, về đúng giờ (lệch trong 10 phút), nghỉ 4 ngày.
//   Bình — hay đi trễ (1 lần trễ 9 phút không tính), bị phạt, ứng 1 triệu.
//   Chi  — hay ở lại (cho tính / không tính / chưa duyệt), quên ra ca 3 lần, xin sửa giờ,
//          đêm 30/11 quay lại dọn quán sau nửa đêm (ghi ngày 1/12 nhưng thuộc lương tháng 11).
//   Dũng — ca đêm riêng 18:00–01:00, nghỉ giữa ca, nửa ngày, ra vào lại sau nửa đêm để dọn.
//   Em   — vào làm từ 10/11, ứng quá tay, nghỉ việc 25/11, kết toán ngay hôm đó.
//   Phát — đổi ca riêng từ 15/11, nghỉ không báo 2 ngày, nghỉ có đơn 2 ngày, quét khác wifi / máy lạ.
// Giữa tháng (20/11) quán đổi giờ đóng cửa 23:00 → 23:30.
// Sáng 1/12 chủ xử lý gợi ý phạt (trễ quá 30 phút, quên ra ca), duyệt thưởng chuyên cần
// (mức gợi ý 300.000đ, ít nhất 22 ngày công; sửa tiền từng người) rồi chốt lương.
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
import { staffBlock } from '../src/lib/dailyInsights.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const SECRET = 'service-role-test-key'.repeat(2);
const SHOP_IP = '113.161.1.2', HOME_IP = '14.1.2.3';
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n, name, role = 'staff') => ({ id: uid(n), full_name: name, role, phone: `ph_${name.toLowerCase()}`.padEnd(24, 'x') });
const OWNER = person(1, 'Chu', 'admin');
const AN = person(2, 'An'), BINH = person(3, 'Binh'), CHI = person(4, 'Chi'), DUNG = person(5, 'Dung'), EM = person(6, 'Em'), PHAT = person(7, 'Phat');
const STAFF = [AN, BINH, CHI, DUNG, EM, PHAT];

// Giờ Việt Nam của ngày `day` tháng 11/2026; "01:00+1" = 1 giờ sáng hôm sau.
const T = (day, hm) => {
  const next = hm.endsWith('+1') ? 1 : 0;
  const [h, m] = hm.replace('+1', '').split(':').map(Number);
  return Date.UTC(2026, 10, day + next, h - 7, m);
};
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
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...departure, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
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

test('a whole month for six people: every pay slip matches the numbers worked out by hand', async () => {
  const state = {
    staff: [OWNER, ...STAFF].map(({ phone, ...p }) => p),
    payroll_config: STAFF.map(p => ({ staff_id: p.id, base_salary: 5200000, overtime_rate: 30000 })),
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }],
    payroll_fine_rules: [
      { id: uid(901), name: 'Đi trễ quá 30 phút', amount: 50000, kind: 'late', active: true, sort: 1 },
      { id: uid(902), name: 'Quên bấm ra ca', amount: 30000, kind: 'forgot', active: true, sort: 2 },
    ],
    __clock: () => env.now,
  };
  const api = compile('../src/app/api/admin/workforce/route.js', state);
  const kioskApi = compile('../src/app/api/checkin/kiosk/route.js', state);
  const plain = v => JSON.parse(JSON.stringify(v));
  const as = (user, time) => { env.user = user; env.now = time; };
  const ownerPost = async (time, body) => { as(OWNER, time); return plain(await api.POST({ json: async () => body, headers: new Map() })); };
  const ownerGet = async (time, query) => { as(OWNER, time); return plain(await api.GET({ url: `http://x/api/admin/workforce?${query}` })).body; };
  const staffPost = async (p, time, body, ip = SHOP_IP, phone = p.phone) => {
    as(p, time);
    return plain(await api.POST({ json: async () => body, headers: new Map([['cf-connecting-ip', ip]]), cookies: { get: k => (k === token.DEVICE_COOKIE ? { value: phone } : undefined) } }));
  };

  // Máy quầy bật lúc 8h ngày 1/11, luôn ở wifi quán.
  as(OWNER, T(1, '08:00'));
  const activated = await kioskApi.POST({ json: async () => ({ action: 'activate', name: 'Quầy' }), headers: new Map([['cf-connecting-ip', SHOP_IP]]), url: 'https://x' });
  const kioskCookie = activated.setCookies[token.KIOSK_COOKIE];
  const qr = async time => {
    as(null, time);
    return plain(await kioskApi.GET({ url: 'https://x/api/checkin/kiosk', headers: new Map([['cf-connecting-ip', SHOP_IP]]),
      cookies: { get: k => (k === token.KIOSK_COOKIE ? { value: kioskCookie } : undefined) } })).body.token;
  };
  const results = [];
  const scan = async (p, time, opts = {}) => {
    const r = await staffPost(p, time, { action: 'clock', token: await qr(time) }, opts.ip, opts.phone);
    results.push({ who: p.full_name, at: iso(time), status: r.status, clocked: r.body.clocked, error: r.body.error, sessions: r.body.sessions });
    return r;
  };

  // ── Lịch từng người: [vào, ra] (ra = null là quên ra ca); nhiều cặp = ra vào giữa ca.
  const events = [];
  const add = (time, fn) => events.push({ time, fn });
  const work = (p, day, pairs, opts = {}) => {
    for (const [inAt, outAt] of pairs) {
      add(T(day, inAt), () => scan(p, T(day, inAt), opts));
      if (outAt) add(T(day, outAt), () => scan(p, T(day, outAt), opts));
    }
  };
  const days = (from, to, skip = []) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter(d => !skip.includes(d));
  const SUNDAYS = [1, 8, 15, 22, 29];
  const close = d => (d >= 20 ? '23:30' : '23:00');

  // An: lệch vài phút (trong 10 phút cho lệch) cả lúc vào lẫn lúc ra.
  const anIn = ['13:52', '14:00', '14:05', '14:08', '13:58'], anOut = [['22:55', '23:00', '23:05', '23:02', '22:58'], ['23:25', '23:30', '23:35', '23:32', '23:28']];
  days(1, 30, [8, 15, 22, 29]).forEach((d, i) => work(AN, d, [[anIn[i % 5], anOut[d >= 20 ? 1 : 0][i % 5]]]));

  // Bình: trễ 8 lần (ngày 19 trễ 9 phút, trong mức cho lệch).
  const binhLate = { 3: '14:25', 5: '14:15', 10: '14:40', 12: '14:11', 17: '15:00', 19: '14:09', 24: '14:30', 26: '14:20' };
  days(2, 30, SUNDAYS).forEach(d => work(BINH, d, [[binhLate[d] || '14:00', close(d)]]));
  add(T(11, '14:01'), () => scan(BINH, T(11, '14:01'))); // lỡ quét 2 lần liền

  // Chi: ở lại, quên ra ca ngày 9, 13, 25.
  const chiOut = { 2: '23:45', 4: '23:30', 6: '23:50', 20: '00:10+1', 9: null, 13: null, 25: null };
  days(1, 30, [8, 15, 22, 29]).forEach(d => work(CHI, d, [['14:00', d in chiOut ? chiOut[d] : close(d)]]));
  work(CHI, 30, [['00:20+1', '00:50+1']]); // quay lại dọn quán: 30 phút ngoài ca, chưa duyệt

  // Dũng: ca riêng 18:00–01:00 từ đầu tháng.
  add(T(1, '09:00'), () => ownerPost(T(1, '09:00'), { action: 'save_shift', staff_id: DUNG.id, start_time: '18:00', end_time: '01:00' }));
  const dungSpecial = {
    5: [['18:00', '21:00'], ['21:30', '01:00+1']],
    12: [['18:00', '21:00']],
    19: [['17:55', '01:20+1']],
    26: [['18:00', '00:30+1'], ['00:40+1', '01:30+1']],
    28: [['18:00', '00:30+1'], ['00:40+1', '01:15+1']],
  };
  days(2, 28, [8, 15, 22]).forEach(d => work(DUNG, d, dungSpecial[d] || [['17:55', '01:00+1']]));

  // Em: vào làm từ 10/11 tới 25/11.
  days(10, 25, [15, 22]).forEach(d => work(EM, d, [['14:00', close(d)]]));

  // Phát: ca riêng 17:00–23:00 từ 15/11; vắng 4 và 18 không báo, nghỉ có đơn 24–25.
  add(T(15, '10:00'), () => ownerPost(T(15, '10:00'), { action: 'save_shift', staff_id: PHAT.id, start_time: '17:00', end_time: '23:00' }));
  days(2, 28, [8, 15, 22, 4, 18, 24, 25]).forEach(d => {
    const pair = [[d < 15 ? '14:00' : '16:58', '23:00']];
    if (d === 6 || d === 7) work(PHAT, d, pair, { ip: HOME_IP });
    else if (d === 9) work(PHAT, d, pair, { phone: 'ph_other_phonexxxxxxxxxx' });
    else work(PHAT, d, pair);
  });

  // Chủ quán tự chấm (không cần mã) ngày 2/11.
  add(T(2, '14:00'), () => ownerPost(T(2, '14:00'), { action: 'clock' }));
  add(T(2, '23:00'), () => ownerPost(T(2, '23:00'), { action: 'clock' }));

  // Thưởng chuyên cần: chủ đặt mức gợi ý 300.000đ, ít nhất 22 ngày công.
  add(T(1, '09:05'), () => ownerPost(T(1, '09:05'), { action: 'save_bonus_settings', bonus_amount: '300.000', bonus_min_days: '22' }));

  // Giờ đóng cửa đổi thành 23:30 từ 20/11.
  add(T(20, '10:00'), () => ownerPost(T(20, '10:00'), { action: 'save_checkin_settings', closing_time: '23:30' }));

  // Đơn từ của nhân viên.
  add(T(10, '09:00'), () => staffPost(PHAT, T(10, '09:00'), { action: 'request', type: 'advance', amount: '500.000', reason: 'tiền nhà' }));
  add(T(15, '09:00'), () => staffPost(BINH, T(15, '09:00'), { action: 'request', type: 'advance', amount: '1.000.000', reason: 'về quê' }));
  add(T(18, '09:00'), () => staffPost(EM, T(18, '09:00'), { action: 'request', type: 'advance', amount: '3.000.000', reason: 'đóng học' }));
  add(T(20, '09:00'), () => staffPost(PHAT, T(20, '09:00'), { action: 'request', type: 'advance', amount: '1.000.000', reason: 'mua xe' }));
  add(T(20, '09:05'), () => staffPost(PHAT, T(20, '09:05'), { action: 'request', type: 'absent', from_date: '2026-11-24', to_date: '2026-11-25', reason: 'đám cưới' }));
  const sessionOf = (p, day) => state.attendance_sessions.find(s => s.staff_id === p.id && s.date === `2026-11-${String(day).padStart(2, '0')}`);
  add(T(10, '10:00'), () => staffPost(CHI, T(10, '10:00'), { action: 'request_fix', attendance_id: sessionOf(CHI, 9).id, clock_out: iso(T(9, '23:40')), reason: 'quên bấm, dọn tới 23:40' }));
  add(T(14, '10:00'), () => staffPost(CHI, T(14, '10:00'), { action: 'request_fix', attendance_id: sessionOf(CHI, 13).id, clock_out: iso(T(13, '23:20')), reason: 'quên bấm' }));

  // Chủ quán duyệt mỗi sáng: giờ ngoài ca theo kế hoạch, đơn sửa giờ, đơn ứng / nghỉ, phạt.
  const extraPlan = { [`${CHI.id}2026-11-02`]: 'approved', [`${CHI.id}2026-11-04`]: 'rejected', [`${CHI.id}2026-11-09`]: 'approved', [`${CHI.id}2026-11-20`]: 'approved',
    [`${DUNG.id}2026-11-19`]: 'approved', [`${DUNG.id}2026-11-26`]: 'approved', [`${DUNG.id}2026-11-28`]: 'approved' };
  const fixPlan = { '2026-11-09': 'approved', '2026-11-13': 'rejected' };
  const requestPlan = { 'tiền nhà': 'approved', 'về quê': 'approved', 'đóng học': 'approved', 'mua xe': 'rejected', 'đám cưới': 'approved' };
  for (const d of days(2, 30)) add(T(d, '10:30'), async () => {
    const view = await ownerGet(T(d, '10:30'), 'checkin=1');
    for (const f of view.fixes.filter(x => x.status === 'pending')) {
      const s = state.attendance_sessions.find(x => x.id === f.attendance_id);
      if (fixPlan[s.date]) await ownerPost(T(d, '10:31'), { action: 'decide_fix', id: f.id, status: fixPlan[s.date] });
    }
    const again = await ownerGet(T(d, '10:32'), 'checkin=1');
    for (const x of again.extras) {
      const plan = extraPlan[`${x.staff_id}${x.date}`];
      if (plan) await ownerPost(T(d, '10:33'), { action: 'decide_extra', attendance_id: x.attendance_id, status: plan });
    }
    for (const r of (state.payroll_requests || []).filter(x => x.status === 'pending')) {
      if (requestPlan[r.reason]) await ownerPost(T(d, '10:34'), { action: 'decide_request', id: r.id, status: requestPlan[r.reason] });
    }
  });
  add(T(21, '23:10'), () => ownerPost(T(21, '23:10'), { action: 'add_violation', staff_id: PHAT.id, amount: '50.000', reason: 'làm vỡ ly', month: 11, year: 2026 }));
  add(T(27, '22:00'), () => ownerPost(T(27, '22:00'), { action: 'add_violation', staff_id: BINH.id, amount: '100.000', reason: 'đi trễ nhiều', month: 11, year: 2026 }));

  // Em nghỉ việc 25/11: kết toán và trả ngay tối đó.
  add(T(25, '23:45'), () => ownerPost(T(25, '23:45'), { action: 'staff_depart', staff_id: EM.id, last_day: '2026-11-25', reason: 'đi học' }));
  add(T(25, '23:50'), () => ownerPost(T(25, '23:50'), { action: 'close_month', year: 2026, month: 11, staff_id: EM.id }));
  add(T(25, '23:55'), () => ownerPost(T(25, '23:55'), { action: 'mark_paid', year: 2026, month: 11, staff_id: EM.id }));

  // ── Chạy cả tháng theo thứ tự giờ.
  events.sort((a, b) => a.time - b.time);
  for (const e of events) await e.fn();

  // ── Ca đêm: vào lại lúc 00:40 để dọn quán thì màn hình hiện chung ca 28/11, không báo trễ.
  const reentry = results.find(r => r.who === 'Dung' && r.at === iso(T(28, '00:40+1')));
  assert.deepEqual(reentry.sessions.map(s => s.clock_in), [iso(T(28, '18:00')), iso(T(28, '00:40+1'))]);
  as(DUNG, T(28, '00:45+1'));
  const me = plain(await api.GET({ url: 'http://x/api/admin/workforce?me=1' })).body;
  assert.deepEqual(me.sessions.map(s => s.clock_in), [iso(T(28, '18:00')), iso(T(28, '00:40+1'))], '"hôm nay" lúc 00:45 vẫn là ca 28/11');
  assert.equal(rules.dayFlags(reentry.sessions, me.rules).late, 0);
  assert.equal(rules.shiftOf(me.rules, DUNG.id, rules.workDayOf(reentry.sessions[1], me.rules)).start, '18:00');
  assert.deepEqual([me.bonus.late, me.bonus.forgot, me.bonus.minDays, me.bonus.approved], [0, 0, 22, null], 'Dũng thấy mình đang giữ được chuyên cần');

  // Báo cáo Zalo mỗi ngày: lượt dọn quán sau nửa đêm nằm ở ngày của ca.
  const names = Object.fromEntries(STAFF.map(p => [p.id, p.full_name]));
  const near = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const report = date => staffBlock({ sessions: state.attendance_sessions.filter(s => s.date >= near(date, -1) && s.date <= near(date, 1)),
    settings: state.checkin_settings[0], shifts: state.staff_shifts, hours: state.checkin_hours, reviews: state.attendance_extra_reviews, staffNames: names, date });
  const line = (text, name) => text.split('\n').find(l => l.startsWith(`• ${name}:`));
  assert.equal(line(report('2026-11-29'), 'Dung'), undefined, '29/11 Dũng nghỉ: lượt 00:40–01:15 thuộc ca 28/11');
  assert.equal(line(report('2026-11-28'), 'Dung'), '• Dung: 18:00–00:30, 00:40–01:15 (7,1 giờ) ⚠ ở lại 15 phút');
  // Ở lại 30 phút (00:20–00:50), không phải 1 giờ 20 phút tính từ 23:30: lúc vắng không tính.
  assert.equal(line(report('2026-11-30'), 'Chi'), '• Chi: 14:00–23:30, 00:20–00:50 (9,5 giờ) ⚠ ở lại 30 phút');
  assert.equal(line(report('2026-12-01'), 'Chi'), undefined);

  // ── Sáng 1/12: chủ xem gợi ý phạt và thưởng chuyên cần (như trang Lương tính), tự điền tiền, rồi chốt.
  const DEC1 = Date.UTC(2026, 11, 1, 2, 0);
  const waiting = await ownerGet(DEC1, 'stats=1&year=2026&month=11');
  const ws = name => waiting.people.find(p => p.name === name);
  assert.deepEqual(STAFF.map(p => [p.full_name, ws(p.full_name).bonus.eligible]), [['An', true], ['Binh', false], ['Chi', false], ['Dung', true], ['Em', false], ['Phat', false]]);
  assert.deepEqual([ws('Binh').bonus.reasons, ws('Chi').bonus.reasons, ws('Em').bonus.reasons, ws('Phat').bonus.reasons],
    [['trễ 7 lần'], ['quên ra ca 3 lần'], ['nghỉ việc', '14/22 ngày công'], ['20/22 ngày công']]);
  assert.deepEqual([waiting.pending.fines, waiting.pending.bonuses], [5, 2]);
  const month = await ownerGet(DEC1, 'payroll=1&year=2026&month=11');
  const R = rules.normalizeRules(state.checkin_settings[0], state.staff_shifts, state.checkin_hours);
  const inMonth = state.attendance_sessions.filter(s => rules.workDayOf(s, R).slice(0, 7) === '2026-11');
  const hints = STAFF.flatMap(p => payroll.fineSuggestions({ staffId: p.id, reviews: month.fineReviews,
    tallies: payroll.monthTallies({ sessions: inMonth.filter(s => s.staff_id === p.id), rules: R, key: '2026-11', autoClosed: month.autoClosed }) }));
  // Bình trễ quá 30 phút 2 lần (24/11 trễ đúng 30 phút thì không), Chi quên ra ca 3 lần.
  assert.deepEqual(hints.map(h => [names[h.staff_id], h.kind, h.day]),
    [['Binh', 'late', '2026-11-10'], ['Binh', 'late', '2026-11-17'], ['Chi', 'forgot', '2026-11-09'], ['Chi', 'forgot', '2026-11-13'], ['Chi', 'forgot', '2026-11-25']]);
  // Phạt trễ 50.000đ, quên ra ca 30.000đ; bỏ qua ngày 9 của Chi (đã xin sửa giờ và được duyệt).
  for (const h of hints) {
    const decision = h.kind === 'late' ? { status: 'fined', amount: '50.000' } : h.day === '2026-11-09' ? { status: 'skipped' } : { status: 'fined', amount: '30.000' };
    assert.equal((await ownerPost(DEC1 + 60000, { action: 'decide_fine', attendance_id: h.attendance_id, kind: h.kind, ...decision })).status, 200);
  }
  // Thưởng: An theo mức gợi ý, Dũng chủ sửa còn 250.000đ.
  assert.equal((await ownerPost(DEC1 + 120000, { action: 'decide_bonus', staff_id: AN.id, year: 2026, month: 11, amount: '300.000' })).status, 200);
  assert.equal((await ownerPost(DEC1 + 120000, { action: 'decide_bonus', staff_id: DUNG.id, year: 2026, month: 11, amount: '250.000' })).status, 200);
  const stats = await ownerGet(DEC1 + 180000, 'stats=1&year=2026&month=11');
  assert.deepEqual([stats.pending.fines, stats.pending.bonuses], [0, 0]);
  const closed = await ownerPost(DEC1 + 240000, { action: 'close_month', year: 2026, month: 11 });
  assert.equal(closed.status, 200);
  const slip = p => state.payroll_closes.find(c => c.staff_id === p.id && c.month === 11)?.snapshot;
  const show = s => s && { units: s.workUnits, basePay: s.basePay, earlyAmt: s.earlyAmt, otHours: s.otHours, otAmt: s.otAmt, pendingH: s.pendingH, bonusAmt: s.bonusAmt, advAmt: s.advAmt, vioAmt: s.vioAmt, absDays: s.absDays, net: s.net };
  assert.deepEqual(state.payroll_violations.filter(v => v.staff_id === CHI.id).map(v => v.reason), ['Quên bấm ra ca (13/11)', 'Quên bấm ra ca (25/11)']);

  // Không có lần quét nào bị lỗi ngoài lần Bình lỡ quét 2 lần liền.
  assert.deepEqual(results.filter(r => r.status !== 200).map(r => [r.who, r.at, r.status]), [['Binh', iso(T(11, '14:01')), 409]]);

  // Số tính tay (lương cơ bản 5.200.000đ = 200.000đ/ngày công, tăng ca 30.000đ/giờ = 500đ/phút).
  assert.deepEqual(show(slip(AN)), { units: 26, basePay: 5200000, earlyAmt: 0, otHours: 0, otAmt: 0, pendingH: 0, bonusAmt: 300000, advAmt: 0, vioAmt: 0, absDays: 0, net: 5500000 }, 'An: thưởng chuyên cần 300.000đ');
  assert.deepEqual(show(slip(BINH)), { units: 25, basePay: 5000000, earlyAmt: 0, otHours: 0, otAmt: 0, pendingH: 0, bonusAmt: 0, advAmt: 1000000, vioAmt: 200000, absDays: 0, net: 3800000 }, 'Bình: phạt tay 100.000đ + 2 lần trễ quá 30 phút');
  assert.deepEqual(show(slip(CHI)), { units: 26, basePay: 5200000, earlyAmt: 0, otHours: 2.1, otAmt: 62500, pendingH: 1.3, bonusAmt: 0, advAmt: 0, vioAmt: 60000, absDays: 0, net: 5202500 }, 'Chi: 45 + 40 + 40 phút cho tính, 50 + 30 phút chưa duyệt, 2 lần quên ra ca bị phạt');
  assert.deepEqual(show(slip(DUNG)), { units: 23.5, basePay: 4700000, earlyAmt: 14286, otHours: 1.1, otAmt: 32500, pendingH: 0, bonusAmt: 250000, advAmt: 0, vioAmt: 0, absDays: 0, net: 4968214 },
    'Dũng: 24 ngày, 1 nửa ngày (12/11 về sớm 4 giờ trên ca 7 giờ: được 200.000 × 3/7 = 85.714đ thay vì nửa ngày → trừ 14.286đ), ra vào lại sau nửa đêm không thành ngày công mới; thưởng 250.000đ');
  assert.deepEqual(show(slip(EM)), { units: 14, basePay: 2800000, earlyAmt: 0, otHours: 0, otAmt: 0, pendingH: 0, bonusAmt: 0, advAmt: 3000000, vioAmt: 0, absDays: 0, net: -200000 }, 'Em: kết toán 25/11, còn nợ quán 200.000đ');
  assert.deepEqual(show(slip(PHAT)), { units: 20, basePay: 4000000, earlyAmt: 0, otHours: 0, otAmt: 0, pendingH: 0, bonusAmt: 0, advAmt: 500000, vioAmt: 50000, absDays: 2, net: 3450000 }, 'Phát: đổi ca 15/11 không tính lại ngày cũ');
  assert.ok(state.payroll_closes.find(c => c.staff_id === EM.id).paid_at, 'Em đã được trả khi nghỉ');
  assert.equal(state.payroll_closes.find(c => c.staff_id === EM.id).closed_at, iso(T(25, '23:50')), 'chốt cả tháng giữ nguyên số đã kết toán của Em');

  // Thống kê tháng.
  const st = name => stats.people.find(p => p.name === name);
  assert.deepEqual([st('Binh').late.count, st('Binh').late.minutes], [7, 201], 'Bình trễ 7 lần (lần 9 phút không tính)');
  assert.equal(st('Chi').forgot, 3);
  assert.deepEqual([st('Dung').late.count, st('Dung').leftEarly.count], [0, 1], 'ca đêm: không báo trễ sai, về sớm đúng 1 lần (nửa ngày)');
  assert.deepEqual([st('Phat').warnings, st('An').late.count, st('An').stayed.count, st('An').early.count], [6, 0, 0, 0], 'Phát: 3 ngày khác wifi / máy lạ = 6 lần quét bị cảnh báo (vào + ra)');
  assert.equal(stats.totals.gross, 5200000 + 5000000 + 5262500 + 4732500 - 14286 + 2800000 + 4000000 + 300000 + 250000);
  assert.equal(stats.totals.earlyCuts, 14286);
  assert.deepEqual([stats.totals.bonuses, stats.totals.fines], [550000, 100000 + 100000 + 60000 + 50000]);
  assert.equal(await departure.hasLeft(fakeDb(state), EM.id, '2026-11-26'), true, 'Em không đăng nhập được nữa từ 26/11');

  // Tháng 12: lượt ghi ngày 1/12 của ca 30/11 không thành ngày công tháng 12.
  const dec = await ownerGet(Date.UTC(2026, 11, 1, 2, 30), 'stats=1&year=2026&month=12');
  const chiDec = dec.people.find(p => p.name === 'Chi').salary;
  assert.deepEqual([chiDec.workUnits, chiDec.pendingH, chiDec.totalWorkH], [0, 0, 0]);
});
