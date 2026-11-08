/**
 * /api/admin/workforce — chấm công, ứng lương / báo nghỉ, phạt, cấu hình lương,
 * tài khoản nhân viên. Trước đây trang Lương / Sổ tay / Chấm công ghi thẳng
 * vào DB bằng khoá công khai, nên ai cũng tự sửa được giờ công, lương, PIN.
 * Giờ mọi thao tác ghi đi qua đây: kiểm cookie đăng nhập, quyền, giờ máy chủ.
 *
 * GET  ?me=1                 → ca đang mở, các ca hôm nay, đơn sửa giờ, lương tạm tính tháng này của mình
 * GET  ?checkin=1            → máy quầy, cài đặt, điện thoại đã đăng ký, lịch sử quét, đơn sửa giờ (admin)
 * GET  ?payroll=1&year&month → số lương đã chốt của tháng, ngày nghỉ của đơn báo nghỉ, thưởng chuyên cần,
 *                              danh sách lỗi, gợi ý phạt đã xử lý, ngày / người ghi của khoản phạt, lương 1 giờ (admin)
 * GET  ?stats=1&year&month   → thống kê nhân sự + quỹ lương cả quán một tháng (admin, trang Thống kê)
 * GET  ?cycles=1            → người trả lương theo kỳ: kỳ đang chạy, ngày phát, tiền từng ngày còn phải trả, ứng / phạt / thưởng chưa trừ (admin)
 * GET  ?face_check=<id>      → lượt quét đang chờ máy quầy so mặt của chính mình: chờ / đúng / sai / chờ duyệt
 * GET  ?faces=1              → so khuôn mặt: cài đặt, ai đã có mặt mẫu, ca chờ duyệt mặt, lượt so gần đây (admin)
 * POST {action}:
 *   clock {token}            → vào / ra ca bằng mã QR trên máy quầy: mỗi mã dùng 1 lần,
 *                              phải cùng wifi với máy quầy, đúng điện thoại đã đăng ký
 *   request {type, amount | from_date, to_date, reason} → ứng lương / báo nghỉ (có ngày nghỉ) của chính mình
 *   request_fix {attendance_id, clock_in, clock_out, reason} → xin sửa giờ một ca của mình
 *   cancel_request {id, kind}  → huỷ đơn của mình khi còn chờ duyệt (kind 'fix' = đơn xin sửa giờ)
 *   confirm_received {kind: 'month', year, month | kind: 'payout', id} → nhân viên xác nhận đã nhận lương chủ đánh dấu đã trả
 *                              (không đổi lại được; đã xác nhận thì chủ không bỏ dấu đã trả / không bỏ lần trả được)
 *   report_violation {rule_id?, reason?, note?} → tự ghi một lỗi của chính mình hôm nay (tiền theo danh sách lỗi; lỗi khác 0đ
 *                              chờ chủ định tiền). Ghi xong không tự sửa / xoá được — chỉ chủ quán (edit_violation / delete_violation).
 *   edit_attendance, add_attendance {staff_id, clock_in, clock_out, note}, delete_attendance {id},
 *   add_advance {staff_id, amount, date, reason}, edit_request {id, amount?, reason?}, delete_request {id},
 *   edit_violation {id, amount?, reason?}, decide_request, decide_fix, decide_extra, close_month, reopen_month, mark_paid,
 *   staff_depart, staff_return, add_violation {staff_id, date, rule_id?, reason, amount}, delete_violation,
 *   decide_fine {attendance_id, kind, status, amount, reason} / reopen_fine → gợi ý phạt từ chấm công,
 *   save_fine_rule, save_bonus_settings, decide_bonus {staff_id, year, month, amount} / remove_bonus,
 *   save_config, save_hourly {staff_id, hourly_rate, unit: hour | day, valid_from} (lương theo giờ / theo ngày),
 *   save_late_rule {scope: 'shop' | staff_id, allowed_minutes, per_minute, fixed_amount, use_shop} (luật đi trễ từ hôm nay),
 *   save_closed_rule {lunar_days} (nghỉ theo âm lịch mỗi tháng, từ hôm nay), save_closed_day {day, note} (thêm ngày nghỉ),
 *   skip_closed_day {day} (ngày theo lịch nhưng quán mở), delete_closed_day {day} (bỏ ngày thêm / mở cửa đã ghi),
 *   save_holiday_pay {staff_id, paid: true | false | null},
 *   save_pay_cycle {staff_id, every_days (0 = chốt theo tháng), start_day?} (trả lương theo kỳ N ngày),
 *   pay_cycle {staff_id, to_day, amount} (đã thanh toán lương kỳ này tới hết to_day; amount = số trang đang hiện), undo_payout {id} (bỏ lần trả gần nhất),
 *   save_tap_staff {staff_id, enabled, label?, photo?} (người không có điện thoại chấm công bằng nút trên máy quầy),
 *   save_checkin_settings, save_shift, revoke_kiosk, reset_device,
 *   create_account, set_pin, edit_account {staff_id, full_name?, phone?}, delete_account,
 *   face_enroll {staff_id, embeddings, force} (lấy mặt mẫu trên máy quầy), face_delete, save_face_settings,
 *   decide_face {attendance_id, clocked, status}   (admin)
 *   hash_all_pins            → băm PIN còn lưu chữ thường (admin / workflow)
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';
import { hashPin, isHashedPin, validPin } from '@/lib/staffPin.mjs';
import { DEVICE_COOKIE, DEVICE_COOKIE_SECONDS, KIOSK_COOKIE, newDeviceId, readKioskCookie, readKioskQrToken, validDeviceId } from '@/lib/checkinToken.mjs';
import { closedDaysToDate, loadPayrollMonth, monthRange, readClosedDays, readHolidays, readHourlyRates, readLateRules, readMonthClaims, readPayrollSettings, reviewsFor } from '@/lib/payrollMonth.mjs';
import { AUTO_CLOSE_BY, AUTO_EXTRA_FROM, MIN_TOGGLE_MS, autoClosedIds, clientIp, closeForgottenSessions, currentWorkDay, hhmm, hoursOn, onKioskNetwork, readCheckinSettings, sessionHours, validTime, workDayOf } from '@/lib/attendanceRules.mjs';
import { DAY_PAY_FROM, DEFAULT_OT_RATE, MAX_CYCLE_DAYS, addDays, computeSalary, cycleDue, cycleDueTo, cyclePayday, cyclePeriod, holidayArgs, nothingDue, lateRulesOf, monthKey, monthTallies, payoutDetail, payoutPartOfMonth, staffMonthStats,
  usesDayPay } from '@/lib/payroll.mjs';
import { activeInMonth } from '@/lib/staffDeparture.mjs';
import { normalizeRole } from '@/lib/staffRoles.mjs';
import { applyClock, latestSession, sessionsOfDay } from '@/lib/clockApply.mjs';
import { ENROLL_MAX, ENROLL_MIN, ENROLL_SELF_MIN, FACE_LEVELS, FACE_MODEL, FACE_STREAK_MS, FACE_TRIES, FACE_WAIT_MS, bestScore, enrollConsistency, faceHolds, faceNeeded,
  faceThreshold, faceVector, faceVectors, markFaceHolds, missingTable, readFaceSettings, wrongStreak } from '@/lib/faceCheck.mjs';
import { clockStatus, nowMs, refreshClock } from '@/lib/trueTime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_MONEY = 1_000_000_000;
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });
// Mọi giờ chấm công / lương theo giờ internet (nowMs), không theo đồng hồ máy tính ở quán (có thể sai).
const isoNow = () => new Date(nowMs()).toISOString();
const vnNow = () => new Date(nowMs() + 7 * 3600000);
const vnToday = () => vnNow().toISOString().slice(0, 10);
const dayBefore = d => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const money = v => { const n = Math.round(Number(String(v ?? '').replace(/\./g, ''))); return Number.isFinite(n) && n >= 0 && n <= MAX_MONEY ? n : null; };
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLAIMS_NOT_READY = 'Web đang cập nhật phần khoản chi hộ, thử lại sau ít phút.';
const PEER_NOT_READY = 'Web đang cập nhật phần báo lỗi đồng nghiệp, thử lại sau ít phút.';
const ddmm = d => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}`;
// Tháng đã hết chưa (giờ Việt Nam): thưởng chuyên cần chỉ duyệt khi đã hết tháng.
const monthOver = (year, month) => vnToday() >= monthRange(year, month).end;

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

async function myStatus(db, staffId) {
  const settings = await readCheckinSettings(db);
  await closeForgottenSessions(db, settings, staffId, nowMs());
  const since = new Date(nowMs() - 40 * 86400000).toISOString();
  const [last, today, fixes, autoClosed, reviews, leaveDays] = await Promise.all([
    latestSession(db, staffId),
    // "Hôm nay" là ngày làm đang diễn ra: lượt dọn quán sau nửa đêm vẫn thuộc ca hôm trước.
    db.from('attendance_sessions').select('*').eq('staff_id', staffId).gte('date', dayBefore(vnToday())).lte('date', vnToday()).order('clock_in'),
    db.from('attendance_fix_requests').select('*').eq('staff_id', staffId).gte('created_at', since).order('created_at', { ascending: false }),
    autoClosedIds(db, { staffId }),
    db.from('attendance_extra_reviews').select('*').eq('staff_id', staffId).order('decided_at', { ascending: false }).limit(1000),
    db.from('payroll_leave_days').select('*').eq('staff_id', staffId).limit(500),
  ]);
  for (const r of [today, fixes, reviews, leaveDays]) if (r.error) throw r.error;
  const day = currentWorkDay(settings, staffId, nowMs());
  // Ngày quán nghỉ của tháng này (và hôm qua): điện thoại không báo trễ / về sớm hôm quán nghỉ. Lỗi thì báo như thường.
  const closedDays = await readClosedDays(db, `${dayBefore(day).slice(0, 7)}-01`, vnToday()).catch(e => { console.error('[workforce] closed days', e); return []; });
  // Giờ làm để tự tính trễ / ngoài ca; không cho nhân viên biết đang chạy thử hay chặn thật.
  const rules = { hours_from: settings.hours_from, hours: settings.hours, shifts: settings.shifts[staffId] ? { [staffId]: settings.shifts[staffId] } : {}, closedDays };
  // Ca ghi sau 3 lần sai mặt (45 ngày gần đây): chưa tính lương, chờ chủ duyệt.
  const { data: held, error: he } = await db.from('attendance_face_reviews').select('attendance_id').eq('staff_id', staffId).eq('status', 'pending').gte('created_at', new Date(nowMs() - 45 * 86400000).toISOString());
  if (he && !missingTable(he)) throw he;
  const holds = new Set((held || []).map(r => r.attendance_id));
  const open = last && !last.clock_out ? markFaceHolds([last], holds)[0] : null;
  return { open, sessions: markFaceHolds((today.data || []).filter(x => workDayOf(x, settings) === day), holds), fixes: fixes.data || [], auto_closed: autoClosed, reviews: reviews.data || [],
    leave_days: leaveDays.data || [], face_holds: [...holds], rules, ...await mySalary(db, staffId, settings, reviews.data || [], autoClosed),
    payments: await myPayments(db, staffId), claims: await myClaims(db, staffId), peer: { ...await myPeerReports(db, staffId), workDay: day } };
}

// Người còn làm (không phải chủ quán, không phải mình, chưa nghỉ việc) để chọn khi báo lỗi đồng nghiệp.
async function colleaguesOf(db, staffId) {
  const [people, left] = await Promise.all([db.from('staff').select('id, full_name, role'), db.from('staff_departures').select('staff_id, last_day')]);
  if (people.error) throw people.error;
  const gone = new Set((left.error ? [] : left.data || []).filter(d => String(d.last_day).slice(0, 10) < vnToday()).map(d => d.staff_id));
  return (people.data || []).filter(p => p.id !== staffId && p.role !== 'admin' && !gone.has(p.id))
    .map(p => ({ id: p.id, name: String(p.full_name || '').trim() || 'Nhân viên' })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

// Báo lỗi đồng nghiệp: các lần mình đã báo (60 ngày + còn chờ) kèm tên người bị báo. Bảng chưa có: ready false (ẩn phần này).
async function myPeerReports(db, staffId) {
  try {
    const { data, error } = await db.from('payroll_peer_reports').select('*').eq('reporter_id', staffId)
      .or(`status.eq.pending,created_at.gte."${new Date(nowMs() - 60 * 86400000).toISOString()}"`).order('created_at', { ascending: false }).limit(100);
    if (missingTable(error)) return { ready: false, colleagues: [], list: [] };
    if (error) throw error;
    const colleagues = await colleaguesOf(db, staffId);
    const nameOf = new Map(colleagues.map(c => [c.id, c.name]));
    const missing = [...new Set((data || []).map(r => r.staff_id).filter(id => !nameOf.has(id)))];
    if (missing.length) {
      const { data: more } = await db.from('staff').select('id, full_name').in('id', missing);
      for (const p of more || []) nameOf.set(p.id, p.full_name || 'Nhân viên');
    }
    // Người báo không cần biết số tiền chủ phạt.
    return { ready: true, colleagues, list: (data || []).map(r => ({ id: r.id, staff_id: r.staff_id, staff_name: nameOf.get(r.staff_id) || 'Nhân viên', date: String(r.report_date).slice(0, 10),
      reason: r.reason, note: r.note || null, status: r.status, admin_note: r.admin_note || null, created_at: r.created_at })) };
  } catch (error) {
    console.error('[workforce] my peer reports', error);
    return { ready: false, colleagues: [], list: [] };
  }
}

/**
 * Mọi việc đang chờ chủ quán quyết định, để duyệt ngay trên /thongke (mục Duyệt): đơn ứng lương / báo nghỉ, xin sửa giờ, giờ ngoài ca,
 * khoản chi hộ, báo lỗi đồng nghiệp, gợi ý phạt từ chấm công (trễ quá 30 phút, quên ra ca), lỗi chưa định tiền, thưởng chuyên cần đủ
 * điều kiện. Gợi ý phạt / lỗi / thưởng xét tháng này và tháng trước; người đã chốt lương tháng đó thì bỏ qua (ghi vào không trừ được).
 * Bảng mới chưa có (chi hộ, báo lỗi) thì phần đó trống.
 */
async function inboxOverview(db) {
  const today = vnToday(), cur = today.slice(0, 7), prev = addDays(`${cur}-01`, -1).slice(0, 7);
  const optional = q => q.then(r => (missingTable(r.error) ? { data: [] } : r));
  const [settings, people, reqs, fixes, claims, peers, rules] = await Promise.all([
    readCheckinSettings(db),
    db.from('staff').select('id, full_name, role'),
    db.from('payroll_requests').select('*').eq('status', 'pending').order('created_at'),
    db.from('attendance_fix_requests').select('*').eq('status', 'pending').order('created_at'),
    optional(db.from('payroll_expense_claims').select('*').eq('status', 'pending').order('created_at')),
    optional(db.from('payroll_peer_reports').select('*').eq('status', 'pending').order('created_at')),
    db.from('payroll_fine_rules').select('kind, amount, active'),
  ]);
  for (const r of [people, reqs, fixes, claims, peers, rules]) if (r.error) throw r.error;
  const nameOf = new Map((people.data || []).map(p => [p.id, String(p.full_name || '').trim() || 'Nhân viên']));
  const who = id => nameOf.get(id) || 'Không rõ';
  const reqIds = (reqs.data || []).map(r => r.id), fixIds = [...new Set((fixes.data || []).map(f => f.attendance_id))];
  const [leave, fixSessions, extras] = await Promise.all([
    reqIds.length ? db.from('payroll_leave_days').select('*').in('request_id', reqIds) : { data: [] },
    fixIds.length ? db.from('attendance_sessions').select('id, clock_in, clock_out, date').in('id', fixIds) : { data: [] },
    pendingExtras(db, settings),
  ]);
  if (leave.error) throw leave.error;
  if (fixSessions.error) throw fixSessions.error;
  const ruleAmount = Object.fromEntries((rules.data || []).filter(r => r.kind).map(r => [r.kind, Number(r.amount) || 0]));
  const fines = [], bonuses = [], unpriced = [];
  for (const key of [prev, cur]) {
    const [year, month] = key.split('-').map(Number);
    const m = await loadPayrollMonth(db, year, month, today);
    const auto = await autoClosedInMonth(db, m.start, m.end);
    const stats = staffMonthStats({ year, month, ...m, autoClosed: auto.map(r => r.attendance_id), scans: [] });
    const open = new Set(stats.people.filter(p => !p.salary.locked).map(p => p.staff_id));
    for (const p of stats.people) {
      if (!open.has(p.staff_id)) continue;
      for (const x of p.fineItems || []) fines.push({ ...x, name: p.name, suggested: ruleAmount[x.kind] || 0 });
      if (monthOver(year, month) && m.bonusSettings?.bonus_amount > 0 && p.bonus?.eligible && !p.bonus?.approved) {
        bonuses.push({ staff_id: p.staff_id, name: p.name, year, month, suggested: Number(m.bonusSettings.bonus_amount) || 0 });
      }
    }
    const zero = m.violations.filter(v => !(Number(v.amount) > 0) && open.has(v.staff_id));
    if (zero.length) {
      const { data: meta, error } = await db.from('payroll_violation_meta').select('*').in('violation_id', zero.map(v => v.id));
      if (error) throw error;
      const metaOf = new Map((meta || []).map(x => [x.violation_id, x]));
      for (const v of zero) {
        const x = metaOf.get(v.id);
        unpriced.push({ id: v.id, staff_id: v.staff_id, name: who(v.staff_id), reason: v.reason, date: x?.fine_date ? String(x.fine_date).slice(0, 10) : null,
          note: x?.note || null, self: !!x?.self_reported, year, month });
      }
    }
  }
  const sessionOf = new Map((fixSessions.data || []).map(x => [x.id, x]));
  const out = {
    requests: (reqs.data || []).map(r => {
      const l = (leave.data || []).find(x => x.request_id === r.id);
      return { id: r.id, staff_id: r.staff_id, name: who(r.staff_id), type: r.request_type, amount: Number(r.amount) || 0, days: Number(r.days) || 0,
        from: l ? String(l.from_date).slice(0, 10) : null, to: l ? String(l.to_date).slice(0, 10) : null, reason: r.reason || '', created_at: r.created_at };
    }),
    fixes: (fixes.data || []).map(f => ({ id: f.id, staff_id: f.staff_id, name: who(f.staff_id), clock_in: f.clock_in, clock_out: f.clock_out, reason: f.reason || '',
      current: sessionOf.get(f.attendance_id) || null, created_at: f.created_at })),
    extras: extras.map(x => ({ ...x, name: who(x.staff_id) })),
    claims: (claims.data || []).map(c => ({ ...claimView(c), name: who(c.staff_id) })),
    peers: (peers.data || []).map(r => ({ id: r.id, staff_id: r.staff_id, name: who(r.staff_id), reporter: r.reporter_name || who(r.reporter_id), date: String(r.report_date).slice(0, 10),
      reason: r.reason, note: r.note || null, suggested: Number(r.suggested_amount) || 0, created_at: r.created_at })),
    fines, unpriced, bonuses,
  };
  out.count = Object.values(out).reduce((a, list) => a + (Array.isArray(list) ? list.length : 0), 0);
  return out;
}

// Trang Lương của chủ: báo lỗi đồng nghiệp còn chờ + đã xử lý 60 ngày gần đây (tên người báo / người bị báo, tiền gợi ý).
async function peerOverview(db) {
  const { data, error } = await db.from('payroll_peer_reports').select('*')
    .or(`status.eq.pending,created_at.gte."${new Date(nowMs() - 60 * 86400000).toISOString()}"`).order('created_at', { ascending: false }).limit(300);
  if (missingTable(error)) return { ready: false, reports: [] };
  if (error) throw error;
  return { ready: true, reports: (data || []).map(r => ({ id: r.id, reporter_id: r.reporter_id, reporter_name: r.reporter_name || null, staff_id: r.staff_id,
    date: String(r.report_date).slice(0, 10), rule_id: r.rule_id || null, reason: r.reason, note: r.note || null, suggested_amount: Number(r.suggested_amount) || 0,
    status: r.status, amount: r.amount ?? null, violation_id: r.violation_id || null, admin_note: r.admin_note || null, decided_by: r.decided_by || null,
    decided_at: r.decided_at || null, created_at: r.created_at })) };
}

// Khoản chi hộ quán của chính người đó (60 ngày gần đây + mọi khoản còn chờ duyệt). Bảng chưa có: ready false (ẩn phần ghi).
async function myClaims(db, staffId) {
  try {
    const { data, error } = await db.from('payroll_expense_claims').select('*').eq('staff_id', staffId)
      .or(`status.eq.pending,created_at.gte."${new Date(nowMs() - 60 * 86400000).toISOString()}"`).order('created_at', { ascending: false }).limit(100);
    if (missingTable(error)) return { ready: false, list: [] };
    if (error) throw error;
    return { ready: true, list: (data || []).map(claimView) };
  } catch (error) {
    console.error('[workforce] my claims', error);
    return { ready: false, list: [] };
  }
}
const claimView = c => ({ id: c.id, staff_id: c.staff_id, spent_on: String(c.spent_on).slice(0, 10), item: c.item, amount: Number(c.amount) || 0, note: c.note || null,
  payout: c.payout, status: c.status, year: c.year, month: c.month, admin_note: c.admin_note || null, decided_by: c.decided_by || null, decided_at: c.decided_at || null,
  created_at: c.created_at, created_by_name: c.created_by_name || null, finance_entry_id: c.finance_entry_id || null });

// Trang Lương của chủ: khoản chi hộ còn chờ duyệt + khoản đã duyệt / từ chối 60 ngày gần đây (kèm tên người ghi).
async function claimsOverview(db) {
  const { data, error } = await db.from('payroll_expense_claims').select('*')
    .or(`status.eq.pending,created_at.gte."${new Date(nowMs() - 60 * 86400000).toISOString()}"`).order('created_at', { ascending: false }).limit(300);
  if (missingTable(error)) return { ready: false, claims: [] };
  if (error) throw error;
  return { ready: true, claims: (data || []).map(claimView) };
}

// Lương chủ quán đã đánh dấu trả cho chính người đó (khoảng 100 ngày gần đây): lương tháng đã chốt (số còn lại sau phần đã trả
// theo kỳ) và từng lần trả theo kỳ — nhân viên bấm "Tôi đã nhận" (received_at). Bảng / cột chưa có: danh sách trống.
async function myPayments(db, staffId) {
  try {
    const since = new Date(nowMs() - 100 * 86400000).toISOString();
    const [closes, payouts] = await Promise.all([
      db.from('payroll_closes').select('*').eq('staff_id', staffId).gte('paid_at', since),
      db.from('payroll_payouts').select('*').eq('staff_id', staffId).gte('paid_at', addDays(vnToday(), -160)),
    ]);
    if (closes.error && !missingTable(closes.error)) throw closes.error;
    if (payouts.error && !missingTable(payouts.error)) throw payouts.error;
    const myPayouts = payouts.error ? [] : payouts.data || [];
    const list = [
      ...(closes.error ? [] : closes.data || []).map(c => {
        const key = monthKey(c.year, c.month);
        return { kind: 'month', year: c.year, month: c.month, label: `Lương tháng ${c.month}/${c.year}`,
          amount: Math.round((Number(c.snapshot?.net) || 0) - payoutPartOfMonth(myPayouts, key)), paid_at: c.paid_at, received_at: c.received_at || null };
      }),
      ...myPayouts.filter(p => String(p.paid_at) >= since).map(p => ({ kind: 'payout', id: p.id, label: `Lương ${ddmm(String(p.from_day))} – ${ddmm(String(p.to_day))}`,
        amount: Number(p.amount) || 0, paid_at: p.paid_at, received_at: p.received_at || null })),
    ];
    return list.sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)));
  } catch (error) {
    console.error('[workforce] my payments', error);
    return [];
  }
}

// Lương tạm tính tháng này của chính người đó (cùng công thức với bảng lương của chủ);
// tháng đã chốt thì đưa số đã chốt. Lỗi ở phần này không làm hỏng phần chấm công.
async function mySalary(db, staffId, settings, reviews, autoClosed = []) {
  try {
    const now = vnNow(), year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;
    const { start, end } = monthRange(year, month);
    const [sessions, config, requests, violations, closed, bonuses, meta, payroll, hourlyRates, lateRules, holidays, me, left] = await Promise.all([
      db.from('attendance_sessions').select('*').eq('staff_id', staffId).gte('date', start).lte('date', end), // cả ngày 1 tháng sau: lượt dọn quán sau nửa đêm của ca cuối tháng
      db.from('payroll_config').select('*').eq('staff_id', staffId).maybeSingle(),
      db.from('payroll_requests').select('*').eq('staff_id', staffId).eq('month', month).eq('year', year),
      db.from('payroll_violations').select('*').eq('staff_id', staffId).eq('month', month).eq('year', year),
      db.from('payroll_closes').select('*').eq('staff_id', staffId).eq('year', year).eq('month', month).maybeSingle(),
      db.from('payroll_bonuses').select('*').eq('staff_id', staffId).eq('year', year).eq('month', month),
      db.from('payroll_violation_meta').select('*').eq('staff_id', staffId).gte('fine_date', start).lt('fine_date', end),
      readPayrollSettings(db),
      readHourlyRates(db, staffId),
      readLateRules(db),
      readHolidays(db),
      db.from('staff').select('id, created_at').eq('id', staffId).maybeSingle(),
      db.from('staff_departures').select('*').eq('staff_id', staffId),
    ]);
    const claims = await readMonthClaims(db, year, month, staffId);
    for (const r of [sessions, config, requests, violations, closed, bonuses, meta]) if (r.error) throw r.error;
    const mine = markFaceHolds(sessions.data || [], await faceHolds(db, (sessions.data || []).map(x => x.id)));
    const closedDays = closedDaysToDate(holidays, start, end, vnToday());
    const live = computeSalary({ year, month, staffId, sessions: mine, config: config.data, requests: requests.data || [],
      violations: violations.data || [], bonuses: bonuses.data || [], rules: settings, reviews, hourlyRates, lateRules: lateRulesOf(lateRules, staffId),
      ...holidayArgs(me.data || { id: staffId }, { closedDays, holidayPay: holidays.holidayPay, departures: left.data || [], returns: holidays.returns, asOf: vnToday() }), claims });
    const salary = closed.data
      ? { bonusAmt: 0, ...closed.data.snapshot, year, month, locked: true, closed_at: closed.data.closed_at, paid_at: closed.data.paid_at || null }
      : { ...live, year, month, locked: false };
    delete salary.name;
    // Thưởng chuyên cần (khi chủ có dùng): tới hôm nay đã trễ / quên ra ca chưa (hôm quán nghỉ không tính). Không đưa mức thưởng gợi ý.
    const t = monthTallies({ sessions: mine, rules: settings, key: monthKey(year, month), autoClosed, closedDays });
    const bonus = payroll.bonus_amount > 0 && usesDayPay(year, month) ? { late: t.late.count, forgot: t.forgot, minDays: payroll.bonus_min_days, units: live.workUnits, approved: bonuses.data?.[0]?.amount || null } : null;
    const metaOf = new Map((meta.data || []).map(m => [m.violation_id, m]));
    // Danh sách lỗi để tự ghi (lỗi máy tự gợi ý từ chấm công — trễ, quên ra ca — không tự ghi).
    const { data: rules, error: re } = await db.from('payroll_fine_rules').select('id, name, amount, kind, active, sort').order('sort').order('created_at');
    if (re) console.error('[workforce] fine rules', re);
    return { salary, bonus, fineRules: (rules || []).filter(r => r.active && !r.kind).map(({ id, name, amount }) => ({ id, name, amount: Number(amount) || 0 })),
      violations: (violations.data || []).map(v => {
        const m = metaOf.get(v.id);
        return { id: v.id, amount: v.amount, reason: v.reason, date: m?.fine_date || null, self: !!m?.self_reported, note: m?.note || null, at: v.created_at || null };
      }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.at || '').localeCompare(String(a.at || ''))) };
  } catch (error) {
    console.error('[workforce] my salary', error);
    return { salary: null, bonus: null, violations: [], fineRules: [] };
  }
}

// Supabase trả tối đa 1000 dòng mỗi lần: đọc từng trang cho đủ (giờ công cả tháng, lượt quét…).
async function readAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}
// Ca máy tự đóng vì quên ra ca: ghi nhật ký vài giờ sau ngày làm (lọc tới 3 ngày sau tháng).
const autoClosedInMonth = (db, start, end) => readAll(() => db.from('attendance_changes').select('attendance_id').eq('changed_by', AUTO_CLOSE_BY)
  .gte('changed_at', start).lt('changed_at', new Date(Date.parse(`${end}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10)).order('changed_at'));


// Trang Thống kê: nhân sự + lương cả quán một tháng, kèm số việc đang chờ chủ duyệt.
async function staffStats(db, year, month) {
  const m = await loadPayrollMonth(db, year, month, vnToday());
  const [auto, scans, fixes, pendingReqs, extras, faces] = await Promise.all([
    autoClosedInMonth(db, m.start, m.end),
    readAll(() => db.from('checkin_scans').select('staff_id, action, warnings').gte('created_at', new Date(`${m.start}T00:00:00+07:00`).toISOString()).lt('created_at', new Date(`${m.end}T00:00:00+07:00`).toISOString()).order('created_at')),
    db.from('attendance_fix_requests').select('id').eq('status', 'pending'),
    db.from('payroll_requests').select('id').eq('status', 'pending'),
    pendingExtras(db, m.rules),
    db.from('attendance_face_reviews').select('attendance_id').eq('status', 'pending'),
  ]);
  const pendingClaims = await db.from('payroll_expense_claims').select('id').eq('status', 'pending');
  if (pendingClaims.error && !missingTable(pendingClaims.error)) throw pendingClaims.error;
  const pendingPeers = await db.from('payroll_peer_reports').select('id').eq('status', 'pending');
  if (pendingPeers.error && !missingTable(pendingPeers.error)) throw pendingPeers.error;
  for (const r of [fixes, pendingReqs]) if (r.error) throw r.error;
  if (faces.error && !missingTable(faces.error)) throw faces.error;
  const stats = staffMonthStats({ year, month, ...m, autoClosed: auto.map(r => r.attendance_id), scans });
  // Người đủ điều kiện thưởng chuyên cần mà chủ chưa duyệt (chỉ khi đã hết tháng và chủ có dùng thưởng).
  const bonusWaiting = monthOver(year, month) && m.bonusSettings.bonus_amount > 0 ? stats.people.filter(p => p.bonus.eligible && !p.bonus.approved && !p.salary.locked).length : 0;
  return { ...stats, pending: { fixes: (fixes.data || []).length, requests: (pendingReqs.data || []).length, extras: extras.length, faces: (faces.data || []).length,
    claims: pendingClaims.error ? 0 : (pendingClaims.data || []).length, peers: pendingPeers.error ? 0 : (pendingPeers.data || []).length,
    fines: stats.people.reduce((a, p) => a + p.fineSuggestions, 0), bonuses: bonusWaiting } };
}

// Bảng lương của một tháng: số đã chốt (nếu có), ngày nghỉ của các đơn báo nghỉ, thưởng chuyên
// cần đã duyệt, danh sách lỗi, gợi ý phạt đã xử lý, ngày / người ghi của các khoản phạt và lương 1 giờ.
async function payrollMonth(db, year, month) {
  const { start, end } = monthRange(year, month);
  const [closes, leaveDays, auto, bonuses, bonusSettings, fineRules, fineReviews, meta, sessionIds, hourlyRates, lateRules, holidays] = await Promise.all([
    db.from('payroll_closes').select('*').eq('year', year).eq('month', month),
    // Ngày nghỉ của các đơn có ngày chạm tháng này.
    db.from('payroll_leave_days').select('*').lt('from_date', end).gte('to_date', start),
    // Ca máy tự đóng vì quên ra ca (ghi sau ngày làm nên lọc theo giờ ghi) để tab Chấm công đánh dấu.
    autoClosedInMonth(db, start, end),
    db.from('payroll_bonuses').select('*').eq('year', year).eq('month', month),
    readPayrollSettings(db),
    db.from('payroll_fine_rules').select('*').order('sort').order('created_at'),
    db.from('payroll_fine_reviews').select('*').gte('work_day', start).lt('work_day', end),
    db.from('payroll_violation_meta').select('*').gte('fine_date', start).lt('fine_date', end),
    readAll(() => db.from('attendance_sessions').select('id').gte('date', start).lte('date', end).order('clock_in')),
    readHourlyRates(db),
    readLateRules(db),
    readHolidays(db),
  ]);
  for (const r of [closes, leaveDays, bonuses, fineRules, fineReviews, meta]) if (r.error) throw r.error;
  // Lần trả lương theo kỳ có thể chứa tiền ngày của tháng này (trả tới ngày trong / sau tháng này): bảng lương trừ phần đã trả.
  const payouts = await db.from('payroll_payouts').select('*').gte('to_day', start);
  if (payouts.error && !missingTable(payouts.error)) throw payouts.error;
  // reviews: lần duyệt giờ ngoài ca của các ca trong tháng (trang Lương tính bằng đúng dữ liệu máy chủ chốt).
  const ids = sessionIds.map(x => x.id);
  // faceHolds: ca chờ chủ duyệt mặt — trang Lương chưa tính lương các ca này. claims: chi hộ đã duyệt tính vào lương tháng này.
  const claims = await readMonthClaims(db, year, month);
  return { closes: closes.data || [], leaveDays: leaveDays.data || [], autoClosed: [...new Set(auto.map(r => r.attendance_id))], claims,
    reviews: await reviewsFor(db, ids), faceHolds: [...await faceHolds(db, ids)],
    bonuses: bonuses.data || [], bonusSettings, fineRules: fineRules.data || [], fineReviews: fineReviews.data || [], violationMeta: meta.data || [],
    hourlyRates, lateRules, ...holidays, payouts: payouts.error ? [] : payouts.data || [], monthOver: monthOver(year, month) };
}

const CYCLE_NOT_READY = 'Web đang cập nhật phần trả lương theo kỳ, thử lại sau ít phút.';
// Tính lại tối đa chừng này tháng gần nhất cho người trả theo kỳ (lâu hơn nữa chưa trả thì xem ở bảng lương tháng đó).
const CYCLE_MONTHS = 6;
const nextMonthKey = k => { const [y, m] = k.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

// Kỳ trả lương của từng người (một người: staffId). null = bảng chưa tạo (web lên trước migration).
async function readCycles(db, staffId = null) {
  let q = db.from('payroll_pay_cycles').select('*');
  if (staffId) q = q.eq('staff_id', staffId);
  const { data, error } = await q;
  if (missingTable(error)) return null;
  if (error) throw error;
  return data || [];
}

/**
 * Người trả lương theo kỳ (một người: staffId) tính tới hôm nay: kỳ đang chạy, ngày phát, tiền từng ngày còn phải trả (cả phần
 * chênh của ngày đã trả mà sau đó sửa giờ), ứng / phạt / thưởng chưa trừ, ca đang mở, các lần trả gần đây. Tính lại từ tháng trước
 * (hoặc từ đầu kỳ nếu kỳ bắt đầu sớm hơn), cùng công thức bảng lương; tháng đã chốt thì theo tiền từng ngày đã chốt.
 */
async function cycleStates(db, staffId = null) {
  const cycles = await readCycles(db, staffId);
  if (cycles === null) return { ready: false, people: [] };
  if (!cycles.length) return { ready: true, people: [] };
  const today = vnToday();
  const { data: payouts, error } = await db.from('payroll_payouts').select('*').in('staff_id', cycles.map(c => c.staff_id)).gte('to_day', addDays(today, -400)).order('to_day');
  if (missingTable(error)) return { ready: false, people: [] };
  if (error) throw error;
  let floor = `${today.slice(0, 7)}-01`;
  for (let i = 1; i < CYCLE_MONTHS; i += 1) floor = `${addDays(floor, -1).slice(0, 7)}-01`;
  const prevMonth = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
  const plans = cycles.map(c => {
    const mine = (payouts || []).filter(p => p.staff_id === c.staff_id);
    const period = cyclePeriod({ cycle: c, payouts: mine, today });
    const first = String(c.start_day).slice(0, 10);
    let from = period.start < prevMonth ? period.start : prevMonth;
    if (from < first) from = first;
    if (from < floor) from = floor;
    return { c, mine, period, from };
  });
  const earliest = plans.reduce((a, p) => (p.from < a ? p.from : a), today);
  const keys = [];
  for (let k = earliest.slice(0, 7); k <= today.slice(0, 7); k = nextMonthKey(k)) keys.push(k);
  const loaded = new Map(await Promise.all(keys.map(async k => [k, await loadPayrollMonth(db, Number(k.slice(0, 4)), Number(k.slice(5, 7)), today)])));
  const monthOf = (k, id) => {
    const m = loaded.get(k), of = rows => (rows || []).filter(r => r.staff_id === id);
    const person = m.staff.find(x => x.id === id) || { id };
    const [year, month] = k.split('-').map(Number), reqs = of(m.requests), vios = of(m.violations), gifts = of(m.bonuses), claims = of(m.claims || []);
    const closed = m.closes.find(x => x.staff_id === id)?.snapshot;
    const byDay = closed?.byDay || computeSalary({ year, month, staffId: id, sessions: of(m.sessions), config: of(m.configs)[0] || null, requests: reqs, violations: vios, bonuses: gifts,
      rules: m.rules, reviews: m.reviews, hourlyRates: of(m.hourlyRates), lateRules: lateRulesOf(m.lateRules, id), ...holidayArgs(person, m) }).byDay;
    return { key: k, byDay, advances: reqs.filter(r => r.request_type === 'advance' && r.status === 'approved').map(r => ({ id: r.id, amount: Number(r.amount) || 0 })),
      fines: vios.map(v => ({ id: v.id, amount: Number(v.amount) || 0 })), bonus: gifts.reduce((a, b) => a + (Number(b.amount) || 0), 0),
      claims: claims.filter(c => c.payout === 'salary').map(c => ({ id: c.id, amount: Number(c.amount) || 0 })) };
  };
  const last = loaded.get(today.slice(0, 7));
  return { ready: true, today, people: plans.map(({ c, mine, period, from }) => {
    const due = cycleDue({ cycle: c, payouts: mine, months: keys.filter(k => k >= from.slice(0, 7)).map(k => monthOf(k, c.staff_id)), to: today, periodStart: period.start });
    // Ca đang mở (chưa ra ca): tiền ngày đó chưa tính, trả tới ngày đó thì phần còn lại vào lần trả sau.
    const open = (last?.sessions || []).find(x => x.staff_id === c.staff_id && !x.clock_out);
    return { staff_id: c.staff_id, every_days: period.every, start_day: String(c.start_day).slice(0, 10), payday_anchor: c.payday_anchor ? String(c.payday_anchor).slice(0, 10) : null,
      period: { start: period.start, payday: period.payday, daysLeft: period.daysLeft, fixed: period.fixed },
      openDay: open ? workDayOf(open, last.rules) : null, days: due.days, advances: due.advances, fines: due.fines, bonuses: due.bonuses, claims: due.claims,
      payouts: mine.slice(-6).reverse().map(({ detail: _d, ...x }) => x) };
  }) };
}

// Ca 45 ngày gần đây có giờ ngoài ca (vào sớm / ở lại) mà chủ chưa duyệt.
async function pendingExtras(db, rules) {
  const since = new Date(nowMs() + 7 * 3600000 - 45 * 86400000).toISOString().slice(0, 10);
  const from = rules.hours_from > since ? rules.hours_from : since;
  if (from > vnToday()) return [];
  const data = await readAll(() => db.from('attendance_sessions').select('*').gte('date', from).order('clock_in'));
  const reviewed = new Set((await reviewsFor(db, data.map(x => x.id))).map(r => r.attendance_id));
  return data.filter(s => s.clock_out && !reviewed.has(s.id))
    .map(s => ({ s, h: sessionHours(s, rules) })).filter(x => x.h.pendingMs > 0)
    // date = ngày của ca (lượt dọn quán sau nửa đêm hiện là ca hôm trước).
    .map(({ s, h }) => ({ attendance_id: s.id, staff_id: s.staff_id, date: workDayOf(s, rules), clock_in: s.clock_in, clock_out: s.clock_out,
      early_minutes: Math.round(h.earlyMs / 60000), stay_minutes: Math.round(h.stayMs / 60000) }));
}

// Lượt quét chờ máy quầy so mặt của một nhân viên (điện thoại hỏi vài giây một lần tới khi có kết quả).
async function faceCheckStatus(db, staffId, id) {
  if (!UUID.test(id || '')) return { status: 'missing' };
  const { data: c, error } = await db.from('checkin_face_checks').select('*').eq('id', id).eq('staff_id', staffId).maybeSingle();
  if (error) throw error;
  if (!c) return { status: 'missing' };
  let status = c.status, reason = c.reason || null;
  // Máy quầy không so trong 1 phút (app tắt, mất mạng): lượt này hết giờ, quét lại.
  if (status === 'waiting' && nowMs() - Date.parse(c.created_at) > FACE_WAIT_MS + 5000) {
    const r = await db.from('checkin_face_checks').update({ status: 'expired', reason: 'timeout', decided_at: isoNow() }).eq('id', c.id).eq('status', 'waiting');
    if (r.error) throw r.error;
    status = 'expired'; reason = 'timeout';
  }
  // Máy quầy vừa báo đúng mặt nhưng chưa ghi xong giờ: điện thoại hỏi lại lần sau.
  if ((status === 'ok' || status === 'review') && !c.attendance_id) return { status: 'waiting', clocked: c.clocked };
  const out = { status, clocked: c.clocked, reason };
  if (status === 'wrong') {
    const { data: recent, error: e } = await db.from('checkin_face_checks').select('status, created_at').eq('staff_id', staffId)
      .gte('created_at', new Date(nowMs() - FACE_STREAK_MS).toISOString()).order('created_at', { ascending: false }).limit(20);
    if (e) throw e;
    out.tries_left = Math.max(0, FACE_TRIES - wrongStreak(recent));
  }
  if ((status === 'ok' || status === 'review') && c.attendance_id) {
    const { data: session, error: e } = await db.from('attendance_sessions').select('*').eq('id', c.attendance_id).maybeSingle();
    if (e) throw e;
    if (session) {
      const settings = await readCheckinSettings(db);
      out.result = { ok: true, clocked: c.clocked, at: c.clocked === 'out' ? session.clock_out : session.clock_in, session, sessions: await sessionsOfDay(db, staffId, session, settings),
        warnings: c.scan?.warnings || [], face_hold: status === 'review' };
    }
  }
  return out;
}

// So khuôn mặt (admin): cài đặt, ai đã có mặt mẫu (không đưa dấu mặt ra ngoài), ca chờ duyệt mặt, lượt so 14 ngày.
async function faceOverview(db) {
  const settings = await readFaceSettings(db);
  // Bảng so mặt chưa tạo (web mới lên, chưa chạy migration): trang Lương báo đang cập nhật.
  if (settings.missing) return { missing: true, settings, levels: FACE_LEVELS, staff: [], reviews: [], checks: [], apps: [], now: isoNow() };
  const [staff, templates, departures, reviews, checks, apps] = await Promise.all([
    db.from('staff').select('id, full_name, role').order('full_name'),
    db.from('staff_face_templates').select('*'),
    db.from('staff_departures').select('staff_id, last_day'),
    db.from('attendance_face_reviews').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(200),
    db.from('checkin_face_checks').select('id, staff_id, kiosk_id, clocked, status, score, reason, attendance_id, created_at')
      .gte('created_at', new Date(nowMs() - 14 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(300),
    db.from('checkin_kiosk_apps').select('*'),
  ]);
  for (const r of [staff, templates, departures, reviews, checks, apps]) if (r.error) throw r.error;
  const ids = [...new Set((reviews.data || []).map(r => r.attendance_id))];
  const { data: sessions, error } = ids.length ? await db.from('attendance_sessions').select('*').in('id', ids) : { data: [] };
  if (error) throw error;
  const today = vnToday();
  const tplOf = new Map((templates.data || []).map(t => [t.staff_id, t]));
  const lastDay = new Map((departures.data || []).map(d => [d.staff_id, d.last_day]));
  return {
    settings, levels: FACE_LEVELS,
    staff: (staff.data || []).map(p => {
      const t = tplOf.get(p.id);
      return { id: p.id, full_name: p.full_name, role: p.role, departed: !!lastDay.get(p.id) && String(lastDay.get(p.id)) < today,
        face: t ? { count: (t.embeddings || []).length, created_at: t.created_at, enrolled_by: t.enrolled_by } : null };
    }),
    reviews: (reviews.data || []).map(r => ({ ...r, session: (sessions || []).find(x => x.id === r.attendance_id) || null })).filter(r => r.session),
    checks: checks.data || [], apps: apps.data || [], now: isoNow(),
  };
}

async function checkinOverview(db) {
  const since = new Date(nowMs() - 14 * 86400000).toISOString();
  const [settings, kiosks, devices, scans, fixes, reviews, departures, tap] = await Promise.all([
    readCheckinSettings(db),
    db.from('checkin_kiosks').select('*').order('created_at', { ascending: false }),
    db.from('staff_checkin_devices').select('*'),
    db.from('checkin_scans').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(300),
    db.from('attendance_fix_requests').select('*').gte('created_at', new Date(nowMs() - 45 * 86400000).toISOString()).order('created_at', { ascending: false }),
    // 1000 lần duyệt gần nhất (để hiện); tính lương dùng lần duyệt của đúng tháng (?payroll=1).
    db.from('attendance_extra_reviews').select('*').order('decided_at', { ascending: false }).limit(1000),
    db.from('staff_departures').select('*'),
    // Người chấm công bằng nút trên máy quầy (bảng chưa tạo: chưa có ai).
    db.from('checkin_tap_staff').select('*'),
  ]);
  for (const r of [kiosks, devices, scans, fixes, reviews, departures]) if (r.error) throw r.error;
  if (tap.error && !missingTable(tap.error)) throw tap.error;
  // Giờ đang ghi của các ca có đơn xin sửa, để chủ so với giờ xin.
  const ids = [...new Set((fixes.data || []).map(f => f.attendance_id))];
  const { data: fixSessions, error } = ids.length ? await db.from('attendance_sessions').select('*').in('id', ids) : { data: [] };
  if (error) throw error;
  return { settings, kiosks: kiosks.data || [], devices: devices.data || [], scans: scans.data || [], fixes: fixes.data || [], fixSessions: fixSessions || [],
    autoClosed: await autoClosedIds(db, { ids }), reviews: reviews.data || [], extras: await pendingExtras(db, settings),
    departures: departures.data || [], tapStaff: tap.error ? [] : tap.data || [], now: isoNow(), clock: clockStatus() };
}

export async function GET(request) {
  try {
    await refreshClock();
    const s = await session(request);
    if (s.error) return s.error;
    const params = new URL(request.url).searchParams;
    if (params.get('me')) return NextResponse.json(await myStatus(s.db, s.user.id), { headers });
    if (params.get('face_check')) return NextResponse.json(await faceCheckStatus(s.db, s.user.id, params.get('face_check')), { headers });
    if (!params.get('checkin') && !params.get('payroll') && !params.get('stats') && !params.get('faces') && !params.get('cycles') && !params.get('claims') && !params.get('peer')
      && !params.get('inbox')) return fail('Thiếu yêu cầu.');
    if (!s.isAdmin) return fail('Chỉ admin xem phần này.', 403);
    if (params.get('claims')) return NextResponse.json(await claimsOverview(s.db), { headers });
    if (params.get('peer')) return NextResponse.json(await peerOverview(s.db), { headers });
    if (params.get('inbox')) return NextResponse.json(await inboxOverview(s.db), { headers });
    if (params.get('faces')) return NextResponse.json(await faceOverview(s.db), { headers });
    if (params.get('cycles')) return NextResponse.json(await cycleStates(s.db), { headers });
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
    await refreshClock();
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
      await closeForgottenSessions(db, settings, user.id, nowMs());
      const device = deviceOf(request);
      const ip = clientIp(request.headers);
      const warnings = [];
      let qr = null;
      if (body.token || !isAdmin) {
        qr = readKioskQrToken(body.token, secret(), nowMs());
        if (!qr) return fail('Mã QR đã hết hạn hoặc không đúng. Quét lại mã trên máy quầy.', 403);
        const { data: kiosk, error } = await db.from('checkin_kiosks').select('*').eq('id', qr.kioskId).maybeSingle();
        if (error) throw error;
        if (!kiosk || kiosk.revoked_at) return fail('Máy quầy này đã bị tắt. Quét mã trên máy quầy đang dùng.', 403);
        if (!onKioskNetwork(ip, kiosk, nowMs())) warnings.push('other_network');
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
      const scan = { staff_id: user.id, kiosk_id: qr?.kioskId || null, nonce: qr?.nonce || null, warnings, enforced: settings.enforce, ip, device_id: device.id, created_at: isoNow(), user_agent: text(request.headers?.get?.('user-agent'), 200) };

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
      if (lastAt && nowMs() - Date.parse(lastAt) < MIN_TOGGLE_MS) {
        return fail(`Bạn vừa ${open ? 'vào' : 'ra'} ca lúc ${hhmm(lastAt)}. Đợi 3 phút rồi quét lại nếu muốn ${open ? 'ra' : 'vào'} ca.`, 409);
      }

      // Mỗi mã chỉ dùng được một lần: hai người cùng dùng một mã thì người sau bị từ chối.
      if (qr) {
        const claim = await db.from('checkin_nonces').insert({ nonce: qr.nonce, staff_id: user.id, used_at: isoNow() });
        if (claim.error) {
          if (claim.error.code === '23505') return fail('Mã này vừa có người dùng. Đợi mã mới trên máy quầy rồi quét lại.', 409);
          throw claim.error;
        }
      }
      // Lần đầu chấm công: ghi điện thoại này là máy của người đó.
      if (!isAdmin && !mine && !holder) {
        await db.from('staff_checkin_devices').insert({ staff_id: user.id, device_id: device.id, user_agent: scan.user_agent, created_at: isoNow() })
          .then(({ error: e }) => { if (e) console.error('[workforce] device bind', e); });
      }

      // Máy quầy là app và người này có mặt mẫu: chưa ghi giờ, chờ máy quầy so mặt (đúng mặt mới ghi).
      const face = qr && !isAdmin ? await faceNeeded(db, user.id, qr.kioskId, nowMs()) : null;
      if (face === 'no_template') warnings.push('no_face');
      if (face === 'face') {
        // Quét lại khi lượt trước còn chờ: bỏ lượt trước, máy quầy so mặt cho lượt mới.
        await db.from('checkin_face_checks').update({ status: 'cancelled', decided_at: isoNow() }).eq('staff_id', user.id).eq('status', 'waiting')
          .then(({ error: e }) => { if (e) console.error('[workforce] face cancel', e); });
        const { staff_id: _who, created_at: _at, ...scanInfo } = scan;
        const { data: check, error: ce } = await db.from('checkin_face_checks').insert({ staff_id: user.id, kiosk_id: qr.kioskId, nonce: qr.nonce, scan: scanInfo,
          clocked: open ? 'out' : 'in', status: 'waiting', created_at: isoNow() }).select('*').single();
        if (ce) throw ce;
        return withDevice(NextResponse.json({ ok: true, face: { id: check.id, clocked: check.clocked, wait_ms: FACE_WAIT_MS }, warnings }, { headers }), request, device);
      }

      let done;
      try { done = await applyClock(db, { staffId: user.id, at: isoNow(), scan }); }
      catch (error) {
        // Hai lượt quét cùng lúc: lượt sau gặp ca vừa được lượt trước mở / đóng.
        if (error?.code === 'already_open') return fail('Bạn vừa chấm công. Đợi 3 phút rồi quét lại nếu muốn đổi vào / ra ca.', 409);
        throw error;
      }
      // Các lượt cùng ngày làm (vào lại sau nửa đêm để dọn quán thì tính chung ca hôm trước, không báo trễ nhầm).
      const sessions = await sessionsOfDay(db, user.id, done.session, settings);
      return withDevice(NextResponse.json({ ok: true, clocked: done.clocked, at: done.at, session: done.session, sessions, warnings }, { headers }), request, device);
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
      // Ô giờ trên điện thoại chỉ có đến phút: trùng phút với giờ đang ghi là không đổi.
      const same = (d, v) => d && v && Math.floor(d.getTime() / 60000) === Math.floor(Date.parse(v) / 60000);
      if (same(clockIn, att.clock_in)) clockIn = null;
      if (same(clockOut, att.clock_out)) clockOut = null;
      if (!clockIn && !clockOut) return fail('Chọn giờ vào hoặc giờ ra muốn sửa (khác giờ đang ghi).');
      const start = clockIn || new Date(att.clock_in), end = clockOut || (att.clock_out ? new Date(att.clock_out) : null);
      if (end && (end <= start || end - start > 20 * 3600000)) return fail('Giờ ra phải sau giờ vào và ca không quá 20 tiếng.');
      if ((clockOut || clockIn) > new Date(nowMs() + 5 * 60000)) return fail('Không xin giờ ở tương lai.');
      const { data: pending } = await db.from('attendance_fix_requests').select('id').eq('attendance_id', att.id).eq('status', 'pending').limit(1);
      if (pending?.length) return fail('Ca này đã có đơn xin sửa đang chờ chủ duyệt.', 409);
      const r = await db.from('attendance_fix_requests').insert({ staff_id: user.id, attendance_id: att.id, clock_in: clockIn?.toISOString() || null, clock_out: clockOut?.toISOString() || null, reason, status: 'pending', created_at: isoNow() });
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
        .eq('status', 'pending').gte('created_at', new Date(nowMs() - 30000).toISOString());
      if (recentError) throw recentError;
      const same = x => x.reason === row.reason && Number(x.amount || 0) === Number(row.amount || 0) && Number(x.days || 0) === Number(row.days || 0)
        && x.month === row.month && x.year === row.year;
      if ((recent || []).some(same)) return NextResponse.json({ ok: true, duplicate: true }, { headers });
      const r = await db.from('payroll_requests').insert({ ...row, created_at: isoNow(), updated_at: isoNow() }).select('id').single();
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
      const table = body.kind === 'fix' ? 'attendance_fix_requests' : body.kind === 'claim' ? 'payroll_expense_claims' : body.kind === 'peer' ? 'payroll_peer_reports' : 'payroll_requests';
      const { data: req, error } = await db.from(table).select('*').eq('id', body.id).maybeSingle();
      if (missingTable(error)) return fail(body.kind === 'peer' ? PEER_NOT_READY : CLAIMS_NOT_READY, 503);
      if (error) throw error;
      if (!req || (body.kind === 'peer' ? req.reporter_id : req.staff_id) !== user.id) return fail('Không tìm thấy đơn của bạn.', 404);
      if (req.status !== 'pending') return fail('Đơn đã được duyệt, không huỷ được nữa. Nhờ chủ quán nếu cần sửa.', 409);
      const r = await db.from(table).delete().eq('id', req.id).eq('status', 'pending').select('id');
      if (r.error) throw r.error;
      if (!r.data?.length) return fail('Đơn vừa được chủ quán xử lý, không huỷ được nữa. Tải lại trang.', 409);
      if (table === 'payroll_requests') {
        await db.from('payroll_leave_days').delete().eq('request_id', req.id).then(({ error: e }) => { if (e) console.error('[workforce] leave days', e); });
      }
      return NextResponse.json({ ok: true }, { headers });
    }

    // Nhân viên xác nhận đã nhận lương chủ quán đánh dấu đã trả (của chính mình). Bấm một lần, không đổi lại được.
    if (body.action === 'confirm_received') {
      const stamp = isoNow();
      const missingCol = e => /received_at/.test(String(e?.message || '')) || missingTable(e);
      if (body.kind === 'payout') {
        if (!UUID.test(body.id || '')) return fail('Thiếu lần trả.');
        const { data: row, error } = await db.from('payroll_payouts').select('*').eq('id', body.id).eq('staff_id', user.id).maybeSingle();
        if (missingCol(error)) return fail('Web đang cập nhật phần xác nhận nhận lương, thử lại sau ít phút.', 503);
        if (error) throw error;
        if (!row) return fail('Không thấy lần trả lương này.', 404);
        if (row.received_at) return NextResponse.json({ ok: true, received_at: row.received_at }, { headers });
        const r = await db.from('payroll_payouts').update({ received_at: stamp }).eq('id', row.id).is('received_at', null).select('id');
        if (missingCol(r.error)) return fail('Web đang cập nhật phần xác nhận nhận lương, thử lại sau ít phút.', 503);
        if (r.error) throw r.error;
        return NextResponse.json({ ok: true, received_at: stamp }, { headers });
      }
      const year = Number(body.year), month = Number(body.month);
      if (!(month >= 1 && month <= 12) || !(year >= 2024 && year <= 2100)) return fail('Tháng không hợp lệ.');
      const { data: row, error } = await db.from('payroll_closes').select('*').eq('year', year).eq('month', month).eq('staff_id', user.id).maybeSingle();
      if (error) throw error;
      if (!row?.paid_at) return fail('Chủ quán chưa đánh dấu đã trả lương tháng này.', 409);
      if (row.received_at) return NextResponse.json({ ok: true, received_at: row.received_at }, { headers });
      const r = await db.from('payroll_closes').update({ received_at: stamp }).eq('year', year).eq('month', month).eq('staff_id', user.id).is('received_at', null).select('staff_id');
      if (missingCol(r.error)) return fail('Web đang cập nhật phần xác nhận nhận lương, thử lại sau ít phút.', 503);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, received_at: stamp }, { headers });
    }

    // Nhân viên / quản lý ghi khoản tự bỏ tiền chi cho quán (vd đổ xăng 50.000đ đi chợ) rồi gửi chủ duyệt; tự chọn nhận lại bằng
    // tiền mặt tại chủ hay cộng vào lương. Ngày chi: hôm nay hoặc tối đa 31 ngày trước. Còn chờ duyệt thì tự huỷ được (cancel_request).
    if (body.action === 'claim_expense') {
      const item = text(body.item, 80), note = text(body.note, 300) || null, amount = money(body.amount);
      const payout = body.payout === 'cash' || body.payout === 'salary' ? body.payout : null;
      const today = vnToday(), spentOn = DATE.test(body.spent_on || '') ? body.spent_on : today;
      if (!item) return fail('Ghi khoản chi gì (vd: Xăng đi chợ).');
      if (!amount || amount < 1000 || amount > 50000000) return fail('Số tiền chi không hợp lệ (từ 1.000đ).');
      if (!payout) return fail('Chọn nhận lại tiền: lấy tiền mặt hay cộng vào lương.');
      if (spentOn > today || spentOn < addDays(today, -31)) return fail('Ngày chi phải trong 31 ngày gần đây, không sau hôm nay.');
      // Bấm đúp / mạng chập chờn: khoản giống hệt vừa gửi trong 30 giây thì coi như đã gửi.
      const { data: recent, error: re } = await db.from('payroll_expense_claims').select('id, item, amount, spent_on, payout, status, created_at').eq('staff_id', user.id)
        .eq('status', 'pending').order('created_at', { ascending: false }).limit(50);
      if (missingTable(re)) return fail(CLAIMS_NOT_READY, 503);
      if (re) throw re;
      if ((recent || []).some(x => x.item === item && Number(x.amount) === amount && String(x.spent_on).slice(0, 10) === spentOn && x.payout === payout
        && Date.parse(x.created_at) > nowMs() - 30000)) return NextResponse.json({ ok: true, duplicate: true }, { headers });
      if ((recent || []).length >= 30) return fail('Bạn còn nhiều khoản chi đang chờ duyệt. Nhờ chủ quán duyệt bớt rồi ghi tiếp.', 429);
      const r = await db.from('payroll_expense_claims').insert({ staff_id: user.id, spent_on: spentOn, item, amount, note, payout, status: 'pending',
        created_by_name: user.full_name || null, created_at: isoNow() }).select('id').single();
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, id: r.data.id }, { headers });
    }

    // Báo lỗi đồng nghiệp: chọn người (không phải mình, không phải chủ quán), lỗi theo danh sách chủ đặt hoặc lỗi khác, ngày (hôm nay
    // hoặc tối đa 7 ngày trước). CHƯA trừ tiền: chủ quán phạt hoặc bỏ qua ở Lương → Yêu cầu. Người bị báo không thấy tên người báo.
    if (body.action === 'report_peer') {
      if (!UUID.test(body.staff_id || '')) return fail('Chọn người bạn muốn báo lỗi.');
      if (String(body.staff_id).toLowerCase() === String(user.id).toLowerCase()) return fail('Lỗi của chính mình thì ghi ở "Tự ghi lỗi".');
      // Ngày xảy ra: ngày người báo chọn (theo lịch, tới hôm nay); không chọn thì ngày làm đang diễn ra (sau nửa đêm vẫn là ca hôm trước).
      const today = vnToday(), day = DATE.test(body.date || '') ? body.date : currentWorkDay(await readCheckinSettings(db), user.id, nowMs());
      if (day > today || day < addDays(today, -7)) return fail('Chỉ báo lỗi trong 7 ngày gần đây.');
      const { data: target, error: te } = await db.from('staff').select('id, full_name, role').eq('id', body.staff_id).maybeSingle();
      if (te) throw te;
      if (!target || target.role === 'admin') return fail('Không báo lỗi người này được.');
      const { data: left } = await db.from('staff_departures').select('last_day').eq('staff_id', target.id).maybeSingle();
      if (left && String(left.last_day).slice(0, 10) < day) return fail('Người này đã nghỉ việc trước ngày đó.');
      let reason = text(body.reason, 200), ruleId = null, suggested = 0;
      if (body.rule_id) {
        if (!UUID.test(body.rule_id)) return fail('Lỗi này không còn trong danh sách.');
        const { data: rule, error } = await db.from('payroll_fine_rules').select('*').eq('id', body.rule_id).maybeSingle();
        if (error) throw error;
        if (!rule || !rule.active || rule.kind) return fail('Lỗi này không còn trong danh sách.');
        ruleId = rule.id; reason = rule.name; suggested = Number(rule.amount) || 0;
      }
      if (!reason) return fail('Chọn lỗi trong danh sách hoặc ghi rõ lỗi gì.');
      const note = text(body.note, 300) || null;
      const { data: recent, error: re } = await db.from('payroll_peer_reports').select('staff_id, reason, report_date, created_at').eq('reporter_id', user.id)
        .gte('created_at', new Date(nowMs() - 86400000).toISOString());
      if (missingTable(re)) return fail(PEER_NOT_READY, 503);
      if (re) throw re;
      // Bấm đúp / mạng chập chờn: cùng người, cùng lỗi, cùng ngày trong 30 giây thì coi như đã gửi. Một ngày tối đa 10 lần báo.
      if ((recent || []).some(x => x.staff_id === target.id && x.reason === reason && String(x.report_date).slice(0, 10) === day && Date.parse(x.created_at) > nowMs() - 30000)) {
        return NextResponse.json({ ok: true, duplicate: true }, { headers });
      }
      if ((recent || []).length >= 10) return fail('Hôm nay bạn đã báo nhiều lần rồi. Nói trực tiếp với chủ quán nhé.', 429);
      const r = await db.from('payroll_peer_reports').insert({ reporter_id: user.id, staff_id: target.id, report_date: day, rule_id: ruleId, reason, note,
        suggested_amount: suggested, status: 'pending', reporter_name: user.full_name || null, created_at: isoNow() }).select('id').single();
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, id: r.data.id, date: day }, { headers });
    }

    // Nhân viên tự ghi lỗi của chính mình hôm nay (làm vỡ ly, ghi sai món…). Tiền theo danh sách lỗi chủ đặt (không tự gõ tiền);
    // lỗi khác thì 0đ, chủ quán định tiền sau. Ghi xong người ghi không sửa / xoá được: chỉ chủ quán (các thao tác bên dưới).
    if (body.action === 'report_violation') {
      const settings = await readCheckinSettings(db);
      const day = currentWorkDay(settings, user.id, nowMs());
      let reason = text(body.reason, 200), ruleId = null, amount = 0;
      if (body.rule_id) {
        if (!UUID.test(body.rule_id)) return fail('Lỗi này không còn trong danh sách.');
        const { data: rule, error } = await db.from('payroll_fine_rules').select('*').eq('id', body.rule_id).maybeSingle();
        if (error) throw error;
        if (!rule || !rule.active || rule.kind) return fail('Lỗi này không còn trong danh sách.');
        ruleId = rule.id; reason = rule.name; amount = Number(rule.amount) || 0;
      }
      if (!reason) return fail('Chọn lỗi trong danh sách hoặc ghi rõ lỗi gì.');
      const note = text(body.note, 300) || null;
      // Bấm nhiều lần liền: một ngày tối đa 20 khoản tự ghi.
      const { data: todays, error: te } = await db.from('payroll_violation_meta').select('violation_id').eq('staff_id', user.id).eq('fine_date', day).eq('self_reported', true);
      if (te) {
        if (/self_reported/.test(String(te.message || '')) || missingTable(te)) return fail('Web đang cập nhật phần tự ghi lỗi, thử lại sau ít phút.', 503);
        throw te;
      }
      if ((todays || []).length >= 20) return fail('Hôm nay bạn đã tự ghi nhiều lỗi rồi. Nhờ chủ quán ghi giúp.', 429);
      const v = await db.from('payroll_violations').insert({ staff_id: user.id, amount, reason, month: Number(day.slice(5, 7)), year: Number(day.slice(0, 4)), created_at: isoNow() })
        .select('id').single();
      if (v.error) throw v.error;
      const meta = await db.from('payroll_violation_meta').insert({ violation_id: v.data.id, staff_id: user.id, fine_date: day, rule_id: ruleId, recorded_by: user.full_name || null,
        self_reported: true, note, created_at: isoNow() });
      if (meta.error) {
        await db.from('payroll_violations').delete().eq('id', v.data.id);
        throw meta.error;
      }
      return NextResponse.json({ ok: true, id: v.data.id, amount, reason, date: day }, { headers });
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
        // Ô giờ chỉ đến phút: trùng phút thì giữ nguyên giờ đang ghi (không làm mất giây, không ghi nhật ký sai).
        const minute = v => (v ? Math.floor(new Date(v).getTime() / 60000) : null);
        const same = f === 'note' ? String(orig[f] ?? '') === String(value ?? '') : minute(orig[f]) === minute(value);
        if (same) continue;
        if (f === 'note' && !('note' in orig)) continue;
        updates[f] = value;
        logs.push({ attendance_id: orig.id, staff_id: orig.staff_id, field_name: f, old_value: String(orig[f] ?? ''), new_value: String(value ?? ''), changed_by: changedBy, changed_at: isoNow() });
      }
      if (!logs.length) return 0;
      // Giờ ra phải sau giờ vào, một ca không quá 24 tiếng (chỉ xét khi đổi giờ; ca đang mở thì chưa có giờ ra).
      if ('clock_in' in updates || 'clock_out' in updates) {
        const start = Date.parse('clock_in' in updates ? updates.clock_in : orig.clock_in), end = Date.parse('clock_out' in updates ? updates.clock_out : orig.clock_out);
        if (Number.isFinite(start) && Number.isFinite(end) && end <= start) return fail('Giờ ra phải sau giờ vào.');
        if (Number.isFinite(start) && Number.isFinite(end) && end - start > 24 * 3600000) return fail('Một ca không dài quá 24 tiếng.');
      }
      // Sửa giờ vào sang ngày khác (lượt quét nhầm sửa thành ca hôm trước…): ngày ghi theo giờ vào mới như lúc thêm ca,
      // không thì ca vẫn tính vào ngày cũ (thành giờ ngoài ca / mất ngày công).
      if (updates.clock_in) updates.date = new Date(Date.parse(updates.clock_in) + 7 * 3600000).toISOString().slice(0, 10);
      const r = await db.from('attendance_sessions').update(updates).eq('id', orig.id);
      if (r.error) throw r.error;
      // Giờ đổi thì giờ ngoài ca đổi theo: bỏ lần duyệt cũ. Từ khi giờ ngoài ca tự tính (AUTO_EXTRA_FROM) giữ lại lần chủ
      // bấm "Không tính" — sửa giờ (kể cả duyệt đơn xin sửa giờ của nhân viên) không được tự mở lại tiền tăng ca.
      if ('clock_in' in updates || 'clock_out' in updates) {
        let reset = db.from('attendance_extra_reviews').delete().eq('attendance_id', orig.id);
        if (workDayOf({ ...orig, ...updates }, await readCheckinSettings(db)) >= AUTO_EXTRA_FROM) reset = reset.neq('status', 'rejected');
        await reset.then(({ error: e }) => { if (e) console.error('[workforce] extra review reset', e); });
      }
      await db.from('attendance_changes').insert(logs).then(({ error: e }) => { if (e) console.error('[workforce] edit log', e); });
      return logs.length;
    };

    if (body.action === 'edit_attendance') {
      if (!UUID.test(body.id || '')) return fail('Thiếu ca cần sửa.');
      const changed = await editAttendance(body.id, body, user.full_name || null);
      return typeof changed === 'number' ? NextResponse.json({ ok: true, changed }, { headers }) : changed;
    }

    // Chủ thêm một ca (nhân viên quên quét cả lúc vào) hoặc xoá ca quét nhầm; ghi vào nhật ký sửa giờ.
    if (body.action === 'add_attendance') {
      const start = new Date(body.clock_in ?? ''), end = new Date(body.clock_out ?? '');
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return fail('Giờ ra phải sau giờ vào.');
      if (end - start > 24 * 3600000) return fail('Một ca không dài quá 24 tiếng.');
      if (end.getTime() > nowMs() + 5 * 60000) return fail('Giờ ra chưa tới.');
      const date = new Date(start.getTime() + 7 * 3600000).toISOString().slice(0, 10);
      // Ca đêm có thể ghi ngày hôm trước / hôm sau: so với các ca từ hôm trước tới hôm sau.
      const dayAfter = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const { data: near, error } = await db.from('attendance_sessions').select('*').eq('staff_id', body.staff_id).gte('date', dayBefore(date)).lte('date', dayAfter);
      if (error) throw error;
      const overlap = (near || []).find(s => Date.parse(s.clock_in) < end.getTime() && (s.clock_out ? Date.parse(s.clock_out) : nowMs()) > start.getTime());
      if (overlap) return fail(`Trùng giờ với ca ${hhmm(overlap.clock_in)}–${overlap.clock_out ? hhmm(overlap.clock_out) : 'đang mở'}. Sửa ca đó thay vì thêm ca mới.`, 409);
      const r = await db.from('attendance_sessions').insert({ staff_id: body.staff_id, date, clock_in: start.toISOString(), clock_out: end.toISOString() }).select('id').single();
      if (r.error) throw r.error;
      await db.from('attendance_changes').insert({ attendance_id: r.data.id, staff_id: body.staff_id, field_name: 'created', old_value: '', new_value: `${start.toISOString()} → ${end.toISOString()}`,
        changed_by: user.full_name || null, changed_at: isoNow(), note: text(body.note) || 'Chủ thêm ca' }).then(({ error: e }) => { if (e) console.error('[workforce] add log', e); });
      return NextResponse.json({ ok: true, id: r.data.id }, { headers });
    }

    if (body.action === 'delete_attendance') {
      if (!UUID.test(body.id || '')) return fail('Thiếu ca cần xoá.');
      const { data: ses, error } = await db.from('attendance_sessions').select('*').eq('id', body.id).maybeSingle();
      if (error) throw error;
      if (!ses) return fail('Không tìm thấy ca.', 404);
      const r = await db.from('attendance_sessions').delete().eq('id', ses.id);
      if (r.error) throw r.error;
      // Lần duyệt giờ ngoài ca và gợi ý phạt của ca này không còn ý nghĩa; khoản phạt đã ghi thì chủ tự xoá nếu muốn.
      const cleanup = await Promise.all([
        db.from('attendance_extra_reviews').delete().eq('attendance_id', ses.id),
        db.from('payroll_fine_reviews').delete().eq('attendance_id', ses.id).is('violation_id', null),
        db.from('attendance_changes').insert({ attendance_id: ses.id, staff_id: ses.staff_id, field_name: 'deleted', old_value: `${ses.clock_in} → ${ses.clock_out || ''}`, new_value: '',
          changed_by: user.full_name || null, changed_at: isoNow(), note: text(body.note) || 'Chủ xoá ca' }),
      ]);
      for (const x of cleanup) if (x.error) console.error('[workforce] delete attendance', x.error);
      return NextResponse.json({ ok: true }, { headers });
    }

    // Ứng lương chủ tự ghi (đưa tiền rồi ghi lại): duyệt luôn, tính vào tháng của ngày ứng.
    if (body.action === 'add_advance') {
      const amount = money(body.amount);
      const date = DATE.test(body.date || '') ? body.date : today;
      if (!UUID.test(body.staff_id || '') || !amount) return fail('Nhập số tiền ứng.');
      const r = await db.from('payroll_requests').insert({ staff_id: body.staff_id, request_type: 'advance', amount, reason: text(body.reason) || 'Chủ ghi ứng lương',
        status: 'approved', admin_note: `Ghi bởi ${user.full_name || 'admin'} (${ddmm(date)})`, month: Number(date.slice(5, 7)), year: Number(date.slice(0, 4)), created_at: isoNow(), updated_at: isoNow() }).select('id').single();
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, id: r.data.id }, { headers });
    }

    // Sửa số tiền / lý do một khoản ứng lương; xoá hẳn một đơn (ứng lương / báo nghỉ) kể cả đã duyệt.
    if (body.action === 'edit_request') {
      if (!UUID.test(body.id || '')) return fail('Thiếu đơn.');
      const { data: req, error } = await db.from('payroll_requests').select('*').eq('id', body.id).maybeSingle();
      if (error) throw error;
      if (!req) return fail('Không tìm thấy đơn.', 404);
      const patch = { updated_at: isoNow() };
      if ('amount' in body) {
        if (req.request_type !== 'advance') return fail('Chỉ sửa được số tiền của đơn ứng lương.');
        const amount = money(body.amount);
        if (!amount) return fail('Số tiền ứng không hợp lệ.');
        patch.amount = amount;
      }
      if ('reason' in body && text(body.reason)) patch.reason = text(body.reason);
      const r = await db.from('payroll_requests').update(patch).eq('id', req.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'delete_request') {
      if (!UUID.test(body.id || '')) return fail('Thiếu đơn.');
      const r = await db.from('payroll_requests').delete().eq('id', body.id);
      if (r.error) throw r.error;
      await db.from('payroll_leave_days').delete().eq('request_id', body.id).then(({ error: e }) => { if (e) console.error('[workforce] leave days', e); });
      return NextResponse.json({ ok: true }, { headers });
    }

    // Sửa số tiền / lý do một khoản phạt đã ghi.
    if (body.action === 'edit_violation') {
      if (!UUID.test(body.id || '')) return fail('Thiếu khoản phạt.');
      const patch = {};
      if ('amount' in body) {
        const amount = money(body.amount);
        if (!amount) return fail('Số tiền phạt không hợp lệ.');
        patch.amount = amount;
      }
      if ('reason' in body && text(body.reason, 200)) patch.reason = text(body.reason, 200);
      if (!Object.keys(patch).length) return fail('Không có gì để sửa.');
      const r = await db.from('payroll_violations').update(patch).eq('id', body.id).select('id');
      if (r.error) throw r.error;
      if (!r.data?.length) return fail('Không tìm thấy khoản phạt.', 404);
      return NextResponse.json({ ok: true }, { headers });
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
      const r = await db.from('attendance_fix_requests').update({ status: body.status, admin_note: text(body.admin_note), decided_by: user.full_name || null, decided_at: isoNow() }).eq('id', fix.id).eq('status', 'pending');
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'save_checkin_settings') {
      const now = isoNow();
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
      // Ca riêng của một nhân viên từ valid_from (mặc định hôm nay; chọn được từ ngày 1 tháng này, ví dụ người mới vào làm
      // trước khi đặt ca); clear = từ ngày đó quay về giờ quán. Ngày trước đó giữ ca cũ; ca đặt sau ngày đó bị bỏ.
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (!body.clear && (!validTime(body.start_time) || !validTime(body.end_time) || body.start_time === body.end_time)) return fail('Giờ vào ca và hết ca dạng 14:00, và phải khác nhau.');
      const from = body.valid_from === undefined || body.valid_from === null || body.valid_from === '' ? today : String(body.valid_from);
      if (!DATE.test(from) || from < `${today.slice(0, 7)}-01` || from > today) return fail('Ngày áp dụng từ ngày 1 tháng này đến hôm nay.');
      const row = { staff_id: body.staff_id, valid_from: from, start_time: body.clear ? null : body.start_time, end_time: body.clear ? null : body.end_time, updated_at: isoNow() };
      const { data: old, error } = await db.from('staff_shifts').select('staff_id').eq('staff_id', body.staff_id).eq('valid_from', from).maybeSingle();
      if (error) throw error;
      const r = old ? await db.from('staff_shifts').update(row).eq('staff_id', body.staff_id).eq('valid_from', from) : await db.from('staff_shifts').insert(row);
      if (r.error) throw r.error;
      const later = await db.from('staff_shifts').delete().eq('staff_id', body.staff_id).gt('valid_from', from);
      if (later.error) throw later.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'close_month' || body.action === 'reopen_month' || body.action === 'mark_paid') {
      // staff_id: chỉ một người (kết toán người nghỉ việc giữa tháng); không có = cả tháng.
      const year = Number(body.year), month = Number(body.month);
      if (!(month >= 1 && month <= 12) || !(year >= 2024 && year <= 2100)) return fail('Tháng không hợp lệ.');
      const only = UUID.test(body.staff_id || '') ? body.staff_id : null;
      if (body.action === 'mark_paid') {
        if (!only) return fail('Thiếu nhân viên.');
        // Nhân viên đã bấm "Tôi đã nhận" thì không bỏ dấu "đã trả" được nữa.
        if (body.paid === false) {
          const { data: row, error: e } = await db.from('payroll_closes').select('*').eq('year', year).eq('month', month).eq('staff_id', only).maybeSingle();
          if (e) throw e;
          if (row?.received_at) return fail('Nhân viên đã xác nhận đã nhận lương tháng này, không bỏ dấu "Đã trả" được.', 409);
        }
        const r = await db.from('payroll_closes').update(body.paid === false ? { paid_at: null, paid_by: null } : { paid_at: isoNow(), paid_by: user.full_name || null })
          .eq('year', year).eq('month', month).eq('staff_id', only).select('staff_id');
        if (r.error) throw r.error;
        if (!r.data?.length) return fail('Chốt lương người này trước rồi mới đánh dấu đã trả.', 409);
        return NextResponse.json({ ok: true }, { headers });
      }
      if (body.action === 'reopen_month') {
        // Người đã đánh dấu "đã trả" giữ nguyên số đã chốt: mở chốt sẽ mất dấu đã trả, dễ trả lương hai lần.
        if (only) {
          const { data: row, error: e } = await db.from('payroll_closes').select('paid_at').eq('year', year).eq('month', month).eq('staff_id', only).maybeSingle();
          if (e) throw e;
          if (row?.paid_at) return fail('Người này đã được đánh dấu đã trả lương. Bỏ dấu "Đã trả" trước rồi mới mở chốt.', 409);
        }
        let q = db.from('payroll_closes').delete().eq('year', year).eq('month', month).is('paid_at', null);
        if (only) q = q.eq('staff_id', only);
        const r = await q.select('staff_id');
        if (r.error) throw r.error;
        const kept = await db.from('payroll_closes').select('staff_id').eq('year', year).eq('month', month);
        if (kept.error) throw kept.error;
        return NextResponse.json({ ok: true, reopened: r.data?.length || 0, keptPaid: (kept.data || []).length }, { headers });
      }
      // Chốt lương: máy chủ tự tính lại bằng cùng công thức với trang Lương rồi lưu lại. Cả tháng thì giữ
      // nguyên người đã chốt riêng trước đó; người nghỉ việc trước tháng này không tính.
      const m = await loadPayrollMonth(db, year, month, vnToday());
      const closedIds = new Set(m.closes.map(c => c.staff_id));
      const closedAt = isoNow();
      const rows = m.staff.filter(p => (only ? p.id === only : !closedIds.has(p.id))).map(p => {
        const departure = m.departures.find(d => d.staff_id === p.id);
        if (!activeInMonth(departure, monthKey(year, month))) return null;
        const of = rows => rows.filter(x => x.staff_id === p.id);
        const config = of(m.configs)[0] || null, mine = of(m.sessions), reqs = of(m.requests), vios = of(m.violations), claims = of(m.claims || []);
        if (!config && !mine.length && !reqs.length && !vios.length && !claims.length) return null;
        // Tiền từng ngày (byDay) lưu cùng số đã chốt: Sổ thu chi theo đúng phiếu đã trả dù sau đó có sửa giờ. Chi tiết từng
        // ngày (trang Lương tự tính lại) không lưu.
        const { daily, ...salary } = computeSalary({ year, month, staffId: p.id, sessions: mine, config, requests: reqs, violations: vios, bonuses: of(m.bonuses), rules: m.rules, reviews: m.reviews, hourlyRates: of(m.hourlyRates), lateRules: lateRulesOf(m.lateRules, p.id),
          ...holidayArgs(p, m), claims });
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
        // Đã qua ngày làm cuối: ghi lần nghỉ (ngày làm cuối → hôm nay đi làm lại) để lương ngày quán nghỉ không tính khoảng
        // đã nghỉ. Huỷ cho nghỉ trước ngày làm cuối thì không có khoảng nghỉ. Bảng chưa tạo (chưa chạy staff_returns.sql):
        // chỉ bỏ dòng nghỉ việc như cũ.
        const { data: left, error: le } = await db.from('staff_departures').select('*').eq('staff_id', body.staff_id).maybeSingle();
        if (le) throw le;
        if (left && String(left.last_day).slice(0, 10) < today) {
          const back = await db.from('staff_returns').insert({ staff_id: body.staff_id, left_day: String(left.last_day).slice(0, 10), return_day: today,
            decided_by: user.full_name || null, created_at: isoNow() });
          if (back.error && !missingTable(back.error)) throw back.error;
        }
        const r = await db.from('staff_departures').delete().eq('staff_id', body.staff_id);
        if (r.error) throw r.error;
        return NextResponse.json({ ok: true }, { headers });
      }
      const lastDay = String(body.last_day || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay) || new Date(`${lastDay}T00:00:00Z`).toISOString().slice(0, 10) !== lastDay) return fail('Chọn ngày làm việc cuối cùng.');
      const { data: person, error } = await db.from('staff').select('id').eq('id', body.staff_id).maybeSingle();
      if (error) throw error;
      if (!person) return fail('Không tìm thấy nhân viên.', 404);
      const row = { staff_id: body.staff_id, last_day: lastDay, reason: text(body.reason), decided_by: user.full_name || null, created_at: isoNow() };
      const { data: old } = await db.from('staff_departures').select('staff_id').eq('staff_id', body.staff_id).maybeSingle();
      const r = old ? await db.from('staff_departures').update(row).eq('staff_id', body.staff_id) : await db.from('staff_departures').insert(row);
      if (r.error) throw r.error;
      // Điện thoại chấm công của người nghỉ được dùng lại cho người khác; dấu mặt mẫu xoá luôn.
      await db.from('staff_checkin_devices').delete().eq('staff_id', body.staff_id).then(({ error: e }) => { if (e) console.error('[workforce] device', e); });
      await db.from('staff_face_templates').delete().eq('staff_id', body.staff_id).then(({ error: e }) => { if (e) console.error('[workforce] face template', e); });
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
        decided_by: user.full_name || null, decided_at: isoNow() };
      // Duyệt lại (lỡ bấm nhầm) thì ghi đè.
      const { data: old, error: e } = await db.from('attendance_extra_reviews').select('attendance_id').eq('attendance_id', att.id).maybeSingle();
      if (e) throw e;
      const r = old ? await db.from('attendance_extra_reviews').update(row).eq('attendance_id', att.id) : await db.from('attendance_extra_reviews').insert(row);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, minutes: row.minutes }, { headers });
    }

    if (body.action === 'face_enroll') {
      // Lấy mặt mẫu trên máy quầy (app), chủ quán đang đăng nhập trên máy đó. Chỉ lưu dấu mặt, không lưu ảnh.
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const vectors = faceVectors(body.embeddings, ENROLL_MIN, ENROLL_MAX);
      if (!vectors) return fail('Chưa lấy đủ mặt mẫu, làm lại.');
      if (enrollConsistency(vectors) < ENROLL_SELF_MIN) return fail('Ảnh mặt chưa rõ (thiếu sáng hoặc quay đi). Nhìn thẳng vào camera rồi làm lại.', 422);
      const [{ data: person, error }, { data: others, error: oe }, faceSettings] = await Promise.all([
        db.from('staff').select('id, full_name').eq('id', body.staff_id).maybeSingle(),
        db.from('staff_face_templates').select('*').neq('staff_id', body.staff_id),
        readFaceSettings(db),
      ]);
      if (error) throw error;
      if (oe) throw oe;
      if (!person) return fail('Không tìm thấy nhân viên.', 404);
      // Mặt này đã là mặt mẫu của người khác (lấy nhầm người, hoặc một người đăng ký hai tên): hỏi lại chủ.
      if (body.force !== true) {
        const twin = (others || []).map(t => ({ t, score: bestScore(vectors, (t.embeddings || []).map(faceVector).filter(Boolean)) }))
          .filter(x => x.score >= faceThreshold(faceSettings)).sort((a, b) => b.score - a.score)[0];
        if (twin) {
          const { data: other } = await db.from('staff').select('full_name').eq('id', twin.t.staff_id).maybeSingle();
          const who = other?.full_name || 'người khác';
          return NextResponse.json({ error: `Mặt này giống mặt mẫu của ${who}. Kiểm tra đúng người rồi mới lưu.`, duplicate: who }, { status: 409, headers });
        }
      }
      const kioskId = readKioskCookie(request.cookies?.get?.(KIOSK_COOKIE)?.value, secret(), nowMs());
      const row = { staff_id: person.id, model: FACE_MODEL, embeddings: vectors.map(v => v.map(x => Math.round(x * 1e6) / 1e6)), kiosk_id: kioskId || null,
        enrolled_by: user.full_name || null, created_at: isoNow() };
      const del = await db.from('staff_face_templates').delete().eq('staff_id', person.id);
      if (del.error) throw del.error;
      const r = await db.from('staff_face_templates').insert(row);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, name: person.full_name, count: vectors.length }, { headers });
    }

    if (body.action === 'face_delete') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const r = await db.from('staff_face_templates').delete().eq('staff_id', body.staff_id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'save_face_settings') {
      const row = { updated_at: isoNow() };
      if ('enabled' in body) row.enabled = body.enabled === true;
      if ('level' in body) {
        if (!FACE_LEVELS[body.level]) return fail('Độ khắt khe không hợp lệ.');
        row.level = body.level;
      }
      const { data: old, error } = await db.from('checkin_face_settings').select('id').eq('id', 1).maybeSingle();
      if (error) throw error;
      const r = old ? await db.from('checkin_face_settings').update(row).eq('id', 1) : await db.from('checkin_face_settings').insert({ id: 1, ...row });
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, settings: await readFaceSettings(db) }, { headers });
    }

    if (body.action === 'decide_face') {
      // Ca ghi sau 3 lần sai mặt: Đúng người → tính lương. Không phải → lượt vào ca: bỏ cả ca; lượt ra ca: bỏ giờ ra
      // (ca mở lại, máy tự đóng khi quên ra ca hoặc chủ sửa giờ).
      if (!UUID.test(body.attendance_id || '') || !['in', 'out'].includes(body.clocked) || !['approved', 'rejected'].includes(body.status)) return fail('Yêu cầu không hợp lệ.');
      const { data: rev, error } = await db.from('attendance_face_reviews').select('*').eq('attendance_id', body.attendance_id).eq('clocked', body.clocked).maybeSingle();
      if (error) throw error;
      if (!rev) return fail('Không tìm thấy ca chờ duyệt.', 404);
      if (rev.status !== 'pending') return fail('Ca này đã được duyệt rồi.', 409);
      const by = user.full_name || 'Admin';
      if (body.status === 'rejected') {
        const { data: att, error: ae } = await db.from('attendance_sessions').select('*').eq('id', rev.attendance_id).maybeSingle();
        if (ae) throw ae;
        if (att && rev.clocked === 'in') {
          const r = await db.from('attendance_sessions').delete().eq('id', att.id);
          if (r.error) throw r.error;
          await db.from('attendance_extra_reviews').delete().eq('attendance_id', att.id).then(({ error: e }) => { if (e) console.error('[workforce] face reject extra', e); });
          await db.from('attendance_changes').insert({ attendance_id: att.id, staff_id: att.staff_id, field_name: 'deleted', old_value: `${att.clock_in || ''} → ${att.clock_out || ''}`, new_value: '',
            changed_by: by, changed_at: isoNow(), note: 'So mặt sai 3 lần, chủ xác nhận không đúng người — bỏ ca này' }).then(({ error: e }) => { if (e) console.error('[workforce] face reject log', e); });
          // Ca đã bỏ thì dòng chờ duyệt giờ ra của ca đó (nếu có) cũng xong.
          await db.from('attendance_face_reviews').update({ status: 'rejected', decided_by: by, decided_at: isoNow() }).eq('attendance_id', att.id).eq('status', 'pending')
            .then(({ error: e }) => { if (e) console.error('[workforce] face reject others', e); });
        } else if (att) {
          const changed = await editAttendance(att.id, { clock_out: null }, `${by} (so mặt sai 3 lần: không đúng người ra ca)`);
          if (typeof changed !== 'number') return changed;
        }
      }
      const r = await db.from('attendance_face_reviews').update({ status: body.status, decided_by: by, decided_at: isoNow() }).eq('attendance_id', rev.attendance_id).eq('clocked', rev.clocked).eq('status', 'pending');
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'revoke_kiosk') {
      if (!UUID.test(body.id || '')) return fail('Thiếu máy quầy.');
      const r = await db.from('checkin_kiosks').update({ revoked_at: isoNow() }).eq('id', body.id);
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

    // Báo lỗi đồng nghiệp: chủ phạt (số tiền tự định, mặc định theo danh sách lỗi; 0đ = ghi lỗi, định tiền sau) → thành một khoản
    // phạt của người bị báo vào ngày bị báo (như chủ tự ghi; không chép tên hay ghi chú của người báo). Bỏ qua thì không ghi gì.
    if (body.action === 'decide_peer') {
      if (!UUID.test(body.id || '')) return fail('Thiếu lần báo lỗi.');
      const status = body.status === 'approved' ? 'approved' : body.status === 'rejected' ? 'rejected' : null;
      if (!status) return fail('Chọn phạt hay bỏ qua.');
      const { data: rep, error } = await db.from('payroll_peer_reports').select('*').eq('id', body.id).maybeSingle();
      if (missingTable(error)) return fail(PEER_NOT_READY, 503);
      if (error) throw error;
      if (!rep) return fail('Không thấy lần báo lỗi này.', 404);
      if (rep.status !== 'pending') return fail('Lần báo lỗi này đã được xử lý rồi. Tải lại trang.', 409);
      const patch = { status, admin_note: text(body.admin_note) || null, decided_by: user.full_name || null, decided_at: isoNow() };
      let violationId = null;
      if (status === 'approved') {
        const amount = body.amount === undefined || body.amount === null || body.amount === '' ? Number(rep.suggested_amount) || 0 : money(body.amount);
        if (amount === null) return fail('Số tiền phạt không hợp lệ.');
        const day = String(rep.report_date).slice(0, 10);
        // Lương tháng của ngày bị báo đã chốt thì khoản phạt không trừ vào đâu: báo chủ mở chốt người đó trước.
        const { data: closed, error: ce } = await db.from('payroll_closes').select('staff_id').eq('year', Number(day.slice(0, 4))).eq('month', Number(day.slice(5, 7)))
          .eq('staff_id', rep.staff_id).maybeSingle();
        if (ce) throw ce;
        if (closed) return fail(`Lương tháng ${Number(day.slice(5, 7))}/${day.slice(0, 4)} của người này đã chốt. Mở chốt người đó rồi phạt, hoặc ghi phạt tháng này ở mục Vi phạm.`, 409);
        const v = await db.from('payroll_violations').insert({ staff_id: rep.staff_id, amount, reason: rep.reason, month: Number(day.slice(5, 7)), year: Number(day.slice(0, 4)), created_at: isoNow() })
          .select('id').single();
        if (v.error) throw v.error;
        violationId = v.data.id;
        const meta = await db.from('payroll_violation_meta').insert({ violation_id: violationId, staff_id: rep.staff_id, fine_date: day, rule_id: rep.rule_id || null,
          recorded_by: user.full_name || null, created_at: isoNow() });
        if (meta.error) console.error('[workforce] peer fine meta', meta.error);
        Object.assign(patch, { amount, violation_id: violationId });
      }
      const r = await db.from('payroll_peer_reports').update(patch).eq('id', rep.id).eq('status', 'pending').select('id');
      if (r.error || !r.data?.length) {
        if (violationId) {
          await db.from('payroll_violation_meta').delete().eq('violation_id', violationId);
          await db.from('payroll_violations').delete().eq('id', violationId);
        }
        if (r.error) throw r.error;
        return fail('Lần báo lỗi này vừa được xử lý ở máy khác. Tải lại trang.', 409);
      }
      return NextResponse.json({ ok: true, status, violation_id: violationId }, { headers });
    }

    // Duyệt khoản chi hộ: khoản chi vào Sổ thu chi (Chi trong ngày, đúng ngày chi); nhân viên chọn cộng vào lương thì cộng vào
    // lương tháng này (người trả theo kỳ: lần trả kế tiếp), chọn tiền mặt thì chủ đưa tiền ngay lúc duyệt. Từ chối thì không ghi gì.
    if (body.action === 'decide_claim') {
      if (!UUID.test(body.id || '')) return fail('Thiếu khoản chi.');
      const status = body.status === 'approved' ? 'approved' : body.status === 'rejected' ? 'rejected' : null;
      if (!status) return fail('Chọn duyệt hay từ chối.');
      const { data: claim, error } = await db.from('payroll_expense_claims').select('*').eq('id', body.id).maybeSingle();
      if (missingTable(error)) return fail(CLAIMS_NOT_READY, 503);
      if (error) throw error;
      if (!claim) return fail('Không thấy khoản chi này.', 404);
      if (claim.status !== 'pending') return fail('Khoản chi này đã được xử lý rồi. Tải lại trang.', 409);
      const now = vnNow(), patch = { status, admin_note: text(body.admin_note) || null, decided_by: user.full_name || null, decided_at: isoNow() };
      let entryId = null;
      if (status === 'approved') {
        // Chủ đổi sang đưa tiền mặt (vd lương tháng đó đã chốt / đã trả): khoản chi không cộng vào lương nữa.
        if (body.cash === true && claim.payout === 'salary') patch.payout = 'cash';
        const payout = patch.payout || claim.payout;
        patch.year = now.getUTCFullYear(); patch.month = now.getUTCMonth() + 1;
        const { data: who } = await db.from('staff').select('full_name').eq('id', claim.staff_id).maybeSingle();
        const name = who?.full_name || claim.created_by_name || 'nhân viên';
        if (payout === 'salary') {
          // Người đã nghỉ việc trước tháng này: cộng vào lương tháng nghỉ việc (bảng lương các tháng sau không còn người đó).
          const { data: left } = await db.from('staff_departures').select('last_day').eq('staff_id', claim.staff_id).maybeSingle();
          const lastDay = left ? String(left.last_day).slice(0, 10) : null;
          if (lastDay && lastDay < `${patch.year}-${String(patch.month).padStart(2, '0')}-01`) {
            patch.year = Number(lastDay.slice(0, 4)); patch.month = Number(lastDay.slice(5, 7));
          }
          // Lương tháng đó đã chốt thì số đã chốt không có khoản này: không cộng lương được (khoản chi sẽ không bao giờ được trả).
          const { data: closed, error: ce } = await db.from('payroll_closes').select('staff_id').eq('year', patch.year).eq('month', patch.month).eq('staff_id', claim.staff_id).maybeSingle();
          if (ce) throw ce;
          if (closed) return fail(`Lương tháng ${patch.month}/${patch.year} của ${name} đã chốt nên không cộng thêm được. Mở chốt người đó rồi duyệt, hoặc bấm "Đưa tiền mặt".`, 409);
        }
        const entry = await db.from('finance_entries').insert({ entry_date: String(claim.spent_on).slice(0, 10), kind: 'drink', category: null, label: claim.item,
          amount: claim.amount, note: `Chi hộ: ${name} · ${payout === 'cash' ? 'đã đưa tiền mặt' : `cộng vào lương tháng ${patch.month}/${patch.year}`}${claim.note ? ` · ${claim.note}` : ''}`.slice(0, 300),
          created_by_name: user.full_name || null }).select('id').single();
        if (entry.error) throw entry.error;
        entryId = entry.data.id;
        patch.finance_entry_id = entryId;
      }
      const r = await db.from('payroll_expense_claims').update(patch).eq('id', claim.id).eq('status', 'pending').select('id');
      if (r.error || !r.data?.length) {
        if (entryId) await db.from('finance_entries').delete().eq('id', entryId).then(({ error: e }) => { if (e) console.error('[workforce] claim entry undo', e); });
        if (r.error) throw r.error;
        return fail('Khoản chi này vừa được xử lý ở máy khác. Tải lại trang.', 409);
      }
      return NextResponse.json({ ok: true, status, year: patch.year || null, month: patch.month || null }, { headers });
    }

    // Xoá khoản chi hộ ghi nhầm (cả khoản đã duyệt): bỏ luôn dòng trong Sổ thu chi. Khoản cộng lương của tháng đã chốt thì mở chốt
    // người đó trước; người trả theo kỳ đã nhận khoản này thì lần trả sau tự trừ lại.
    if (body.action === 'delete_claim') {
      if (!UUID.test(body.id || '')) return fail('Thiếu khoản chi.');
      const { data: claim, error } = await db.from('payroll_expense_claims').select('*').eq('id', body.id).maybeSingle();
      if (missingTable(error)) return fail(CLAIMS_NOT_READY, 503);
      if (error) throw error;
      if (!claim) return NextResponse.json({ ok: true }, { headers });
      if (claim.status === 'approved' && claim.payout === 'salary' && claim.year && claim.month) {
        const { data: closed, error: ce } = await db.from('payroll_closes').select('staff_id').eq('year', claim.year).eq('month', claim.month).eq('staff_id', claim.staff_id).maybeSingle();
        if (ce) throw ce;
        if (closed) return fail(`Lương tháng ${claim.month}/${claim.year} của người này đã chốt. Mở chốt người đó trước rồi mới xoá khoản chi.`, 409);
      }
      if (claim.finance_entry_id) {
        const d = await db.from('finance_entries').delete().eq('id', claim.finance_entry_id);
        if (d.error) throw d.error;
      }
      const r = await db.from('payroll_expense_claims').delete().eq('id', claim.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'decide_request') {
      if (!UUID.test(body.id || '') || !['approved', 'rejected'].includes(body.status)) return fail('Yêu cầu không hợp lệ.');
      const r = await db.from('payroll_requests').update({ status: body.status, admin_note: text(body.admin_note), updated_at: isoNow() }).eq('id', body.id);
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
      const r = await db.from('payroll_violations').insert({ staff_id: body.staff_id, amount, reason, month, year, created_at: isoNow() }).select('id').single();
      if (r.error) throw r.error;
      if (date) {
        const meta = await db.from('payroll_violation_meta').insert({ violation_id: r.data.id, staff_id: body.staff_id, fine_date: date, rule_id: ruleId, recorded_by: user.full_name || null, created_at: isoNow() });
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
      const claim = await db.from('payroll_fine_reviews').insert({ attendance_id: ses.id, kind, staff_id: ses.staff_id, work_day: day, status, decided_by: by, decided_at: isoNow() });
      if (claim.error) {
        if (claim.error.code === '23505') return fail('Gợi ý này đã được xử lý rồi.', 409);
        throw claim.error;
      }
      if (status === 'skipped') return NextResponse.json({ ok: true }, { headers });
      const rule = ruleRow.data;
      const reason = text(body.reason, 200) || `${rule?.name || (kind === 'late' ? 'Đi trễ' : 'Quên bấm ra ca')} (${ddmm(day)})`;
      const v = await db.from('payroll_violations').insert({ staff_id: ses.staff_id, amount, reason, month: Number(day.slice(5, 7)), year: Number(day.slice(0, 4)), created_at: isoNow() }).select('id').single();
      if (v.error) {
        await db.from('payroll_fine_reviews').delete().eq('attendance_id', ses.id).eq('kind', kind);
        throw v.error;
      }
      const links = await Promise.all([
        db.from('payroll_fine_reviews').update({ violation_id: v.data.id }).eq('attendance_id', ses.id).eq('kind', kind),
        db.from('payroll_violation_meta').insert({ violation_id: v.data.id, staff_id: ses.staff_id, fine_date: day, rule_id: rule?.id || null, attendance_id: ses.id, kind, recorded_by: by, created_at: isoNow() }),
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
      const payload = { name, amount, active: body.active !== false, updated_at: isoNow() };
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
      const row = { bonus_amount: amount, bonus_min_days: minDays, updated_by: user.full_name || null, updated_at: isoNow() };
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
      const row = { amount, note: text(body.note, 200) || null, decided_by: user.full_name || null, decided_at: isoNow() };
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
        pay_day: Math.min(31, Math.max(1, Math.round(Number(body.pay_day) || 5))), updated_at: isoNow() };
      const { data: existing, error } = await db.from('payroll_config').select('id').eq('staff_id', body.staff_id).maybeSingle();
      if (error) throw error;
      const r = existing ? await db.from('payroll_config').update(payload).eq('staff_id', body.staff_id) : await db.from('payroll_config').insert(payload);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    // Ngày quán nghỉ (cả quán đóng cửa): thêm ngày nghỉ, ngày theo lịch âm mà quán mở (skip), bỏ dòng đã ghi.
    // Người được nhận lương ngày nghỉ có đủ 1 ngày công.
    if (['save_closed_day', 'skip_closed_day', 'delete_closed_day'].includes(body.action)) {
      const day = String(body.day || '');
      if (!DATE.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return fail('Chọn ngày quán nghỉ.');
      const row = { day, note: body.action === 'save_closed_day' ? text(body.note, 120) || null : null, skip: body.action === 'skip_closed_day',
        created_by: user.full_name || null, created_at: isoNow() };
      const r = body.action === 'delete_closed_day'
        ? await db.from('shop_closed_days').delete().eq('day', day)
        : await db.from('shop_closed_days').upsert(row, { onConflict: 'day' });
      if (missingTable(r.error) || /skip/.test(String(r.error?.message || ''))) return fail('Web đang cập nhật phần ngày quán nghỉ, thử lại sau ít phút.', 503);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    // Lịch nghỉ theo âm lịch mỗi tháng (vd. mùng 1 và rằm), áp dụng từ hôm nay; danh sách rỗng = thôi nghỉ theo lịch.
    if (body.action === 'save_closed_rule') {
      const days = [...new Set((Array.isArray(body.lunar_days) ? body.lunar_days : []).map(Number))].sort((a, b) => a - b);
      if (days.some(d => !Number.isInteger(d) || d < 1 || d > 30)) return fail('Ngày âm lịch từ 1 đến 30.');
      const r = await db.from('shop_closed_rules').upsert({ valid_from: today, lunar_days: days, updated_by: user.full_name || null, updated_at: isoNow() }, { onConflict: 'valid_from' });
      if (missingTable(r.error)) return fail('Web đang cập nhật phần ngày quán nghỉ, thử lại sau ít phút.', 503);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    // Từng người có nhận lương ngày quán nghỉ không: true / false; null = theo mặc định (lương tháng có, theo giờ không).
    if (body.action === 'save_holiday_pay') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const staffId = String(body.staff_id).toLowerCase();
      const r = body.paid === true || body.paid === false
        ? await db.from('payroll_holiday_pay').upsert({ staff_id: staffId, paid: body.paid, updated_by: user.full_name || null, updated_at: isoNow() }, { onConflict: 'staff_id' })
        : await db.from('payroll_holiday_pay').delete().eq('staff_id', staffId);
      if (missingTable(r.error)) return fail('Web đang cập nhật phần ngày quán nghỉ, thử lại sau ít phút.', 503);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    // Kỳ trả lương của một người: mỗi every_days ngày (vd. 7, 10) tính từ start_day; every_days 0 = thôi, chốt theo tháng như cũ.
    // Sửa số ngày của kỳ giữ nguyên ngày bắt đầu (kỳ đang chạy vẫn tính từ ngày sau lần trả gần nhất).
    if (body.action === 'save_pay_cycle') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const staffId = String(body.staff_id).toLowerCase(), every = Math.round(Number(body.every_days) || 0);
      if (!every) {
        const r = await db.from('payroll_pay_cycles').delete().eq('staff_id', staffId);
        if (missingTable(r.error)) return fail(CYCLE_NOT_READY, 503);
        if (r.error) throw r.error;
        return NextResponse.json({ ok: true }, { headers });
      }
      if (!(every >= 1 && every <= MAX_CYCLE_DAYS)) return fail(`Kỳ trả lương từ 1 tới ${MAX_CYCLE_DAYS} ngày.`);
      const old = await readCycles(db, staffId);
      if (old === null) return fail(CYCLE_NOT_READY, 503);
      const start = DATE.test(body.start_day || '') ? body.start_day : old[0] ? String(old[0].start_day).slice(0, 10) : today;
      if (start < `${DAY_PAY_FROM}-01`) return fail(`Ngày bắt đầu kỳ từ ${ddmm(`${DAY_PAY_FROM}-01`)}/${DAY_PAY_FROM.slice(0, 4)} trở đi.`);
      if (start > addDays(today, MAX_CYCLE_DAYS)) return fail('Ngày bắt đầu kỳ quá xa hôm nay.');
      // Ngày phát cố định: payday_weekday (0 = CN … 6 = T7, kỳ 7 ngày) → thứ đó gần nhất từ hôm nay; payday_anchor: một ngày phát;
      // '' / null = không cố định. Không gửi gì = giữ như đang cài.
      const row = { staff_id: staffId, every_days: every, start_day: start, updated_by: user.full_name || null, updated_at: isoNow() };
      if ('payday_weekday' in body || 'payday_anchor' in body) {
        const wd = body.payday_weekday === '' || body.payday_weekday === null || body.payday_weekday === undefined ? null : Number(body.payday_weekday);
        if (wd !== null) {
          if (!(Number.isInteger(wd) && wd >= 0 && wd <= 6) || every !== 7) return fail('Chọn thứ phát lương cho kỳ 7 ngày.');
          row.payday_anchor = addDays(today, (wd - new Date(`${today}T00:00:00Z`).getUTCDay() + 7) % 7);
        } else if (DATE.test(body.payday_anchor || '')) {
          row.payday_anchor = body.payday_anchor;
        } else {
          row.payday_anchor = null;
        }
      }
      const r = await db.from('payroll_pay_cycles').upsert(row, { onConflict: 'staff_id' });
      if (missingTable(r.error) || /payday_anchor/.test(String(r.error?.message || ''))) return fail(CYCLE_NOT_READY, 503);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    // Đã thanh toán lương kỳ này tới hết ngày to_day: máy chủ tính lại số phải trả (cùng cách trang Lương hiện); khác số trang đang
    // hiện (amount) thì không lưu, bắt tải lại để chủ trả đúng số. Lưu xong, kỳ mới bắt đầu ngày sau to_day.
    if (body.action === 'pay_cycle') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (!DATE.test(body.to_day || '')) return fail('Chọn ngày trả tới.');
      const st = await cycleStates(db, String(body.staff_id).toLowerCase());
      if (!st.ready) return fail(CYCLE_NOT_READY, 503);
      const me = st.people[0];
      if (!me) return fail('Người này chưa cài trả lương theo kỳ.', 409);
      if (body.to_day < me.period.start) return fail(`Kỳ này bắt đầu ngày ${ddmm(me.period.start)}: chọn trả tới từ ngày đó trở đi.`);
      if (body.to_day > today) return fail('Chỉ trả tới hết hôm nay.');
      const due = cycleDueTo(me, body.to_day, me.period.start);
      const vnd = n => `${Number(n).toLocaleString('vi-VN')}đ`;
      if (nothingDue(due)) return fail(`Từ ${ddmm(me.period.start)} tới hết ${ddmm(body.to_day)} chưa có ngày công hay khoản nào để trả (0đ), không cần bấm đã thanh toán.`, 409);
      if (Math.round(Number(body.amount)) !== due.amount) return fail(`Số tiền vừa thay đổi, nay là ${vnd(due.amount)}. Xem lại rồi bấm lại.`, 409);
      if (due.amount < 0) return fail(`Tiền ứng / phạt nhiều hơn tiền công ${vnd(-due.amount)} nên chưa phải trả; lần trả sau sẽ trừ tiếp.`, 409);
      const r = await db.from('payroll_payouts').insert({ staff_id: me.staff_id, from_day: me.period.start, to_day: body.to_day, amount: due.amount, detail: payoutDetail(due),
        paid_at: isoNow(), paid_by: user.full_name || null }).select('id').single();
      if (r.error?.code === '23505') return fail('Kỳ này vừa được bấm đã trả rồi. Tải lại trang.', 409);
      if (missingTable(r.error)) return fail(CYCLE_NOT_READY, 503);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true, id: r.data.id, amount: due.amount }, { headers });
    }

    // Bấm nhầm "Đã thanh toán lương": bỏ lần trả gần nhất của người đó (kỳ quay lại như trước khi bấm).
    if (body.action === 'undo_payout') {
      if (!UUID.test(body.id || '')) return fail('Thiếu lần trả.');
      const { data: row, error } = await db.from('payroll_payouts').select('*').eq('id', body.id).maybeSingle();
      if (missingTable(error)) return fail(CYCLE_NOT_READY, 503);
      if (error) throw error;
      if (!row) return fail('Không thấy lần trả này.', 404);
      if (row.received_at) return fail('Nhân viên đã xác nhận đã nhận lần trả này, không bỏ được.', 409);
      const later = await db.from('payroll_payouts').select('id').eq('staff_id', row.staff_id).gt('to_day', row.to_day);
      if (later.error) throw later.error;
      if (later.data?.length) return fail('Chỉ bỏ được lần trả gần nhất của người này.', 409);
      const r = await db.from('payroll_payouts').delete().eq('id', row.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    // Cho / thôi cho một người chấm công bằng nút tên trên máy quầy (không có điện thoại); tên trên nút + ảnh nhỏ.
    if (body.action === 'save_tap_staff') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const staffId = String(body.staff_id).toLowerCase();
      if (body.enabled === false) {
        const r = await db.from('checkin_tap_staff').delete().eq('staff_id', staffId);
        if (missingTable(r.error)) return fail('Web đang cập nhật phần chấm công bằng nút, thử lại sau ít phút.', 503);
        if (r.error) throw r.error;
        return NextResponse.json({ ok: true }, { headers });
      }
      const row = { staff_id: staffId, label: text(body.label, 30) || null, created_by: user.full_name || null, updated_at: isoNow() };
      if ('photo' in body) {
        const photo = body.photo === null || body.photo === '' ? null : String(body.photo);
        if (photo && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 150000)) return fail('Ảnh không hợp lệ hoặc quá lớn.');
        row.photo = photo;
      }
      const r = await db.from('checkin_tap_staff').upsert(row, { onConflict: 'staff_id' });
      if (missingTable(r.error)) return fail('Web đang cập nhật phần chấm công bằng nút, thử lại sau ít phút.', 503);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'save_late_rule') {
      // Luật đi trễ / về sớm từ ngày valid_from (mặc định hôm nay, sớm nhất ngày 1 tháng này; "từ ngày X" nghĩa là từ X trở đi,
      // các luật đặt sau X của cùng người / quán bị bỏ). scope 'shop' = mặc định cả quán, hoặc một nhân viên (use_shop: quay về
      // theo quán). late_on / early_on = false: được phép đi trễ / về sớm — vẫn ghi lại, không trừ tiền. Không gửi phần về sớm
      // (trang cũ) thì giữ như cũ (cột trống).
      const scope = body.scope === 'shop' ? 'shop' : UUID.test(body.scope || '') ? String(body.scope).toLowerCase() : null;
      if (!scope) return fail('Thiếu nhân viên.');
      const from = DATE.test(body.valid_from || '') ? body.valid_from : today;
      if (from > today || from < `${today.slice(0, 7)}-01`) return fail('Ngày áp dụng từ đầu tháng này tới hôm nay.');
      const allowed = Math.round(Number(body.allowed_minutes)), fixed = money(body.fixed_amount ?? 0);
      const useShop = scope !== 'shop' && body.use_shop === true;
      if (!useShop && (!Number.isFinite(allowed) || allowed < 0 || allowed > 600)) return fail('Số phút cho phép trễ từ 0 đến 600.');
      if (fixed === null || fixed > 10_000_000) return fail('Số tiền trừ mỗi lần trễ không hợp lệ.');
      const row = { scope, valid_from: from, allowed_minutes: useShop ? 0 : allowed, per_minute: !useShop && body.per_minute === true, fixed_amount: useShop ? 0 : fixed,
        use_shop: useShop, updated_by: user.full_name || null, updated_at: isoNow() };
      const withEarly = !useShop && ('late_on' in body || 'early_allowed_minutes' in body);
      if (withEarly) {
        const earlyAllowed = Math.round(Number(body.early_allowed_minutes)), earlyFixed = money(body.early_fixed_amount ?? 0);
        if (!Number.isFinite(earlyAllowed) || earlyAllowed < 0 || earlyAllowed > 600) return fail('Số phút cho phép về sớm từ 0 đến 600.');
        if (earlyFixed === null || earlyFixed > 10_000_000) return fail('Số tiền trừ mỗi lần về sớm không hợp lệ.');
        Object.assign(row, { late_on: body.late_on !== false, early_on: body.early_on !== false, early_allowed_minutes: earlyAllowed, early_per_minute: body.early_per_minute === true,
          early_fixed_amount: earlyFixed });
      }
      // Số tiền trừ mỗi phút trễ / về sớm chủ tự điền (trống = theo lương: lương ngày ÷ số phút của ca). Trang cũ không gửi thì giữ trống.
      if (!useShop && ('minute_amount' in body || 'early_minute_amount' in body)) {
        const perMin = v => (v === null || v === undefined || v === '' ? 0 : money(v));
        const lateMin = perMin(body.minute_amount), earlyMin = perMin(body.early_minute_amount);
        if (lateMin === null || lateMin > 1_000_000 || earlyMin === null || earlyMin > 1_000_000) return fail('Số tiền trừ mỗi phút không hợp lệ.');
        Object.assign(row, { minute_amount: body.per_minute === true && lateMin > 0 ? lateMin : null,
          early_minute_amount: body.early_per_minute === true && earlyMin > 0 ? earlyMin : null });
      }
      const r = await db.from('payroll_late_rules').upsert(row, { onConflict: 'scope,valid_from' });
      if (missingTable(r.error)) return fail('Web đang cập nhật phần luật đi trễ, thử lại sau ít phút.', 503);
      if (r.error && /late_on|early_|minute_amount/.test(String(r.error.message || ''))) return fail('Web đang cập nhật phần luật đi trễ / về sớm, thử lại sau ít phút.', 503);
      if (r.error) throw r.error;
      // Luật đặt sau ngày áp dụng của cùng người / quán: bỏ (luật mới tính từ ngày đó trở đi).
      const later = await db.from('payroll_late_rules').delete().eq('scope', scope).gt('valid_from', from);
      if (later.error) throw later.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'save_hourly') {
      // Trả lương theo giờ (unit 'hour') hoặc theo ngày (unit 'day', hourly_rate = lương 1 ngày) từ ngày valid_from
      // (sớm nhất ngày 1 tháng này); hourly_rate 0 = từ ngày đó trả theo tháng.
      // Mức đặt sau ngày đó bị bỏ: "từ ngày X" nghĩa là từ X trở đi cho tới khi đổi lại.
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const unit = body.unit === 'day' ? 'day' : 'hour';
      const rate = money(body.hourly_rate);
      if (rate === null || rate > 10_000_000) return fail(unit === 'day' ? 'Lương 1 ngày không hợp lệ.' : 'Lương 1 giờ không hợp lệ.');
      const from = DATE.test(body.valid_from || '') ? body.valid_from : today;
      const latest = new Date(Date.parse(`${today}T00:00:00Z`) + 62 * 86400000).toISOString().slice(0, 10);
      if (from < `${today.slice(0, 7)}-01` || from > latest) return fail('Ngày áp dụng từ ngày 1 tháng này đến 2 tháng tới.');
      const row = { staff_id: body.staff_id, valid_from: from, hourly_rate: rate, unit, updated_by: user.full_name || null, updated_at: isoNow() };
      let r = await db.from('payroll_hourly_rates').upsert(row, { onConflict: 'staff_id,valid_from' });
      if (missingTable(r.error) && !/unit/.test(String(r.error.message || ''))) return fail('Web đang cập nhật phần lương theo giờ, thử lại sau ít phút.', 503);
      // DB chưa có cột unit (chưa chạy payroll_daily_rates.sql): theo giờ / theo tháng vẫn lưu được như cũ.
      if (r.error && /unit/.test(String(r.error.message || ''))) {
        if (unit === 'day') return fail('Web đang cập nhật phần lương theo ngày, thử lại sau ít phút.', 503);
        const { unit: _hour, ...old } = row;
        r = await db.from('payroll_hourly_rates').upsert(old, { onConflict: 'staff_id,valid_from' });
      }
      if (r.error) throw r.error;
      const later = await db.from('payroll_hourly_rates').delete().eq('staff_id', body.staff_id).gt('valid_from', from);
      if (later.error) throw later.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'create_account') {
      const fullName = text(body.full_name, 80), phone = text(body.phone, 20);
      const role = normalizeRole(body.role);
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

    // Sửa tên / số điện thoại đăng nhập của một tài khoản (nhân viên, quản lý, admin). Mã PIN không đổi (băm theo mã tài khoản,
    // không theo số điện thoại); lần sau đăng nhập bằng số mới. Số điện thoại không trùng tài khoản khác.
    if (body.action === 'edit_account') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const patch = {};
      if ('full_name' in body) {
        const name = text(body.full_name, 80).replace(/\s+/g, ' ');
        if (!name) return fail('Tên không được để trống.');
        patch.full_name = name;
      }
      if ('phone' in body) {
        const phone = text(body.phone, 20).replace(/\s+/g, '');
        if (!/^\+?\d{8,15}$/.test(phone)) return fail('Số điện thoại gồm 8–15 chữ số.');
        const { data: dup, error } = await db.from('staff').select('id').eq('phone', phone).neq('id', body.staff_id).limit(1);
        if (error) throw error;
        if (dup?.length) return fail('⚠️ Số điện thoại này đã là tài khoản của người khác.', 409);
        patch.phone = phone;
      }
      if (!Object.keys(patch).length) return fail('Không có gì để sửa.');
      const r = await db.from('staff').update(patch).eq('id', body.staff_id).select('id, full_name, phone');
      if (r.error) return fail(String(r.error.message).includes('unique') ? '⚠️ Số điện thoại này đã là tài khoản của người khác.' : 'Không sửa được tài khoản.', 409);
      if (!r.data?.length) return fail('Không tìm thấy nhân viên.', 404);
      return NextResponse.json({ ok: true, staff: r.data[0] }, { headers });
    }

    if (body.action === 'set_role') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      if (body.staff_id === user.id) return fail('Không tự đổi vai trò của tài khoản đang đăng nhập.');
      const r = await db.from('staff').update({ role: normalizeRole(body.role) }).eq('id', body.staff_id).select('id');
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
