// Đọc mọi thứ cần để tính lương cả quán một tháng — dùng chung cho trang Lương / chốt lương /
// Thống kê (api/admin/workforce) và Sổ thu chi (lương mỗi ngày theo chấm công). Chỉ phía server.
import { readCheckinSettings } from './attendanceRules.mjs';
import { BONUS_MIN_DAYS, activeFineKinds } from './payroll.mjs';

export const monthRange = (year, month) => {
  const pad = n => String(n).padStart(2, '0');
  return { start: `${year}-${pad(month)}-01`, end: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01` };
};

// Supabase trả tối đa 1000 dòng mỗi lần: đọc từng trang cho đủ giờ công cả tháng.
async function readAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

// Mức thưởng chuyên cần gợi ý + số ngày công tối thiểu (chưa cài thì 0đ / 22 ngày).
export async function readPayrollSettings(db) {
  const { data, error } = await db.from('payroll_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  return { bonus_amount: Number(data?.bonus_amount) || 0, bonus_min_days: data?.bonus_min_days === undefined || data?.bonus_min_days === null ? BONUS_MIN_DAYS : Number(data.bonus_min_days) };
}

// Lần chủ duyệt giờ ngoài ca của đúng các ca đang tính (bảng này chỉ lớn dần, không đọc hết được).
export async function reviewsFor(db, sessionIds) {
  const rows = [];
  for (let i = 0; i < sessionIds.length; i += 200) {
    const { data, error } = await db.from('attendance_extra_reviews').select('*').in('attendance_id', sessionIds.slice(i, i + 200));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

export async function loadPayrollMonth(db, year, month) {
  const { start, end } = monthRange(year, month);
  const [staff, configs, sessions, requests, violations, closes, departures, rules, bonuses, bonusSettings, fineReviews, fineRules] = await Promise.all([
    db.from('staff').select('id, full_name, role'),
    db.from('payroll_config').select('*'),
    // Cả ngày 1 tháng sau (ca đêm cuối tháng); đọc từng trang.
    readAll(() => db.from('attendance_sessions').select('*').gte('date', start).lte('date', end).order('clock_in')),
    db.from('payroll_requests').select('*').eq('month', month).eq('year', year),
    db.from('payroll_violations').select('*').eq('month', month).eq('year', year),
    db.from('payroll_closes').select('*').eq('year', year).eq('month', month),
    db.from('staff_departures').select('*'),
    readCheckinSettings(db),
    db.from('payroll_bonuses').select('*').eq('year', year).eq('month', month),
    readPayrollSettings(db),
    db.from('payroll_fine_reviews').select('*').gte('work_day', start).lt('work_day', end),
    db.from('payroll_fine_rules').select('kind, active'),
  ]);
  for (const r of [staff, configs, requests, violations, closes, departures, bonuses, fineReviews, fineRules]) if (r.error) throw r.error;
  const reviews = await reviewsFor(db, sessions.map(x => x.id));
  return { start, end, staff: staff.data || [], configs: configs.data || [], sessions, requests: requests.data || [],
    violations: violations.data || [], reviews, closes: closes.data || [], departures: departures.data || [], rules,
    bonuses: bonuses.data || [], bonusSettings, fineReviews: fineReviews.data || [], fineKinds: activeFineKinds(fineRules.data) };
}
