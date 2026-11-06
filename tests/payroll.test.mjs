import test from 'node:test';
import assert from 'node:assert/strict';
import { dayFlags, dayInShiftMs, groupByWorkDay, normalizeRules, sessionHours } from '../src/lib/attendanceRules.mjs';
import { LATE_FINE_MINUTES, activeFineKinds, bonusCheck, computeSalary, dailyRateOn, fineSuggestions, holidayArgs, hourlyRateOn, lateRuleOn, monthTallies, payRateOn, payrollCost, staffMonthStats,
  usesDayPay } from '../src/lib/payroll.mjs';

// Quán 14:00–23:00 giờ VN = 07:00Z–16:00Z, cho lệch 10 phút, tính giờ theo ca từ 25/10/2026.
const RULES = normalizeRules({ hours_from: '2026-10-25' }, [], [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]);
// Từ 11/2026 một ngày công = lương cơ bản ÷ số ngày của tháng: 6.000.000đ ÷ 30 (tháng 11) = 200.000đ. Tháng 10 tính cách cũ (÷ 26).
const CONFIG = { base_salary: 6000000, overtime_rate: 30000 };
const OLD_CONFIG = { base_salary: 5200000, overtime_rate: 30000 };
const ses = (id, date, from, to) => ({ id, staff_id: 'a', date, clock_in: `${date}T${from}:00Z`, clock_out: to ? `${date}T${to}:00Z` : null });

test('from November: pay by days worked, half a day under half a shift, outside time paid as overtime without approval', () => {
  assert.deepEqual([usesDayPay(2026, 10), usesDayPay(2026, 11), usesDayPay(2027, 1)], [false, true, true]);
  const sessions = [
    ses('n2', '2026-11-02', '07:00', '16:00'), // đủ ca → 1 ngày
    ses('n3', '2026-11-03', '07:05', '11:00'), // 4 giờ < nửa ca 4,5 giờ → nửa ngày; về sớm 5 giờ → còn 4/9 ngày
    ses('n4', '2026-11-04', '06:00', '16:30'), // vào sớm 60, ở lại 30 phút, chủ cho tính 90 phút → 1 ngày + 1,5 giờ tăng ca
    ses('n5', '2026-11-05', '07:00', '16:00'),
    ses('n6', '2026-11-06', '07:00', '16:40'), // ở lại 40 phút: tự tính tăng ca, không chờ duyệt
    ses('n7', '2026-11-07', '07:00', null),    // đang làm, chưa tính
  ];
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: CONFIG, rules: RULES,
    reviews: [{ attendance_id: 'n4', status: 'approved', minutes: 90 }],
    requests: [
      { status: 'approved', request_type: 'advance', amount: 200000, month: 11, year: 2026 },
      { status: 'approved', request_type: 'absent', days: 1, month: 11, year: 2026 },
      { status: 'pending', request_type: 'advance', amount: 999999, month: 11, year: 2026 },
    ],
    violations: [{ amount: 50000 }] });
  assert.equal(c.rule, 'days');
  assert.deepEqual([c.workUnits, c.basePay], [4.5, 900000], '6.000.000 ÷ 30 × 4,5');
  assert.deepEqual([c.otHours, c.otAmt, c.pendingH], [2.2, 65000, 0], '90 approved + 40 automatic minutes × 30.000đ');
  assert.deepEqual([c.absDays, c.absAmt], [1, 0], 'a leave request is not deducted again');
  assert.equal(c.totalWorkH, 42.2);
  // Về sớm 5 giờ ngày 3/11: được 200.000đ × 4/9 = 88.889đ thay vì nửa ngày 100.000đ → trừ 11.111đ.
  assert.deepEqual([c.earlyAmt, c.earlyList], [11111, [{ day: '2026-11-03', minutes: 300, amount: 11111 }]]);
  assert.equal(c.net, 900000 - 11111 + 65000 - 200000 - 50000);
});

test('monthly pay: a day is the base ÷ 30 in every month, a full month is exactly the base, each missed day costs the same; overtime rate 0 pays none', () => {
  const month = (y, m, n, from = 1) => Array.from({ length: n }, (_, i) => ses(`d${i}`, `${y}-${String(m).padStart(2, '0')}-${String(i + from).padStart(2, '0')}`, '06:00', '16:00'));
  const sessions = month(2026, 12, 27);
  const reviews = sessions.map(s => ({ attendance_id: s.id, status: 'approved', minutes: 60 }));
  // Tháng 12 có 31 ngày, 6.000.000đ: 27 công × 200.000đ − 1 ngày của tháng 31 ngày = 5.200.000đ = lương − 4 ngày nghỉ × 200.000đ.
  const c = computeSalary({ year: 2026, month: 12, staffId: 'a', sessions, config: { base_salary: 6000000, overtime_rate: 0 }, rules: RULES, reviews });
  assert.deepEqual([c.workUnits, c.standardDays, c.dayBase, c.dayAmt, c.monthAdjust, c.basePay], [27, 31, 30, 5400000, -200000, 5200000]);
  assert.deepEqual([c.otHours, c.otAmt], [27, 0]);
  // Lương 7.800.000đ: đi đủ tháng nào cũng 7.800.000đ; nghỉ 1 ngày tháng nào cũng trừ 260.000đ (7.800.000 ÷ 30).
  for (const [y, m, n, adjust] of [[2026, 11, 30, 0], [2026, 12, 31, -260000], [2027, 2, 28, 520000], [2028, 2, 29, 260000]]) {
    const pay = days => computeSalary({ year: y, month: m, staffId: 'a', sessions: month(y, m, days), config: { base_salary: 7800000, overtime_rate: 0 }, rules: RULES });
    const full = pay(n), missed = pay(n - 1);
    assert.deepEqual([full.workUnits, full.standardDays, full.monthAdjust, full.basePay], [n, n, adjust, 7800000], `${m}/${y}: every day worked = the base`);
    assert.equal(missed.basePay, 7800000 - 260000, `${m}/${y}: one day missed costs 260.000đ`);
    // Sổ thu chi: từng ngày 260.000đ, phần chỉnh của tháng tính riêng (cả tháng).
    assert.equal(Object.values(full.byDay).reduce((a, x) => a + x, 0) + full.monthAdjust, 7800000);
  }
  // Tháng đang chạy (tới 10/12): phần chỉnh chỉ tính 10 ngày. Vào làm 11/12, đi đủ: đúng 21/31 lương tháng.
  const running = computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: month(2026, 12, 10), config: { base_salary: 6000000, overtime_rate: 0 }, rules: RULES, asOf: '2026-12-10' });
  assert.deepEqual([running.dayAmt, running.monthAdjust, running.basePay], [2000000, -64516, 1935484]);
  const joined = computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: month(2026, 12, 21, 11), config: { base_salary: 6000000, overtime_rate: 0 }, rules: RULES,
    employed: { from: '2026-12-11', to: null } });
  assert.deepEqual([joined.dayAmt, joined.monthAdjust, joined.basePay], [4200000, -135484, 4064516]);
  // Người trả theo ngày: không có phần chỉnh.
  const daily = computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: month(2026, 12, 31), config: { base_salary: 6000000, overtime_rate: 0 }, rules: RULES,
    hourlyRates: [{ staff_id: 'a', valid_from: '2026-12-01', hourly_rate: 200000, unit: 'day' }] });
  assert.deepEqual([daily.monthAdjust, daily.basePay], [0, 6200000]);
  // Sổ thu chi tháng 12: tiền từng ngày + phần chỉnh của tháng (cùng thưởng − phạt) = đúng lương; tháng đã chốt theo số chốt.
  const all = month(2026, 12, 31).map(s => ({ ...s, staff_id: 'a' }));
  const cost = payrollCost({ year: 2026, month: 12, staff: [{ id: 'a' }], rules: RULES, sessions: all, configs: [{ staff_id: 'a', base_salary: 7800000, overtime_rate: 0 }] });
  assert.deepEqual([Object.values(cost.byDay).reduce((a, x) => a + x, 0), cost.monthExtra], [8060000, -260000]);
  const closedCost = payrollCost({ year: 2026, month: 12, staff: [{ id: 'a' }], rules: RULES, sessions: [], configs: [{ staff_id: 'a', base_salary: 7800000 }],
    closes: [{ staff_id: 'a', snapshot: { byDay: { '2026-12-01': 8060000 }, bonusAmt: 0, vioAmt: 0, monthAdjust: -260000 } }] });
  assert.equal(closedCost.monthExtra, -260000);
  assert.equal(computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: [], config: { base_salary: 1 }, rules: RULES }).basePay, 0, 'no days, no base pay');
});

test('October keeps the old formula: full base, overtime above 8 hours a day, leave days deducted', () => {
  const sessions = [
    ses('o20', '2026-10-20', '07:00', '16:30'), // trước ngày tính theo ca: 9,5 giờ → tăng ca 1,5
    ses('o26', '2026-10-26', '06:00', '16:30'), // theo ca: chỉ 9 giờ trong ca → tăng ca 1
  ];
  const c = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions, config: OLD_CONFIG, rules: RULES,
    requests: [{ status: 'approved', request_type: 'absent', days: 2, month: 10, year: 2026 }] });
  assert.equal(c.rule, 'hours');
  assert.deepEqual([c.basePay, c.workDays, c.totalWorkH, c.otHours, c.otAmt, c.absAmt, c.pendingH], [5200000, 2, 18.5, 2.5, 75000, 400000, 1.5]);
  assert.equal(c.net, 5200000 + 75000 - 400000);
  assert.equal(computeSalary({ year: 2026, month: 10, staffId: 'a', sessions, config: { base_salary: 0 }, rules: RULES }).otAmt, 62500, 'no overtime rate set: 25.000đ an hour');
});

test('overtime money follows the exact approved minutes, the hours are only rounded for display', () => {
  const s = { id: 'x', staff_id: 'a', date: '2026-11-03', clock_in: '2026-11-03T07:00:00Z', clock_out: '2026-11-03T16:45:00Z' };
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: [s], config: CONFIG, rules: RULES, reviews: [{ attendance_id: 'x', status: 'approved', minutes: 45 }] });
  assert.deepEqual([c.otHours, c.otAmt], [0.8, 22500], '45 minutes × 30.000đ/hour');
});

test('a clean-up visit after midnight belongs to the shift before: no extra half day, no false late', () => {
  // Ca 14:00–23:00 ngày 28/11, quay lại dọn 00:30–01:00 (ghi ngày 29/11, hôm đó nghỉ); chủ cho tính 30 phút.
  const night = [ses('a1', '2026-11-28', '07:00', '16:00'), { id: 'a2', staff_id: 'a', date: '2026-11-29', clock_in: '2026-11-28T17:30:00Z', clock_out: '2026-11-28T18:00:00Z' }];
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: night, config: CONFIG, rules: RULES, reviews: [{ attendance_id: 'a2', status: 'approved', minutes: 30 }] });
  assert.deepEqual([c.workDays, c.workUnits, c.basePay, c.otAmt], [1, 1, 200000, 15000]);
  const days = groupByWorkDay(night, RULES);
  assert.deepEqual([...days.keys()], ['2026-11-28']);
  assert.deepEqual(dayFlags(days.get('2026-11-28'), RULES), { late: 0, early: 0, leftEarly: 0, stayed: 30 });
  // Đêm cuối tháng: lượt ghi ngày 1/12 thuộc lương tháng 11, không thành ngày công tháng 12.
  const last = [ses('b1', '2026-11-30', '07:00', '16:00'), { id: 'b2', staff_id: 'a', date: '2026-12-01', clock_in: '2026-11-30T17:20:00Z', clock_out: '2026-11-30T17:50:00Z' }];
  const nov = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: last, config: CONFIG, rules: RULES });
  const dec = computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: last, config: CONFIG, rules: RULES });
  assert.deepEqual([nov.workUnits, nov.pendingH, nov.otAmt, dec.workUnits, dec.pendingH, dec.totalWorkH], [1, 0, 15000, 0, 0, 0]);
});

test('an approved attendance bonus is added to the pay of its own month only', () => {
  const sessions = [ses('n2', '2026-11-02', '07:00', '16:00')];
  const bonuses = [{ staff_id: 'a', year: 2026, month: 11, amount: 300000 }, { staff_id: 'a', year: 2026, month: 12, amount: 999 }];
  const nov = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: CONFIG, rules: RULES, bonuses });
  assert.deepEqual([nov.bonusAmt, nov.net], [300000, 200000 + 300000]);
  const oct = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions: [], config: OLD_CONFIG, rules: RULES, bonuses: [{ year: 2026, month: 10, amount: 100000 }] });
  assert.deepEqual([oct.bonusAmt, oct.net], [100000, 5200000 + 100000], 'the old formula adds it too');
  assert.equal(computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: CONFIG, rules: RULES }).bonusAmt, 0);
});

test('attendance bonus: no late day, no forgotten clock-out and enough work days; fines are suggested, never applied', () => {
  // 23 ngày đủ ca (2–24/11), ngày 25 trễ 35 phút, ngày 26 trễ đúng 30 phút, ngày 27 quên ra ca (máy tự đóng).
  const days = Array.from({ length: 23 }, (_, i) => ses(`d${i}`, `2026-11-${String(i + 2).padStart(2, '0')}`, '07:00', '16:00'));
  const late35 = ses('late35', '2026-11-25', '07:35', '16:00'), late30 = ses('late30', '2026-11-26', '07:30', '16:00'), forgot = ses('forgot', '2026-11-27', '07:00', '16:00');
  const key = '2026-11';
  const clean = monthTallies({ sessions: days, rules: RULES, key });
  const salary = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: days, config: CONFIG, rules: RULES });
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary, tallies: clean, settings: { bonus_min_days: 22 } }), { eligible: true, reasons: [], minDays: 22 });
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary, tallies: clean, settings: { bonus_min_days: 24 } }).reasons, ['23/24 ngày công']);
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary, tallies: clean, departure: { last_day: '2026-11-28' } }).reasons, ['nghỉ việc']);
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary: { ...salary, base: 0 }, tallies: clean }).reasons, ['chưa có lương cơ bản']);
  assert.equal(bonusCheck({ year: 2026, month: 10, salary, tallies: clean }).eligible, false, 'not before November');

  const all = [...days, late35, late30, forgot];
  const t = monthTallies({ sessions: all, rules: RULES, key, autoClosed: ['forgot'] });
  assert.deepEqual([t.late.count, t.late.minutes, t.forgot], [2, 65, 1]);
  const full = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: all, config: CONFIG, rules: RULES });
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary: full, tallies: t }).reasons, ['trễ 2 lần', 'quên ra ca 1 lần']);

  // Gợi ý phạt: trễ QUÁ 30 phút (35 có, 30 không) và lần quên ra ca; đã xử lý hay loại đã ẩn thì không gợi ý nữa.
  assert.equal(LATE_FINE_MINUTES, 30);
  const hints = fineSuggestions({ staffId: 'a', tallies: t });
  assert.deepEqual(hints.map(h => [h.kind, h.attendance_id, h.day, h.minutes]), [['late', 'late35', '2026-11-25', 35], ['forgot', 'forgot', '2026-11-27', undefined]]);
  assert.deepEqual(fineSuggestions({ staffId: 'a', tallies: t, reviews: [{ attendance_id: 'late35', kind: 'late' }] }).map(h => h.kind), ['forgot']);
  assert.deepEqual(fineSuggestions({ staffId: 'a', tallies: t, kinds: ['late'] }).map(h => h.kind), ['late']);
  assert.deepEqual(activeFineKinds([{ kind: 'late', active: true }, { kind: 'forgot', active: false }, { kind: null, active: true }]), ['late']);
  assert.deepEqual(activeFineKinds([]), ['late', 'forgot']);
  // Không có khoản nào tự trừ: lương không đổi khi chỉ có gợi ý.
  assert.equal(full.vioAmt, 0);
});

test('leaving 30 minutes or more early costs the early hours: day pay ÷ shift hours', () => {
  // Ca 14:00–23:00 (9 giờ), lương 6.000.000đ → 200.000đ/ngày ≈ 22.222đ/giờ.
  const pay = (from, to) => computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: [ses('x', '2026-11-04', from, to)], config: CONFIG, rules: RULES });
  assert.deepEqual([pay('07:00', '15:31').earlyAmt, pay('07:00', '15:31').net], [0, 200000], 'left 29 minutes early: no cut');
  assert.deepEqual([pay('07:00', '15:30').earlyAmt, pay('07:00', '15:30').net], [11111, 188889], '30 minutes early: 30 minutes cut');
  const tired = pay('07:00', '13:00'); // xin về lúc 20:00, sớm 3 giờ
  assert.deepEqual([tired.workUnits, tired.earlyAmt, tired.net], [1, 66667, 133333]);
  assert.deepEqual(tired.earlyList, [{ day: '2026-11-04', minutes: 180, amount: 66667 }]);
  // Vào trễ không bị trừ tự động; chỉ về sớm.
  assert.equal(pay('08:00', '16:00').earlyAmt, 0);
  // Tháng cũ (tháng 10) không trừ.
  const oct = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions: [ses('o', '2026-10-27', '07:00', '13:00')], config: OLD_CONFIG, rules: RULES });
  assert.deepEqual([oct.earlyAmt, oct.net], [0, 5200000]);
});

test('the night of 31/10 → 1/11: a clean-up after midnight is paid in October, not lost between the two formulas', () => {
  const night = [ses('o31', '2026-10-31', '07:00', '16:00'), { id: 'n1', staff_id: 'a', date: '2026-11-01', clock_in: '2026-10-31T17:30:00Z', clock_out: '2026-10-31T18:30:00Z' }];
  const oct = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions: night, config: OLD_CONFIG, rules: RULES, reviews: [{ attendance_id: 'n1', status: 'approved', minutes: 60 }] });
  const nov = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: night, config: CONFIG, rules: RULES, reviews: [{ attendance_id: 'n1', status: 'approved', minutes: 60 }] });
  assert.deepEqual([oct.workDays, oct.totalWorkH, oct.otHours], [1, 10, 2], 'October: one day of 10 hours (9 + the approved clean-up hour), 2 hours over 8');
  assert.deepEqual([nov.workUnits, nov.totalWorkH], [0, 0], 'not a November day');
});

// Sổ thu chi lấy lương mỗi ngày từ đúng công thức này.
const NOV = [
  ses('n2', '2026-11-02', '07:00', '16:00'),
  ses('n3', '2026-11-03', '07:05', '11:00'),
  ses('n4', '2026-11-04', '06:00', '16:30'),
  ses('n7', '2026-11-07', '07:00', null),
];
const NOV_REVIEWS = [{ attendance_id: 'n4', status: 'approved', minutes: 90 }];

test('each day of pay for the finance book adds up to the pay slip: day pay, overtime and early cuts', () => {
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: NOV, config: CONFIG, rules: RULES, reviews: NOV_REVIEWS });
  assert.deepEqual(c.byDay, {
    '2026-11-02': 200000,                // 6.000.000 ÷ 30
    '2026-11-03': 100000 - 11111,        // nửa ngày, về sớm còn 4/9 ngày
    '2026-11-04': 200000 + 45000,        // + 1,5 giờ tăng ca × 30.000đ
  }, 'a shift still open is not paid yet');
  const sum = Object.values(c.byDay).reduce((a, x) => a + x, 0);
  assert.equal(sum, c.basePay - c.lateAmt - c.earlyAmt + c.otAmt);
});

test('October days for the finance book: base ÷ 26 for each day worked plus that day overtime', () => {
  const c = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions: [ses('o26', '2026-10-26', '06:00', '16:30')], config: OLD_CONFIG, rules: RULES });
  assert.deepEqual(c.byDay, { '2026-10-26': 200000 + 30000 });
});

test('the shop wage cost per day adds everyone; bonus minus fines go to the month; advances are not a cost', () => {
  const staff = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const sessions = [...NOV, ses('b2', '2026-11-02', '07:00', '16:00')].map((x, i) => i >= NOV.length ? { ...x, staff_id: 'b' } : x);
  const cost = payrollCost({ year: 2026, month: 11, staff, rules: RULES, reviews: NOV_REVIEWS, sessions,
    configs: [{ staff_id: 'a', ...CONFIG }, { staff_id: 'b', base_salary: 3000000 }],
    requests: [{ staff_id: 'a', status: 'approved', request_type: 'advance', amount: 300000, month: 11, year: 2026 }],
    violations: [{ staff_id: 'a', amount: 50000 }, { staff_id: 'c', amount: 20000 }],
    bonuses: [{ staff_id: 'b', year: 2026, month: 11, amount: 300000 }] });
  assert.deepEqual(cost.byDay, { '2026-11-02': 200000 + 100000, '2026-11-03': 88889, '2026-11-04': 245000 });
  assert.equal(cost.monthExtra, 300000 - 50000 - 20000, 'someone with only a fine still counts');

  const closed = payrollCost({ year: 2026, month: 11, staff, rules: RULES, reviews: NOV_REVIEWS, sessions, configs: [{ staff_id: 'a', ...CONFIG }],
    violations: [{ staff_id: 'a', amount: 50000 }], closes: [{ staff_id: 'a', snapshot: { vioAmt: 70000, bonusAmt: 10000 } }] });
  assert.equal(closed.monthExtra, 10000 - 70000, 'a closed month uses the closed numbers');
});

// Người trả theo giờ: ca riêng 14:30–00:00 (07:30Z–17:00Z), 25.000đ/giờ.
const HOURLY_RULES = normalizeRules({ hours_from: '2026-10-25' }, [{ staff_id: 'a', valid_from: '2026-11-01', start_time: '14:30', end_time: '00:00' }],
  [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]);
const HOURLY = [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 25000 }];
const HOUR_DAYS = [
  ses('h1', '2026-11-02', '07:30', '17:00'), // đủ ca 9 giờ 30 phút
  ses('h2', '2026-11-03', '07:45', '17:05'), // trễ 15 phút; ra trễ 5 phút trong số phút cho lệch → hết ca
  ses('h3', '2026-11-04', '07:25', '14:30'), // vào sớm 5 phút (cho lệch) → từ 14:30; về 21:30
  ses('h4', '2026-11-05', '07:30', '18:00'), // ở lại tới 01:00, chủ cho tính 60 phút → giá tăng ca
];

test('paid by the hour: minutes inside the own shift × hourly rate, late / early cost exactly those minutes, extra time at the overtime rate', () => {
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: HOUR_DAYS, config: { base_salary: 0, overtime_rate: 30000 }, rules: HOURLY_RULES,
    reviews: [{ attendance_id: 'h4', status: 'approved', minutes: 60 }], hourlyRates: HOURLY });
  assert.deepEqual(c.hourly, { minutes: 570 + 555 + 420 + 570, amount: 881250, rates: [25000] });
  assert.deepEqual([c.dayUnits, c.dayAmt, c.workUnits, c.earlyAmt, c.earlyList], [0, 0, 4, 0, []], 'no day pay, no extra early-leave cut');
  assert.deepEqual([c.basePay, c.otHours, c.otAmt, c.net], [881250, 1, 30000, 911250]);
  assert.deepEqual(c.byDay, { '2026-11-02': 237500, '2026-11-03': 231250, '2026-11-04': 175000, '2026-11-05': 237500 + 30000 });
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary: c, tallies: monthTallies({ sessions: HOUR_DAYS, rules: HOURLY_RULES, key: '2026-11' }) }).reasons,
    ['trễ 1 lần', '4/22 ngày công'], 'an hourly person has a salary for the attendance bonus');
});

test('paid by the hour: seconds round up to the minute so the paid time matches "late 11 minutes"', () => {
  const s = { id: 'x', staff_id: 'a', date: '2026-11-06', clock_in: '2026-11-06T07:41:23Z', clock_out: '2026-11-06T17:00:00Z' };
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: [s], config: null, rules: HOURLY_RULES, hourlyRates: HOURLY });
  assert.equal(dayFlags([s], HOURLY_RULES).late, 11);
  assert.deepEqual([c.hourly.minutes, c.hourly.amount], [570 - 11, Math.round(559 / 60 * 25000)]);
});

test('switching to or from hourly pay applies from its day: earlier days keep the day pay', () => {
  const days = [ses('m1', '2026-11-02', '07:30', '17:00'), ses('m2', '2026-11-03', '07:30', '17:00'), ses('m3', '2026-11-04', '07:30', '17:00')];
  const rates = [{ staff_id: 'a', valid_from: '2026-11-03', hourly_rate: 20000 }, { staff_id: 'a', valid_from: '2026-11-04', hourly_rate: 0 }, { staff_id: 'b', valid_from: '2026-11-01', hourly_rate: 99000 }];
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: days, config: CONFIG, rules: HOURLY_RULES, hourlyRates: rates });
  assert.deepEqual([c.dayUnits, c.dayAmt, c.hourly], [2, 400000, { minutes: 570, amount: 190000, rates: [20000] }]);
  assert.deepEqual(c.byDay, { '2026-11-02': 200000, '2026-11-03': 190000, '2026-11-04': 200000 });
  assert.equal(c.basePay, 590000);
  assert.equal(computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: [], config: CONFIG, rules: HOURLY_RULES, hourlyRates: rates }).hourly, null, 'back to monthly pay');
  assert.deepEqual(computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: [], config: null, rules: HOURLY_RULES, hourlyRates: HOURLY }).hourly,
    { minutes: 0, amount: 0, rates: [25000] }, 'a rate set from an earlier month still applies');
});

test('the shop wage cost per day includes people paid by the hour', () => {
  const cost = payrollCost({ year: 2026, month: 11, staff: [{ id: 'a' }], rules: HOURLY_RULES, sessions: HOUR_DAYS.slice(0, 2), configs: [], hourlyRates: HOURLY });
  assert.deepEqual(cost.byDay, { '2026-11-02': 237500, '2026-11-03': 231250 });
});

// Ca 14:00 → 00:00 (07:00Z–17:00Z), 8.653.846đ ÷ 30 ngày (tháng 11): lương ngày 288.462đ (số lẻ để thử làm tròn), 10 tiếng = 600 phút.
const LATE_RULES = normalizeRules({ hours_from: '2026-10-25' }, [], [{ valid_from: '2026-11-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }]);
// Luật đi trễ mặc định của quán từ 4/11: cho trễ 10 phút; quá thì trừ 50.000đ mỗi lần + trừ theo phút.
const SHOP_LATE = [{ scope: 'shop', valid_from: '2026-11-04', allowed_minutes: 10, per_minute: true, fixed_amount: 50000, use_shop: false }];
const PER_MINUTE = [{ scope: 'shop', valid_from: '2026-11-04', allowed_minutes: 10, per_minute: true, fixed_amount: 0, use_shop: false }];
const vnAt = (day, hm) => new Date(`${day}T${hm}:00+07:00`).toISOString();
const dayOf = (day, from, to = '00:00', lateRules = PER_MINUTE, reviews = []) => {
  const out = to < from ? new Date(Date.parse(vnAt(day, to)) + 86400000).toISOString() : vnAt(day, to);
  return computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 8653846, overtime_rate: 25000 }, rules: LATE_RULES, lateRules, reviews,
    sessions: [{ id: 'x', staff_id: 'a', date: day, clock_in: vnAt(day, from), clock_out: out }] });
};

test('late past the allowed minutes costs exactly those minutes of the day pay; within them nothing', () => {
  const pay = from => { const c = dayOf('2026-11-05', from); return [c.daily[0].late, c.lateAmt, c.byDay['2026-11-05']]; };
  assert.deepEqual(pay('14:00'), [0, 0, 288462]);
  assert.deepEqual(pay('14:10'), [0, 0, 288462], '10 minutes late is allowed');
  assert.deepEqual(pay('14:11'), [11, 5288, 283174], '11 minutes × 288.462 ÷ 600');
  assert.deepEqual(pay('14:30'), [30, 14423, 274039]);
  assert.deepEqual(pay('15:00'), [60, 28846, 259616]);
  const both = dayOf('2026-11-05', '14:20', '23:20');
  assert.deepEqual([both.lateAmt, both.earlyAmt, both.byDay['2026-11-05'], both.net], [9615, 19231, 259616, 259616], 'late 20 + left 40 minutes early');
  assert.deepEqual(both.lateList, [{ day: '2026-11-05', minutes: 20, amount: 9615, perMinute: 9615, fixed: 0 }]);
  assert.deepEqual([dayOf('2026-11-03', '15:00').lateAmt, dayOf('2026-11-03', '15:00').daily[0].late], [0, 60], 'before the rule starts: shown, not cut');
});

test('the shop default late rule: past 10 minutes 50.000đ each time plus the minutes; a person can have their own rule', () => {
  const c = dayOf('2026-11-05', '14:11', '00:00', SHOP_LATE);
  assert.deepEqual([c.lateAmt, c.lateList[0].fixed, c.lateList[0].perMinute, c.byDay['2026-11-05'], c.net], [55288, 50000, 5288, 233174, 288462 - 55288]);
  assert.equal(dayOf('2026-11-05', '14:10', '00:00', SHOP_LATE).lateAmt, 0, 'within the allowed 10 minutes');
  // Riêng người này: cho trễ 30 phút, chỉ trừ 50.000đ, không trừ theo phút.
  const own = [...SHOP_LATE, { scope: 'a', valid_from: '2026-11-05', allowed_minutes: 30, per_minute: false, fixed_amount: 50000, use_shop: false }];
  assert.equal(dayOf('2026-11-05', '14:25', '00:00', own).lateAmt, 0, '25 minutes is allowed for this person');
  assert.deepEqual([dayOf('2026-11-05', '14:45', '00:00', own).lateAmt, dayOf('2026-11-05', '14:45', '00:00', own).byDay['2026-11-05']], [50000, 238462]);
  // Từ 7/11 quay về theo quán; ngày trước 5/11 luật riêng chưa có.
  const back = [...own, { scope: 'a', valid_from: '2026-11-07', allowed_minutes: 0, per_minute: false, fixed_amount: 0, use_shop: true }];
  assert.equal(dayOf('2026-11-07', '14:25', '00:00', back).lateAmt, 50000 + 12019, '25 minutes × 288.462 ÷ 600');
  assert.equal(dayOf('2026-11-04', '14:25', '00:00', own).lateAmt, 50000 + 12019, 'the 4th still uses the shop rule');
  assert.deepEqual(lateRuleOn(back, 'a', '2026-11-06'), { allowed: 30, perMinute: false, fixed: 50000, own: true, on: true, early: null });
  assert.deepEqual(lateRuleOn(back, 'a', '2026-11-08'), { allowed: 10, perMinute: true, fixed: 50000, own: false, on: true, early: null });
  assert.equal(lateRuleOn(back, 'a', '2026-11-01'), null, 'no rule yet: nothing is cut');
  // Ngày đã tự trừ theo luật thì không gợi ý phạt trễ nữa.
  const late = { lateDays: [{ day: '2026-11-05', minutes: 45, attendance_id: 'x' }], forgotten: [] };
  assert.equal(fineSuggestions({ staffId: 'a', tallies: late }).length, 1);
  assert.equal(fineSuggestions({ staffId: 'a', tallies: late, autoLateDays: ['2026-11-05'] }).length, 0);
  // Người trả theo giờ: trễ đã mất phút, chỉ trừ thêm tiền cố định.
  const hourly = computeSalary({ year: 2026, month: 11, staffId: 'a', config: null, rules: LATE_RULES, lateRules: SHOP_LATE, hourlyRates: [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 30000 }],
    sessions: [{ id: 'h', staff_id: 'a', date: '2026-11-05', clock_in: vnAt('2026-11-05', '14:30'), clock_out: new Date(Date.parse(vnAt('2026-11-05', '00:00')) + 86400000).toISOString() }] });
  assert.deepEqual([hourly.hourly.minutes, hourly.hourly.amount, hourly.lateAmt, hourly.net, hourly.byDay['2026-11-05']], [570, 285000, 50000, 235000, 235000]);
});

test('early arrival and staying late are paid as overtime by themselves; each day shows early / late / stay / left early', () => {
  const c = dayOf('2026-11-05', '13:15', '01:13');
  assert.deepEqual(c.daily, [{ day: '2026-11-05', in: vnAt('2026-11-05', '13:15'), out: new Date(Date.parse(vnAt('2026-11-05', '01:13')) + 86400000).toISOString(), hourly: false,
    early: 45, late: 0, stay: 73, leftEarly: 0, inShiftMin: 600, extraMin: 118, extraAmt: 49167, pendingMin: 0, lateCut: 0, earlyCut: 0, pay: 337629 }]);
  // Ngày tính ra 337.628,2đ nhưng phiếu làm tròn từng phần (288.462 + 49.167): ngày cuối nhận phần lệch để khớp phiếu.
  assert.deepEqual([c.otAmt, c.pendingH, c.net, c.byDay['2026-11-05']], [49167, 0, 337629, 337629], 'the day takes the rounding of the slip');
  const no = dayOf('2026-11-05', '13:15', '23:59', PER_MINUTE, [{ attendance_id: 'x', status: 'rejected', minutes: 0 }]);
  assert.deepEqual([no.otAmt, no.daily[0].early], [0, 45], 'the owner can still not count a shift');
  // Trước tháng 11 giờ ngoài ca chưa duyệt vẫn chờ chủ.
  const oct = sessionHours({ id: 'o', staff_id: 'a', date: '2026-10-27', clock_in: '2026-10-27T06:00:00Z', clock_out: '2026-10-27T16:00:00Z' }, RULES);
  assert.deepEqual([oct.pendingMs / 60000, oct.approvedMs, !!oct.autoExtra], [60, 0, false]);
});

test('someone without a salary yet is not cut for being late', () => {
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', config: null, rules: LATE_RULES, lateRules: SHOP_LATE,
    sessions: [{ id: 'x', staff_id: 'a', date: '2026-11-05', clock_in: vnAt('2026-11-05', '15:00'), clock_out: vnAt('2026-11-05', '23:00') }] });
  assert.deepEqual([c.lateAmt, c.net, c.daily[0].late], [0, 0, 60]);
});

test('the fixed late cut never makes a day negative; days before shift hours are not cut', () => {
  // 6.000.000đ, ca 14:00 → 00:00: vào 21:30 (trễ 450 phút), làm 2 giờ 30 phút → nửa ngày 100.000đ, theo phút còn 50.000đ.
  const shortDay = computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 6000000, overtime_rate: 25000 }, rules: LATE_RULES, lateRules: SHOP_LATE,
    sessions: [{ id: 'x', staff_id: 'a', date: '2026-11-05', clock_in: vnAt('2026-11-05', '21:30'), clock_out: new Date(Date.parse(vnAt('2026-11-05', '00:00')) + 86400000).toISOString() }] });
  assert.deepEqual([shortDay.byDay['2026-11-05'], shortDay.lateAmt, shortDay.lateList[0].fixed], [0, 100000, 50000], 'never below 0');
  assert.equal(shortDay.net, 0);
  const hourly = computeSalary({ year: 2026, month: 11, staffId: 'a', config: null, rules: LATE_RULES, lateRules: SHOP_LATE, hourlyRates: [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 25000 }],
    sessions: [{ id: 'h', staff_id: 'a', date: '2026-11-05', clock_in: vnAt('2026-11-05', '22:00'), clock_out: vnAt('2026-11-05', '23:00') }] });
  assert.deepEqual([hourly.byDay['2026-11-05'], hourly.lateAmt, hourly.net], [0, 25000, 0], '1 hour of work, the fixed cut stops at 25.000đ');
  const later = normalizeRules({ hours_from: '2027-01-01' }, [], [{ valid_from: '2026-11-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }]);
  assert.equal(computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 8653846 }, rules: later, lateRules: SHOP_LATE,
    sessions: [{ id: 'y', staff_id: 'a', date: '2026-11-05', clock_in: vnAt('2026-11-05', '15:00'), clock_out: vnAt('2026-11-05', '23:00') }] }).lateAmt, 0, 'shift hours not used yet');
});

test('shop closed days: a full day of pay for people who get it (monthly by default, hourly not), only while employed', () => {
  const work = [{ id: 'w', staff_id: 'a', date: '2026-11-04', clock_in: vnAt('2026-11-04', '14:00'), clock_out: new Date(Date.parse(vnAt('2026-11-04', '00:00')) + 86400000).toISOString() }];
  const pay = extra => computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 9000000, overtime_rate: 30000 }, rules: LATE_RULES, sessions: work,
    closedDays: ['2026-11-03', '2026-11-04', '2026-12-01'], ...extra });
  const c = pay({});
  assert.deepEqual([c.holidayDays, c.workUnits, c.dayUnits, c.dayAmt, c.net], [1, 2, 2, 600000, 600000], '3/11 paid; 4/11 was worked, paid once; December is another month');
  assert.deepEqual(c.byDay, { '2026-11-03': 300000, '2026-11-04': 300000 });
  assert.deepEqual(c.daily.map(d => [d.day, !!d.holiday, d.pay]), [['2026-11-03', true, 300000], ['2026-11-04', false, 300000]]);
  assert.equal(pay({ holidayPaid: false }).holidayDays, 0, 'set to not paid');
  assert.equal(pay({ employed: { from: '2026-11-04', to: null } }).holidayDays, 0, 'joined after the closed day');
  assert.equal(pay({ employed: { from: '2026-01-01', to: '2026-11-02' } }).holidayDays, 0, 'left before the closed day');
  assert.equal(computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 9000000 }, rules: LATE_RULES, sessions: [], closedDays: ['2026-11-03'] }).holidayDays, 0,
    'nobody is paid a closed day in a month they never worked');
  // Theo giờ (ca 14:00 → 00:00, 30.000đ/giờ): mặc định không; bật lên thì được đủ giờ của ca.
  const hourlyRates = [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 30000 }];
  assert.equal(pay({ hourlyRates }).holidayDays, 0);
  const h = pay({ hourlyRates, holidayPaid: true });
  assert.deepEqual([h.holidayDays, h.hourly.minutes, h.hourly.amount, h.byDay['2026-11-03'], h.net], [1, 1200, 600000, 300000, 600000]);
  assert.deepEqual(holidayArgs({ id: 'a', created_at: '2026-11-02T18:00:00Z' }, { closedDays: [{ day: '2026-11-03' }], holidayPay: [{ staff_id: 'a', paid: false }], departures: [{ staff_id: 'a', last_day: '2026-11-20' }] }),
    { closedDays: ['2026-11-03'], holidayPaid: false, employed: { from: '2026-11-03', to: '2026-11-20' } }, 'created 01:00 on 3/11 Vietnam time');
});

test('working on a shop closed day: no late / early cut, and someone paid for closed days gets at least the full day', () => {
  const at = (from, to) => [{ id: 'c', staff_id: 'a', date: '2026-11-10', clock_in: vnAt('2026-11-10', from), clock_out: vnAt('2026-11-10', to) }];
  const pay = (sessions, extra = {}) => computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 9000000, overtime_rate: 30000 }, rules: LATE_RULES,
    lateRules: SHOP_LATE, sessions, closedDays: ['2026-11-10'], ...extra });
  const called = pay(at('16:00', '20:00')); // gọi vào dọn 4 tiếng: trễ 2 tiếng, về sớm 4 tiếng
  assert.deepEqual([called.byDay['2026-11-10'], called.lateAmt, called.earlyAmt, called.dayUnits, called.holidayDays], [300000, 0, 0, 1, 0], 'never less than staying home');
  assert.equal(called.daily[0].closed, true);
  const unpaid = pay(at('16:00', '20:00'), { holidayPaid: false });
  assert.deepEqual([unpaid.byDay['2026-11-10'], unpaid.lateAmt, unpaid.earlyAmt, unpaid.dayUnits], [150000, 0, 0, 0.5], 'not paid for closed days: half a day worked, still no cuts');
  // Bật "có lương" nhưng chưa nhập lương cơ bản: không cộng ngày công ảo.
  const noBase = computeSalary({ year: 2026, month: 11, staffId: 'a', config: null, rules: LATE_RULES, holidayPaid: true, closedDays: ['2026-11-03'],
    sessions: [{ id: 'w', staff_id: 'a', date: '2026-11-04', clock_in: vnAt('2026-11-04', '14:00'), clock_out: vnAt('2026-11-04', '23:00') }] });
  assert.deepEqual([noBase.dayUnits, noBase.workUnits, noBase.holidayDays, noBase.net], [1, 1, 0, 0]);
});

// Trả theo ngày: 120.000đ một ngày công (cùng bảng lương theo giờ, unit = 'day'), ca 14:00 → 00:00 (600 phút).
const DAILY = [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 120000, unit: 'day' }];
const daySes = (id, day, from, to) => ({ id, staff_id: 'a', date: day, clock_in: vnAt(day, from), clock_out: to === '00:00' || to < from ? new Date(Date.parse(vnAt(day, to)) + 86400000).toISOString() : vnAt(day, to) });

test('paid by the day: each day clocked earns the day wage, a day not clocked earns nothing; half a day, late and early cuts as for monthly pay', () => {
  const sessions = [
    daySes('d2', '2026-11-02', '14:00', '00:00'), // đủ ca → 120.000đ
    // 3/11 không chấm công → nghỉ, không lương
    daySes('d5', '2026-11-05', '14:00', '18:00'), // 4 giờ < nửa ca → nửa ngày 60.000đ; về sớm 6 tiếng → còn 120.000 × 4/10 = 48.000đ
    daySes('d6', '2026-11-06', '14:20', '00:00'), // trễ 20 phút: 120.000 × 20/600 = 4.000đ + 50.000đ mỗi lần
    daySes('d7', '2026-11-07', '13:30', '00:30'), // vào sớm 30 + ở lại 30 phút → 1 giờ tăng ca 25.000đ
  ];
  // Lương cơ bản cũ còn trong cấu hình: ngày trả theo ngày không dùng tới.
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: { base_salary: 9000000, overtime_rate: 25000 }, rules: LATE_RULES, lateRules: SHOP_LATE, hourlyRates: DAILY });
  assert.deepEqual(c.dayWage, { days: 3.5, amount: 420000, rates: [120000] });
  assert.deepEqual([c.dayUnits, c.dayAmt, c.hourly, c.workUnits], [0, 0, null, 3.5]);
  assert.deepEqual([c.lateAmt, c.earlyAmt, c.otAmt, c.basePay, c.net], [54000, 12000, 25000, 420000, 420000 - 54000 - 12000 + 25000]);
  assert.deepEqual(c.byDay, { '2026-11-02': 120000, '2026-11-05': 48000, '2026-11-06': 66000, '2026-11-07': 145000 });
  assert.deepEqual(c.daily.map(d => [d.day, d.wage, d.pay]), [['2026-11-02', 120000, 120000], ['2026-11-05', 120000, 48000], ['2026-11-06', 120000, 66000], ['2026-11-07', 120000, 145000]]);
  assert.deepEqual(c.lateList, [{ day: '2026-11-06', minutes: 20, amount: 54000, perMinute: 4000, fixed: 50000 }]);
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary: c, tallies: monthTallies({ sessions, rules: LATE_RULES, key: '2026-11' }) }).reasons,
    ['trễ 1 lần', '3,5/22 ngày công'], 'someone paid by the day has a salary for the attendance bonus');
  const cost = payrollCost({ year: 2026, month: 11, staff: [{ id: 'a' }], rules: LATE_RULES, lateRules: SHOP_LATE, sessions, configs: [], hourlyRates: DAILY });
  assert.deepEqual(cost.byDay, c.byDay, 'the finance book counts the same day pay');
});

test('paid by the day: shop closed days are unpaid by default; the owner can pay them; a worked closed day has no cuts', () => {
  const work = [daySes('w', '2026-11-04', '14:00', '00:00')];
  const pay = extra => computeSalary({ year: 2026, month: 11, staffId: 'a', config: null, rules: LATE_RULES, lateRules: SHOP_LATE, hourlyRates: DAILY, sessions: work, closedDays: ['2026-11-03'], ...extra });
  assert.deepEqual([pay({}).holidayDays, pay({}).net], [0, 120000], 'a day not clocked is a day off');
  const paid = pay({ holidayPaid: true });
  assert.deepEqual([paid.holidayDays, paid.dayWage.days, paid.dayWage.amount, paid.byDay['2026-11-03'], paid.net], [1, 2, 240000, 120000, 240000]);
  const called = computeSalary({ year: 2026, month: 11, staffId: 'a', config: null, rules: LATE_RULES, lateRules: SHOP_LATE, hourlyRates: DAILY, closedDays: ['2026-11-10'],
    sessions: [daySes('c', '2026-11-10', '16:00', '20:00')] });
  assert.deepEqual([called.byDay['2026-11-10'], called.lateAmt, called.earlyAmt, called.dayWage.days], [60000, 0, 0, 0.5], 'half a day worked, no late / early cut');
});

test('switching between monthly, daily and hourly pay applies from its day', () => {
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((d, i) => daySes(`s${i}`, d, '14:00', '00:00'));
  const rates = [{ staff_id: 'a', valid_from: '2026-11-03', hourly_rate: 120000, unit: 'day' }, { staff_id: 'a', valid_from: '2026-11-04', hourly_rate: 30000, unit: 'hour' },
    { staff_id: 'a', valid_from: '2026-11-05', hourly_rate: 0, unit: 'hour' }];
  const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: days, config: { base_salary: 6000000, overtime_rate: 25000 }, rules: LATE_RULES, hourlyRates: rates });
  assert.deepEqual([c.dayUnits, c.dayAmt, c.dayWage, c.hourly], [2, 400000, { days: 1, amount: 120000, rates: [120000] }, { minutes: 600, amount: 300000, rates: [30000] }]);
  assert.deepEqual(c.byDay, { '2026-11-02': 200000, '2026-11-03': 120000, '2026-11-04': 300000, '2026-11-05': 200000 });
  assert.equal(c.basePay, 820000);
  // Dòng cũ không có unit là lương theo giờ.
  assert.deepEqual([payRateOn(HOURLY, 'a', '2026-11-02'), hourlyRateOn(HOURLY, 'a', '2026-11-02'), dailyRateOn(HOURLY, 'a', '2026-11-02')], [{ rate: 25000, unit: 'hour' }, 25000, null]);
  assert.deepEqual([payRateOn(DAILY, 'a', '2026-11-02'), hourlyRateOn(DAILY, 'a', '2026-11-02'), dailyRateOn(DAILY, 'a', '2026-11-02')], [{ rate: 120000, unit: 'day' }, null, 120000]);
  assert.equal(payRateOn(rates, 'a', '2026-11-06'), null, 'back to monthly pay');
  assert.deepEqual(computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: [], config: null, rules: LATE_RULES, hourlyRates: DAILY }).dayWage,
    { days: 0, amount: 0, rates: [120000] }, 'a day wage set in an earlier month still applies');
});

test('left and came back ("Đi làm lại"): closed days while away are not paid; before leaving and from the return day they are', () => {
  // Tài khoản cũ (2025), làm tới hết 5/11, đi làm lại 19/11. Quán nghỉ 3, 5, 9, 17, 19 và 23/11.
  const work = ['2026-11-02', '2026-11-04', '2026-11-20', '2026-11-24'].map((d, i) => daySes(`r${i}`, d, '14:00', '00:00'));
  const closedDays = ['2026-11-03', '2026-11-05', '2026-11-09', '2026-11-17', '2026-11-19', '2026-11-23'];
  const returns = [{ staff_id: 'a', left_day: '2026-11-05', return_day: '2026-11-19' }, { staff_id: 'b', left_day: '2026-11-01', return_day: '2026-11-30' }];
  const person = { id: 'a', created_at: '2025-06-01T00:00:00Z' };
  const args = holidayArgs(person, { closedDays, returns });
  assert.deepEqual(args.employed, { from: '2025-06-01', to: null, away: [['2026-11-05', '2026-11-19']] }, 'only their own time away');
  const pay = extra => computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 9000000, overtime_rate: 30000 }, rules: LATE_RULES, sessions: work, ...extra });
  const c = pay(args);
  assert.deepEqual(c.daily.filter(d => d.holiday).map(d => d.day), ['2026-11-03', '2026-11-05', '2026-11-19', '2026-11-23'], 'the last day and the return day are working days');
  assert.deepEqual([c.holidayDays, c.workUnits, c.basePay], [4, 8, 2400000]);
  assert.equal(pay(holidayArgs(person, { closedDays })).holidayDays, 6, 'without the record every closed day would be paid');
  // Đi làm lại rồi nghỉ tiếp sau 21/11: chỉ tới ngày làm cuối mới.
  assert.equal(pay(holidayArgs(person, { closedDays, returns, departures: [{ staff_id: 'a', last_day: '2026-11-21' }] })).holidayDays, 3);
});

test('called in on a shop closed day: not counted late or leaving early, so no fine suggestion and the attendance bonus is kept', () => {
  // 22 ngày đủ ca + quán nghỉ 10/11 chủ gọi vào 16:00 → 20:00 ("trễ 2 giờ", "về sớm 4 giờ").
  const sessions = [...[2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map(d => daySes(`d${d}`, `2026-11-${String(d).padStart(2, '0')}`, '14:00', '00:00')),
    daySes('c10', '2026-11-10', '16:00', '20:00')];
  const key = '2026-11', closedDays = ['2026-11-10'];
  const open = monthTallies({ sessions, rules: LATE_RULES, key });
  assert.deepEqual([open.late, open.leftEarly, open.lateDays.length], [{ count: 1, minutes: 120 }, { count: 1, minutes: 240 }, 1], 'an open day would count');
  const t = monthTallies({ sessions, rules: LATE_RULES, key, closedDays });
  assert.deepEqual([t.late, t.leftEarly, t.lateDays], [{ count: 0, minutes: 0 }, { count: 0, minutes: 0 }, []]);
  const salary = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: { base_salary: 9000000, overtime_rate: 30000 }, rules: LATE_RULES, lateRules: SHOP_LATE, closedDays });
  const day = salary.daily.find(d => d.day === '2026-11-10');
  assert.deepEqual([day.closed, day.late, day.leftEarly, day.pay, salary.workUnits, salary.lateAmt], [true, 0, 0, 300000, 23, 0], 'pay was already right; the day no longer shows late');
  assert.deepEqual(fineSuggestions({ staffId: 'a', tallies: t, autoLateDays: salary.lateList.map(x => x.day) }), []);
  assert.deepEqual(bonusCheck({ year: 2026, month: 11, salary, tallies: t }), { eligible: true, reasons: [], minDays: 22 });
  // Trang Thống kê (?stats=1) truyền ngày quán nghỉ của tháng.
  const stats = staffMonthStats({ year: 2026, month: 11, staff: [{ id: 'a', full_name: 'A' }], configs: [{ staff_id: 'a', base_salary: 9000000, overtime_rate: 30000 }], sessions,
    rules: LATE_RULES, lateRules: SHOP_LATE, closedDays: [{ day: '2026-11-10', source: 'manual' }] });
  const p = stats.people[0];
  assert.deepEqual([p.late, p.leftEarly, p.fineSuggestions, p.bonus.eligible, stats.totals.late], [{ count: 0, minutes: 0 }, { count: 0, minutes: 0 }, 0, true, 0]);
});

test('paid by the hour: a mis-scan then back in, or leaving then back to clean up, never pays the same minutes twice', () => {
  // Ca riêng 18:00 → 02:00 (480 phút), 30.000đ/giờ = 500đ/phút; cho lệch 10 phút.
  const NIGHT = normalizeRules({ hours_from: '2026-10-25' }, [{ staff_id: 'a', valid_from: '2026-11-01', start_time: '18:00', end_time: '02:00' }],
    [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }]);
  const rate = [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 30000 }];
  const hourly = (sessions, rules = NIGHT) => computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: { base_salary: 0, overtime_rate: 30000 }, rules, hourlyRates: rate });
  // Quét nhầm 18:00–18:05 rồi vào lại 18:09: 18:00–18:05 không tính hai lần.
  const misScan = [daySes('m1', '2026-11-10', '18:00', '18:05'), daySes('m2', '2026-11-10', '18:09', '02:00')];
  assert.equal(misScan.reduce((a, s) => a + sessionHours(s, NIGHT).countedMs, 0) / 60000, 485, 'each scan alone');
  assert.equal(dayInShiftMs(misScan, NIGHT) / 60000, 480);
  const m = hourly(misScan);
  assert.deepEqual([m.hourly.minutes, m.basePay, m.daily[0].inShiftMin, m.totalWorkH], [480, 240000, 480, 8]);
  // Ca 14:00 → 00:00: về 23:52 (trong 10 phút cho lệch) rồi quay lại dọn 23:55 → 00:30: 600 phút trong ca + 30 phút ở lại,
  // không phải 605 phút; và không ít hơn lúc về luôn lúc 23:52.
  const back = hourly([daySes('b1', '2026-11-11', '14:00', '23:52'), daySes('b2', '2026-11-11', '23:55', '00:30')], LATE_RULES);
  assert.deepEqual([back.hourly.minutes, back.daily[0].extraMin, back.otAmt, back.net], [600, 30, 15000, 315000]);
  assert.equal(hourly([daySes('b1', '2026-11-11', '14:00', '23:52')], LATE_RULES).hourly.minutes, 600);
  assert.equal(hourly([daySes('f1', '2026-11-12', '14:00', '14:04'), daySes('f2', '2026-11-12', '14:08', '00:00')], LATE_RULES).hourly.minutes, 600, 'mis-scan at the start');
  // Lương tháng: ngày công như cũ, giờ làm hiện đúng.
  const monthly = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: misScan, config: { base_salary: 9000000, overtime_rate: 30000 }, rules: NIGHT });
  assert.deepEqual([monthly.workUnits, monthly.basePay, monthly.daily[0].inShiftMin, monthly.totalWorkH], [1, 300000, 480, 8]);
  // Trước ngày tính theo ca: cả lượt, cộng như cũ.
  assert.equal(dayInShiftMs([ses('p1', '2026-10-20', '07:00', '09:00'), ses('p2', '2026-10-20', '10:00', '12:00')], RULES) / 60000, 240);
});

test('the finance book days add up to the pay slip to the đồng: the rounding goes to the last day', () => {
  // Tháng 11: đi làm 28 ngày + 2 ngày quán nghỉ (9/11, 23/11) được lương = 30 công = đúng lương cơ bản.
  const closed = ['2026-11-09', '2026-11-23'];
  const open28 = Array.from({ length: 30 }, (_, i) => i + 1).filter(d => d !== 9 && d !== 23);
  const full = (list, to = '00:00') => list.map(d => daySes(`g${d}`, `2026-11-${String(d).padStart(2, '0')}`, '14:00', to));
  const gross = c => c.basePay - c.lateAmt - c.earlyAmt + c.otAmt;
  const book = c => Object.values(c.byDay).reduce((a, x) => a + x, 0);
  for (const base of [7000000, 6500000, 5500000, 8000000]) {
    const c = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: full(open28), config: { base_salary: base, overtime_rate: 30000 }, rules: LATE_RULES, closedDays: closed });
    assert.deepEqual([book(c), gross(c), c.basePay, c.workUnits, c.holidayDays], [base, base, base, 30, 2], `base ${base}`);
  }
  // 7.000.000đ ÷ 30 = 233.333,33đ: mỗi ngày 233.333đ, ngày cuối 233.343đ (cả trang Lương lẫn Sổ thu chi).
  const g = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: full(open28), config: { base_salary: 7000000, overtime_rate: 30000 }, rules: LATE_RULES, closedDays: closed });
  assert.deepEqual([g.byDay['2026-11-02'], g.byDay['2026-11-09'], g.byDay['2026-11-30'], g.daily.at(-1).pay], [233333, 233333, 233343, 233343]);
  // Tăng ca 25.000đ/giờ mặc định, ở lại 17 phút 10 ngày; theo giờ 22.000đ, về 23:47 10 ngày; trễ + ngày quán nghỉ.
  const ten = [10, 11, 12, 13, 14, 15, 16, 18, 19, 20];
  const ot = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: full(ten, '00:17'), config: { base_salary: 9000000, overtime_rate: null }, rules: LATE_RULES });
  const hr = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: full(ten, '23:47'), config: { base_salary: 0, overtime_rate: 30000 }, rules: LATE_RULES,
    hourlyRates: [{ staff_id: 'a', valid_from: '2026-11-01', hourly_rate: 22000 }] });
  const late = computeSalary({ year: 2026, month: 11, staffId: 'a', config: { base_salary: 7000000, overtime_rate: 30000 }, rules: LATE_RULES, lateRules: SHOP_LATE, closedDays: ['2026-11-09'],
    sessions: [...full([2, 3, 4, 5, 6, 7, 8, 10, 11, 13, 14, 15]), daySes('g12', '2026-11-12', '14:15', '00:00')] });
  assert.deepEqual([ot, hr, late].map(c => book(c) - gross(c)), [0, 0, 0]);
  // late: 13 ngày + ngày quán nghỉ 9/11 = 14 công × 233.333,33đ = 3.266.667đ − trễ 15 phút (5.833đ) − 50.000đ.
  assert.deepEqual([gross(ot), gross(hr), gross(late)], [3070833, 2152333, 3210834], 'the slips do not change');
});

test('a closed month: the finance book days follow the closed slip, even when attendance changes afterwards', () => {
  const staff = [{ id: 'a' }, { id: 'b' }];
  const sessions = [...NOV, { ...ses('b2', '2026-11-02', '07:00', '16:00'), staff_id: 'b' }];
  const configs = [{ staff_id: 'a', ...CONFIG }, { staff_id: 'b', base_salary: 3000000 }];
  // a chốt khi mới có 2/11 và 3/11 (sau đó chủ thêm ca 4/11); b chốt từ trước khi số chốt lưu tiền từng ngày.
  const closes = [{ staff_id: 'a', snapshot: { byDay: { '2026-11-02': 200000, '2026-11-03': 88889 }, bonusAmt: 0, vioAmt: 0 } }, { staff_id: 'b', snapshot: { vioAmt: 0 } }];
  const cost = payrollCost({ year: 2026, month: 11, staff, rules: RULES, reviews: NOV_REVIEWS, sessions, configs, closes });
  assert.deepEqual(cost.byDay, { '2026-11-02': 200000 + 100000, '2026-11-03': 88889 }, 'a by the closed slip, b recomputed');
  assert.deepEqual(payrollCost({ year: 2026, month: 11, staff, rules: RULES, reviews: NOV_REVIEWS, sessions, configs }).byDay,
    { '2026-11-02': 200000 + 100000, '2026-11-03': 88889, '2026-11-04': 245000 }, 'not closed: live attendance');
});
