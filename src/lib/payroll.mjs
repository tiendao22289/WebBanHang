/**
 * Tính lương một người trong một tháng — dùng chung cho trang Lương, nút "Chốt
 * lương" trên máy chủ và test.
 *
 * Từ tháng 11/2026 (DAY_PAY_FROM):
 *   lương ngày công = lương cơ bản ÷ 26 × số ngày đi làm (làm dư thì cộng thêm;
 *   ngày có giờ trong ca dưới nửa ca tính nửa ngày), tăng ca = giờ ngoài ca chủ đã
 *   cho tính × giá tăng ca. Đơn báo nghỉ chỉ để ghi lý do, không trừ thêm.
 * Tháng trước đó giữ cách cũ: đủ lương cơ bản, tăng ca = giờ quá 8 tiếng/ngày,
 *   trừ ngày nghỉ có đơn × lương cơ bản ÷ 26.
 */
import { dayFlags, groupByWorkDay, sessionHours, shiftOf, shiftWindow, workDayOf } from './attendanceRules.mjs';

export const STANDARD_DAYS = 26;
export const DAY_PAY_FROM = '2026-11';
export const DEFAULT_OT_RATE = 25000;
const HOUR = 3600000;
const round1 = n => Math.round(n * 10) / 10;

export const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
export const usesDayPay = (year, month) => monthKey(year, month) >= DAY_PAY_FROM;

function byDate(sessions) {
  const days = new Map();
  for (const s of sessions) days.set(s.date, [...(days.get(s.date) || []), s]);
  return [...days.values()];
}

/**
 * sessions: ca của người đó trong tháng; config: dòng payroll_config; requests: đơn của
 * người đó; violations: tiền phạt trong tháng; rules / reviews: giờ làm và các lần
 * chủ duyệt giờ ngoài ca.
 */
export function computeSalary({ year, month, staffId, sessions = [], config = null, requests = [], violations = [], rules = null, reviews = [] }) {
  const base = Number(config?.base_salary) || 0;
  const otRate = config?.overtime_rate === null || config?.overtime_rate === undefined ? DEFAULT_OT_RATE : Number(config.overtime_rate) || 0;
  const reviewOf = new Map(reviews.map(r => [r.attendance_id, r]));
  const key = monthKey(year, month);
  const approved = requests.filter(r => r.status === 'approved' && r.month === month && r.year === year);
  const advAmt = approved.filter(r => r.request_type === 'advance').reduce((a, r) => a + Number(r.amount || 0), 0);
  const absDays = approved.filter(r => r.request_type === 'absent').reduce((a, r) => a + Number(r.days || 0), 0);
  const vioAmt = violations.reduce((a, v) => a + Number(v.amount || 0), 0);
  let totalWorkH = 0, otHours = 0, pendingMs = 0, workUnits = 0;

  if (usesDayPay(year, month)) {
    // Theo ngày làm (ngày của ca): lượt vào lại sau nửa đêm để dọn quán thuộc ca hôm trước, không thành
    // ngày công mới; ngày làm nằm ngoài tháng (ca đêm cuối tháng trước) không tính vào tháng này.
    const days = [...groupByWorkDay(sessions, rules).entries()].filter(([day]) => day.slice(0, 7) === key);
    const workDays = days.filter(([, list]) => list.some(s => s.clock_out)).length;
    let otMs = 0;
    for (const [day, list] of days) {
      const hs = list.map(s => sessionHours(s, rules, reviewOf.get(s.id)));
      const inShiftMs = hs.reduce((a, h) => a + h.countedMs - h.approvedMs, 0);
      const shift = shiftOf(rules, staffId, day);
      const w = shiftWindow(day, shift.start, shift.end);
      if (inShiftMs > 0) workUnits += inShiftMs >= (w.end - w.start) / 2 ? 1 : 0.5;
      otMs += hs.reduce((a, h) => a + h.approvedMs, 0);
      pendingMs += hs.reduce((a, h) => a + h.pendingMs, 0);
      totalWorkH += hs.reduce((a, h) => a + h.countedMs, 0) / HOUR;
    }
    otHours = round1(otMs / HOUR);
    const basePay = Math.round(base * workUnits / STANDARD_DAYS);
    // Tiền tăng ca theo đúng số phút đã duyệt (45 phút × 30.000đ/giờ = 22.500đ); số giờ chỉ làm tròn để hiện.
    const otAmt = Math.round(otMs / HOUR * otRate);
    return { rule: 'days', base, standardDays: STANDARD_DAYS, workDays, workUnits, basePay, totalWorkH: round1(totalWorkH), otHours, otAmt,
      advAmt, absDays, absAmt: 0, vioAmt, pendingH: round1(pendingMs / HOUR), net: basePay + otAmt - advAmt - vioAmt };
  }

  // Cách cũ (giữ nguyên số của các tháng trước): tính từng ngày ghi, làm tròn 0,1 giờ.
  const days = byDate(sessions.filter(s => String(s.date).slice(0, 7) === key));
  const workDays = days.filter(d => d.some(s => s.clock_out)).length;
  for (const day of days) {
    const byShift = rules && String(day[0].date) >= rules.hours_from;
    const dayH = byShift
      ? round1(day.reduce((a, s) => a + sessionHours(s, rules, reviewOf.get(s.id)).countedMs, 0) / HOUR)
      : round1(day.filter(s => s.clock_out).reduce((a, s) => a + round1((new Date(s.clock_out) - new Date(s.clock_in)) / HOUR), 0));
    if (byShift) pendingMs += day.reduce((a, s) => a + sessionHours(s, rules, reviewOf.get(s.id)).pendingMs, 0);
    totalWorkH += dayH;
    if (dayH > 8) otHours += round1(dayH - 8);
  }
  totalWorkH = round1(totalWorkH);
  otHours = round1(otHours);
  const otAmt = Math.round(otHours * otRate);
  const absAmt = Math.round(absDays * (base > 0 ? Math.round(base / STANDARD_DAYS) : 0));
  return { rule: 'hours', base, standardDays: STANDARD_DAYS, workDays, workUnits: workDays, basePay: base, totalWorkH, otHours, otAmt,
    advAmt, absDays, absAmt, vioAmt, pendingH: round1(pendingMs / HOUR), net: base + otAmt - advAmt - absAmt - vioAmt };
}

/**
 * Thống kê nhân sự một tháng cho trang Thống kê: lương từng người (số đã chốt nếu có),
 * số lần / số phút đi trễ, về sớm, vào sớm, ở lại, quên ra ca, quét bị cảnh báo,
 * và tổng quỹ lương. Người nghỉ việc trước tháng này không tính.
 */
export function staffMonthStats({ year, month, staff = [], configs = [], sessions = [], requests = [], violations = [], reviews = [], rules = null,
  closes = [], departures = [], autoClosed = [], scans = [] }) {
  const key = monthKey(year, month);
  const of = (rows, id) => rows.filter(r => r.staff_id === id);
  const auto = new Set(autoClosed);
  const people = staff.map(p => {
    const departure = departures.find(d => d.staff_id === p.id) || null;
    if (departure && String(departure.last_day).slice(0, 7) < key) return null;
    const mine = of(sessions, p.id), config = configs.find(c => c.staff_id === p.id) || null;
    const reqs = of(requests, p.id), vios = of(violations, p.id);
    if (!config && !mine.length && !reqs.length && !vios.length) return null;
    const live = computeSalary({ year, month, staffId: p.id, sessions: mine, config, requests: reqs, violations: vios, rules, reviews });
    const closed = closes.find(c => c.staff_id === p.id);
    const salary = closed ? { ...closed.snapshot, locked: true, paid_at: closed.paid_at || null } : { ...live, locked: false, paid_at: null };
    const tally = { late: [0, 0], early: [0, 0], leftEarly: [0, 0], stayed: [0, 0] };
    // Trễ / sớm tính theo từng ngày làm đủ lượt (ca đêm ra vào lại sau nửa đêm không bị báo trễ sai).
    for (const [day, list] of groupByWorkDay(mine, rules)) {
      if (day.slice(0, 7) !== key) continue;
      const f = dayFlags(list, rules);
      for (const k of Object.keys(tally)) if (f[k]) { tally[k][0] += 1; tally[k][1] += f[k]; }
    }
    const myScans = of(scans, p.id);
    return {
      staff_id: p.id, name: p.full_name, departure, salary,
      late: { count: tally.late[0], minutes: tally.late[1] }, early: { count: tally.early[0], minutes: tally.early[1] },
      leftEarly: { count: tally.leftEarly[0], minutes: tally.leftEarly[1] }, stayed: { count: tally.stayed[0], minutes: tally.stayed[1] },
      forgot: mine.filter(s => auto.has(s.id) && workDayOf(s, rules).slice(0, 7) === key).length,
      warnings: myScans.filter(s => s.warnings?.length).length, blocked: myScans.filter(s => s.action === 'blocked').length,
    };
  }).filter(Boolean);
  const sum = f => people.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  return {
    year, month, rule: usesDayPay(year, month) ? 'days' : 'hours', people,
    totals: {
      staff: people.length,
      gross: sum(p => p.salary.basePay + p.salary.otAmt),
      net: sum(p => p.salary.net), advances: sum(p => p.salary.advAmt), fines: sum(p => p.salary.vioAmt),
      otAmt: sum(p => p.salary.otAmt), hours: round1(sum(p => p.salary.totalWorkH)), pendingH: round1(sum(p => p.salary.pendingH)),
      late: sum(p => p.late.count), forgot: sum(p => p.forgot), closed: people.filter(p => p.salary.locked).length,
      paid: people.filter(p => p.salary.paid_at).length,
    },
  };
}
