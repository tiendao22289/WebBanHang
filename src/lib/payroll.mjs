/**
 * Tính lương một người trong một tháng — dùng chung cho trang Lương, nút "Chốt
 * lương" trên máy chủ và test.
 *
 * Từ tháng 11/2026 (DAY_PAY_FROM):
 *   lương ngày công = lương cơ bản ÷ số ngày của tháng (28 / 29 / 30 / 31) × số ngày công (ngày có giờ trong ca dưới
 *   nửa ca tính nửa ngày; ngày quán nghỉ người lương tháng cũng được 1 công, nên đi làm đủ tháng = đúng lương cơ bản —
 *   chủ chọn 2026-11-05 thay cho ÷ 26: quán chỉ nghỉ 2 ngày một tháng, chia 26 thì đi làm đủ được 30–31 công), tăng ca = giờ ngoài ca (vào sớm / ở lại,
 *   tự tính từ AUTO_EXTRA_FROM trừ ca chủ bấm không tính) × giá tăng ca. Đơn báo nghỉ chỉ để ghi
 *   lý do, không trừ thêm.
 *   Đi trễ theo luật đi trễ (payroll_late_rules: mặc định cả quán hoặc riêng từng người): trễ quá số phút
 *   cho phép thì trừ số tiền cố định mỗi lần và / hoặc trừ đúng số phút trễ; về sớm từ 30 phút: trừ số phút
 *   về sớm — phần theo phút tính theo lương ngày ÷ số phút của ca, không trừ quá số tiền ngày đó được tính.
 *   Ngày quán nghỉ (shop_closed_days) mà người đó không đi làm: người được nhận lương ngày nghỉ được đủ 1 ngày công
 *   (lương cơ bản ÷ số ngày của tháng; theo giờ: số giờ của ca × lương 1 giờ), tính cả vào số ngày công. Mặc định lương tháng có,
 *   theo giờ không; chủ đổi từng người (payroll_holiday_pay). Chỉ tính ngày từ lúc vào làm tới ngày nghỉ việc (người
 *   nghỉ rồi đi làm lại: không tính khoảng đã nghỉ). Ngày quán nghỉ có đi làm không tính trễ / về sớm.
 *   Người trả theo giờ (payroll_hourly_rates, có ngày áp dụng): ngày đó được số phút trong ca
 *   × lương 1 giờ — trễ / về sớm mất đúng số phút đó, không nửa ngày, không trừ về sớm thêm;
 *   giờ ngoài ca chủ cho tính vẫn trả theo giá tăng ca.
 *   Người trả theo ngày (cùng bảng, unit = 'day'): như lương tháng nhưng một ngày công = lương 1 ngày chủ nhập
 *   (thay cho lương cơ bản ÷ số ngày của tháng); ngày không chấm công là nghỉ, không lương. Ngày quán nghỉ mặc định không lương.
 * Tháng trước đó giữ cách cũ: đủ lương cơ bản, tăng ca = giờ quá 8 tiếng/ngày,
 *   trừ ngày nghỉ có đơn × lương cơ bản ÷ 26.
 * Thưởng chuyên cần chủ đã duyệt cộng vào thực lĩnh; phạt trừ ra.
 * Ca có face_hold (ghi sau 3 lần sai mặt ở máy quầy, chờ chủ duyệt) chưa tính.
 *
 * byDay { ngày làm: tiền } — lương của riêng từng ngày (ngày công + tăng ca − trừ trễ / về sớm) cho Sổ thu chi, cộng lại
 * đúng bằng phiếu lương (vài đồng lệch do làm tròn từng ngày dồn vào ngày cuối); tháng tính cách cũ cũng ghi theo ngày
 * làm: lương cơ bản ÷ 26 + tăng ca hôm đó.
 * daily — từng ngày làm: giờ vào / ra, vào sớm, vào trễ, ở lại (ra dư), về sớm (phút) và tiền của ngày đó.
 */
import { dayFlags, dayInShiftMs, groupByWorkDay, sessionHours, shiftOf, shiftWindow, workDayOf } from './attendanceRules.mjs';
import { lunarDaysBetween } from './lunar.mjs';

// Ngày công chuẩn của cách tính cũ (tháng trước 11/2026). Từ 11/2026 một ngày công = lương cơ bản ÷ số ngày của tháng (monthDays).
export const STANDARD_DAYS = 26;
export const monthDays = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
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

const unitOf = r => (r?.unit === 'day' ? 'day' : 'hour');

/** Mức lương của một người ngày `day` (dòng mới nhất đã áp dụng): { rate, unit: 'hour' | 'day' }; null = trả theo tháng. */
export function payRateOn(rates, staffId, day) {
  let found = null;
  for (const r of rates || []) {
    if (r.staff_id === staffId && String(r.valid_from) <= day && (!found || String(r.valid_from) > String(found.valid_from))) found = r;
  }
  return Number(found?.hourly_rate) > 0 ? { rate: Number(found.hourly_rate), unit: unitOf(found) } : null;
}

/** Lương 1 giờ của một người ngày `day`; null = không trả theo giờ. */
export function hourlyRateOn(rates, staffId, day) {
  const p = payRateOn(rates, staffId, day);
  return p?.unit === 'hour' ? p.rate : null;
}

/** Lương 1 ngày của một người ngày `day`; null = không trả theo ngày. */
export function dailyRateOn(rates, staffId, day) {
  const p = payRateOn(rates, staffId, day);
  return p?.unit === 'day' ? p.rate : null;
}

/**
 * Luật đi trễ của một người ngày `day` (bảng payroll_late_rules): luật riêng nếu có (và không chọn "theo quán"),
 * không thì mặc định của quán; null = ngày đó chưa có luật, không trừ. allowed: số phút được trễ; perMinute: trừ
 * theo phút trễ; fixed: tiền trừ mỗi lần trễ; own: luật riêng của người đó.
 */
export function lateRuleOn(rules, staffId, day) {
  const latest = scope => {
    let found = null;
    for (const r of rules || []) if (r.scope === scope && String(r.valid_from) <= day && (!found || String(r.valid_from) > String(found.valid_from))) found = r;
    return found;
  };
  const own = latest(staffId), r = own && !own.use_shop ? own : latest('shop');
  return r ? { allowed: Number(r.allowed_minutes) || 0, perMinute: !!r.per_minute, fixed: Number(r.fixed_amount) || 0, own: r === own } : null;
}

const vnDay = iso => (iso ? new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(0, 10) : null);
const dayBefore = d => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/**
 * Ngày quán nghỉ từ `from` tới `to`: theo lịch âm lịch mỗi tháng (shop_closed_rules, mỗi dòng áp dụng từ valid_from tới
 * dòng sau) + ngày chủ thêm tay (shop_closed_days), bỏ ngày chủ bấm mở cửa (skip). withSkipped: giữ ngày mở cửa (skipped).
 * → [{ day, source: 'lunar' | 'manual', lunar?, note?, skipped? }] theo thứ tự ngày.
 */
export function shopClosedDays({ rules = [], rows = [], from, to, withSkipped = false }) {
  const out = new Map(), list = [...(rules || [])].sort((a, b) => String(a.valid_from).localeCompare(String(b.valid_from)));
  list.forEach((r, i) => {
    const start = String(r.valid_from) > from ? String(r.valid_from) : from;
    const stop = list[i + 1] ? dayBefore(String(list[i + 1].valid_from)) : to, end = stop < to ? stop : to;
    if (start <= end) for (const x of lunarDaysBetween(start, end, r.lunar_days)) out.set(x.date, { day: x.date, source: 'lunar', lunar: x.lunar });
  });
  for (const r of rows || []) {
    const day = String(r.day).slice(0, 10);
    if (day < from || day > to) continue;
    if (!r.skip) out.set(day, { day, source: 'manual', note: r.note || null });
    else if (withSkipped && out.has(day)) out.set(day, { ...out.get(day), skipped: true });
    else out.delete(day);
  }
  return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Tham số ngày quán nghỉ cho computeSalary của một người: các ngày quán nghỉ, người đó có được nhận lương ngày nghỉ
 * không (null = mặc định), và khoảng làm việc (từ ngày tạo tài khoản tới ngày làm cuối nếu đã nghỉ việc). returns: các
 * lần nghỉ việc rồi đi làm lại (bảng staff_returns) → employed.away [ngày làm cuối, ngày đi làm lại]: giữa hai ngày đó
 * không phải lúc đang làm.
 */
export function holidayArgs(person, { closedDays = [], holidayPay = [], departures = [], returns = [] } = {}) {
  const flag = (holidayPay || []).find(h => h.staff_id === person?.id);
  const away = (returns || []).filter(r => r.staff_id === person?.id).map(r => [String(r.left_day).slice(0, 10), String(r.return_day).slice(0, 10)]);
  return { closedDays: (closedDays || []).map(d => String(d?.day ?? d).slice(0, 10)), holidayPaid: flag ? !!flag.paid : null,
    employed: { from: vnDay(person?.created_at), to: (departures || []).find(d => d.staff_id === person?.id)?.last_day || null, ...(away.length ? { away } : {}) } };
}

// Các mức lương 1 giờ / 1 ngày (unit) áp dụng trong tháng `key` (đầu tháng + các lần đổi trong tháng).
const ratesIn = (rates, staffId, key, unit) => [...new Set([(unit === 'day' ? dailyRateOn : hourlyRateOn)(rates, staffId, `${key}-01`),
  ...(rates || []).filter(r => r.staff_id === staffId && String(r.valid_from).slice(0, 7) === key && unitOf(r) === unit).map(r => Number(r.hourly_rate) || 0)].filter(r => r > 0))];

/**
 * sessions: ca của người đó trong tháng; config: dòng payroll_config; requests: đơn của
 * người đó; violations: tiền phạt trong tháng; bonuses: thưởng chuyên cần đã duyệt;
 * rules / reviews: giờ làm và các lần chủ duyệt giờ ngoài ca; hourlyRates: lương 1 giờ
 * (payroll_hourly_rates) của người đó; lateRules: luật đi trễ (của quán + của người đó); closedDays / holidayPaid /
 * employed: ngày quán nghỉ (xem holidayArgs).
 */
export function computeSalary({ year, month, staffId, sessions = [], config = null, requests = [], violations = [], bonuses = [], rules = null, reviews = [], hourlyRates = [], lateRules = [],
  closedDays = [], holidayPaid = null, employed = null }) {
  sessions = sessions.filter(s => !s.face_hold);
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
  const byDay = {};

  if (usesDayPay(year, month)) {
    // Theo ngày làm (ngày của ca): lượt vào lại sau nửa đêm để dọn quán thuộc ca hôm trước, không thành
    // ngày công mới; ngày làm nằm ngoài tháng (ca đêm cuối tháng trước) không tính vào tháng này.
    const days = [...groupByWorkDay(sessions, rules).entries()].filter(([day]) => day.slice(0, 7) === key);
    const workDays = days.filter(([, list]) => list.some(s => s.clock_out)).length;
    const standardDays = monthDays(year, month), dayRate = base / standardDays;
    const earlyList = [], lateList = [], daily = [];
    let otMs = 0, dayUnits = 0, hourMin = 0, hourPay = 0, wageUnits = 0, wagePay = 0;
    // Ngày quán nghỉ: người được nhận lương ngày nghỉ (trong thời gian làm việc, trừ lúc đã nghỉ rồi đi làm lại; mặc định
    // lương tháng có, theo giờ / theo ngày không).
    const closedSet = new Set(closedDays);
    const employedOn = day => !(employed?.from && day < employed.from) && !(employed?.to && day > employed.to)
      && !(employed?.away || []).some(([left, back]) => day > left && day < back);
    const holidayOk = (day, rate, wage) => employedOn(day) && !!(holidayPaid ?? (!rate && !wage && base > 0));
    for (const [day, list] of days) {
      const hs = list.map(s => sessionHours(s, rules, reviewOf.get(s.id)));
      // Giờ trong ca gộp cả ngày: lượt quét nhầm rồi vào lại / về rồi quay lại dọn quán không tính trùng.
      const inShiftMs = dayInShiftMs(list, rules);
      const shift = shiftOf(rules, staffId, day);
      const w = shiftWindow(day, shift.start, shift.end);
      const flags = dayFlags(list, rules);
      const rate = hourlyRateOn(hourlyRates, staffId, day), wage = dailyRateOn(hourlyRates, staffId, day);
      // Đi làm đúng ngày quán nghỉ (chủ gọi vào dọn dẹp...): không trừ trễ / về sớm, và người được lương ngày nghỉ ít nhất
      // vẫn đủ 1 ngày công như ở nhà.
      const closedDay = closedSet.has(day), holidayFull = closedDay && holidayOk(day, rate, wage) && (base > 0 || !!rate || !!wage);
      const worked = inShiftMs > 0 ? (inShiftMs >= (w.end - w.start) / 2 ? 1 : 0.5) : 0, unit = holidayFull ? 1 : worked;
      // Ngày công (cả ngày trả theo giờ) để xét thưởng chuyên cần và hiện số ngày đi làm.
      workUnits += unit;
      // Đi trễ so với giờ vào ca (đủ phút, kể cả trong số phút cho lệch của quán); quá số phút luật cho phép thì bị trừ.
      // Chỉ từ ngày tính giờ theo ca; người chưa có lương (chưa nhập lương cơ bản, không trả theo giờ / theo ngày) chưa trừ gì.
      const lateRule = lateRuleOn(lateRules, staffId, day);
      const rawLate = Math.max(0, Math.floor((Date.parse(list[0].clock_in) - w.start.getTime()) / 60000)) || 0;
      const byShift = !!rules && String(list[0].date) >= rules.hours_from;
      const lateHit = !!(lateRule && unit && byShift && !closedDay && rawLate > lateRule.allowed && (base > 0 || rate || wage));
      // Tiền cố định mỗi lần trễ: không trừ quá số tiền còn lại của ngày đó (ngày làm ít giờ không thành âm).
      const fixedOf = left => (lateHit ? Math.min(lateRule.fixed, Math.max(0, Math.floor(left))) : 0);
      let pay, lateCut = 0, earlyCut = 0, lateFixed = 0;
      if (rate) {
        // Theo giờ: số phút trong ca × lương 1 giờ (trễ đã mất đúng số phút đó, chỉ trừ thêm tiền cố định của luật đi
        // trễ). Làm tròn lên phút để khớp "trễ / về sớm X phút" (làm tròn xuống).
        const minutes = Math.max(Math.ceil(inShiftMs / 60000), holidayFull ? Math.round((w.end - w.start) / 60000) : 0), earned = minutes / 60 * rate;
        lateFixed = fixedOf(earned);
        pay = earned - lateFixed;
        hourMin += minutes;
        hourPay += earned;
      } else {
        // Lương 1 ngày: trả theo ngày thì đúng số chủ nhập, theo tháng thì lương cơ bản ÷ số ngày của tháng.
        const oneDay = wage || dayRate;
        if (wage) { wageUnits += unit; wagePay += wage * unit; } else dayUnits += unit;
        // Trễ quá số phút cho phép (luật trừ theo phút): trừ đúng số phút trễ; về sớm từ 30 phút: trừ số phút về sớm.
        // Ngày đó chỉ được lương ngày × phần ca có mặt, không hơn số tiền ngày công đã tính (dưới nửa ca vẫn tối đa nửa ngày).
        const shiftMin = (w.end - w.start) / 60000;
        const late = lateHit && lateRule.perMinute ? rawLate : 0;
        const early = unit && !closedDay && flags.leftEarly >= EARLY_CUT_MINUTES ? flags.leftEarly : 0;
        const full = oneDay * unit, kept = Math.min(full, oneDay * Math.max(0, 1 - (late + early) / shiftMin));
        const cut = Math.round(full - kept);
        lateCut = Math.min(cut, Math.round(oneDay * late / shiftMin));
        earlyCut = cut - lateCut;
        if (earlyCut > 0) earlyList.push({ day, minutes: early, amount: earlyCut });
        lateFixed = fixedOf(full - cut);
        pay = full - cut - lateFixed;
      }
      // Tiền trừ vì đi trễ của ngày: phần theo phút + tiền cố định mỗi lần trễ.
      if (lateCut + lateFixed > 0) lateList.push({ day, minutes: rawLate, amount: lateCut + lateFixed, perMinute: lateCut, fixed: lateFixed });
      lateCut += lateFixed;
      const dayOtMs = hs.reduce((a, h) => a + h.approvedMs, 0);
      otMs += dayOtMs;
      if (unit || dayOtMs) byDay[day] = Math.round(pay + dayOtMs / HOUR * otRate);
      const last = list[list.length - 1];
      // Ngày quán nghỉ không có trễ / về sớm (chủ gọi vào làm giờ nào cũng được).
      daily.push({ day, in: list[0].clock_in, out: last.clock_out || null, hourly: !!rate, ...(wage ? { wage } : {}), ...(closedDay ? { closed: true } : {}),
        early: flags.early, late: lateHit ? rawLate : closedDay ? 0 : flags.late, stay: flags.stayed, leftEarly: closedDay ? 0 : flags.leftEarly,
        inShiftMin: Math.round(inShiftMs / 60000), extraMin: Math.round(dayOtMs / 60000), extraAmt: Math.round(dayOtMs / HOUR * otRate),
        pendingMin: Math.round(hs.reduce((a, h) => a + h.pendingMs, 0) / 60000), lateCut, earlyCut, pay: byDay[day] || 0 });
      pendingMs += hs.reduce((a, h) => a + h.pendingMs, 0);
      totalWorkH += (inShiftMs + dayOtMs) / HOUR;
    }
    // Ngày quán nghỉ người đó không đi làm: người được nhận lương ngày nghỉ được đủ 1 ngày công. Chỉ khi tháng đó người ấy
    // có đi làm (tài khoản cũ đã thôi làm mà chưa ghi nghỉ việc thì không tự có lương).
    const workedDays = new Set(days.map(([day]) => day));
    let holidayDays = 0;
    for (const day of (workedDays.size ? [...closedSet] : []).filter(d => d.slice(0, 7) === key && !workedDays.has(d)).sort()) {
      const rate = hourlyRateOn(hourlyRates, staffId, day), wage = dailyRateOn(hourlyRates, staffId, day);
      if (!holidayOk(day, rate, wage)) continue;
      const shift = shiftOf(rules, staffId, day), w = shiftWindow(day, shift.start, shift.end), minutes = Math.round((w.end - w.start) / 60000);
      const pay = rate ? minutes / 60 * rate : wage || dayRate;
      if (!(pay > 0)) continue;
      if (rate) { hourMin += minutes; hourPay += pay; } else if (wage) { wageUnits += 1; wagePay += wage; } else dayUnits += 1;
      workUnits += 1;
      holidayDays += 1;
      byDay[day] = Math.round(pay);
      daily.push({ day, in: null, out: null, hourly: !!rate, ...(wage ? { wage } : {}), holiday: true, early: 0, late: 0, stay: 0, leftEarly: 0, inShiftMin: 0, extraMin: 0, extraAmt: 0,
        pendingMin: 0, lateCut: 0, earlyCut: 0, pay: byDay[day] });
    }
    daily.sort((a, b) => a.day.localeCompare(b.day));
    otHours = round1(otMs / HOUR);
    // dayAmt: lương ngày công (trả theo tháng); hourly: phần trả theo giờ (có khi người đó có lương 1 giờ trong tháng);
    // dayWage: phần trả theo ngày (số ngày công × lương 1 ngày).
    const dayAmt = Math.round(base * dayUnits / standardDays);
    const rates = ratesIn(hourlyRates, staffId, key, 'hour'), wages = ratesIn(hourlyRates, staffId, key, 'day');
    const hourly = rates.length || hourMin ? { minutes: hourMin, amount: Math.round(hourPay), rates } : null;
    const dayWage = wages.length || wageUnits ? { days: wageUnits, amount: Math.round(wagePay), rates: wages } : null;
    const basePay = dayAmt + (hourly?.amount || 0) + (dayWage?.amount || 0);
    const earlyAmt = earlyList.reduce((a, x) => a + x.amount, 0), lateAmt = lateList.reduce((a, x) => a + x.amount, 0);
    // Tiền tăng ca theo đúng số phút ngoài ca được tính (45 phút × 30.000đ/giờ = 22.500đ); số giờ chỉ làm tròn để hiện.
    const otAmt = Math.round(otMs / HOUR * otRate);
    // Phiếu làm tròn cả tháng, mỗi ngày làm tròn riêng: vài đồng lệch dồn vào ngày cuối có lương để Sổ thu chi cộng đúng
    // bằng phiếu.
    const lastDay = Object.keys(byDay).sort().filter(d => byDay[d] > 0).pop();
    const rest = basePay - lateAmt - earlyAmt + otAmt - Object.values(byDay).reduce((a, x) => a + x, 0);
    if (lastDay && rest) {
      byDay[lastDay] += rest;
      daily.find(d => d.day === lastDay).pay = byDay[lastDay];
    }
    return { rule: 'days', base, standardDays, workDays, workUnits, holidayDays, dayUnits, dayAmt, hourly, dayWage, basePay, earlyAmt, earlyList, lateAmt, lateList,
      totalWorkH: round1(totalWorkH), otHours, otAmt, bonusAmt, advAmt, absDays, absAmt: 0, vioAmt, pendingH: round1(pendingMs / HOUR),
      net: basePay - lateAmt - earlyAmt + otAmt + bonusAmt - advAmt - vioAmt, byDay, daily };
  }

  // Cách cũ (giữ nguyên số của các tháng trước): tính từng ngày làm, làm tròn 0,1 giờ. Theo ngày làm như tháng
  // ngày công để lượt dọn quán sau nửa đêm (vd. đêm 31/10 → 1/11) vẫn thuộc tháng của ca, không rơi mất.
  const dayEntries = [...groupByWorkDay(sessions, rules).entries()].filter(([day]) => day.slice(0, 7) === key);
  const days = dayEntries.map(([, list]) => list);
  const workDays = days.filter(d => d.some(s => s.clock_out)).length;
  for (const [dayKey, day] of dayEntries) {
    const byShift = rules && String(day[0].date) >= rules.hours_from;
    const dayH = byShift
      ? round1(day.reduce((a, s) => a + sessionHours(s, rules, reviewOf.get(s.id)).countedMs, 0) / HOUR)
      : round1(day.filter(s => s.clock_out).reduce((a, s) => a + round1((new Date(s.clock_out) - new Date(s.clock_in)) / HOUR), 0));
    if (byShift) pendingMs += day.reduce((a, s) => a + sessionHours(s, rules, reviewOf.get(s.id)).pendingMs, 0);
    totalWorkH += dayH;
    const dayOt = dayH > 8 ? round1(dayH - 8) : 0;
    otHours += dayOt;
    if (day.some(s => s.clock_out)) byDay[dayKey] = Math.round(base / STANDARD_DAYS + dayOt * otRate);
  }
  totalWorkH = round1(totalWorkH);
  otHours = round1(otHours);
  const otAmt = Math.round(otHours * otRate);
  const absAmt = Math.round(absDays * (base > 0 ? Math.round(base / STANDARD_DAYS) : 0));
  return { rule: 'hours', base, standardDays: STANDARD_DAYS, workDays, workUnits: workDays, hourly: null, basePay: base, earlyAmt: 0, earlyList: [], lateAmt: 0, lateList: [], totalWorkH, otHours, otAmt,
    bonusAmt, advAmt, absDays, absAmt, vioAmt, pendingH: round1(pendingMs / HOUR), net: base + otAmt + bonusAmt - advAmt - absAmt - vioAmt, byDay };
}

/**
 * Chi phí lương cả quán cho Sổ thu chi. byDay { ngày làm: tiền } = cộng lương từng ngày của mọi người
 * theo chấm công (đúng công thức computeSalary); người đã chốt lương tháng đó thì theo tiền từng ngày lưu lúc chốt
 * (sửa giờ sau khi chốt không làm Sổ thu chi khác phiếu đã trả; số chốt cũ chưa lưu thì tính lại). monthExtra = thưởng −
 * phạt cả tháng (theo số đã chốt nếu tháng đã chốt). Ứng lương là trả trước, không phải chi phí, nên không tính.
 */
export function payrollCost({ year, month, staff = [], configs = [], sessions = [], requests = [], violations = [], bonuses = [], rules = null, reviews = [], closes = [], hourlyRates = [], lateRules = [],
  closedDays = [], holidayPay = [], departures = [], returns = [] }) {
  const byDay = {};
  let monthExtra = 0;
  for (const p of staff) {
    const of = rows => rows.filter(r => r.staff_id === p.id);
    const config = configs.find(c => c.staff_id === p.id) || null;
    const mine = of(sessions), vios = of(violations), gifts = of(bonuses);
    if (!config && !mine.length && !vios.length && !gifts.length) continue;
    const closed = closes.find(c => c.staff_id === p.id)?.snapshot;
    const live = closed?.byDay ? null : computeSalary({ year, month, staffId: p.id, sessions: mine, config, requests: of(requests), violations: vios, bonuses: gifts, rules, reviews,
      hourlyRates: of(hourlyRates), lateRules: lateRulesOf(lateRules, p.id), ...holidayArgs(p, { closedDays, holidayPay, departures, returns }) });
    for (const [day, amount] of Object.entries(closed?.byDay || live.byDay)) byDay[day] = (byDay[day] || 0) + amount;
    const settled = closed ? { bonusAmt: 0, ...closed } : live;
    monthExtra += (Number(settled.bonusAmt) || 0) - (Number(settled.vioAmt) || 0);
  }
  return { byDay, monthExtra };
}

/**
 * Trễ / vào sớm / về sớm / ở lại và quên ra ca của một người trong tháng `key`, theo ngày
 * làm (ca đêm qua nửa đêm không thành ngày mới). lateDays / forgotten: từng ngày trễ và
 * từng ca máy tự đóng — dùng cho gợi ý phạt. closedDays: ngày quán nghỉ — chủ gọi vào làm thì không
 * tính trễ / về sớm (không gợi ý phạt, không mất thưởng chuyên cần).
 */
export function monthTallies({ sessions = [], rules = null, key, autoClosed = [], closedDays = [] }) {
  sessions = sessions.filter(s => !s.face_hold);
  const tally = { late: [0, 0], early: [0, 0], leftEarly: [0, 0], stayed: [0, 0] };
  const lateDays = [];
  const closed = new Set((closedDays || []).map(d => String(d?.day ?? d).slice(0, 10)));
  for (const [day, list] of groupByWorkDay(sessions, rules)) {
    if (day.slice(0, 7) !== key) continue;
    const f = closed.has(day) ? { ...dayFlags(list, rules), late: 0, leftEarly: 0 } : dayFlags(list, rules);
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
  if (!(Number(salary?.base) > 0) && !salary?.hourly?.rates?.length && !salary?.dayWage?.rates?.length) reasons.push('chưa có lương cơ bản');
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
export function fineSuggestions({ staffId, tallies, reviews = [], kinds = ['late', 'forgot'], autoLateDays = [] }) {
  const done = new Set(reviews.map(r => `${r.attendance_id}:${r.kind}`)), auto = new Set(autoLateDays);
  return [
    // Ngày đã tự trừ tiền theo luật đi trễ thì không gợi ý phạt trễ nữa (khỏi trừ hai lần).
    ...(tallies?.lateDays || []).filter(d => d.minutes > LATE_FINE_MINUTES && !auto.has(d.day))
      .map(d => ({ staff_id: staffId, kind: 'late', attendance_id: d.attendance_id, day: d.day, minutes: d.minutes })),
    ...(tallies?.forgotten || []).map(f => ({ staff_id: staffId, kind: 'forgot', attendance_id: f.attendance_id, day: f.day, clock_out: f.clock_out })),
  ].filter(x => kinds.includes(x.kind) && !done.has(`${x.attendance_id}:${x.kind}`)).sort((a, b) => a.day.localeCompare(b.day));
}

/** Luật đi trễ dùng cho một người: mặc định của quán + luật riêng của người đó. */
export const lateRulesOf = (rules, staffId) => (rules || []).filter(r => r.scope === 'shop' || r.scope === staffId);

/** Loại gợi ý phạt còn dùng: lỗi máy tự gợi ý mà chủ chưa ẩn (chưa có danh sách lỗi thì dùng cả hai). */
export const activeFineKinds = rules => (rules?.length ? rules.filter(r => r.kind && r.active !== false).map(r => r.kind) : ['late', 'forgot']);

/**
 * Thống kê nhân sự một tháng cho trang Thống kê: lương từng người (số đã chốt nếu có),
 * số lần / số phút đi trễ, về sớm, vào sớm, ở lại, quên ra ca, quét bị cảnh báo,
 * và tổng quỹ lương. Người nghỉ việc trước tháng này không tính.
 */
export function staffMonthStats({ year, month, staff = [], configs = [], sessions = [], requests = [], violations = [], reviews = [], rules = null,
  closes = [], departures = [], autoClosed = [], scans = [], bonuses = [], bonusSettings = null, fineReviews = [], fineKinds = ['late', 'forgot'], hourlyRates = [], lateRules = [],
  closedDays = [], holidayPay = [], returns = [] }) {
  const key = monthKey(year, month);
  const of = (rows, id) => rows.filter(r => r.staff_id === id);
  const people = staff.map(p => {
    const departure = departures.find(d => d.staff_id === p.id) || null;
    if (departure && String(departure.last_day).slice(0, 7) < key) return null;
    const mine = of(sessions, p.id), config = configs.find(c => c.staff_id === p.id) || null;
    const reqs = of(requests, p.id), vios = of(violations, p.id), gifts = of(bonuses, p.id);
    if (!config && !mine.length && !reqs.length && !vios.length) return null;
    const live = computeSalary({ year, month, staffId: p.id, sessions: mine, config, requests: reqs, violations: vios, bonuses: gifts, rules, reviews, hourlyRates: of(hourlyRates, p.id),
      lateRules: lateRulesOf(lateRules, p.id), ...holidayArgs(p, { closedDays, holidayPay, departures, returns }) });
    const closed = closes.find(c => c.staff_id === p.id);
    // Số đã chốt trước khi có thưởng chuyên cần không có bonusAmt.
    const salary = closed ? { bonusAmt: 0, ...closed.snapshot, locked: true, paid_at: closed.paid_at || null } : { ...live, locked: false, paid_at: null };
    // Trễ / sớm theo từng ngày làm đủ lượt (ca đêm ra vào lại sau nửa đêm không bị báo trễ sai; ngày quán nghỉ không tính).
    const t = monthTallies({ sessions: mine, rules, key, autoClosed, closedDays });
    const myScans = of(scans, p.id);
    return {
      staff_id: p.id, name: p.full_name, departure, salary,
      late: t.late, early: t.early, leftEarly: t.leftEarly, stayed: t.stayed, forgot: t.forgot,
      warnings: myScans.filter(s => s.warnings?.length).length, blocked: myScans.filter(s => s.action === 'blocked').length,
      bonus: { ...bonusCheck({ year, month, salary: live, tallies: t, departure, settings: bonusSettings }), approved: gifts[0] || null },
      fineSuggestions: fineSuggestions({ staffId: p.id, tallies: t, reviews: fineReviews, kinds: fineKinds, autoLateDays: (live.lateList || []).map(x => x.day) }).length,
    };
  }).filter(Boolean);
  const sum = f => people.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  return {
    year, month, rule: usesDayPay(year, month) ? 'days' : 'hours', people,
    totals: {
      staff: people.length,
      gross: sum(p => p.salary.basePay - (p.salary.lateAmt || 0) - (p.salary.earlyAmt || 0) + p.salary.otAmt + p.salary.bonusAmt),
      net: sum(p => p.salary.net), advances: sum(p => p.salary.advAmt), fines: sum(p => p.salary.vioAmt), bonuses: sum(p => p.salary.bonusAmt),
      earlyCuts: sum(p => p.salary.earlyAmt || 0), lateCuts: sum(p => p.salary.lateAmt || 0),
      otAmt: sum(p => p.salary.otAmt), hours: round1(sum(p => p.salary.totalWorkH)), pendingH: round1(sum(p => p.salary.pendingH)),
      late: sum(p => p.late.count), forgot: sum(p => p.forgot), closed: people.filter(p => p.salary.locked).length,
      paid: people.filter(p => p.salary.paid_at).length,
    },
  };
}

/*
 * Trả lương theo kỳ (người trả theo ngày / theo giờ, bảng payroll_pay_cycles): mỗi người một kỳ N ngày (vd. 7 ngày) tính từ
 * start_day. Kỳ đang chạy bắt đầu ngày sau lần trả gần nhất (payroll_payouts); ngày phát = ngày đầu kỳ + N − 1. Chủ bấm "Đã thanh
 * toán lương" → lưu lần trả với tiền từng ngày đã trả và các khoản ứng / phạt / thưởng đã trừ / cộng; kỳ mới bắt đầu từ hôm sau.
 *
 * Số phải trả tới hết ngày `to` = tiền công từng ngày (byDay của computeSalary, cùng công thức bảng lương) từ start_day tới `to`
 * − số đã trả cho từng ngày đó (ngày đã trả mà sau đó sửa giờ / ra ca muộn: phần chênh vào lần trả sau) − ứng lương, phạt chưa trừ
 * + thưởng chuyên cần chưa cộng (ứng / phạt / thưởng đã trừ rồi mà sau đó sửa số tiền hay xoá: phần chênh cũng vào lần trả sau).
 * Lương tháng của người đó vẫn tính như cũ; bảng lương tháng trừ phần đã trả theo kỳ (payoutPartOfMonth) ra "còn lại".
 */
export const MAX_CYCLE_DAYS = 31;
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const day10 = d => String(d ?? '').slice(0, 10);

/** Lần trả gần nhất (trả tới ngày muộn nhất). */
export const lastPayout = payouts => [...(payouts || [])].sort((a, b) => day10(b.to_day).localeCompare(day10(a.to_day)))[0] || null;

/**
 * Kỳ đang chạy của một người: { every, start, payday, daysLeft (âm = quá ngày phát), last }; null = không trả theo kỳ.
 * Kỳ bắt đầu ngày sau lần trả gần nhất (trả sớm / trễ thì kỳ sau tính lại từ hôm sau ngày đã trả tới), không sớm hơn start_day.
 */
export function cyclePeriod({ cycle, payouts = [], today }) {
  const every = Math.round(Number(cycle?.every_days) || 0);
  if (!(every >= 1) || !cycle?.start_day) return null;
  const last = lastPayout(payouts), first = day10(cycle.start_day);
  const after = last ? addDays(day10(last.to_day), 1) : first;
  const start = after > first ? after : first, payday = addDays(start, every - 1);
  return { every, start, payday, daysLeft: daysBetween(today, payday), last };
}

// Tổng đã trả / đã trừ trong các lần trả: tiền từng ngày, từng khoản ứng / phạt (theo mã), thưởng từng tháng.
function payoutTotals(payouts) {
  const days = {}, advances = new Map(), fines = new Map(), bonuses = new Map();
  const add = (map, k, v, key) => map.set(k, { amount: (map.get(k)?.amount || 0) + (Number(v) || 0), key });
  for (const p of payouts || []) {
    const d = p.detail || {};
    for (const [day, v] of Object.entries(d.days || {})) days[day] = (days[day] || 0) + (Number(v) || 0);
    for (const a of d.advances || []) add(advances, a.id, a.amount, a.key);
    for (const f of d.fines || []) add(fines, f.id, f.amount, f.key);
    for (const b of d.bonuses || []) add(bonuses, b.key, b.amount, b.key);
  }
  return { days, advances, fines, bonuses };
}

/**
 * Số phải trả của một người tới hết ngày `to`. months: các tháng đã tính lại (từ tháng của ngày cần tính sớm nhất tới tháng của
 * `to`) [{ key: 'YYYY-MM', byDay: { ngày: tiền }, advances: [{ id, amount }] (ứng đã duyệt), fines: [{ id, amount }],
 * bonus: thưởng chuyên cần đã duyệt }]. Ngày / khoản của tháng không có trong months thì không đụng tới.
 * → { days: [{ day, earned, paid, due }] (ngày còn chênh), work (tiền ngày từ đầu kỳ), adjust (chênh ngày đã trả trước đó),
 *     advances / fines / bonuses: [{ id?, key, amount }] (phần chưa trừ / chưa cộng), amount (số phải trả) }.
 */
export function cycleDue({ cycle, payouts = [], months = [], to, periodStart = null }) {
  const first = day10(cycle?.start_day), toKey = String(to).slice(0, 7);
  const list = (months || []).filter(m => m.key <= toKey), keys = new Set(list.map(m => m.key));
  const inScope = d => d >= first && d <= to && keys.has(d.slice(0, 7));
  const done = payoutTotals(payouts);
  const earned = {};
  for (const m of list) for (const [d, v] of Object.entries(m.byDay || {})) if (inScope(d)) earned[d] = (earned[d] || 0) + (Number(v) || 0);
  const days = [...new Set([...Object.keys(earned), ...Object.keys(done.days).filter(inScope)])].sort()
    .map(day => ({ day, earned: earned[day] || 0, paid: done.days[day] || 0 })).map(x => ({ ...x, due: x.earned - x.paid })).filter(x => x.due !== 0);
  // Khoản ứng / phạt: số hiện tại − số đã trừ (khoản đã xoá sau khi trừ: trả lại phần đã trừ).
  const items = (field, taken) => {
    const now = new Map(list.flatMap(m => (m[field] || []).map(x => [x.id, { amount: Number(x.amount) || 0, key: m.key }])));
    return [...new Set([...now.keys(), ...[...taken.entries()].filter(([, v]) => keys.has(v.key)).map(([id]) => id)])]
      .map(id => ({ id, key: now.get(id)?.key || taken.get(id).key, amount: (now.get(id)?.amount || 0) - (taken.get(id)?.amount || 0) })).filter(x => x.amount !== 0);
  };
  const advances = items('advances', done.advances), fines = items('fines', done.fines);
  const bonuses = list.map(m => ({ key: m.key, amount: (Number(m.bonus) || 0) - (done.bonuses.get(m.key)?.amount || 0) })).filter(x => x.amount !== 0);
  const sum = xs => xs.reduce((a, x) => a + x.amount, 0);
  const start = periodStart || first;
  const work = days.filter(x => x.day >= start).reduce((a, x) => a + x.due, 0), adjust = days.filter(x => x.day < start).reduce((a, x) => a + x.due, 0);
  return { days, work, adjust, advances, fines, bonuses, amount: work + adjust - sum(advances) - sum(fines) + sum(bonuses) };
}

/** Chi tiết lưu cùng lần trả (để lần sau biết ngày / khoản nào đã trả, và bảng lương tháng trừ đúng phần của tháng). */
export const payoutDetail = due => ({
  days: Object.fromEntries(due.days.map(x => [x.day, x.due])),
  advances: due.advances.map(({ id, key, amount }) => ({ id, key, amount })), fines: due.fines.map(({ id, key, amount }) => ({ id, key, amount })),
  bonuses: due.bonuses.map(({ key, amount }) => ({ key, amount })),
});

/** Phần lương tháng `key` (YYYY-MM) đã trả theo kỳ: tiền các ngày của tháng + thưởng − ứng − phạt của tháng đó đã tính vào các lần trả. */
export function payoutPartOfMonth(payouts, key) {
  let total = 0;
  for (const p of payouts || []) {
    const d = p.detail || {};
    for (const [day, v] of Object.entries(d.days || {})) if (day.startsWith(key)) total += Number(v) || 0;
    for (const b of d.bonuses || []) if (b.key === key) total += Number(b.amount) || 0;
    for (const x of [...(d.advances || []), ...(d.fines || [])]) if (x.key === key) total -= Number(x.amount) || 0;
  }
  return total;
}

/**
 * Phần của `due` (cycleDue tính tới hôm nay) nếu chỉ trả tới hết ngày `to`: ngày tới `to`, ứng / phạt / thưởng của các tháng tới
 * tháng của `to` — đúng bằng cycleDue tính thẳng tới `to`. Trang Lương dùng để đổi ngày trả tới mà không phải hỏi lại máy chủ.
 */
export function cycleDueTo(due, to, periodStart) {
  const toKey = String(to).slice(0, 7), upTo = x => x.key <= toKey;
  const days = (due?.days || []).filter(x => x.day <= to);
  const advances = (due?.advances || []).filter(upTo), fines = (due?.fines || []).filter(upTo), bonuses = (due?.bonuses || []).filter(upTo);
  const sum = xs => xs.reduce((a, x) => a + x.amount, 0);
  const work = days.filter(x => x.day >= periodStart).reduce((a, x) => a + x.due, 0), adjust = days.filter(x => x.day < periodStart).reduce((a, x) => a + x.due, 0);
  return { days, work, adjust, advances, fines, bonuses, amount: work + adjust - sum(advances) - sum(fines) + sum(bonuses) };
}
