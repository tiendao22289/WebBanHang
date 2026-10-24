/**
 * Tính lương một người trong một tháng — dùng chung cho trang Lương, nút "Chốt
 * lương" trên máy chủ và test.
 *
 * Từ tháng 11/2026 (DAY_PAY_FROM):
 *   lương ngày công = lương cơ bản ÷ 26 × số ngày đi làm (làm dư thì cộng thêm;
 *   ngày có giờ trong ca dưới nửa ca tính nửa ngày), tăng ca = giờ ngoài ca chủ đã
 *   cho tính × giá tăng ca. Đơn báo nghỉ chỉ để ghi lý do, không trừ thêm.
 *   Về sớm từ 30 phút: trừ tiền theo giờ về sớm (lương ngày ÷ số giờ của ca), không trừ
 *   quá số tiền ngày đó được tính.
 * Tháng trước đó giữ cách cũ: đủ lương cơ bản, tăng ca = giờ quá 8 tiếng/ngày,
 *   trừ ngày nghỉ có đơn × lương cơ bản ÷ 26.
 * Thưởng chuyên cần chủ đã duyệt cộng vào thực lĩnh; phạt trừ ra.
 */
import { dayFlags, groupByWorkDay, sessionHours, shiftOf, shiftWindow, workDayOf } from './attendanceRules.mjs';

export const STANDARD_DAYS = 26;
export const DAY_PAY_FROM = '2026-11';
export const DEFAULT_OT_RATE = 25000;
// Thưởng chuyên cần: mặc định phải đủ 22 ngày công; gợi ý phạt khi trễ quá 30 phút.
export const BONUS_MIN_DAYS = 22;
export const LATE_FINE_MINUTES = 30;
// Về sớm từ chừng này phút thì trừ tiền theo giờ về sớm.
export const EARLY_CUT_MINUTES = 30;
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
 * người đó; violations: tiền phạt trong tháng; bonuses: thưởng chuyên cần đã duyệt;
 * rules / reviews: giờ làm và các lần chủ duyệt giờ ngoài ca.
 */
export function computeSalary({ year, month, staffId, sessions = [], config = null, requests = [], violations = [], bonuses = [], rules = null, reviews = [] }) {
  const base = Number(config?.base_salary) || 0;
  const otRate = config?.overtime_rate === null || config?.overtime_rate === undefined ? DEFAULT_OT_RATE : Number(config.overtime_rate) || 0;
  const reviewOf = new Map(reviews.map(r => [r.attendance_id, r]));
  const key = monthKey(year, month);
  const approved = requests.filter(r => r.status === 'approved' && r.month === month && r.year === year);
  const advAmt = approved.filter(r => r.request_type === 'advance').reduce((a, r) => a + Number(r.amount || 0), 0);
  const absDays = approved.filter(r => r.request_type === 'absent').reduce((a, r) => a + Number(r.days || 0), 0);
  const vioAmt = violations.reduce((a, v) => a + Number(v.amount || 0), 0);
  const bonusAmt = bonuses.filter(b => Number(b.year) === year && Number(b.month) === month).reduce((a, b) => a + Number(b.amount || 0), 0);
  let totalWorkH = 0, otHours = 0, pendingMs = 0, workUnits = 0;

  if (usesDayPay(year, month)) {
    // Theo ngày làm (ngày của ca): lượt vào lại sau nửa đêm để dọn quán thuộc ca hôm trước, không thành
    // ngày công mới; ngày làm nằm ngoài tháng (ca đêm cuối tháng trước) không tính vào tháng này.
    const days = [...groupByWorkDay(sessions, rules).entries()].filter(([day]) => day.slice(0, 7) === key);
    const workDays = days.filter(([, list]) => list.some(s => s.clock_out)).length;
    const dayRate = base / STANDARD_DAYS;
    const earlyList = [];
    let otMs = 0;
    for (const [day, list] of days) {
      const hs = list.map(s => sessionHours(s, rules, reviewOf.get(s.id)));
      const inShiftMs = hs.reduce((a, h) => a + h.countedMs - h.approvedMs, 0);
      const shift = shiftOf(rules, staffId, day);
      const w = shiftWindow(day, shift.start, shift.end);
      const unit = inShiftMs > 0 ? (inShiftMs >= (w.end - w.start) / 2 ? 1 : 0.5) : 0;
      workUnits += unit;
      // Về sớm từ 30 phút: ngày đó chỉ được lương ngày × phần ca có mặt tới lúc về (trừ đúng số giờ về sớm),
      // không hơn số tiền ngày công đã tính (ngày làm dưới nửa ca vẫn tối đa nửa ngày).
      const early = unit ? dayFlags(list, rules).leftEarly : 0;
      if (early >= EARLY_CUT_MINUTES) {
        const shiftMin = (w.end - w.start) / 60000;
        const cut = Math.round(Math.max(0, dayRate * unit - dayRate * Math.max(0, 1 - early / shiftMin)));
        if (cut > 0) earlyList.push({ day, minutes: early, amount: cut });
      }
      otMs += hs.reduce((a, h) => a + h.approvedMs, 0);
      pendingMs += hs.reduce((a, h) => a + h.pendingMs, 0);
      totalWorkH += hs.reduce((a, h) => a + h.countedMs, 0) / HOUR;
    }
    otHours = round1(otMs / HOUR);
    const basePay = Math.round(base * workUnits / STANDARD_DAYS);
    const earlyAmt = earlyList.reduce((a, x) => a + x.amount, 0);
    // Tiền tăng ca theo đúng số phút đã duyệt (45 phút × 30.000đ/giờ = 22.500đ); số giờ chỉ làm tròn để hiện.
    const otAmt = Math.round(otMs / HOUR * otRate);
    return { rule: 'days', base, standardDays: STANDARD_DAYS, workDays, workUnits, basePay, earlyAmt, earlyList, totalWorkH: round1(totalWorkH), otHours, otAmt,
      bonusAmt, advAmt, absDays, absAmt: 0, vioAmt, pendingH: round1(pendingMs / HOUR), net: basePay - earlyAmt + otAmt + bonusAmt - advAmt - vioAmt };
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
  return { rule: 'hours', base, standardDays: STANDARD_DAYS, workDays, workUnits: workDays, basePay: base, earlyAmt: 0, earlyList: [], totalWorkH, otHours, otAmt,
    bonusAmt, advAmt, absDays, absAmt, vioAmt, pendingH: round1(pendingMs / HOUR), net: base + otAmt + bonusAmt - advAmt - absAmt - vioAmt };
}

/**
 * Trễ / vào sớm / về sớm / ở lại và quên ra ca của một người trong tháng `key`, theo ngày
 * làm (ca đêm qua nửa đêm không thành ngày mới). lateDays / forgotten: từng ngày trễ và
 * từng ca máy tự đóng — dùng cho gợi ý phạt.
 */
export function monthTallies({ sessions = [], rules = null, key, autoClosed = [] }) {
  const tally = { late: [0, 0], early: [0, 0], leftEarly: [0, 0], stayed: [0, 0] };
  const lateDays = [];
  for (const [day, list] of groupByWorkDay(sessions, rules)) {
    if (day.slice(0, 7) !== key) continue;
    const f = dayFlags(list, rules);
    for (const k of Object.keys(tally)) if (f[k]) { tally[k][0] += 1; tally[k][1] += f[k]; }
    if (f.late) lateDays.push({ day, minutes: f.late, attendance_id: list[0].id });
  }
  const auto = new Set(autoClosed);
  const forgotten = sessions.filter(s => auto.has(s.id) && workDayOf(s, rules).slice(0, 7) === key)
    .map(s => ({ day: workDayOf(s, rules), attendance_id: s.id, clock_out: s.clock_out }));
  const pair = ([count, minutes]) => ({ count, minutes });
  return { late: pair(tally.late), early: pair(tally.early), leftEarly: pair(tally.leftEarly), stayed: pair(tally.stayed),
    forgot: forgotten.length, lateDays, forgotten };
}

/**
 * Thưởng chuyên cần của một người trong tháng: không trễ, không quên ra ca, đủ số ngày
 * công (settings.bonus_min_days). Người chưa có lương cơ bản hoặc nghỉ việc trong tháng
 * không xét. Chỉ là gợi ý — chủ tự điền tiền và duyệt.
 */
export function bonusCheck({ year, month, salary, tallies, departure = null, settings = null }) {
  const minDays = Number(settings?.bonus_min_days ?? BONUS_MIN_DAYS);
  const reasons = [];
  if (!usesDayPay(year, month)) reasons.push('tháng này chưa xét thưởng chuyên cần');
  if (!(Number(salary?.base) > 0)) reasons.push('chưa có lương cơ bản');
  if (departure && String(departure.last_day).slice(0, 7) <= monthKey(year, month)) reasons.push('nghỉ việc');
  if (tallies?.late?.count) reasons.push(`trễ ${tallies.late.count} lần`);
  if (tallies?.forgot) reasons.push(`quên ra ca ${tallies.forgot} lần`);
  const units = Number(salary?.workUnits) || 0;
  if (units < minDays) reasons.push(`${String(units).replace('.', ',')}/${String(minDays).replace('.', ',')} ngày công`);
  return { eligible: !reasons.length, reasons, minDays };
}

/**
 * Gợi ý phạt từ chấm công của một người: ngày trễ quá 30 phút, lần quên ra ca. Bỏ các
 * gợi ý chủ đã xử lý (reviews: payroll_fine_reviews — phạt hoặc bỏ qua) và loại lỗi chủ
 * đã ẩn khỏi danh sách lỗi (kinds: loại còn dùng).
 */
export function fineSuggestions({ staffId, tallies, reviews = [], kinds = ['late', 'forgot'] }) {
  const done = new Set(reviews.map(r => `${r.attendance_id}:${r.kind}`));
  return [
    ...(tallies?.lateDays || []).filter(d => d.minutes > LATE_FINE_MINUTES)
      .map(d => ({ staff_id: staffId, kind: 'late', attendance_id: d.attendance_id, day: d.day, minutes: d.minutes })),
    ...(tallies?.forgotten || []).map(f => ({ staff_id: staffId, kind: 'forgot', attendance_id: f.attendance_id, day: f.day, clock_out: f.clock_out })),
  ].filter(x => kinds.includes(x.kind) && !done.has(`${x.attendance_id}:${x.kind}`)).sort((a, b) => a.day.localeCompare(b.day));
}

/** Loại gợi ý phạt còn dùng: lỗi máy tự gợi ý mà chủ chưa ẩn (chưa có danh sách lỗi thì dùng cả hai). */
export const activeFineKinds = rules => (rules?.length ? rules.filter(r => r.kind && r.active !== false).map(r => r.kind) : ['late', 'forgot']);

/**
 * Thống kê nhân sự một tháng cho trang Thống kê: lương từng người (số đã chốt nếu có),
 * số lần / số phút đi trễ, về sớm, vào sớm, ở lại, quên ra ca, quét bị cảnh báo,
 * và tổng quỹ lương. Người nghỉ việc trước tháng này không tính.
 */
export function staffMonthStats({ year, month, staff = [], configs = [], sessions = [], requests = [], violations = [], reviews = [], rules = null,
  closes = [], departures = [], autoClosed = [], scans = [], bonuses = [], bonusSettings = null, fineReviews = [], fineKinds = ['late', 'forgot'] }) {
  const key = monthKey(year, month);
  const of = (rows, id) => rows.filter(r => r.staff_id === id);
  const people = staff.map(p => {
    const departure = departures.find(d => d.staff_id === p.id) || null;
    if (departure && String(departure.last_day).slice(0, 7) < key) return null;
    const mine = of(sessions, p.id), config = configs.find(c => c.staff_id === p.id) || null;
    const reqs = of(requests, p.id), vios = of(violations, p.id), gifts = of(bonuses, p.id);
    if (!config && !mine.length && !reqs.length && !vios.length) return null;
    const live = computeSalary({ year, month, staffId: p.id, sessions: mine, config, requests: reqs, violations: vios, bonuses: gifts, rules, reviews });
    const closed = closes.find(c => c.staff_id === p.id);
    // Số đã chốt trước khi có thưởng chuyên cần không có bonusAmt.
    const salary = closed ? { bonusAmt: 0, ...closed.snapshot, locked: true, paid_at: closed.paid_at || null } : { ...live, locked: false, paid_at: null };
    // Trễ / sớm theo từng ngày làm đủ lượt (ca đêm ra vào lại sau nửa đêm không bị báo trễ sai).
    const t = monthTallies({ sessions: mine, rules, key, autoClosed });
    const myScans = of(scans, p.id);
    return {
      staff_id: p.id, name: p.full_name, departure, salary,
      late: t.late, early: t.early, leftEarly: t.leftEarly, stayed: t.stayed, forgot: t.forgot,
      warnings: myScans.filter(s => s.warnings?.length).length, blocked: myScans.filter(s => s.action === 'blocked').length,
      bonus: { ...bonusCheck({ year, month, salary: live, tallies: t, departure, settings: bonusSettings }), approved: gifts[0] || null },
      fineSuggestions: fineSuggestions({ staffId: p.id, tallies: t, reviews: fineReviews, kinds: fineKinds }).length,
    };
  }).filter(Boolean);
  const sum = f => people.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  return {
    year, month, rule: usesDayPay(year, month) ? 'days' : 'hours', people,
    totals: {
      staff: people.length,
      gross: sum(p => p.salary.basePay - (p.salary.earlyAmt || 0) + p.salary.otAmt + p.salary.bonusAmt),
      net: sum(p => p.salary.net), advances: sum(p => p.salary.advAmt), fines: sum(p => p.salary.vioAmt), bonuses: sum(p => p.salary.bonusAmt),
      earlyCuts: sum(p => p.salary.earlyAmt || 0),
      otAmt: sum(p => p.salary.otAmt), hours: round1(sum(p => p.salary.totalWorkH)), pendingH: round1(sum(p => p.salary.pendingH)),
      late: sum(p => p.late.count), forgot: sum(p => p.forgot), closed: people.filter(p => p.salary.locked).length,
      paid: people.filter(p => p.salary.paid_at).length,
    },
  };
}
