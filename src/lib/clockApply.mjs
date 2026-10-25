/**
 * Ghi giờ vào / ra ca sau khi quét mã — dùng chung cho điện thoại nhân viên (api/admin/workforce, khi
 * không cần so mặt) và máy quầy (api/checkin/kiosk, sau khi so mặt). Chỉ phía server.
 */
import { workDayOf } from './attendanceRules.mjs';

const vnDate = iso => new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(0, 10);
const dayBefore = d => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

// Ca mới nhất của một người (kể cả ca hôm qua chưa ra, ví dụ làm qua 12h đêm).
export async function latestSession(db, staffId) {
  const { data, error } = await db.from('attendance_sessions').select('*').eq('staff_id', staffId).order('clock_in', { ascending: false }).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

/**
 * Lúc `at`: đang có ca mở thì ra ca, không thì vào ca; ghi lượt quét (scan: wifi, điện thoại, cảnh báo).
 * review: ca ghi sau 3 lần sai mặt → thêm dòng chờ chủ duyệt (ca đó chưa tính lương).
 */
export async function applyClock(db, { staffId, at, scan = {}, review = null }) {
  const last = await latestSession(db, staffId);
  const open = last && !last.clock_out ? last : null;
  const result = open
    ? await db.from('attendance_sessions').update({ clock_out: at }).eq('id', open.id).select('*').single()
    : await db.from('attendance_sessions').insert({ staff_id: staffId, date: vnDate(at), clock_in: at }).select('*').single();
  if (result.error) throw result.error;
  const clocked = open ? 'out' : 'in';
  if (review) {
    const r = await db.from('attendance_face_reviews').insert({ attendance_id: result.data.id, clocked, staff_id: staffId, check_id: review.checkId || null, status: 'pending', created_at: at });
    if (r.error) throw r.error;
  }
  await db.from('checkin_scans').insert({ ...scan, staff_id: staffId, created_at: at, action: clocked, attendance_id: result.data?.id || null })
    .then(({ error }) => { if (error) console.error('[clock] scan log', error); });
  return { clocked, at, session: result.data };
}

/** Các lượt cùng ngày làm với ca này (vào lại sau nửa đêm để dọn quán thì tính chung ca hôm trước). */
export async function sessionsOfDay(db, staffId, session, settings) {
  const today = vnDate(session.clock_out || session.clock_in);
  const { data, error } = await db.from('attendance_sessions').select('*').eq('staff_id', staffId).gte('date', dayBefore(today)).lte('date', today).order('clock_in');
  if (error) throw error;
  const day = workDayOf(session, settings);
  return (data || []).filter(x => workDayOf(x, settings) === day);
}
