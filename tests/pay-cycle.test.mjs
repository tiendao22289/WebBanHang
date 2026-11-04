// Trả lương theo kỳ (người trả theo ngày): kỳ N ngày, ngày phát, "Đã thanh toán lương" mở kỳ mới, ngày sửa giờ sau khi trả
// vào lần trả sau, ứng / phạt / thưởng trừ đúng một lần, bảng lương tháng trừ phần đã trả theo kỳ.
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

const { cyclePeriod, cycleDue, cycleDueTo, payoutDetail, payoutPartOfMonth } = payroll;

test('the running period starts the day after the last payout and the payday is N days on', () => {
  const cycle = { every_days: 7, start_day: '2026-11-01' };
  assert.deepEqual(cyclePeriod({ cycle, payouts: [], today: '2026-11-05' }), { every: 7, start: '2026-11-01', payday: '2026-11-07', daysLeft: 2, last: null });
  // Trả sớm tới 06/11: kỳ sau từ 07/11, phát 13/11. Trả trễ (tới 09/11): kỳ sau từ 10/11.
  const early = cyclePeriod({ cycle, payouts: [{ to_day: '2026-11-06' }], today: '2026-11-07' });
  assert.deepEqual([early.start, early.payday, early.daysLeft], ['2026-11-07', '2026-11-13', 6]);
  const late = cyclePeriod({ cycle: { every_days: 10, start_day: '2026-11-01' }, payouts: [{ to_day: '2026-11-06' }, { to_day: '2026-11-09' }], today: '2026-11-25' });
  assert.deepEqual([late.start, late.payday, late.daysLeft], ['2026-11-10', '2026-11-19', -6]);
  assert.equal(cyclePeriod({ cycle: { every_days: 0, start_day: '2026-11-01' }, today: '2026-11-05' }), null);
});

test('amount due: new days, changes to days already paid, advances / fines once, bonus once, cut at any day', () => {
  const cycle = { every_days: 7, start_day: '2026-11-01' };
  const months = [{ key: '2026-11', byDay: { '2026-10-31': 999, '2026-11-01': 200000, '2026-11-02': 200000, '2026-11-08': 100000, '2026-11-09': 200000 },
    advances: [{ id: 'a1', amount: 150000 }, { id: 'a2', amount: 50000 }], fines: [{ id: 'f1', amount: 20000 }], bonus: 0 }];
  // Lần trước trả tới 07/11: ngày 02/11 lúc đó mới 100.000 (sau sửa giờ thành 200.000), ứng a1 đã trừ 100.000 (sau sửa thành 150.000),
  // phạt f9 đã trừ rồi bị xoá.
  const payouts = [{ to_day: '2026-11-07', detail: { days: { '2026-11-01': 200000, '2026-11-02': 100000 }, advances: [{ id: 'a1', key: '2026-11', amount: 100000 }],
    fines: [{ id: 'f9', key: '2026-11', amount: 30000 }], bonuses: [] } }];
  const due = cycleDue({ cycle, payouts, months, to: '2026-11-09', periodStart: '2026-11-08' });
  assert.deepEqual(due.days.map(x => [x.day, x.due]), [['2026-11-02', 100000], ['2026-11-08', 100000], ['2026-11-09', 200000]], 'day before the cycle start is not paid by the cycle');
  assert.deepEqual([due.work, due.adjust], [300000, 100000]);
  assert.deepEqual(due.advances.map(x => [x.id, x.amount]), [['a1', 50000], ['a2', 50000]]);
  assert.deepEqual(due.fines.map(x => [x.id, x.amount]), [['f1', 20000], ['f9', -30000]], 'a deleted fine gives back what was taken');
  assert.equal(due.amount, 300000 + 100000 - 100000 - (20000 - 30000));
  // Cắt tới 08/11 bằng cycleDueTo = tính thẳng tới 08/11.
  const cut = cycleDueTo(due, '2026-11-08', '2026-11-08'), direct = cycleDue({ cycle, payouts, months, to: '2026-11-08', periodStart: '2026-11-08' });
  assert.deepEqual(cut, direct);
  // Sau khi trả, không còn gì (cùng số liệu), và phần của tháng 11 = tổng đã trả.
  const all = [...payouts, { to_day: '2026-11-09', amount: due.amount, detail: payoutDetail(due) }];
  assert.equal(cycleDue({ cycle, payouts: all, months, to: '2026-11-09', periodStart: '2026-11-10' }).amount, 0);
  assert.equal(payoutPartOfMonth(all, '2026-11'), 300000 - 100000 - 30000 + due.amount);
  // Thưởng chuyên cần tháng 10 duyệt sau: cộng một lần; ứng của tháng sau ngày trả tới chưa trừ.
  const withBonus = [{ key: '2026-10', byDay: {}, advances: [], fines: [], bonus: 300000 }, ...months, { key: '2026-12', byDay: {}, advances: [{ id: 'd1', amount: 70000 }], fines: [], bonus: 0 }];
  const b = cycleDue({ cycle: { ...cycle, start_day: '2026-10-01' }, payouts: all, months: withBonus, to: '2026-11-09', periodStart: '2026-11-10' });
  assert.deepEqual([b.bonuses, b.advances, b.amount], [[{ key: '2026-10', amount: 300000 }], [], 300000 + 999]);
});

// ---- Qua đúng code máy chủ ----
const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin', created_at: '2026-10-01T00:00:00Z' };
const DUNG = { id: '00000000-0000-4000-8000-00000000dddd', full_name: 'Dũng', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const T = (day, hm) => { const next = hm.endsWith('+1') ? 1 : 0; const [h, m] = hm.replace('+1', '').split(':').map(Number); return Date.UTC(2026, 10, day + next, h - 7, m); };
const iso = t => new Date(t).toISOString();
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

test('weekly pay for a day worker: pay on payday, late clock-out goes to the next pay, undo, month page keeps the rest', async () => {
  let n = 0;
  const shift = (day, inAt = '13:58', outAt = '00:00+1') => ({ id: `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`, staff_id: DUNG.id,
    date: `2026-11-${String(day).padStart(2, '0')}`, clock_in: iso(T(day, inAt)), clock_out: outAt ? iso(T(day, outAt)) : null });
  // Đi làm 1, 2, 3, 5, 6 và 7 (ca 7 còn mở lúc trả lương); nghỉ 4.
  const state = {
    staff: [OWNER, DUNG], payroll_config: [{ staff_id: DUNG.id, base_salary: 0, overtime_rate: 0 }],
    payroll_hourly_rates: [{ staff_id: DUNG.id, valid_from: '2026-11-01', hourly_rate: 200000, unit: 'day' }],
    checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    attendance_sessions: [...[1, 2, 3, 5, 6].map(d => shift(d)), shift(7, '13:58', null)],
    __clock: () => env.now,
  };
  const wf = api(state);
  const as = (user, t) => { env.user = user; env.now = t; };
  const post = async (t, body, user = OWNER) => { as(user, t); return plain(await wf.POST({ json: async () => body, headers: new Map() })); };
  const get = async (t, q, user = OWNER) => { as(user, t); return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };

  assert.equal((await post(T(1, '10:00'), { action: 'save_pay_cycle', staff_id: DUNG.id, every_days: 40 })).status, 400);
  assert.equal((await post(T(1, '10:00'), { action: 'save_pay_cycle', staff_id: DUNG.id, every_days: 7, start_day: '2026-10-20' })).status, 400, 'not before day pay began');
  assert.equal((await post(T(1, '10:00'), { action: 'save_pay_cycle', staff_id: DUNG.id, every_days: 7, start_day: '2026-11-01' }, DUNG)).status, 403);
  assert.equal((await post(T(1, '10:00'), { action: 'save_pay_cycle', staff_id: DUNG.id, every_days: 7, start_day: '2026-11-01' })).status, 200);
  assert.equal((await get(T(1, '10:00'), 'cycles=1', DUNG)).status, 403);
  assert.equal((await post(T(3, '15:00'), { action: 'add_advance', staff_id: DUNG.id, amount: 100000, date: '2026-11-03' })).status, 200);

  // Ngày phát 07/11, 23:30 (ca hôm nay chưa ra): 5 ngày × 200.000 − ứng 100.000 = 900.000; tiền hôm nay chưa tính.
  const s1 = (await get(T(7, '23:30'), 'cycles=1')).body.people[0];
  assert.deepEqual([s1.period.start, s1.period.payday, s1.period.daysLeft, s1.openDay], ['2026-11-01', '2026-11-07', 0, '2026-11-07']);
  const due1 = cycleDueTo(s1, '2026-11-07', s1.period.start);
  assert.deepEqual([due1.work, due1.advances.map(a => a.amount), due1.amount], [1000000, [100000], 900000]);
  assert.equal((await post(T(7, '23:30'), { action: 'pay_cycle', staff_id: DUNG.id, to_day: '2026-11-07', amount: 800000 })).status, 409, 'page shows an old number');
  assert.equal((await post(T(7, '23:30'), { action: 'pay_cycle', staff_id: DUNG.id, to_day: '2026-11-08', amount: 900000 })).status, 400, 'not past today');
  const paid1 = await post(T(7, '23:30'), { action: 'pay_cycle', staff_id: DUNG.id, to_day: '2026-11-07', amount: 900000 });
  assert.deepEqual([paid1.status, paid1.body.amount], [200, 900000]);
  assert.equal((await post(T(7, '23:31'), { action: 'pay_cycle', staff_id: DUNG.id, to_day: '2026-11-07', amount: 900000 })).status, 400, 'pressed twice: the new period starts on the 8th');

  // Ra ca 7/11 lúc 00:00: 200.000 của ngày 7 vào lần trả sau. Đi làm 8, 9; ứng 100.000 sửa thành 150.000.
  state.attendance_sessions.find(x => !x.clock_out).clock_out = iso(T(7, '00:00+1'));
  state.attendance_sessions.push(shift(8), shift(9));
  const adv = state.payroll_requests.find(r => r.request_type === 'advance');
  assert.equal((await post(T(10, '12:00'), { action: 'edit_request', id: adv.id, amount: 150000 })).status, 200);
  const s2 = (await get(T(10, '12:00'), 'cycles=1')).body.people[0];
  assert.deepEqual([s2.period.start, s2.period.payday, s2.openDay], ['2026-11-08', '2026-11-14', null]);
  const due2 = cycleDueTo(s2, '2026-11-10', s2.period.start);
  assert.deepEqual([due2.work, due2.adjust, due2.advances.map(a => a.amount), due2.amount], [400000, 200000, [50000], 550000]);
  const paid2 = await post(T(10, '12:00'), { action: 'pay_cycle', staff_id: DUNG.id, to_day: '2026-11-10', amount: 550000 });
  assert.equal(paid2.status, 200);

  // Bảng lương tháng 11: lương 8 ngày 1.600.000 − ứng 150.000 = 1.450.000; đã trả theo kỳ 900.000 + 550.000 → còn 0.
  const month = (await get(T(10, '12:05'), 'payroll=1&year=2026&month=11')).body;
  assert.equal(payoutPartOfMonth(month.payouts.filter(p => p.staff_id === DUNG.id), '2026-11'), 1450000);

  // Bỏ lần trả: chỉ lần gần nhất; bỏ xong kỳ quay lại 08/11.
  assert.equal((await post(T(10, '12:10'), { action: 'undo_payout', id: paid1.body.id })).status, 409);
  assert.equal((await post(T(10, '12:10'), { action: 'undo_payout', id: paid2.body.id })).status, 200);
  const s3 = (await get(T(10, '12:10'), 'cycles=1')).body.people[0];
  assert.equal(s3.period.start, '2026-11-08');

  // Ứng nhiều hơn tiền công: chưa phải trả, không lưu.
  assert.equal((await post(T(10, '12:20'), { action: 'add_advance', staff_id: DUNG.id, amount: 2000000, date: '2026-11-10' })).status, 200);
  const s4 = cycleDueTo((await get(T(10, '12:20'), 'cycles=1')).body.people[0], '2026-11-10', '2026-11-08');
  assert.ok(s4.amount < 0);
  const neg = await post(T(10, '12:20'), { action: 'pay_cycle', staff_id: DUNG.id, to_day: '2026-11-10', amount: s4.amount });
  assert.equal(neg.status, 409);
  assert.match(neg.body.error, /chưa phải trả/);

  // Thôi trả theo kỳ: các lần đã trả vẫn giữ (bảng lương tháng vẫn trừ).
  assert.equal((await post(T(10, '12:30'), { action: 'save_pay_cycle', staff_id: DUNG.id, every_days: 0 })).status, 200);
  assert.deepEqual((await get(T(10, '12:30'), 'cycles=1')).body.people, []);
  assert.equal(state.payroll_payouts.length, 1);
});

test('before the migration runs the cycle parts say the web is updating', async () => {
  const state = { staff: [OWNER, DUNG], __noTable: ['payroll_pay_cycles', 'payroll_payouts'], checkin_settings: [{ id: 1 }], checkin_hours: [] };
  const wf = api(state);
  env.user = OWNER; env.now = T(5, '12:00');
  assert.deepEqual(plain(await wf.GET({ url: 'http://x/api/admin/workforce?cycles=1' })).body, { ready: false, people: [] });
  const r = plain(await wf.POST({ json: async () => ({ action: 'save_pay_cycle', staff_id: DUNG.id, every_days: 7 }), headers: new Map() }));
  assert.equal(r.status, 503);
  const month = plain(await wf.GET({ url: 'http://x/api/admin/workforce?payroll=1&year=2026&month=11' }));
  assert.deepEqual([month.status, month.body.payouts], [200, []]);
});
