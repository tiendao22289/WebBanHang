/**
 * /api/checkin/kiosk — máy quầy chấm công (trang /chamcong).
 *
 * GET  ?t=<mã đang hiện>  → mã QR để hiện. Giữ mã cũ nếu còn mới (dưới 30 giây)
 *                           và chưa ai dùng; không thì tạo mã mới và báo ai vừa chấm.
 *                           Mỗi lần hỏi, máy chủ ghi lại địa chỉ wifi của quán.
 * POST {action: 'activate', name} → admin biến máy đang mở thành máy quầy. Máy này
 *                           bị đăng xuất tài khoản admin, chỉ còn xem được mã QR.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, statusDatabase, staffDatabase } from '@/lib/statusAuth';
import { STATUS_COOKIE } from '@/lib/statusSession.mjs';
import { CHECKIN_SHOW_MS, KIOSK_COOKIE, KIOSK_COOKIE_SECONDS, kioskQrToken, readKioskCookie, readKioskQrToken, signKioskCookie } from '@/lib/checkinToken.mjs';
import { clientIp, closeForgottenSessions, readCheckinSettings, rememberIp } from '@/lib/attendanceRules.mjs';
import { clockStatus, nowMs, refreshClock } from '@/lib/trueTime.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const fail = (error, status = 400, extra = {}) => NextResponse.json({ error, ...extra }, { status, headers });
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const secure = request => request.headers?.get?.('x-forwarded-proto') === 'https' || String(request.url || '').startsWith('https:');

// Máy quầy hỏi mỗi vài giây; đóng ca quên ra ca tối đa 5 phút một lần.
let lastSweep = 0;

export async function GET(request) {
  try {
    // Mã QR, giờ vào / ra theo giờ internet (đồng hồ máy tính ở quán có thể sai).
    await refreshClock();
    const kioskId = readKioskCookie(request.cookies?.get?.(KIOSK_COOKIE)?.value, secret(), nowMs());
    if (!kioskId) return fail('Máy này chưa được bật làm máy quầy.', 401, { kiosk: false });
    const db = statusDatabase();
    const { data: kiosk, error } = await db.from('checkin_kiosks').select('*').eq('id', kioskId).maybeSingle();
    if (error) throw error;
    if (!kiosk || kiosk.revoked_at) return fail('Máy quầy này đã bị tắt trong trang Lương.', 401, { kiosk: false });

    const now = nowMs();
    const ip = clientIp(request.headers);
    const known = (kiosk.recent_ips || []).find(x => x.ip === ip);
    if (!known || now - Date.parse(known.at) > 60000 || !kiosk.last_seen_at || now - Date.parse(kiosk.last_seen_at) > 60000) {
      const r = await db.from('checkin_kiosks').update({ recent_ips: rememberIp(kiosk.recent_ips, ip, now), last_seen_at: new Date(now).toISOString() }).eq('id', kiosk.id);
      if (r.error) console.error('[kiosk] remember ip', r.error);
    }
    if (now - lastSweep > 5 * 60000) {
      lastSweep = now;
      readCheckinSettings(db).then(s => closeForgottenSessions(db, s, null, nowMs())).catch(e => console.error('[kiosk] auto close', e));
    }

    const shown = readKioskQrToken(new URL(request.url).searchParams.get('t'), secret(), now);
    let lastScan = null, keep = false;
    if (shown && shown.kioskId === kiosk.id) {
      const { data: used, error: e } = await db.from('checkin_nonces').select('nonce, staff_id').eq('nonce', shown.nonce).maybeSingle();
      if (e) throw e;
      if (used) {
        const [{ data: person }, { data: scans }] = await Promise.all([
          db.from('staff').select('full_name').eq('id', used.staff_id).maybeSingle(),
          db.from('checkin_scans').select('action, created_at').eq('nonce', shown.nonce).limit(1),
        ]);
        lastScan = { name: person?.full_name || 'Nhân viên', action: scans?.[0]?.action || null, at: scans?.[0]?.created_at || new Date(now).toISOString() };
      } else keep = shown.ageMs < CHECKIN_SHOW_MS;
    }
    const token = keep ? new URL(request.url).searchParams.get('t') : kioskQrToken(secret(), kiosk.id, now);
    const age = keep ? shown.ageMs : 0;
    // computerClockMs: đồng hồ máy tính chạy web lệch bao nhiêu so với internet (máy quầy báo chủ chỉnh giờ máy).
    const clock = clockStatus();
    return NextResponse.json({ token, name: kiosk.name, refreshInMs: Math.max(1000, CHECKIN_SHOW_MS - age), lastScan, serverTime: new Date(now).toISOString(),
      computerClockMs: clock.synced ? -clock.offsetMs : null }, { headers });
  } catch (error) {
    console.error('[kiosk] GET', error);
    return fail('Không tải được mã, đang thử lại…', 500);
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action !== 'activate') return fail('Thao tác không hợp lệ.');
    await refreshClock();
    const s = await getStaffSession(request);
    if (s.code !== 200) return fail('Cần admin đăng nhập để bật máy quầy.', s.code === 503 ? 503 : 401);
    if (s.user.role !== 'admin') return fail('Chỉ admin bật được máy quầy.', 403);
    const name = String(body.name ?? '').trim().slice(0, 60) || 'Máy quầy';
    const db = staffDatabase(s.user.id);
    const { data: kiosk, error } = await db.from('checkin_kiosks')
      .insert({ name, created_by: s.user.id, recent_ips: rememberIp([], clientIp(request.headers), nowMs()), last_seen_at: new Date(nowMs()).toISOString(), created_at: new Date(nowMs()).toISOString() }).select('*').single();
    if (error) throw error;
    const response = NextResponse.json({ ok: true, name: kiosk.name }, { headers });
    response.cookies.set(KIOSK_COOKIE, signKioskCookie(kiosk.id, secret(), nowMs()), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: KIOSK_COOKIE_SECONDS, secure: secure(request) });
    // Máy quầy để ở quầy cho mọi người thấy: không giữ đăng nhập admin trên máy này.
    response.cookies.set(STATUS_COOKIE, '', { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 0 });
    return response;
  } catch (error) {
    console.error('[kiosk] POST', error);
    return fail('Không bật được máy quầy, thử lại.', 500);
  }
}
