/**
 * Luật chấm công dùng chung cho máy chủ, trang Lương, báo cáo Zalo và test:
 * cùng wifi với máy quầy, giờ làm (chung hoặc riêng từng người), chỉ tính
 * lương trong ca, tự đóng ca khi quên ra ca, chặn bấm hai lần liền.
 */

export const NETWORK_WINDOW_MS = 15 * 60 * 1000;
export const FORGOT_GRACE_MS = 2 * 3600 * 1000;
export const MIN_TOGGLE_MS = 3 * 60 * 1000;
export const AUTO_CLOSE_BY = 'Máy tự đóng (quên ra ca)';

export const WARNING_TEXT = {
  other_network: 'không dùng wifi quán',
  unknown_device: 'chấm bằng máy lạ',
  shared_device: 'máy này đã đăng ký cho người khác',
  admin_no_qr: 'admin chấm không quét mã',
};

/** Địa chỉ mạng của người gửi (qua Cloudflare Tunnel là địa chỉ thật). */
export function clientIp(headers) {
  const raw = headers?.get?.('cf-connecting-ip') || headers?.get?.('x-forwarded-for')?.split(',')[0] || 'local';
  return String(raw).trim().replace(/^::ffff:(?=\d+\.)/i, '').slice(0, 60);
}

function expandV6(ip) {
  const [head, tail] = ip.toLowerCase().split('::');
  const a = head ? head.split(':') : [], b = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - a.length - b.length)).fill('0');
  return [...a, ...fill, ...b].map(x => x.padStart(4, '0'));
}

/** Cùng một mạng: IPv4 trùng hẳn, IPv6 trùng dải /64 (mỗi máy trong nhà một địa chỉ riêng). */
export function sameNetwork(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (!a.includes(':') || !b.includes(':')) return false;
  return expandV6(a).slice(0, 4).join(':') === expandV6(b).slice(0, 4).join(':');
}

/** Ghi lại địa chỉ máy quầy vừa dùng, giữ tối đa 6 địa chỉ trong 30 phút gần nhất. */
export function rememberIp(list, ip, now = Date.now()) {
  const fresh = (Array.isArray(list) ? list : []).filter(x => x?.ip && x.ip !== ip && now - Date.parse(x.at) < 2 * NETWORK_WINDOW_MS);
  return [{ ip, at: new Date(now).toISOString() }, ...fresh].slice(0, 6);
}

/** Điện thoại có cùng wifi với máy quầy (máy quầy mở trong 15 phút gần đây) không. */
export function onKioskNetwork(ip, kiosk, now = Date.now()) {
  return (kiosk?.recent_ips || []).some(x => now - Date.parse(x.at) < NETWORK_WINDOW_MS && sameNetwork(ip, x.ip));
}

export const validTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const HOUR = 3600000;

const DEFAULT_HOURS = { opening: '14:00', closing: '23:00', grace: 10 };
const dayOf = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
const addDays = (date, n) => { const [y, m, d] = String(date).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

/**
 * Cài đặt chấm công đã chuẩn hoá. Giờ quán và ca riêng có ngày áp dụng: đổi giờ chỉ
 * áp dụng từ hôm đó, ngày cũ giữ giờ cũ. Chưa cài thì giờ quán 14:00–23:00 và chưa
 * tính giờ theo ca.
 */
export function normalizeRules(row, shiftRows = [], hoursRows = []) {
  const hours = (hoursRows || []).filter(r => dayOf(r.valid_from) && validTime(r.opening_time) && validTime(r.closing_time))
    .map(r => ({ from: dayOf(r.valid_from), opening: r.opening_time, closing: r.closing_time, grace: Number.isInteger(r.grace_minutes) ? r.grace_minutes : DEFAULT_HOURS.grace }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const shifts = {};
  for (const r of shiftRows || []) {
    if (!dayOf(r.valid_from)) continue;
    const own = validTime(r.start_time) && validTime(r.end_time);
    (shifts[r.staff_id] ||= []).push({ from: dayOf(r.valid_from), start: own ? r.start_time : null, end: own ? r.end_time : null });
  }
  for (const list of Object.values(shifts)) list.sort((a, b) => a.from.localeCompare(b.from));
  return { enforce: !!row?.enforce, hours_from: dayOf(row?.hours_from) || '9999-12-31', hours, shifts };
}

export async function readCheckinSettings(db) {
  const [settings, shifts, hours] = await Promise.all([
    db.from('checkin_settings').select('*').eq('id', 1).maybeSingle(),
    db.from('staff_shifts').select('*'),
    db.from('checkin_hours').select('*'),
  ]);
  for (const r of [settings, shifts, hours]) if (r.error) throw r.error;
  return normalizeRules(settings.data, shifts.data, hours.data);
}

const latestFrom = (list, date) => { let found = null; for (const x of Array.isArray(list) ? list : []) if (x.from <= date) found = x; return found; };

/** Giờ quán áp dụng cho ngày `date`: { opening, closing, grace }. */
export function hoursOn(rules, date) {
  const h = latestFrom(rules?.hours, String(date));
  return h ? { opening: h.opening, closing: h.closing, grace: h.grace } : { ...DEFAULT_HOURS };
}

/** Ca của một người ngày `date`: ca riêng nếu chủ đã đặt, không thì giờ quán. */
export function shiftOf(rules, staffId, date) {
  const own = latestFrom(rules?.shifts?.[staffId], String(date));
  if (own?.start) return { start: own.start, end: own.end, own: true };
  const h = hoursOn(rules, date);
  return { start: h.opening, end: h.closing, own: false };
}

/** Khung ca của ngày làm `date` (giờ Việt Nam). Giờ hết ca trước giờ vào ca nghĩa là sau nửa đêm. */
export function shiftWindow(date, start, end) {
  const [y, m, d] = String(date).split('-').map(Number);
  const s = validTime(start) ? start : '14:00', e = validTime(end) ? end : '23:00';
  const at = (t, plusDays) => { const [hh, mm] = t.split(':').map(Number); return new Date(Date.UTC(y, m - 1, d + plusDays, hh - 7, mm)); };
  return { start: at(s, 0), end: at(e, e <= s ? 1 : 0) };
}

// Khung ca của một lượt chấm. Lượt bắt đầu sau nửa đêm (ra rồi vào lại để dọn quán)
// vẫn thuộc ca hôm trước. Mỗi ngày dùng giờ làm của chính ngày đó.
function windowFor(session, rules) {
  const at = date => {
    const shift = shiftOf(rules, session.staff_id, date);
    return { ...shiftWindow(date, shift.start, shift.end), grace: hoursOn(rules, date).grace * 60000, date };
  };
  const today = at(session.date), prev = at(addDays(session.date, -1));
  const s = Date.parse(session.clock_in);
  return s < today.start.getTime() && s <= prev.end.getTime() + 4 * HOUR ? prev : today;
}

/**
 * Ngày làm (ngày của ca) của một lượt chấm: lượt ra rồi vào lại sau nửa đêm để dọn quán
 * thuộc ca hôm trước, không phải một ngày công mới. Chưa có giờ làm thì theo ngày ghi.
 */
export const workDayOf = (session, rules) => (rules && session?.clock_in ? windowFor(session, rules).date : String(session.date));

/** Nhóm các lượt chấm theo ngày làm, mỗi nhóm xếp theo giờ vào (đủ lượt của ngày làm mới tính trễ / sớm đúng). */
export function groupByWorkDay(sessions, rules) {
  const days = new Map();
  for (const s of sessions || []) {
    const day = workDayOf(s, rules);
    days.set(day, [...(days.get(day) || []), s]);
  }
  for (const list of days.values()) list.sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
  return days;
}

/** Ngày làm đang diễn ra lúc `now` của một người: dọn quán sau nửa đêm vẫn là ca hôm trước. */
export const currentWorkDay = (rules, staffId, now = Date.now()) =>
  workDayOf({ staff_id: staffId, date: new Date(now + 7 * HOUR).toISOString().slice(0, 10), clock_in: new Date(now).toISOString() }, rules);

/**
 * Giờ công của một ca đã ra ca. Từ ngày `hours_from`: chỉ tính trong ca (vào trễ /
 * về sớm trong số phút cho lệch vẫn tính đủ); vào sớm / ở lại quá số phút đó là
 * giờ ngoài ca, chỉ tính khi chủ cho (`review`). Ngày trước đó tính cả ca như cũ.
 */
export function sessionHours(session, rules, review = null) {
  const out = { totalMs: 0, countedMs: 0, earlyMs: 0, stayMs: 0, pendingMs: 0, approvedMs: 0, byShift: false };
  const s = Date.parse(session?.clock_in), e = Date.parse(session?.clock_out);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return out;
  out.totalMs = e - s;
  if (!rules || !(String(session.date) >= rules.hours_from)) { out.countedMs = out.totalMs; return out; }
  out.byShift = true;
  const w = windowFor(session, rules);
  const ws = w.start.getTime(), we = w.end.getTime(), grace = w.grace;
  let cs = Math.max(s, ws); if (cs - ws <= grace) cs = ws;
  let ce = Math.min(e, we); if (we - ce <= grace) ce = we;
  const inShift = Math.max(0, ce - cs);
  out.earlyMs = s < ws - grace ? Math.max(0, Math.min(e, ws) - s) : 0;
  out.stayMs = e > we + grace ? Math.max(0, e - Math.max(s, we)) : 0;
  const outside = out.earlyMs + out.stayMs;
  if (review?.status === 'approved') out.approvedMs = Math.min(outside, Math.max(0, Number(review.minutes) || 0) * 60000);
  else if (!review) out.pendingMs = outside;
  out.countedMs = inShift + out.approvedMs;
  return out;
}

/** Vào trễ / vào sớm / về sớm / ở lại (phút, chỉ khi quá số phút cho lệch) của một người trong một ngày. */
export function dayFlags(sessions, rules) {
  const flags = { late: 0, early: 0, leftEarly: 0, stayed: 0 };
  const list = [...(sessions || [])].filter(x => x.clock_in).sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
  if (!list.length || !rules || !(String(list[0].date) >= rules.hours_from)) return flags;
  // Làm tròn xuống: quét lúc 16:59:40 với ca 14:00 là trễ 2 giờ 59 phút, khớp giờ hiện trên màn hình.
  const minutes = ms => Math.floor(ms / 60000);
  const first = list[0], last = list[list.length - 1];
  const w1 = windowFor(first, rules), s = Date.parse(first.clock_in);
  if (s > w1.start.getTime() + w1.grace) flags.late = minutes(s - w1.start.getTime());
  if (s < w1.start.getTime() - w1.grace) flags.early = minutes(w1.start.getTime() - s);
  if (last.clock_out) {
    const w2 = windowFor(last, rules), e = Date.parse(last.clock_out);
    if (e < w2.end.getTime() - w2.grace) flags.leftEarly = minutes(w2.end.getTime() - e);
    // Ở lại = số phút có mặt sau giờ hết ca của các lượt (về rồi quay lại dọn quán thì không tính lúc vắng), khớp giờ ngoài ca chờ duyệt.
    flags.stayed = minutes(list.reduce((a, x) => a + sessionHours(x, rules).stayMs, 0));
  }
  return flags;
}

/** "45 phút", "1 giờ 35 phút". */
export function durationText(min) {
  const m = Math.max(0, Math.round(Number(min) || 0)), h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} giờ${r ? ` ${r} phút` : ''}` : `${r} phút`;
}

export const flagTexts = f => [
  f.late && `trễ ${durationText(f.late)}`,
  f.early && `vào sớm ${durationText(f.early)}`,
  f.leftEarly && `về sớm ${durationText(f.leftEarly)}`,
  f.stayed && `ở lại ${durationText(f.stayed)}`,
].filter(Boolean);

/**
 * Ca còn mở quá giờ hết ca (và giờ đóng quán) 2 tiếng → coi là quên ra ca, trả về giờ
 * ra ca máy tự ghi: giờ hết ca của người đó, hoặc giờ vào nếu vào sau giờ đó. Không thì null.
 */
export function forgottenClockOut(session, rules, now = Date.now()) {
  if (!session || session.clock_out || !session.clock_in || !session.date) return null;
  const w = windowFor(session, rules), shop = hoursOn(rules, session.date);
  const shopEnd = shiftWindow(session.date, shop.opening, shop.closing).end.getTime();
  const closeAt = Math.max(w.end.getTime(), Date.parse(session.clock_in));
  return now >= Math.max(closeAt, shopEnd) + FORGOT_GRACE_MS ? new Date(closeAt) : null;
}

/** Đóng các ca quên ra ca (của một người, hoặc mọi người) và ghi vào nhật ký sửa giờ. */
export async function closeForgottenSessions(db, rules, staffId = null, now = Date.now()) {
  let query = db.from('attendance_sessions').select('*').is('clock_out', null);
  if (staffId) query = query.eq('staff_id', staffId);
  const { data, error } = await query;
  if (error) throw error;
  let closed = 0;
  for (const s of data || []) {
    const out = forgottenClockOut(s, rules, now);
    if (!out) continue;
    const value = out.toISOString();
    const r = await db.from('attendance_sessions').update({ clock_out: value }).eq('id', s.id).is('clock_out', null);
    if (r.error) throw r.error;
    // Bảng ca không có cột ghi chú: dấu "quên ra ca" nằm ở nhật ký sửa giờ (changed_by = AUTO_CLOSE_BY).
    const log = await db.from('attendance_changes').insert({ attendance_id: s.id, staff_id: s.staff_id, field_name: 'clock_out', old_value: '', new_value: value,
      changed_by: AUTO_CLOSE_BY, changed_at: new Date(now).toISOString(), note: `Quên ra ca — máy tự tính ra ca lúc ${hhmm(value)}` });
    if (log.error) console.error('[attendance] auto close log', log.error);
    closed += 1;
  }
  return closed;
}

/** Mã các ca máy tự đóng vì quên ra ca (theo nhật ký sửa giờ), của một người hoặc trong danh sách ca. */
export async function autoClosedIds(db, { staffId, ids } = {}) {
  if (ids && !ids.length) return [];
  let query = db.from('attendance_changes').select('attendance_id').eq('changed_by', AUTO_CLOSE_BY);
  if (staffId) query = query.eq('staff_id', staffId);
  if (ids) query = query.in('attendance_id', ids);
  const { data, error } = await query.limit(500);
  if (error) throw error;
  return [...new Set((data || []).map(r => r.attendance_id))];
}

export const hhmm = iso => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(11, 16);
