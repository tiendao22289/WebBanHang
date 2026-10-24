// Cả quy trình chấm công → lương → nghỉ việc chạy liền một mạch, ở các giờ cố định của
// tháng 11/2026 (tháng tính theo ngày công): bật máy quầy, quét mã, đi trễ, ở lại, quên ra
// ca, xin sửa giờ, duyệt giờ ngoài ca, ứng lương, báo nghỉ, phạt, chốt lương, đã trả,
// thống kê, cho nghỉ việc.
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

const SECRET = 'service-role-test-key'.repeat(2);
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const PHAT = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Phát', role: 'staff' };
const SHOP_IP = '113.161.1.2', PHONE = 'P'.repeat(24);
const strip = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const workforceSource = strip('../src/app/api/admin/workforce/route.js');
const kioskSource = strip('../src/app/api/checkin/kiosk/route.js');
const plain = v => JSON.parse(JSON.stringify(v));
const at = (day, hm) => Date.parse(`2026-11-${day}T${hm}:00+07:00`);

// Chạy route ở một giờ cố định (`now`), với người đang đăng nhập `user`.
function context(state, user, now) {
  class FixedDate extends Date {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }
  const NextResponse = { json: (body, init = {}) => {
    const res = { status: init.status || 200, body };
    Object.defineProperty(res, 'cookies', { value: { set: (k, v) => { res.setCookies = { ...res.setCookies, [k]: v }; } }, enumerable: false });
    return res;
  } };
  return {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...departure, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
    Date: FixedDate, STATUS_COOKIE: 'local_admin_session',
    kioskQrToken: (s, id) => token.kioskQrToken(s, id, now),
    readKioskQrToken: (t, s) => token.readKioskQrToken(t, s, now),
    readKioskCookie: (v, s) => token.readKioskCookie(v, s, now),
    onKioskNetwork: (ip, k) => rules.onKioskNetwork(ip, k, now),
    rememberIp: (list, ip) => rules.rememberIp(list, ip, now),
    closeForgottenSessions: (db, r, id) => rules.closeForgottenSessions(db, r, id, now),
    console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: SECRET } },
    getStaffSession: async () => (user ? { code: 200, user } : { code: 401 }),
    staffDatabase: () => fakeDb(state), statusDatabase: () => fakeDb(state),
  };
}
const workforce = (state, user, now) => vm.runInNewContext(`${workforceSource}\n({ GET, POST })`, context(state, user, now));
const kiosk = (state, user, now) => vm.runInNewContext(`${kioskSource}\n({ GET, POST })`, context(state, user, now));
const phone = (body, ip = SHOP_IP) => ({ json: async () => body, headers: new Map([['cf-connecting-ip', ip], ['user-agent', 'iPhone']]),
  cookies: { get: k => (k === token.DEVICE_COOKIE ? { value: PHONE } : undefined) } });
const post = async (api, body, ip) => { const res = await api.POST(phone(body, ip)); return { ...plain(res), setCookies: res.setCookies }; };
const get = async (api, query) => plain(await api.GET({ url: `http://x/api/admin/workforce?${query}` }));

test('the whole flow: scan, late, forgot, fix, approvals, requests, pay, close, paid, stats, leaving', async () => {
  const state = {
    staff: [{ ...ADMIN }, { ...PHAT }],
    payroll_config: [{ staff_id: PHAT.id, base_salary: 5200000, overtime_rate: 30000 }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }],
  };

  // 1. Chủ quán bật máy quầy; máy quầy lấy mã QR (máy chủ nhớ wifi quán).
  const activated = await kiosk(state, ADMIN, at('02', '13:00')).POST({ json: async () => ({ action: 'activate', name: 'Quầy' }),
    headers: new Map([['cf-connecting-ip', SHOP_IP]]), url: 'https://x/api/checkin/kiosk' });
  assert.equal(activated.status, 200);
  const kioskCookie = activated.setCookies[token.KIOSK_COOKIE];
  const qrAt = async now => plain(await kiosk(state, null, now).GET({ url: 'https://x/api/checkin/kiosk', headers: new Map([['cf-connecting-ip', SHOP_IP]]),
    cookies: { get: k => (k === token.KIOSK_COOKIE ? { value: kioskCookie } : undefined) } })).body.token;

  // 2. Ngày 2/11: vào 14:25 (trễ 25 phút), ra 23:40 (ở lại 40 phút).
  let r = await post(workforce(state, PHAT, at('02', '14:25')), { action: 'clock', token: await qrAt(at('02', '14:25')) });
  assert.deepEqual([r.status, r.body.clocked, r.body.warnings], [200, 'in', []]);
  assert.equal(state.staff_checkin_devices[0].device_id, PHONE, 'first scan registers the phone');
  r = await post(workforce(state, PHAT, at('02', '23:40')), { action: 'clock', token: await qrAt(at('02', '23:40')) });
  assert.equal(r.body.clocked, 'out');

  // 3. Ngày 3/11: vào 13:55 (trong 10 phút cho lệch) rồi quên ra ca.
  r = await post(workforce(state, PHAT, at('03', '13:55')), { action: 'clock', token: await qrAt(at('03', '13:55')) });
  assert.equal(r.body.clocked, 'in');

  // 4. Sáng 4/11 mở trang: ca 3/11 đã tự đóng lúc 23:00 → xin sửa thành 23:30.
  const me4 = (await get(workforce(state, PHAT, at('04', '10:00')), 'me=1')).body;
  const day3 = state.attendance_sessions.find(s => s.date === '2026-11-03');
  assert.equal(day3.clock_out, new Date(at('03', '23:00')).toISOString());
  assert.deepEqual(me4.auto_closed, [day3.id]);
  r = await post(workforce(state, PHAT, at('04', '10:01')), { action: 'request_fix', attendance_id: day3.id, clock_out: new Date(at('03', '23:30')).toISOString(), reason: 'dọn quán tới 23:30' });
  assert.equal(r.status, 200);

  // 5. Ứng lương 500.000đ và báo nghỉ 10–11/11.
  assert.equal((await post(workforce(state, PHAT, at('04', '10:05')), { action: 'request', type: 'advance', amount: '500.000', reason: 'tiền nhà' })).status, 200);
  assert.equal((await post(workforce(state, PHAT, at('04', '10:06')), { action: 'request', type: 'absent', from_date: '2026-11-10', to_date: '2026-11-11', reason: 'về quê' })).status, 200);

  // 6. Chủ quán duyệt: đơn sửa giờ, giờ ngoài ca 2 ngày, ứng, nghỉ; thêm phạt đi trễ.
  const owner = now => workforce(state, ADMIN, now);
  const overview = (await get(owner(at('04', '11:00')), 'checkin=1')).body;
  assert.equal(overview.fixes.filter(f => f.status === 'pending').length, 1);
  assert.equal((await post(owner(at('04', '11:01')), { action: 'decide_fix', id: overview.fixes[0].id, status: 'approved' })).status, 200);
  assert.equal(day3.clock_out, new Date(at('03', '23:30')).toISOString());
  const extras = (await get(owner(at('04', '11:02')), 'checkin=1')).body.extras;
  assert.deepEqual(extras.map(x => [x.date, x.early_minutes, x.stay_minutes]).sort(), [['2026-11-02', 0, 40], ['2026-11-03', 0, 30]]);
  for (const x of extras) assert.equal((await post(owner(at('04', '11:03')), { action: 'decide_extra', attendance_id: x.attendance_id, status: 'approved' })).status, 200);
  for (const req of state.payroll_requests) await post(owner(at('04', '11:04')), { action: 'decide_request', id: req.id, status: 'approved' });
  assert.equal((await post(owner(at('04', '11:05')), { action: 'add_violation', staff_id: PHAT.id, amount: '50.000', reason: 'đi trễ', month: 11, year: 2026 })).status, 200);

  // 7. Lương tạm tính (nhân viên và chủ thấy cùng số): 2 ngày công, 70 phút tăng ca (35.000đ), ứng quá số đã làm.
  const salary = (await get(workforce(state, PHAT, at('04', '12:00')), 'me=1')).body.salary;
  assert.deepEqual([salary.rule, salary.workUnits, salary.basePay, salary.otHours, salary.otAmt, salary.advAmt, salary.vioAmt, salary.absDays, salary.absAmt],
    ['days', 2, 400000, 1.2, 35000, 500000, 50000, 2, 0]);
  assert.equal(salary.net, 400000 + 35000 - 500000 - 50000);

  // 8. Thống kê tháng: 1 lần trễ, 1 lần quên ra ca, quỹ lương = lương ngày công + tăng ca.
  const stats = (await get(owner(at('04', '12:30')), 'stats=1&year=2026&month=11')).body;
  const p = stats.people.find(x => x.staff_id === PHAT.id);
  assert.deepEqual([p.late.count, p.late.minutes, p.forgot, p.stayed.count], [1, 25, 1, 2]);
  assert.deepEqual([stats.totals.gross, stats.totals.advances, stats.pending.fixes, stats.pending.extras], [435000, 500000, 0, 0]);

  // 9. Phát nghỉ việc, làm đến hết 4/11: kết toán riêng, đánh dấu đã trả.
  assert.equal((await post(owner(at('04', '20:00')), { action: 'staff_depart', staff_id: PHAT.id, last_day: '2026-11-04', reason: 'chuyển chỗ' })).status, 200);
  assert.equal(state.staff_checkin_devices.length, 0, 'the phone can be used by someone else');
  r = await post(owner(at('04', '20:05')), { action: 'close_month', year: 2026, month: 11, staff_id: PHAT.id });
  assert.deepEqual([r.status, r.body.closed], [200, 1]);
  assert.equal(state.payroll_closes[0].snapshot.net, -115000, 'he owes the shop 115.000đ');
  assert.equal((await post(owner(at('04', '20:06')), { action: 'mark_paid', year: 2026, month: 11, staff_id: PHAT.id })).status, 200);
  const closed = (await get(workforce(state, PHAT, at('04', '20:10')), 'me=1')).body.salary;
  assert.deepEqual([closed.locked, closed.net, !!closed.paid_at], [true, -115000, true]);
  assert.equal(await departure.hasLeft(fakeDb(state), PHAT.id, '2026-11-05'), true, 'from 5/11 he cannot log in or scan');
  assert.equal(await departure.hasLeft(fakeDb(state), PHAT.id, '2026-11-04'), false, 'still working on his last day');

  // 10. Chốt cả tháng 11 giữ nguyên số đã kết toán; tháng 12 không còn Phát.
  await post(owner(at('30', '23:30')), { action: 'close_month', year: 2026, month: 11 });
  assert.equal(state.payroll_closes.filter(c => c.month === 11).length, 1);
  assert.equal((await post(owner(at('30', '23:31')), { action: 'close_month', year: 2026, month: 12 })).body.closed, 0);
  assert.equal((await get(owner(at('30', '23:32')), 'stats=1&year=2026&month=12')).body.people.length, 0);
  // Đi làm lại thì lại tính bình thường.
  await post(owner(at('30', '23:33')), { action: 'staff_return', staff_id: PHAT.id });
  assert.equal(await departure.hasLeft(fakeDb(state), PHAT.id, '2026-12-01'), false);
});
