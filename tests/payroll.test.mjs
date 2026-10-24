import test from 'node:test';
import assert from 'node:assert/strict';
import { dayFlags, groupByWorkDay, normalizeRules } from '../src/lib/attendanceRules.mjs';
import { LATE_FINE_MINUTES, activeFineKinds, bonusCheck, computeSalary, fineSuggestions, monthTallies, usesDayPay } from '../src/lib/payroll.mjs';

// Quán 14:00–23:00 giờ VN = 07:00Z–16:00Z, cho lệch 10 phút, tính giờ theo ca từ 25/10/2026.
const RULES = normalizeRules({ hours_from: '2026-10-25' }, [], [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]);
const CONFIG = { base_salary: 5200000, overtime_rate: 30000 };
const ses = (id, date, from, to) => ({ id, staff_id: 'a', date, clock_in: `${date}T${from}:00Z`, clock_out: to ? `${date}T${to}:00Z` : null });

test('from November: pay by days worked, half a day under half a shift, overtime only for approved outside time', () => {
  assert.deepEqual([usesDayPay(2026, 10), usesDayPay(2026, 11), usesDayPay(2027, 1)], [false, true, true]);
  const sessions = [
    ses('n2', '2026-11-02', '07:00', '16:00'), // đủ ca → 1 ngày
    ses('n3', '2026-11-03', '07:05', '11:00'), // 4 giờ < nửa ca 4,5 giờ → nửa ngày; về sớm 5 giờ → còn 4/9 ngày
    ses('n4', '2026-11-04', '06:00', '16:30'), // vào sớm 60, ở lại 30 phút, chủ cho tính 90 phút → 1 ngày + 1,5 giờ tăng ca
    ses('n5', '2026-11-05', '07:00', '16:00'),
    ses('n6', '2026-11-06', '07:00', '16:40'), // ở lại 40 phút chưa duyệt
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
  assert.deepEqual([c.workUnits, c.basePay], [4.5, 900000], '5.200.000 ÷ 26 × 4,5');
  assert.deepEqual([c.otHours, c.otAmt, c.pendingH], [1.5, 45000, 0.7]);
  assert.deepEqual([c.absDays, c.absAmt], [1, 0], 'a leave request is not deducted again');
  assert.equal(c.totalWorkH, 41.5);
  // Về sớm 5 giờ ngày 3/11: được 200.000đ × 4/9 = 88.889đ thay vì nửa ngày 100.000đ → trừ 11.111đ.
  assert.deepEqual([c.earlyAmt, c.earlyList], [11111, [{ day: '2026-11-03', minutes: 300, amount: 11111 }]]);
  assert.equal(c.net, 900000 - 11111 + 45000 - 200000 - 50000);
});

test('working more than 26 days adds pay, and an overtime rate of 0 pays no overtime', () => {
  const sessions = Array.from({ length: 27 }, (_, i) => ses(`d${i}`, `2026-12-${String(i + 1).padStart(2, '0')}`, '06:00', '16:00'));
  const reviews = sessions.map(s => ({ attendance_id: s.id, status: 'approved', minutes: 60 }));
  const c = computeSalary({ year: 2026, month: 12, staffId: 'a', sessions, config: { base_salary: 5200000, overtime_rate: 0 }, rules: RULES, reviews });
  assert.deepEqual([c.workUnits, c.basePay], [27, 5400000]);
  assert.deepEqual([c.otHours, c.otAmt], [27, 0]);
  assert.equal(computeSalary({ year: 2026, month: 12, staffId: 'a', sessions: [], config: { base_salary: 1 }, rules: RULES }).basePay, 0, 'no days, no base pay');
});

test('October keeps the old formula: full base, overtime above 8 hours a day, leave days deducted', () => {
  const sessions = [
    ses('o20', '2026-10-20', '07:00', '16:30'), // trước ngày tính theo ca: 9,5 giờ → tăng ca 1,5
    ses('o26', '2026-10-26', '06:00', '16:30'), // theo ca: chỉ 9 giờ trong ca → tăng ca 1
  ];
  const c = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions, config: CONFIG, rules: RULES,
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
  assert.deepEqual([nov.workUnits, nov.pendingH, dec.workUnits, dec.pendingH, dec.totalWorkH], [1, 0.5, 0, 0, 0]);
});

test('an approved attendance bonus is added to the pay of its own month only', () => {
  const sessions = [ses('n2', '2026-11-02', '07:00', '16:00')];
  const bonuses = [{ staff_id: 'a', year: 2026, month: 11, amount: 300000 }, { staff_id: 'a', year: 2026, month: 12, amount: 999 }];
  const nov = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: CONFIG, rules: RULES, bonuses });
  assert.deepEqual([nov.bonusAmt, nov.net], [300000, 200000 + 300000]);
  const oct = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions: [], config: CONFIG, rules: RULES, bonuses: [{ year: 2026, month: 10, amount: 100000 }] });
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
  // Ca 14:00–23:00 (9 giờ), lương 5.200.000đ → 200.000đ/ngày ≈ 22.222đ/giờ.
  const pay = (from, to) => computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: [ses('x', '2026-11-04', from, to)], config: CONFIG, rules: RULES });
  assert.deepEqual([pay('07:00', '15:31').earlyAmt, pay('07:00', '15:31').net], [0, 200000], 'left 29 minutes early: no cut');
  assert.deepEqual([pay('07:00', '15:30').earlyAmt, pay('07:00', '15:30').net], [11111, 188889], '30 minutes early: 30 minutes cut');
  const tired = pay('07:00', '13:00'); // xin về lúc 20:00, sớm 3 giờ
  assert.deepEqual([tired.workUnits, tired.earlyAmt, tired.net], [1, 66667, 133333]);
  assert.deepEqual(tired.earlyList, [{ day: '2026-11-04', minutes: 180, amount: 66667 }]);
  // Vào trễ không bị trừ tự động; chỉ về sớm.
  assert.equal(pay('08:00', '16:00').earlyAmt, 0);
  // Tháng cũ (tháng 10) không trừ.
  const oct = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions: [ses('o', '2026-10-27', '07:00', '13:00')], config: CONFIG, rules: RULES });
  assert.deepEqual([oct.earlyAmt, oct.net], [0, 5200000]);
});

test('the night of 31/10 → 1/11: a clean-up after midnight is paid in October, not lost between the two formulas', () => {
  const night = [ses('o31', '2026-10-31', '07:00', '16:00'), { id: 'n1', staff_id: 'a', date: '2026-11-01', clock_in: '2026-10-31T17:30:00Z', clock_out: '2026-10-31T18:30:00Z' }];
  const oct = computeSalary({ year: 2026, month: 10, staffId: 'a', sessions: night, config: CONFIG, rules: RULES, reviews: [{ attendance_id: 'n1', status: 'approved', minutes: 60 }] });
  const nov = computeSalary({ year: 2026, month: 11, staffId: 'a', sessions: night, config: CONFIG, rules: RULES, reviews: [{ attendance_id: 'n1', status: 'approved', minutes: 60 }] });
  assert.deepEqual([oct.workDays, oct.totalWorkH, oct.otHours], [1, 10, 2], 'October: one day of 10 hours (9 + the approved clean-up hour), 2 hours over 8');
  assert.deepEqual([nov.workUnits, nov.totalWorkH], [0, 0], 'not a November day');
});
