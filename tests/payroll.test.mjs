import test from 'node:test';
import assert from 'node:assert/strict';
import { dayFlags, groupByWorkDay, normalizeRules } from '../src/lib/attendanceRules.mjs';
import { computeSalary, usesDayPay } from '../src/lib/payroll.mjs';

// Quán 14:00–23:00 giờ VN = 07:00Z–16:00Z, cho lệch 10 phút, tính giờ theo ca từ 25/10/2026.
const RULES = normalizeRules({ hours_from: '2026-10-25' }, [], [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]);
const CONFIG = { base_salary: 5200000, overtime_rate: 30000 };
const ses = (id, date, from, to) => ({ id, staff_id: 'a', date, clock_in: `${date}T${from}:00Z`, clock_out: to ? `${date}T${to}:00Z` : null });

test('from November: pay by days worked, half a day under half a shift, overtime only for approved outside time', () => {
  assert.deepEqual([usesDayPay(2026, 10), usesDayPay(2026, 11), usesDayPay(2027, 1)], [false, true, true]);
  const sessions = [
    ses('n2', '2026-11-02', '07:00', '16:00'), // đủ ca → 1 ngày
    ses('n3', '2026-11-03', '07:05', '11:00'), // 4 giờ < nửa ca 4,5 giờ → nửa ngày
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
  assert.equal(c.net, 900000 + 45000 - 200000 - 50000);
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
