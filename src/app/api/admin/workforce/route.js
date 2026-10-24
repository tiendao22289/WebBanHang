/**
 * /api/admin/workforce — chấm công, ứng lương / báo nghỉ, phạt, cấu hình lương,
 * tài khoản nhân viên. Trước đây trang Lương / Sổ tay / Chấm công ghi thẳng
 * vào DB bằng khoá công khai, nên ai cũng tự sửa được giờ công, lương, PIN.
 * Giờ mọi thao tác ghi đi qua đây: kiểm cookie đăng nhập, quyền, giờ máy chủ.
 *
 * GET  ?me=1                 → ca đang mở, các ca hôm nay, đơn sửa giờ, lương tạm tính tháng này của mình
 * GET  ?checkin=1            → máy quầy, cài đặt, điện thoại đã đăng ký, lịch sử quét, đơn sửa giờ (admin)
 * GET  ?payroll=1&year&month → số lương đã chốt của tháng, ngày nghỉ của đơn báo nghỉ, thưởng chuyên cần,
 *                              danh sách lỗi, gợi ý phạt đã xử lý, ngày / người ghi của khoản phạt (admin)
 * GET  ?stats=1&year&month   → thống kê nhân sự + quỹ lương cả quán một tháng (admin, trang Thống kê)
 * POST {action}:
 *   clock {token}            → vào / ra ca bằng mã QR trên máy quầy: mỗi mã dùng 1 lần,
 *                              phải cùng wifi với máy quầy, đúng điện thoại đã đăng ký
 *   request {type, amount | from_date, to_date, reason} → ứng lương / báo nghỉ (có ngày nghỉ) của chính mình
 *   request_fix {attendance_id, clock_in, clock_out, reason} → xin sửa giờ một ca của mình
 *   cancel_request {id, kind}  → huỷ đơn của mình khi còn chờ duyệt (kind 'fix' = đơn xin sửa giờ)
 *   edit_attendance, decide_request, decide_fix, decide_extra, close_month, reopen_month, mark_paid,
 *   staff_depart, staff_return, add_violation {staff_id, date, rule_id?, reason, amount}, delete_violation,
 *   decide_fine {attendance_id, kind, status, amount, reason} / reopen_fine → gợi ý phạt từ chấm công,
 *   save_fine_rule, save_bonus_settings, decide_bonus {staff_id, year, month, amount} / remove_bonus,
 *   save_config, save_checkin_settings, save_shift, revoke_kiosk, reset_device,
 *   create_account, set_pin, delete_account   (admin)
 *   hash_all_pins            → băm PIN còn lưu chữ thường (admin / workflow)
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';
import { hashPin, isHashedPin, validPin } from '@/lib/staffPin.mjs';
import { DEVICE_COOKIE, DEVICE_COOKIE_SECONDS, newDeviceId, readKioskQrToken, validDeviceId } from '@/lib/checkinToken.mjs';
import { AUTO_CLOSE_BY, MIN_TOGGLE_MS, autoClosedIds, clientIp, closeForgottenSessions, currentWorkDay, hhmm, hoursOn, onKioskNetwork, readCheckinSettings, sessionHours, validTime, workDayOf } from '@/lib/attendanceRules.mjs';
import { BONUS_MIN_DAYS, DEFAULT_OT_RATE, activeFineKinds, computeSalary, monthKey, monthTallies, staffMonthStats, usesDayPay } from '@/lib/payroll.mjs';
import { activeInMonth } from '@/lib/staffDeparture.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_MONEY = 1_000_000_000;
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });
const vnNow = () => new Date(Date.now() + 7 * 3600000);
const vnToday = () => vnNow().toISOString().slice(0, 10);
const dayBefore = d => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const money = v => { const n = Math.round(Number(String(v ?? '').replace(/\./g, ''))); return Number.isFinite(n) && n >= 0 && n <= MAX_MONEY ? n : null; };
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ddmm = d => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}`;
const monthRange = (year, month) => {
  const pad = n => String(n).padStart(2, '0');
  return { start: `${year}-${pad(month)}-01`, end: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01` };
};
// Tháng đã hết chưa (giờ Việt Nam): thưởng chuyên cần chỉ duyệt khi đã hết tháng.
const monthOver = (year, month) => vnToday() >= monthRange(year, month).end;

// Mức thưởng chuyên cần gợi ý + số ngày công tối thiểu (chưa cài thì 0đ / 22 ngày).
async function readPayrollSettings(db) {
  const { data, error } = await db.from('payroll_settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  return { bonus_amount: Number(data?.bonus_amount) || 0, bonus_min_days: data?.bonus_min_days === undefined || data?.bonus_min_days === null ? BONUS_MIN_DAYS : Number(data.bonus_min_days) };
}

// Workflow trên máy chủ ký bằng khoá service role (như báo cáo Sổ thu chi).
function serverKeyOk(request) {
  const s = secret();
  const given = String(request.headers?.get?.('x-server-key') || '');
  if (s.length < 20 || !given) return false;
  const want = createHmac('sha256', s).update('staff-maintenance').digest('hex');
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

async function session(request) {
  const s = await getStaffSession(request);
  if (s.code !== 200) return { error: fail(s.code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập.', s.code) };
  return { user: s.user, isAdmin: s.user.role === 'admin', db: staffDatabase(s.user.id) };
}

async function hashAllPins(db) {
  const { data, error } = await db.from('staff').select('id, pin');
  if (error) throw error;
  let hashed = 0;
  for (const row of data || []) {
    if (!row.pin || isHashedPin(row.pin)) continue;
    const { error: e } = await db.from('staff').update({ pin: hashPin(row.id, row.pin, secret()) }).eq('id', row.id);
    if (e) throw e;
    hashed += 1;
  }
  return hashed;
}

const BLOCK_MESSAGE = {
  other_network: 'Điện thoại chưa vào wifi quán. Bật wifi quán (tắt 4G) rồi quét lại mã trên máy quầy.',
  shared_device: 'Điện thoại này đã đăng ký chấm công cho người khác. Mỗi người chấm bằng điện thoại của mình.',
  unknown_device: 'Đây không phải điện thoại bạn đã đăng ký chấm công. Dùng đúng máy của bạn, hoặc nhờ chủ quán bấm "Cho đổi máy".',
};

// Mã nhận diện điện thoại: cookie riêng của máy chủ, trang web không đọc / chép được.
function deviceOf(request) {
  const id = request.cookies?.get?.(DEVICE_COOKIE)?.value;
  return validDeviceId(id) ? { id, fresh: false } : { id: newDeviceId(), fresh: true };
}
function withDevice(response, request, device) {
  if (device.fresh) response.cookies?.set?.(DEVICE_COOKIE, device.id, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: DEVICE_COOKIE_SECONDS,
    secure: request.headers?.get?.('x-forwarded-proto') === 'https' || String(request.url || '').startsWith('https:'),
  });
  return response;
}

// Ca mới nhất của một người (kể cả ca hôm qua chưa ra, ví dụ làm qua 12h đêm).
async function latestSession(db, staffId) {
  const { data, error } = await db.from('attendance_sessions').select('*').eq('staff_id', staffId).order('clock_in', { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function myStatus(db, staffId) {
  const settings = await readCheckinSettings(db);
  await closeForgottenSessions(db, settings, staffId);
  const since = new Date(Date.now() - 40 * 86400000).toISOString();
  const [last, today, fixes, autoClosed, reviews, leaveDays] = await Promise.all([
    latestSession(db, staffId),
    // "Hôm nay" là ngày làm đang diễn ra: lượt dọn quán sau nửa đêm vẫn thuộc ca hôm trước.
    db.from('attendance_sessions').select('*').eq('staff_id', staffId).gte('date', dayBefore(vnToday())).lte('date', vnToday()).order('clock_in'),
    db.from('attendance_fix_requests').select('*').eq('staff_id', staffId).gte('created_at', since).order('created_at', { ascending: false }),
    autoClosedIds(db, { staffId }),
    db.from('attendance_extra_reviews').select('*').eq('staff_id', staffId).limit(1000),
    db.from('payroll_leave_days').select('*').eq('staff_id', staffId).limit(500),
  ]);
  for (const r of [today, fixes, reviews, leaveDays]) if (r.error) throw r.error;
  // Giờ làm để tự tính trễ / ngoài ca; không cho nhân viên biết đang chạy thử hay chặn thật.
  const rules = { hours_from: settings.hours_from, hours: settings.hours, shifts: settings.shifts[staffId] ? { [staffId]: settings.shifts[staffId] } : {} };
  const day = currentWorkDay(settings, staffId, Date.now());
  return { open: last && !last.clock_out ? last : null, sessions: (today.data || []).filter(x => workDayOf(x, settings) === day), fixes: fixes.data || [], auto_closed: autoClosed, reviews: reviews.data || [],
    leave_days: leaveDays.data || [], rules, ...await mySalary(db, staffId, settings, reviews.data || [], autoClosed) };
}

// Lương tạm tính tháng này của chính người đó (cùng công thức với bảng lương của chủ);
// tháng đã chốt thì đưa số đã chốt. Lỗi ở phần này không làm hỏng phần chấm công.
async function mySalary(db, staffId, settings, reviews, autoClosed = []) {
  try {
    const now = vnNow(), year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;
    const { start, end } = monthRange(year, month);
    const [sessions, config, requests, violations, closed, bonuses, meta, payroll] = await Promise.all([
      db.from('attendance_sessions').select('*').eq('staff_id', staffId).gte('date', start).lte('date', end), // cả ngày 1 tháng sau: lượt dọn quán sau nửa đêm của ca cuối tháng
      db.from('payroll_config').select('*').eq('staff_id', staffId).maybeSingle(),
      db.from('payroll_requests').select('*').eq('staff_id', staffId).eq('month', month).eq('year', year),
      db.from('payroll_violations').select('*').eq('staff_id', staffId).eq('month', month).eq('year', year),
      db.from('payroll_closes').select('*').eq('staff_id', staffId).eq('year', year).eq('month', month).maybeSingle(),
      db.from('payroll_bonuses').select('*').eq('staff_id', staffId).eq('year', year).eq('month', month),
      db.from('payroll_violation_meta').select('violation_id, fine_date').eq('staff_id', staffId).gte('fine_date', start).lt('fine_date', end),
      readPayrollSettings(db),
    ]);
    for (const r of [sessions, config, requests, violations, closed, bonuses, meta]) if (r.error) throw r.error;
    const live = computeSalary({ year, month, staffId, sessions: sessions.data || [], config: config.data, requests: requests.data || [],
      violations: violations.data || [], bonuses: bonuses.data || [], rules: settings, reviews });
    const salary = closed.data
      ? { bonusAmt: 0, ...closed.data.snapshot, year, month, locked: true, closed_at: closed.data.closed_at, paid_at: closed.data.paid_at || null }
      : { ...live, year, month, locked: false };
    delete salary.name;
    // Thưởng chuyên cần (khi chủ có dùng): tới hôm nay đã trễ / quên ra ca chưa. Không đưa mức thưởng gợi ý.
    const t = monthTallies({ sessions: sessions.data || [], rules: settings, key: monthKey(year, month), autoClosed });
    const bonus = payroll.bonus_amount > 0 && usesDayPay(year, month) ? { late: t.late.count, forgot: t.forgot, minDays: payroll.bonus_min_days, units: live.workUnits, approved: bonuses.data?.[0]?.amount || null } : null;
    const dateOf = new Map((meta.data || []).map(m => [m.violation_id, m.fine_date]));
    return { salary, bonus, violations: (violations.data || []).map(v => ({ amount: v.amount, reason: v.reason, date: dateOf.get(v.id) || null })) };
  } catch (error) {
    console.error('[workforce] my salary', error);
    return { salary: null, bonus: null, violations: [] };
  }
}

// Mọi thứ cần để tính lương cả quán một tháng (dùng cho chốt lương và trang Thống kê).
async function loadPayrollMonth(db, year, month) {
  const { start, end } = monthRange(year, month);
  const [staff, configs, sessions, requests, violations, reviews, closes, departures, rules, bonuses, bonusSettings, fineReviews, fineRules] = await Promise.all([
    db.from('staff').select('id, full_name, role'),
    db.from('payroll_config').select('*'),
    db.from('attendance_sessions').select('*').gte('date', start).lte('date', end), // cả ngày 1 tháng sau (ca đêm cuối tháng)
    db.from('payroll_requests').select('*').eq('month', month).eq('year', year),
    db.from('payroll_violations').select('*').eq('month', month).eq('year', year),
    db.from('attendance_extra_reviews').select('*').limit(5000),
    db.from('payroll_closes').select('*').eq('year', year).eq('month', month),
    db.from('staff_departures').select('*'),
    readCheckinSettings(db),
    db.from('payroll_bonuses').select('*').eq('year', year).eq('month', month),
    readPayrollSettings(db),
    db.from('payroll_fine_reviews').select('*').gte('work_day', start).lt('work_day', end),
    db.from('payroll_fine_rules').select('kind, active'),
  ]);
  for (const r of [staff, configs, sessions, requests, violations, reviews, closes, departures, bonuses, fineReviews, fineRules]) if (r.error) throw r.error;
  return { start, end, staff: staff.data || [], configs: configs.data || [], sessions: sessions.data || [], requests: requests.data || [],
    violations: violations.data || [], reviews: reviews.data || [], closes: closes.data || [], departures: departures.data || [], rules,
    bonuses: bonuses.data || [], bonusSettings, fineReviews: fineReviews.data || [], fineKinds: activeFineKinds(fineRules.data) };
}

// Trang Thống kê: nhân sự + lương cả quán một tháng, kèm số việc đang chờ chủ duyệt.
async function staffStats(db, year, month) {
  const m = await loadPayrollMonth(db, year, month);
  const [auto, scans, fixes, pendingReqs] = await Promise.all([
    // Ca máy tự đóng vì quên ra ca được ghi sau ngày làm, nên lọc theo giờ ghi nhật ký.
    db.from('attendance_changes').select('attendance_id').eq('changed_by', AUTO_CLOSE_BY).gte('changed_at', m.start).limit(5000),
    db.from('checkin_scans').select('staff_id, action, warnings').gte('created_at', new Date(`${m.start}T00:00:00+07:00`).toISOString()).lt('created_at', new Date(`${m.end}T00:00:00+07:00`).toISOString()),
    db.from('attendance_fix_requests').select('id').eq('status', 'pending'),
    db.from('payroll_requests').select('id').eq('status', 'pending'),
  ]);
  for (const r of [auto, scans, fixes, pendingReqs]) if (r.error) throw r.error;
  const stats = staffMonthStats({ year, month, ...m, autoClosed: (auto.data || []).map(r => r.attendance_id), scans: scans.data || [] });
  // Người đủ điều kiện thưởng chuyên cần mà chủ chưa duyệt (chỉ khi đã hết tháng và chủ có dùng thưởng).
  const bonusWaiting = monthOver(year, month) && m.bonusSettings.bonus_amount > 0 ? stats.people.filter(p => p.bonus.eligible && !p.bonus.approved && !p.salary.locked).length : 0;
  return { ...stats, pending: { fixes: (fixes.data || []).length, requests: (pendingReqs.data || []).length, extras: (await pendingExtras(db, m.rules, m.reviews)).length,
    fines: stats.people.reduce((a, p) => a + p.fineSuggestions, 0), bonuses: bonusWaiting } };
}

// Bảng lương của một tháng: số đã chốt (nếu có), ngày nghỉ của các đơn báo nghỉ, thưởng chuyên
// cần đã duyệt, danh sách lỗi, gợi ý phạt đã xử lý và ngày / người ghi của các khoản phạt.
async function payrollMonth(db, year, month) {
  const { start, end } = monthRange(year, month);
  const [closes, leaveDays, auto, bonuses, bonusSettings, fineRules, fineReviews, meta] = await Promise.all([
    db.from('payroll_closes').select('*').eq('year', year).eq('month', month),
    db.from('payroll_leave_days').select('*').limit(5000),
    // Ca máy tự đóng vì quên ra ca (ghi sau ngày làm nên lọc theo giờ ghi) để tab Chấm công đánh dấu.
    db.from('attendance_changes').select('attendance_id').eq('changed_by', AUTO_CLOSE_BY).gte('changed_at', start).limit(5000),
    db.from('payroll_bonuses').select('*').eq('year', year).eq('month', month),
    readPayrollSettings(db),
    db.from('payroll_fine_rules').select('*').order('sort').order('created_at'),
    db.from('payroll_fine_reviews').select('*').gte('work_day', start).lt('work_day', end),
    db.from('payroll_violation_meta').select('*').gte('fine_date', start).lt('fine_date', end),
  ]);
  for (const r of [closes, leaveDays, auto, bonuses, fineRules, fineReviews, meta]) if (r.error) throw r.error;
  return { closes: closes.data || [], leaveDays: leaveDays.data || [], autoClosed: [...new Set((auto.data || []).map(r => r.attendance_id))],
    bonuses: bonuses.data || [], bonusSettings, fineRules: fineRules.data || [], fineReviews: fineReviews.data || [], violationMeta: meta.data || [],
    monthOver: monthOver(year, month) };
}

// Ca 45 ngày gần đây có giờ ngoài ca (vào sớm / ở lại) mà chủ chưa duyệt.
async function pendingExtras(db, rules, reviews) {
  const since = new Date(Date.now() + 7 * 3600000 - 45 * 86400000).toISOString().slice(0, 10);
  const from = rules.hours_from > since ? rules.hours_from : since;
  if (from > vnToday()) return [];
  const { data, error } = await db.from('attendance_sessions').select('*').gte('date', from).order('clock_in');
  if (error) throw error;
  const reviewed = new Set(reviews.map(r => r.attendance_id));
  return (data || []).filter(s => s.clock_out && !reviewed.has(s.id))
    .map(s => ({ s, h: sessionHours(s, rules) })).filter(x => x.h.pendingMs > 0)
    // date = ngày của ca (lượt dọn quán sau nửa đêm hiện là ca hôm trước).
    .map(({ s, h }) => ({ attendance_id: s.id, staff_id: s.staff_id, date: workDayOf(s, rules), clock_in: s.clock_in, clock_out: s.clock_out,
      early_minutes: Math.round(h.earlyMs / 60000), stay_minutes: Math.round(h.stayMs / 60000) }));
}

async function checkinOverview(db) {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const [settings, kiosks, devices, scans, fixes, reviews, departures] = await Promise.all([
    readCheckinSettings(db),
    db.from('checkin_kiosks').select('*').order('created_at', { ascending: false }),
    db.from('staff_checkin_devices').select('*'),
    db.from('checkin_scans').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(300),
    db.from('attendance_fix_requests').select('*').gte('created_at', new Date(Date.now() - 45 * 86400000).toISOString()).order('created_at', { ascending: false }),
    db.from('attendance_extra_reviews').select('*').order('decided_at', { ascending: false }).limit(5000),
    db.from('staff_departures').select('*'),
  ]);
  for (const r of [kiosks, devices, scans, fixes, reviews, departures]) if (r.error) throw r.error;
  // Giờ đang ghi của các ca có đơn xin sửa, để chủ so với giờ xin.
  const ids = [...new Set((fixes.data || []).map(f => f.attendance_id))];
  const { data: fixSessions, error } = ids.length ? await db.from('attendance_sessions').select('*').in('id', ids) : { data: [] };
  if (error) throw error;
  return { settings, kiosks: kiosks.data || [], devices: devices.data || [], scans: scans.data || [], fixes: fixes.data || [], fixSessions: fixSessions || [],
    autoClosed: await autoClosedIds(db, { ids }), reviews: reviews.data || [], extras: await pendingExtras(db, settings, reviews.data || []),
    departures: departures.data || [], now: new Date().toISOString() };
}

export async function GET(request) {
  try {
    const s = await session(request);
    if (s.error) return s.error;
    const params = new URL(request.url).searchParams;
    if (params.get('me')) return NextResponse.json(await myStatus(s.db, s.user.id), { headers });
    if (!params.get('checkin') && !params.get('payroll') && !params.get('stats')) return fail('Thiếu yêu cầu.');
    if (!s.isAdmin) return fail('Chỉ admin xem phần này.', 403);
    if (params.get('payroll') || params.get('stats')) {
      const year = Number(params.get('year')), month = Number(params.get('month'));
      if (!(month >= 1 && month <= 12) || !(year >= 2024 && year <= 2100)) return fail('Tháng không hợp lệ.');
      return NextResponse.json(params.get('stats') ? await staffStats(s.db, year, month) : await payrollMonth(s.db, year, month), { headers });
    }
    return NextResponse.json(await checkinOverview(s.db), { headers });
  } catch (error) {
    console.error('[workforce] GET', error);
    return fail('Không tải được, thử lại.', 500);
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action === 'hash_all_pins' && serverKeyOk(request)) {
      return NextResponse.json({ ok: true, hashed: await hashAllPins(staffDatabase(null)) }, { headers });
    }
    const s = await session(request);
    if (s.error) return s.error;
    const { user, isAdmin, db } = s;
    const today = vnToday();
    const adminOnly = () => (isAdmin ? null : fail('Chỉ admin được làm việc này.', 403));

    if (body.action === 'clock') {
      // Nhân viên quét mã trên máy quầy; admin chấm không cần mã (ghi lại là admin tự chấm).
      const settings = await readCheckinSettings(db);
      await closeForgottenSessions(db, settings, user.id);
      const device = deviceOf(request);
      const ip = clientIp(request.headers);
      const warnings = [];
      let qr = null;
      if (body.token || !isAdmin) {
        qr = readKioskQrToken(body.token, secret());
        if (!qr) return fail('Mã QR đã hết hạn hoặc không đúng. Quét lại mã trên máy quầy.', 403);
        const { data: kiosk, error } = await db.from('checkin_kiosks').select('*').eq('id', qr.kioskId).maybeSingle();
        if (error) throw error;
        if (!kiosk || kiosk.revoked_at) return fail('Máy quầy này đã bị tắt. Quét mã trên máy quầy đang dùng.', 403);
        if (!onKioskNetwork(ip, kiosk)) warnings.push('other_network');
      } else warnings.push('admin_no_qr');

      let mine = null, holder = null;
      if (!isAdmin) {
        const [a, b] = await Promise.all([
          db.from('staff_checkin_devices').select('*').eq('staff_id', user.id).maybeSingle(),
          db.from('staff_checkin_devices').select('*').eq('device_id', device.id).maybeSingle(),
        ]);
        if (a.error) throw a.error;
        if (b.error) throw b.error;
        mine = a.data; holder = b.data;
        if (holder && holder.staff_id !== user.id) warnings.push('shared_device');
        else if (mine && mine.device_id !== device.id) warnings.push('unknown_device');
      }
      const scan = { staff_id: user.id, kiosk_id: qr?.kioskId || null, nonce: qr?.nonce || null, warnings, enforced: settings.enforce, ip, device_id: device.id, user_agent: text(request.headers?.get?.('user-agent'), 200) };

      // Đang bật "chặn thật": khác wifi / máy lạ thì không cho chấm (admin vẫn được, chỉ ghi lại).
      const blocking = !isAdmin && settings.enforce ? warnings.find(w => BLOCK_MESSAGE[w]) : null;
      if (blocking) {
        await db.from('checkin_scans').insert({ ...scan, action: 'blocked' }).then(({ error: e }) => { if (e) console.error('[workforce] scan log', e); });
        return withDevice(fail(BLOCK_MESSAGE[blocking], 403), request, device);
      }

      // Lỡ quét hai lần liền thì không tự ra ca / vào lại ngay.
      const last = await latestSession(db, user.id);
      const open = last && !last.clock_out ? last : null;
      const lastAt = open ? open.clock_in : last?.clock_out;
      if (lastAt && Date.now() - Date.parse(lastAt) < MIN_TOGGLE_MS) {
        return fail(`Bạn vừa ${open ? 'vào' : 'ra'} ca lúc ${hhmm(lastAt)}. Đợi 3 phút rồi quét lại nếu muốn ${open ? 'ra' : 'vào'} ca.`, 409);
      }

      // Mỗi mã chỉ dùng được một lần: hai người cùng dùng một mã thì người sau bị từ chối.
      if (qr) {
        const claim = await db.from('checkin_nonces').insert({ nonce: qr.nonce, staff_id: user.id });
        if (claim.error) {
          if (claim.error.code === '23505') return fail('Mã này vừa có người dùng. Đợi mã mới trên máy quầy rồi quét lại.', 409);
          throw claim.error;
        }
      }
      // Lần đầu chấm công: ghi điện thoại này là máy của người đó.
      if (!isAdmin && !mine && !holder) {
        await db.from('staff_checkin_devices').insert({ staff_id: user.id, device_id: device.id, user_agent: scan.user_agent })
          .then(({ error: e }) => { if (e) console.error('[workforce] device bind', e); });
      }

      const at = new Date().toISOString();
      const result = open
        ? await db.from('attendance_sessions').update({ clock_out: at }).eq('id', open.id).select('*').single()
        : await db.from('attendance_sessions').insert({ staff_id: user.id, date: today, clock_in: at }).select('*').single();
      if (result.error) throw result.error;
      await db.from('checkin_scans').insert({ ...scan, action: open ? 'out' : 'in', attendance_id: result.data?.id || null })
        .then(({ error: e }) => { if (e) console.error('[workforce] scan log', e); });
      // Các lượt cùng ngày làm (vào lại sau nửa đêm để dọn quán thì tính chung ca hôm trước, không báo trễ nhầm).
      const { data: fresh } = await db.from('attendance_sessions').select('*').eq('staff_id', user.id).gte('date', dayBefore(today)).lte('date', today).order('clock_in');
      const day = workDayOf(result.data, settings);
      return withDevice(NextResponse.json({ ok: true, clocked: open ? 'out' : 'in', at, session: result.data, sessions: (fresh || []).filter(x => workDayOf(x, settings) === day), warnings }, { headers }), request, device);
    }

    if (body.action === 'request_fix') {
      const reason = text(body.reason);
      if (!UUID.test(body.attendance_id || '') || !reason) return fail('Ghi rõ lý do xin sửa giờ.');
      const { data: att, error } = await db.from('attendance_sessions').select('*').eq('id', body.attendance_id).maybeSingle();
      if (error) throw error;
      if (!att || att.staff_id !== user.id) return fail('Không tìm thấy ca của bạn.', 404);
      const when = v => (v ? new Date(v) : null);
      let clockIn = when(body.clock_in), clockOut = when(body.clock_out);
      if ([clockIn, clockOut].some(d => d && Number.isNaN(d.getTime()))) return fail('Giờ không hợp lệ.');
      // Ô nào giữ nguyên giờ đang ghi thì coi như không xin sửa ô đó (chủ chỉ thấy phần thay đổi).
      const same = (d, v) => d && v && d.getTime() === Date.parse(v);
      if (same(clockIn, att.clock_in)) clockIn = null;
      if (same(clockOut, att.clock_out)) clockOut = null;
      if (!clockIn && !clockOut) return fail('Chọn giờ vào hoặc giờ ra muốn sửa (khác giờ đang ghi).');
      const start = clockIn || new Date(att.clock_in), end = clockOut || (att.clock_out ? new Date(att.clock_out) : null);
      if (end && (end <= start || end - start > 20 * 3600000)) return fail('Giờ ra phải sau giờ vào và ca không quá 20 tiếng.');
      if ((clockOut || clockIn) > new Date(Date.now() + 5 * 60000)) return fail('Không xin giờ ở tương lai.');
      const { data: pending } = await db.from('attendance_fix_requests').select('id').eq('attendance_id', att.id).eq('status', 'pending').limit(1);
      if (pending?.length) return fail('Ca này đã có đơn xin sửa đang chờ chủ duyệt.', 409);
      const r = await db.from('attendance_fix_requests').insert({ staff_id: user.id, attendance_id: att.id, clock_in: clockIn?.toISOString() || null, clock_out: clockOut?.toISOString() || null, reason, status: 'pending' });
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'request') {
      const type = body.type === 'absent' ? 'absent' : body.type === 'advance' ? 'advance' : null;
      const reason = text(body.reason);
      if (!type || !reason) return fail('Vui lòng điền đầy đủ!');
      const now = vnNow();
      const row = { staff_id: user.id, request_type: type, reason, month: now.getUTCMonth() + 1, year: now.getUTCFullYear(), status: 'pending' };
      let leave = null;
      if (type === 'advance') {
        const amount = money(body.amount);
        if (!amount) return fail('Số tiền ứng không hợp lệ.');
        row.amount = amount;
      } else {
        // Báo nghỉ ghi rõ ngày nghỉ; đơn thuộc tháng của ngày nghỉ (không phải tháng gửi đơn).
        const from = String(body.from_date || ''), to = String(body.to_date || body.from_date || '');
        const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
        if (!validDay(from) || !validDay(to) || to < from) return fail('Chọn ngày nghỉ (từ ngày – đến ngày).');
        if (from.slice(0, 7) !== to.slice(0, 7)) return fail('Nghỉ qua 2 tháng thì gửi 2 đơn, mỗi tháng một đơn.');
        if (Math.abs(Date.parse(`${from}T00:00:00Z`) - now.getTime()) > 366 * 86400000) return fail('Ngày nghỉ không hợp lệ.');
        row.days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
        row.month = Number(from.slice(5, 7));
        row.year = Number(from.slice(0, 4));
        leave = { from_date: from, to_date: to };
      }
      // Bấm đúp / mạng chập chờn gửi lại: đơn giống hệt vừa gửi trong 30 giây thì coi như đã gửi, không tạo đơn thứ hai.
      const { data: recent, error: recentError } = await db.from('payroll_requests').select('*').eq('staff_id', user.id).eq('request_type', type)
        .eq('status', 'pending').gte('created_at', new Date(Date.now() - 30000).toISOString());
      if (recentError) throw recentError;
      const same = x => x.reason === row.reason && Number(x.amount || 0) === Number(row.amount || 0) && Number(x.days || 0) === Number(row.days || 0)
        && x.month === row.month && x.year === row.year;
      if ((recent || []).some(same)) return NextResponse.json({ ok: true, duplicate: true }, { headers });
      const r = await db.from('payroll_requests').insert(row).select('id').single();
      if (r.error) throw r.error;
      if (leave) {
        await db.from('payroll_leave_days').insert({ request_id: r.data.id, staff_id: user.id, ...leave })
          .then(({ error: e }) => { if (e) console.error('[workforce] leave days', e); });
      }
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'cancel_request') {
      // Nhân viên tự huỷ đơn của mình khi còn chờ duyệt (ứng lương, báo nghỉ, xin sửa giờ).
      if (!UUID.test(body.id || '')) return fail('Thiếu đơn cần huỷ.');
      const table = body.kind === 'fix' ? 'attendance_fix_requests' : 'payroll_requests';
      const { data: req, error } = await db.from(table).select('*').eq('id', body.id).maybeSingle();
      if (error) throw error;
      if (!req || req.staff_id !== user.id) return fail('Không tìm thấy đơn của bạn.', 404);
      if (req.status !== 'pending') return fail('Đơn đã được duyệt, không huỷ được nữa. Nhờ chủ quán nếu cần sửa.', 409);
      const r = await db.from(table).delete().eq('id', req.id).eq('status', 'pending');
      if (r.error) throw r.error;
      if (table === 'payroll_requests') {
        await db.from('payroll_leave_days').delete().eq('request_id', req.id).then(({ error: e }) => { if (e) console.error('[workforce] leave days', e); });
      }
      return NextResponse.json({ ok: true }, { headers });
    }

    const denied = adminOnly();
    if (denied) return denied;

    // Sửa giờ một ca, ghi nhật ký từng ô đổi. Trả về số ô đã đổi, hoặc response lỗi.
    const editAttendance = async (id, fields, changedBy) => {
      const { data: orig, error } = await db.from('attendance_sessions').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!orig) return fail('Không tìm thấy ca.', 404);
      const updates = {}, logs = [];
      for (const f of ['clock_in', 'clock_out', 'note']) {
        if (!(f in fields)) continue;
        const next = fields[f] === '' || fields[f] === null ? null : f === 'note' ? text(fields[f]) : new Date(fields[f]);
        if (f !== 'note' && next && Number.isNaN(next.getTime())) return fail('Giờ không hợp lệ.');
        const value = next instanceof Date ? next.toISOString() : next;
        const same = f === 'note' ? String(orig[f] ?? '') === String(value ?? '')
          : (orig[f] ? new Date(orig[f]).getTime() : null) === (value ? new Date(value).getTime() : null);
        if (same) continue;
        if (f === 'note' && !('note' in orig)) continue;
        updates[f] = value;
        logs.push({ attendance_id: orig.id, staff_id: orig.staff_id, field_name: f, old_value: String(orig[f] ?? ''), new_value: String(value ?? ''), changed_by: changedBy });
      }
      if (!logs.length) return 0;
      const r = await db.from('attendance_sessions').update(updates).eq('id', orig.id);
      if (r.error) throw r.error;
      // Giờ đổi thì giờ ngoài ca đổi theo: bỏ lần duyệt cũ để chủ duyệt lại.
      if ('clock_in' in updates || 'clock_out' in updates) {
        await db.from('attendance_extra_reviews').delete().eq('attendance_id', orig.id).then(({ error: e }) => { if (e) console.error('[workforce] extra review reset', e); });
      }
      await db.from('attendance_changes').insert(logs).then(({ error: e }) => { if (e) console.error('[workforce] edit log', e); });
      return logs.length;
    };

    if (body.action === 'edit_attendance') {
      if (!UUID.test(body.id || '')) return fail('Thiếu ca cần sửa.');
      const changed = await editAttendance(body.id, body, user.full_name || null);
      return typeof changed === 'number' ? NextResponse.json({ ok: true, changed }, { headers }) : changed;
    }

    if (body.action === 'decide_fix') {
      if (!UUID.test(body.id || '') || !['approved', 'rejected'].includes(body.status)) return fail('Yêu cầu không hợp lệ.');
      const { data: fix, error } = await db.from('attendance_fix_requests').select('*').eq('id', body.id).maybeSingle();
      if (error) throw error;
      if (!fix) return fail('Không tìm thấy đơn.', 404);
      if (fix.status !== 'pending') return fail('Đơn này đã được duyệt rồi.', 409);
      if (body.status === 'approved') {
        const fields = {};
        if (fix.clock_in) fields.clock_in = fix.clock_in;
        if (fix.clock_out) fields.clock_out = fix.clock_out;
        const changed = await editAttendance(fix.attendance_id, fields, `${user.full_name || 'Admin'} (duyệt đơn xin sửa giờ)`);
        if (typeof changed !== 'number') return changed;
      }
      const r = await db.from('attendance_fix_requests').update({ status: body.status, admin_note: text(body.admin_note), decided_by: user.full_name || null, decided_at: new Date().toISOString() }).eq('id', fix.id).eq('status', 'pending');
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'save_checkin_settings') {
      const now = new Date().toISOString();
      if ('enforce' in body) {
        const r = await db.from('checkin_settings').update({ enforce: body.enforce === true, updated_at: now }).eq('id', 1);
        if (r.error) throw r.error;
      }
      // Giờ quán / số phút cho lệch: áp dụng từ hôm nay, ngày cũ giữ giờ cũ.
      if (['opening_time', 'closing_time', 'grace_minutes'].some(k => k in body)) {
        for (const [key, label] of [['opening_time', 'Giờ mở cửa dạng 14:00.'], ['closing_time', 'Giờ đóng quán dạng 23:00.']]) {
          if (key in body && !validTime(body[key])) return fail(label);
        }
        const grace = 'grace_minutes' in body ? Number(body.grace_minutes) : null;
        if (grace !== null && (!Number.isInteger(grace) || grace < 0 || grace > 60)) return fail('Số phút cho lệch từ 0 đến 60.');
        const current = hoursOn(await readCheckinSettings(db), today);
        const row = { valid_from: today, opening_time: body.opening_time ?? current.opening, closing_time: body.closing_time ?? current.closing,
          grace_minutes: grace ?? current.grace, updated_at: now };
        if (row.opening_time === row.closing_time) return fail('Giờ mở cửa và giờ đóng quán phải khác nhau.');
        const { data: old, error } = await db.from('checkin_hours').select('valid_from').eq('valid_from', today).maybeSingle();
        if (error) throw error;
        const r = old ? await db.from('checkin_hours').update(row).eq('valid_from', today) : await db.from('checkin_hours').insert(row);
        if (r.error) throw r.error;
      }
      return NextResponse.json({ ok: true, settings: await readCheckinSettings(db) }, { headers });
    }

    if (body.action === 'save_shift') {
      // Ca riêng của một nhân viên từ hôm nay; clear = từ hôm nay quay về giờ quán. Ngày cũ giữ ca cũ.
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (!body.clear && (!validTime(body.start_time) || !validTime(body.end_time) || body.start_time === body.end_time)) return fail('Giờ vào ca và hết ca dạng 14:00, và phải khác nhau.');
      const row = { staff_id: body.staff_id, valid_from: today, start_time: body.clear ? null : body.start_time, end_time: body.clear ? null : body.end_time, updated_at: new Date().toISOString() };
      const { data: old, error } = await db.from('staff_shifts').select('staff_id').eq('staff_id', body.staff_id).eq('valid_from', today).maybeSingle();
      if (error) throw error;
      const r = old ? await db.from('staff_shifts').update(row).eq('staff_id', body.staff_id).eq('valid_from', today) : await db.from('staff_shifts').insert(row);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'close_month' || body.action === 'reopen_month' || body.action === 'mark_paid') {
      // staff_id: chỉ một người (kết toán người nghỉ việc giữa tháng); không có = cả tháng.
      const year = Number(body.year), month = Number(body.month);
      if (!(month >= 1 && month <= 12) || !(year >= 2024 && year <= 2100)) return fail('Tháng không hợp lệ.');
      const only = UUID.test(body.staff_id || '') ? body.staff_id : null;
      if (body.action === 'mark_paid') {
        if (!only) return fail('Thiếu nhân viên.');
        const r = await db.from('payroll_closes').update(body.paid === false ? { paid_at: null, paid_by: null } : { paid_at: new Date().toISOString(), paid_by: user.full_name || null })
          .eq('year', year).eq('month', month).eq('staff_id', only).select('staff_id');
        if (r.error) throw r.error;
        if (!r.data?.length) return fail('Chốt lương người này trước rồi mới đánh dấu đã trả.', 409);
        return NextResponse.json({ ok: true }, { headers });
      }
      if (body.action === 'reopen_month') {
        let q = db.from('payroll_closes').delete().eq('year', year).eq('month', month);
        if (only) q = q.eq('staff_id', only);
        const r = await q;
        if (r.error) throw r.error;
        return NextResponse.json({ ok: true }, { headers });
      }
      // Chốt lương: máy chủ tự tính lại bằng cùng công thức với trang Lương rồi lưu lại. Cả tháng thì giữ
      // nguyên người đã chốt riêng trước đó; người nghỉ việc trước tháng này không tính.
      const m = await loadPayrollMonth(db, year, month);
      const closedIds = new Set(m.closes.map(c => c.staff_id));
      const closedAt = new Date().toISOString();
      const rows = m.staff.filter(p => (only ? p.id === only : !closedIds.has(p.id))).map(p => {
        const departure = m.departures.find(d => d.staff_id === p.id);
        if (!activeInMonth(departure, monthKey(year, month))) return null;
        const of = rows => rows.filter(x => x.staff_id === p.id);
        const config = of(m.configs)[0] || null, mine = of(m.sessions), reqs = of(m.requests), vios = of(m.violations);
        if (!config && !mine.length && !reqs.length && !vios.length) return null;
        const salary = computeSalary({ year, month, staffId: p.id, sessions: mine, config, requests: reqs, violations: vios, bonuses: of(m.bonuses), rules: m.rules, reviews: m.reviews });
        return { year, month, staff_id: p.id, snapshot: { name: p.full_name, ...salary }, closed_by: user.full_name || null, closed_at: closedAt };
      }).filter(Boolean);
      if (only) {
        const del = await db.from('payroll_closes').delete().eq('year', year).eq('month', month).eq('staff_id', only);
        if (del.error) throw del.error;
      }
      if (rows.length) {
        const r = await db.from('payroll_closes').insert(rows);
        if (r.error) throw r.error;
      }
      return NextResponse.json({ ok: true, closed: rows.length }, { headers });
    }

    if (body.action === 'staff_depart' || body.action === 'staff_return') {
      // Cho nghỉ việc (ngày làm cuối) hoặc đi làm lại. Qua ngày làm cuối thì không đăng nhập / chấm công được.
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (body.staff_id === user.id) return fail('Không tự cho mình nghỉ việc được.');
      if (body.action === 'staff_return') {
        const r = await db.from('staff_departures').delete().eq('staff_id', body.staff_id);
        if (r.error) throw r.error;
        return NextResponse.json({ ok: true }, { headers });
      }
      const lastDay = String(body.last_day || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay) || new Date(`${lastDay}T00:00:00Z`).toISOString().slice(0, 10) !== lastDay) return fail('Chọn ngày làm việc cuối cùng.');
      const { data: person, error } = await db.from('staff').select('id').eq('id', body.staff_id).maybeSingle();
      if (error) throw error;
      if (!person) return fail('Không tìm thấy nhân viên.', 404);
      const row = { staff_id: body.staff_id, last_day: lastDay, reason: text(body.reason), decided_by: user.full_name || null };
      const { data: old } = await db.from('staff_departures').select('staff_id').eq('staff_id', body.staff_id).maybeSingle();
      const r = old ? await db.from('staff_departures').update(row).eq('staff_id', body.staff_id) : await db.from('staff_departures').insert(row);
      if (r.error) throw r.error;
      // Điện thoại chấm công của người nghỉ được dùng lại cho người khác.
      await db.from('staff_checkin_devices').delete().eq('staff_id', body.staff_id).then(({ error: e }) => { if (e) console.error('[workforce] device', e); });
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'decide_extra') {
      // Giờ ngoài ca (vào sớm / ở lại) của một ca: cho tính hết số phút lúc duyệt, hoặc không tính.
      if (!UUID.test(body.attendance_id || '') || !['approved', 'rejected'].includes(body.status)) return fail('Yêu cầu không hợp lệ.');
      const { data: att, error } = await db.from('attendance_sessions').select('*').eq('id', body.attendance_id).maybeSingle();
      if (error) throw error;
      if (!att || !att.clock_out) return fail('Không tìm thấy ca đã ra ca.', 404);
      const h = sessionHours(att, await readCheckinSettings(db));
      const row = { attendance_id: att.id, staff_id: att.staff_id, status: body.status, minutes: body.status === 'approved' ? Math.round((h.earlyMs + h.stayMs) / 60000) : 0,
        decided_by: user.full_name || null, decided_at: new Date().toISOString() };
      // Duyệt lại (lỡ bấm nhầm) thì ghi đè.
      const { data: old, error: e } = await db.from('attendance_extra_reviews').select('attendance_id').eq('attendance_id', att.id).maybeSingle();
      if (e) throw e;
      const r = old ? await db.from('attendance_extra_reviews').update(row).eq('attendance_id', att.id) : await db.from('attendance_extra_reviews').insert(row);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, minutes: row.minutes }, { headers });
    }

    if (body.action === 'revoke_kiosk') {
      if (!UUID.test(body.id || '')) return fail('Thiếu máy quầy.');
      const r = await db.from('checkin_kiosks').update({ revoked_at: new Date().toISOString() }).eq('id', body.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'reset_device') {
      // Cho nhân viên đổi điện thoại: lần chấm công tới sẽ ghi máy mới.
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const r = await db.from('staff_checkin_devices').delete().eq('staff_id', body.staff_id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'decide_request') {
      if (!UUID.test(body.id || '') || !['approved', 'rejected'].includes(body.status)) return fail('Yêu cầu không hợp lệ.');
      const r = await db.from('payroll_requests').update({ status: body.status, admin_note: text(body.admin_note), updated_at: new Date().toISOString() }).eq('id', body.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    // Ghi phạt: ngày phạt (tính vào lương tháng của ngày đó), lỗi có sẵn hoặc lý do tự ghi, người ghi.
    if (body.action === 'add_violation') {
      const amount = money(body.amount);
      const date = DATE.test(body.date || '') ? body.date : null;
      // Không có ngày (trang cũ) thì theo tháng / năm gửi lên.
      const year = date ? Number(date.slice(0, 4)) : Number(body.year), month = date ? Number(date.slice(5, 7)) : Number(body.month);
      let reason = text(body.reason, 200), ruleId = null;
      if (UUID.test(body.rule_id || '')) {
        const { data: rule, error } = await db.from('payroll_fine_rules').select('*').eq('id', body.rule_id).maybeSingle();
        if (error) throw error;
        if (!rule) return fail('Lỗi này không còn trong danh sách.');
        ruleId = rule.id;
        if (!reason) reason = rule.name;
      }
      if (!UUID.test(body.staff_id || '') || !amount || !reason || !(month >= 1 && month <= 12) || !(year >= 2024 && year <= 2100)) return fail('Vui lòng điền đầy đủ!');
      const r = await db.from('payroll_violations').insert({ staff_id: body.staff_id, amount, reason, month, year }).select('id').single();
      if (r.error) throw r.error;
      if (date) {
        const meta = await db.from('payroll_violation_meta').insert({ violation_id: r.data.id, staff_id: body.staff_id, fine_date: date, rule_id: ruleId, recorded_by: user.full_name || null });
        if (meta.error) console.error('[workforce] fine meta', meta.error);
      }
      return NextResponse.json({ ok: true, id: r.data.id }, { headers });
    }

    // Gợi ý phạt từ chấm công (trễ quá 30 phút / quên ra ca): chủ phạt (tự điền tiền) hoặc bỏ qua.
    // Mỗi gợi ý xử lý đúng một lần: giữ chỗ bằng khoá chính (ca + lỗi) trước khi ghi tiền phạt.
    if (body.action === 'decide_fine') {
      const kind = ['late', 'forgot'].includes(body.kind) ? body.kind : null;
      const status = ['fined', 'skipped'].includes(body.status) ? body.status : null;
      if (!UUID.test(body.attendance_id || '') || !kind || !status) return fail('Yêu cầu không hợp lệ.');
      const amount = money(body.amount);
      if (status === 'fined' && !amount) return fail('Nhập số tiền phạt.');
      const [found, settings, ruleRow] = await Promise.all([
        db.from('attendance_sessions').select('*').eq('id', body.attendance_id).maybeSingle(),
        readCheckinSettings(db),
        db.from('payroll_fine_rules').select('*').eq('kind', kind).maybeSingle(),
      ]);
      if (found.error) throw found.error;
      if (ruleRow.error) throw ruleRow.error;
      const ses = found.data;
      if (!ses) return fail('Không tìm thấy ca này.', 404);
      const day = workDayOf(ses, settings), by = user.full_name || null;
      const claim = await db.from('payroll_fine_reviews').insert({ attendance_id: ses.id, kind, staff_id: ses.staff_id, work_day: day, status, decided_by: by, decided_at: new Date().toISOString() });
      if (claim.error) {
        if (claim.error.code === '23505') return fail('Gợi ý này đã được xử lý rồi.', 409);
        throw claim.error;
      }
      if (status === 'skipped') return NextResponse.json({ ok: true }, { headers });
      const rule = ruleRow.data;
      const reason = text(body.reason, 200) || `${rule?.name || (kind === 'late' ? 'Đi trễ' : 'Quên bấm ra ca')} (${ddmm(day)})`;
      const v = await db.from('payroll_violations').insert({ staff_id: ses.staff_id, amount, reason, month: Number(day.slice(5, 7)), year: Number(day.slice(0, 4)) }).select('id').single();
      if (v.error) {
        await db.from('payroll_fine_reviews').delete().eq('attendance_id', ses.id).eq('kind', kind);
        throw v.error;
      }
      const links = await Promise.all([
        db.from('payroll_fine_reviews').update({ violation_id: v.data.id }).eq('attendance_id', ses.id).eq('kind', kind),
        db.from('payroll_violation_meta').insert({ violation_id: v.data.id, staff_id: ses.staff_id, fine_date: day, rule_id: rule?.id || null, attendance_id: ses.id, kind, recorded_by: by }),
      ]);
      for (const x of links) if (x.error) console.error('[workforce] fine links', x.error);
      return NextResponse.json({ ok: true, id: v.data.id }, { headers });
    }

    // Xem lại một gợi ý phạt đã bỏ qua: nó hiện lại trong danh sách gợi ý.
    if (body.action === 'reopen_fine') {
      const kind = ['late', 'forgot'].includes(body.kind) ? body.kind : null;
      if (!UUID.test(body.attendance_id || '') || !kind) return fail('Yêu cầu không hợp lệ.');
      const r = await db.from('payroll_fine_reviews').delete().eq('attendance_id', body.attendance_id).eq('kind', kind).eq('status', 'skipped');
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'delete_violation') {
      if (!UUID.test(body.id || '')) return fail('Thiếu khoản phạt.');
      const r = await db.from('payroll_violations').delete().eq('id', body.id);
      if (r.error) throw r.error;
      // Xoá cả ngày / người ghi; khoản từ gợi ý chấm công thì gợi ý hiện lại để chủ xử lý lại.
      const cleanup = await Promise.all([
        db.from('payroll_violation_meta').delete().eq('violation_id', body.id),
        db.from('payroll_fine_reviews').delete().eq('violation_id', body.id),
      ]);
      for (const x of cleanup) if (x.error) console.error('[workforce] fine cleanup', x.error);
      return NextResponse.json({ ok: true }, { headers });
    }

    // Danh sách lỗi có sẵn: tên + tiền phạt gợi ý (0 = điền mỗi lần), ẩn / hiện. Lỗi máy tự gợi ý giữ nguyên loại.
    if (body.action === 'save_fine_rule') {
      const name = text(body.name, 80);
      const amount = money(String(body.amount ?? '').trim() === '' ? 0 : body.amount);
      if (!name || amount === null) return fail('Nhập tên lỗi và số tiền (để 0 nếu muốn điền mỗi lần).');
      const payload = { name, amount, active: body.active !== false, updated_at: new Date().toISOString() };
      const r = UUID.test(body.id || '')
        ? await db.from('payroll_fine_rules').update(payload).eq('id', body.id).select('id')
        : await db.from('payroll_fine_rules').insert({ ...payload, sort: 100 }).select('id');
      if (r.error) throw r.error;
      if (!r.data?.length) return fail('Không tìm thấy lỗi này.', 404);
      return NextResponse.json({ ok: true }, { headers });
    }

    // Thưởng chuyên cần: mức gợi ý (0 = không dùng) và số ngày công tối thiểu.
    if (body.action === 'save_bonus_settings') {
      const amount = money(body.bonus_amount);
      const minDays = Math.round(Number(String(body.bonus_min_days ?? '').replace(',', '.')) * 10) / 10;
      if (amount === null || String(body.bonus_min_days ?? '').trim() === '' || !(minDays >= 0 && minDays <= 31)) return fail('Mức thưởng hoặc số ngày công không hợp lệ.');
      const row = { bonus_amount: amount, bonus_min_days: minDays, updated_by: user.full_name || null, updated_at: new Date().toISOString() };
      const up = await db.from('payroll_settings').update(row).eq('id', 1).select('id');
      if (up.error) throw up.error;
      if (!up.data?.length) {
        const ins = await db.from('payroll_settings').insert({ id: 1, ...row });
        if (ins.error) throw ins.error;
      }
      return NextResponse.json({ ok: true }, { headers });
    }

    // Duyệt thưởng chuyên cần một người (số tiền chủ tự điền) — chỉ khi đã hết tháng; bỏ thưởng thì xoá.
    if (body.action === 'decide_bonus' || body.action === 'remove_bonus') {
      const year = Number(body.year), month = Number(body.month);
      if (!UUID.test(body.staff_id || '') || !(month >= 1 && month <= 12) || !(year >= 2024 && year <= 2100)) return fail('Yêu cầu không hợp lệ.');
      const mine = q => q.eq('year', year).eq('month', month).eq('staff_id', body.staff_id);
      if (body.action === 'remove_bonus') {
        const r = await mine(db.from('payroll_bonuses').delete());
        if (r.error) throw r.error;
        return NextResponse.json({ ok: true }, { headers });
      }
      if (!monthOver(year, month)) return fail('Hết tháng mới duyệt thưởng chuyên cần được.');
      const amount = money(body.amount);
      if (!amount) return fail('Nhập số tiền thưởng.');
      const row = { amount, note: text(body.note, 200) || null, decided_by: user.full_name || null, decided_at: new Date().toISOString() };
      const update = () => mine(db.from('payroll_bonuses').update(row)).select('staff_id');
      let up = await update();
      if (up.error) throw up.error;
      if (!up.data?.length) {
        const ins = await db.from('payroll_bonuses').insert({ year, month, staff_id: body.staff_id, ...row });
        // Hai lần bấm cùng lúc: lần sau ghi đè số tiền.
        if (ins.error?.code === '23505') up = await update();
        else if (ins.error) throw ins.error;
        if (up.error) throw up.error;
      }
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'save_config') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      // Giá tăng ca để 0 được (không trả tăng ca); bỏ trống / sai thì 25.000đ.
      const otRate = money(body.overtime_rate);
      const payload = { staff_id: body.staff_id, base_salary: money(body.base_salary) || 0, overtime_rate: otRate === null || String(body.overtime_rate ?? '').trim() === '' ? DEFAULT_OT_RATE : otRate,
        pay_day: Math.min(31, Math.max(1, Math.round(Number(body.pay_day) || 5))), updated_at: new Date().toISOString() };
      const { data: existing, error } = await db.from('payroll_config').select('id').eq('staff_id', body.staff_id).maybeSingle();
      if (error) throw error;
      const r = existing ? await db.from('payroll_config').update(payload).eq('staff_id', body.staff_id) : await db.from('payroll_config').insert(payload);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'create_account') {
      const fullName = text(body.full_name, 80), phone = text(body.phone, 20);
      const role = body.role === 'admin' ? 'admin' : 'staff';
      if (!fullName || !/^[\d+ ]{8,15}$/.test(phone)) return fail('Vui lòng điền đầy đủ tên và số điện thoại!');
      if (!validPin(body.pin)) return fail('PIN gồm 4–8 chữ số!');
      const { data: dup } = await db.from('staff').select('id').eq('phone', phone).limit(1);
      if (dup?.length) return fail('⚠️ Số điện thoại đã tồn tại!', 409);
      const id = randomUUID();
      const r = await db.from('staff').insert({ id, full_name: fullName, phone, role, pin: hashPin(id, body.pin, secret()) });
      if (r.error) return fail(String(r.error.message).includes('unique') ? '⚠️ Số điện thoại đã tồn tại!' : 'Không tạo được tài khoản.', 409);
      return NextResponse.json({ ok: true, id }, { headers });
    }

    if (body.action === 'set_pin') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (!validPin(body.pin)) return fail('PIN gồm 4–8 chữ số!');
      const r = await db.from('staff').update({ pin: hashPin(body.staff_id, body.pin, secret()) }).eq('id', body.staff_id).select('id');
      if (r.error) throw r.error;
      if (!r.data?.length) return fail('Không tìm thấy nhân viên.', 404);
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'delete_account') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (body.staff_id === user.id) return fail('Không tự xoá tài khoản đang đăng nhập.');
      const r = await db.from('staff').delete().eq('id', body.staff_id);
      if (r.error) return fail('Không xoá được (nhân viên còn dữ liệu chấm công / Sổ tay).', 409);
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'hash_all_pins') return NextResponse.json({ ok: true, hashed: await hashAllPins(db) }, { headers });

    return fail('Thao tác không hợp lệ.');
  } catch (error) {
    console.error('[workforce] POST', error);
    return fail('Không lưu được, thử lại.', 500);
  }
}
