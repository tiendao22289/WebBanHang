/**
 * /api/checkin/kiosk — máy quầy chấm công (trang /chamcong).
 *
 * GET  ?t=<mã đang hiện>  → mã QR để hiện. Giữ mã cũ nếu còn mới (dưới 30 giây)
 *      [&app=<phiên bản>]   và chưa ai dùng; không thì tạo mã mới và báo ai vừa chấm.
 *                           lastFail: lượt quét bị chặn ở máy này trong 15 giây qua.
 *                           Mỗi lần hỏi, máy chủ ghi lại địa chỉ wifi của quán.
 *                           app: máy quầy là app iPhone (so mặt được) → faceCheck: lượt quét
 *                           đang chờ máy này so mặt.
 * POST {action: 'activate', name} → admin biến máy đang mở thành máy quầy. Máy này
 *                           bị đăng xuất tài khoản admin, chỉ còn xem được mã QR.
 * POST {action: 'face_verify', id, embeddings | reason} → app gửi dấu mặt vừa chụp (hoặc lý do không
 *                           so được): đúng mặt → ghi giờ; sai → lượt đó không tính; sai 3 lần liền →
 *                           ghi giờ, ca chờ chủ duyệt.
 * GET  ?tap=1            → người được chấm công bằng nút (không có điện thoại): tên trên nút + ảnh.
 *                           Mỗi lần hỏi mã, máy chủ đưa thêm tap {version, open}: danh sách đổi thì tải lại,
 *                           ai đang trong ca (nút hiện "Ra ca").
 * POST {action: 'tap_clock', staff_id, expect} → bấm nút tên trên máy quầy = quét mã thành công (chỉ người chủ
 *                           đã cho dùng nút). expect 'in' | 'out': máy quầy đang hiện vào hay ra, khác thì báo bấm lại.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, statusDatabase, staffDatabase } from '@/lib/statusAuth';
import { STATUS_COOKIE } from '@/lib/statusSession.mjs';
import { CHECKIN_SHOW_MS, KIOSK_COOKIE, KIOSK_COOKIE_SECONDS, kioskQrToken, readKioskCookie, readKioskQrToken, signKioskCookie } from '@/lib/checkinToken.mjs';
import { MIN_TOGGLE_MS, clientIp, closeForgottenSessions, hhmm, onKioskNetwork, readCheckinSettings, rememberIp } from '@/lib/attendanceRules.mjs';
import { clockStatus, nowMs, refreshClock } from '@/lib/trueTime.mjs';
import { applyClock, latestSession, sessionsOfDay } from '@/lib/clockApply.mjs';
import { punctuality } from '@/lib/clockMessages.mjs';
import { FACE_MISS_TEXT, FACE_STREAK_MS, FACE_TRIES, FACE_WAIT_MS, bestScore, faceOutcome, faceThreshold, faceVector, faceVectors, missingTable, readFaceSettings, wrongStreak } from '@/lib/faceCheck.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const fail = (error, status = 400, extra = {}) => NextResponse.json({ error, ...extra }, { status, headers });
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const secure = request => request.headers?.get?.('x-forwarded-proto') === 'https' || String(request.url || '').startsWith('https:');

// Máy quầy hỏi mỗi vài giây; đóng ca quên ra ca tối đa 5 phút một lần.
let lastSweep = 0;
const FAIL_SHOW_MS = 15000;
// App máy quầy: ghi "đang chạy app" tối đa 30 giây một lần cho mỗi máy.
const appSeen = new Map();
const APP_NOTE_MS = 30000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
// Lúc máy chủ web khởi động (mỗi lần đưa bản mới lên đều khởi động lại): máy quầy thấy đổi thì tự tải lại trang
// để có giao diện mới (app iPhone ở quầy giữ trang đã mở rất lâu).
const SERVER_BOOT = String(Date.now());
const vnToday = () => new Date(nowMs() + 7 * 3600000).toISOString().slice(0, 10);

// Người được chấm công bằng nút, trừ người đã nghỉ việc (ngày làm cuối đã qua). Bảng chưa tạo: chưa có ai.
// columns: lúc máy quầy hỏi mã (2,5 giây một lần) chỉ lấy mã + giờ sửa, không kéo theo ảnh.
async function tapPeople(db, columns = '*') {
  const [{ data: rows, error }, { data: left, error: le }] = await Promise.all([
    db.from('checkin_tap_staff').select(columns),
    db.from('staff_departures').select('staff_id, last_day'),
  ]);
  if (missingTable(error)) return [];
  if (error) throw error;
  if (le) throw le;
  const gone = new Set((left || []).filter(d => String(d.last_day) < vnToday()).map(d => d.staff_id));
  return (rows || []).filter(r => !gone.has(r.staff_id));
}

// Máy quầy hỏi mã: version (đổi khi chủ thêm / bớt / sửa nút → tải lại danh sách kèm ảnh) + ai đang trong ca.
async function tapState(db) {
  const people = await tapPeople(db, 'staff_id, updated_at');
  if (!people.length) return { version: '0', open: [] };
  const { data: open, error } = await db.from('attendance_sessions').select('staff_id').in('staff_id', people.map(p => p.staff_id)).is('clock_out', null);
  if (error) throw error;
  const latest = people.map(p => String(p.updated_at || '')).sort().pop();
  return { version: `${people.length}:${latest}`, open: [...new Set((open || []).map(o => o.staff_id))] };
}

// Máy quầy hợp lệ (cookie máy quầy, chưa bị tắt) → dòng máy quầy, không thì null.
async function activeKiosk(request, db) {
  const kioskId = readKioskCookie(request.cookies?.get?.(KIOSK_COOKIE)?.value, secret(), nowMs());
  if (!kioskId) return null;
  const { data: kiosk, error } = await db.from('checkin_kiosks').select('id, revoked_at, recent_ips').eq('id', kioskId).maybeSingle();
  if (error) throw error;
  return kiosk && !kiosk.revoked_at ? kiosk : null;
}

export async function GET(request) {
  try {
    // Mã QR, giờ vào / ra theo giờ internet (đồng hồ máy tính ở quán có thể sai).
    await refreshClock();
    if (new URL(request.url).searchParams.get('tap')) return await tapList(request);
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
        const [{ data: person }, { data: scans }, { data: faces }] = await Promise.all([
          db.from('staff').select('full_name').eq('id', used.staff_id).maybeSingle(),
          db.from('checkin_scans').select('action, created_at').eq('nonce', shown.nonce).limit(1),
          db.from('checkin_face_checks').select('id').eq('nonce', shown.nonce).limit(1),
        ]);
        // Lượt quét đang chờ so mặt: chưa ghi giờ, máy quầy báo khi so xong (faceCheck), không báo "đã chấm".
        if (scans?.[0] || !faces?.[0]) lastScan = { name: person?.full_name || 'Nhân viên', action: scans?.[0]?.action || null, at: scans?.[0]?.created_at || new Date(now).toISOString() };
      } else keep = shown.ageMs < CHECKIN_SHOW_MS;
    }
    // Lượt quét mã của máy này vừa bị chặn (đang bật chặn thật: khác wifi / máy lạ) → máy quầy báo "chưa thành công".
    let lastFail = null;
    const { data: blocked, error: be } = await db.from('checkin_scans').select('id, staff_id, warnings, created_at')
      .eq('kiosk_id', kiosk.id).eq('action', 'blocked').gte('created_at', new Date(now - FAIL_SHOW_MS).toISOString())
      .order('created_at', { ascending: false }).limit(1);
    if (be) throw be;
    if (blocked?.[0]) {
      const { data: person } = await db.from('staff').select('full_name').eq('id', blocked[0].staff_id).maybeSingle();
      lastFail = { id: blocked[0].id, name: person?.full_name || 'Nhân viên', reason: (blocked[0].warnings || [])[0] || null, at: blocked[0].created_at };
    }
    // App máy quầy (so mặt được): ghi lại máy này đang chạy app; đưa lượt quét đang chờ so mặt.
    let faceCheck = null;
    const app = String(new URL(request.url).searchParams.get('app') || '').slice(0, 20);
    // Lỗi phần so mặt (vd. bảng chưa tạo) không làm máy quầy mất mã QR.
    if (app) faceCheck = await kioskFaceCheck(db, kiosk.id, app, now).catch(e => { console.error('[kiosk] face', e); return null; });
    const token = keep ? new URL(request.url).searchParams.get('t') : kioskQrToken(secret(), kiosk.id, now);
    const age = keep ? shown.ageMs : 0;
    // computerClockMs: đồng hồ máy tính chạy web lệch bao nhiêu so với internet (máy quầy báo chủ chỉnh giờ máy).
    const clock = clockStatus();
    // Nút chấm công cho người không có điện thoại (lỗi phần này không làm máy quầy mất mã QR).
    const tap = await tapState(db).catch(e => { console.error('[kiosk] tap', e); return null; });
    return NextResponse.json({ token, name: kiosk.name, refreshInMs: Math.max(1000, CHECKIN_SHOW_MS - age), lastScan, lastFail, faceCheck, tap, boot: SERVER_BOOT, serverTime: new Date(now).toISOString(),
      computerClockMs: clock.synced ? -clock.offsetMs : null }, { headers });
  } catch (error) {
    console.error('[kiosk] GET', error);
    return fail('Không tải được mã, đang thử lại…', 500);
  }
}

// Máy quầy là app: ghi lại máy đang chạy app (30 giây một lần), lượt chờ quá 1 phút thì hết giờ,
// đưa lượt quét mới nhất đang chờ máy này so mặt.
async function kioskFaceCheck(db, kioskId, version, now) {
  if (now - (appSeen.get(kioskId) || 0) > APP_NOTE_MS) {
    appSeen.set(kioskId, now);
    const row = { version, seen_at: new Date(now).toISOString() };
    const r = await db.from('checkin_kiosk_apps').update(row).eq('kiosk_id', kioskId).select('kiosk_id');
    if (r.error) throw r.error;
    if (!r.data?.length) {
      const ins = await db.from('checkin_kiosk_apps').insert({ kiosk_id: kioskId, ...row });
      if (ins.error) throw ins.error;
    }
  }
  const expired = await db.from('checkin_face_checks').update({ status: 'expired', reason: 'timeout', decided_at: new Date(now).toISOString() })
    .eq('kiosk_id', kioskId).eq('status', 'waiting').lt('created_at', new Date(now - FACE_WAIT_MS).toISOString());
  if (expired.error) throw expired.error;
  const { data: waiting, error } = await db.from('checkin_face_checks').select('id, staff_id, clocked, created_at').eq('kiosk_id', kioskId).eq('status', 'waiting')
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  if (!waiting?.[0]) return null;
  const { data: person } = await db.from('staff').select('full_name').eq('id', waiting[0].staff_id).maybeSingle();
  return { id: waiting[0].id, name: person?.full_name || 'Nhân viên', clocked: waiting[0].clocked, at: waiting[0].created_at };
}

export async function POST(request) {
  let action = '';
  try {
    const body = await request.json().catch(() => ({}));
    action = body.action;
    if (body.action === 'face_verify') return await faceVerify(request, body);
    if (body.action === 'tap_clock') return await tapClock(request, body);
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
    return fail(action === 'face_verify' ? 'Không so được mặt, quét lại mã.' : action === 'tap_clock' ? 'Chưa chấm công được, bấm lại.' : 'Không bật được máy quầy, thử lại.', 500);
  }
}

// App máy quầy so mặt xong một lượt quét: đúng mặt → ghi giờ; sai → lượt đó không tính; sai 3 lần liền
// (trong 1 giờ, chưa có lần đúng xen giữa) → vẫn ghi giờ nhưng ca chờ chủ duyệt, chưa tính lương.
async function faceVerify(request, body) {
  await refreshClock();
  const kioskId = readKioskCookie(request.cookies?.get?.(KIOSK_COOKIE)?.value, secret(), nowMs());
  if (!kioskId) return fail('Máy này chưa được bật làm máy quầy.', 401, { kiosk: false });
  const db = statusDatabase();
  const { data: c, error } = await db.from('checkin_face_checks').select('*').eq('id', String(body.id || '')).eq('kiosk_id', kioskId).maybeSingle();
  if (error) throw error;
  if (!c) return fail('Không tìm thấy lượt quét.', 404);
  const { data: person } = await db.from('staff').select('full_name').eq('id', c.staff_id).maybeSingle();
  const reply = (result, extra = {}) => NextResponse.json({ result, name: person?.full_name || 'Nhân viên', clocked: c.clocked, ...extra }, { headers });
  if (c.status !== 'waiting') return reply(c.status === 'cancelled' ? 'expired' : c.status, { done: true });

  const now = nowMs();
  // Chỉ một lần so được tính cho mỗi lượt quét (hai yêu cầu cùng lúc thì yêu cầu sau thua).
  const finish = async (status, fields = {}) => {
    const r = await db.from('checkin_face_checks').update({ status, decided_at: new Date(now).toISOString(), ...fields }).eq('id', c.id).eq('status', 'waiting').select('id');
    if (r.error) throw r.error;
    return (r.data || []).length > 0;
  };
  const miss = FACE_MISS_TEXT[body.reason] ? body.reason : null;
  if (miss || now - Date.parse(c.created_at) > FACE_WAIT_MS + 5000) {
    const reason = miss || 'timeout';
    await finish('expired', { reason });
    return reply('expired', { reason });
  }
  const probes = faceVectors(body.embeddings, 1, 3);
  if (!probes) return fail('Dấu mặt không hợp lệ.');

  const [{ data: tpl, error: te }, settings, { data: recent, error: re }] = await Promise.all([
    db.from('staff_face_templates').select('*').eq('staff_id', c.staff_id).maybeSingle(),
    readFaceSettings(db),
    db.from('checkin_face_checks').select('id, status, created_at').eq('staff_id', c.staff_id).gte('created_at', new Date(now - FACE_STREAK_MS).toISOString())
      .order('created_at', { ascending: false }).limit(20),
  ]);
  if (te) throw te;
  if (re) throw re;
  // Mặt mẫu vừa bị xoá giữa chừng: chấm như không cần so mặt.
  const templates = (tpl?.embeddings || []).map(faceVector).filter(Boolean);
  const score = templates.length ? bestScore(probes, templates) : 1;
  const streak = wrongStreak((recent || []).filter(x => x.id !== c.id));
  const outcome = faceOutcome(score, faceThreshold(settings), streak);
  if (!await finish(outcome, { score: Math.round(score * 1000) / 1000 })) return reply('expired', { done: true });
  if (outcome === 'wrong') return reply('wrong', { tries_left: FACE_TRIES - streak - 1 });

  // Đúng mặt (hoặc sai lần thứ 3 → chờ chủ duyệt): ghi giờ đúng lúc quét mã.
  const at = new Date(Date.parse(c.created_at)).toISOString();
  const done = await applyClock(db, { staffId: c.staff_id, at, scan: { ...(c.scan || {}) }, review: outcome === 'review' ? { checkId: c.id } : null });
  await db.from('checkin_face_checks').update({ attendance_id: done.session.id, clocked: done.clocked }).eq('id', c.id)
    .then(({ error: e }) => { if (e) console.error('[kiosk] face check link', e); });
  return reply(outcome, { clocked: done.clocked, at });
}

// Danh sách nút trên máy quầy: tên hiện trên nút (chủ đặt, không thì tên tài khoản) + ảnh nhỏ.
async function tapList(request) {
  const db = statusDatabase();
  if (!(await activeKiosk(request, db))) return fail('Máy này chưa được bật làm máy quầy.', 401, { kiosk: false });
  const people = await tapPeople(db);
  if (!people.length) return NextResponse.json({ people: [] }, { headers });
  const { data: staff, error } = await db.from('staff').select('id, full_name').in('id', people.map(p => p.staff_id));
  if (error) throw error;
  const nameOf = new Map((staff || []).map(p => [p.id, p.full_name]));
  return NextResponse.json({ people: people.filter(p => nameOf.has(p.staff_id))
    .map(p => ({ id: p.staff_id, name: p.label || nameOf.get(p.staff_id), photo: p.photo || null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi')) }, { headers });
}

// Bấm nút tên trên máy quầy (người không có điện thoại): như quét mã thành công — vào ca nếu chưa vào, không thì
// ra ca; ghi lượt chấm method = 'tap'. Chỉ máy quầy đang bật và chỉ người chủ đã cho dùng nút.
async function tapClock(request, body) {
  await refreshClock();
  const db = statusDatabase();
  const kiosk = await activeKiosk(request, db);
  if (!kiosk) return fail('Máy này chưa được bật làm máy quầy.', 401, { kiosk: false });
  const kioskId = kiosk.id;
  // Bấm nút phải từ đúng mạng máy quầy đang dùng (như quét mã phải ở wifi quán).
  if (!onKioskNetwork(clientIp(request.headers), kiosk, nowMs())) return fail('Máy quầy không ở wifi quán. Kiểm tra mạng của máy quầy.', 403);
  const staffId = UUID.test(body.staff_id || '') ? String(body.staff_id).toLowerCase() : '';
  const allowed = staffId ? (await tapPeople(db)).find(p => p.staff_id === staffId) : null;
  if (!allowed) return fail('Người này chưa được chấm công bằng nút. Nhờ chủ quán cho phép trong trang Lương.', 403);
  const { data: person, error } = await db.from('staff').select('id, full_name').eq('id', staffId).maybeSingle();
  if (error) throw error;
  if (!person) return fail('Không tìm thấy nhân viên này.', 404);
  const name = allowed.label || person.full_name;
  const settings = await readCheckinSettings(db);
  await closeForgottenSessions(db, settings, staffId, nowMs());
  const last = await latestSession(db, staffId);
  const open = last && !last.clock_out ? last : null;
  // Máy quầy đang hiện "Vào ca" mà người đó đã vào (vừa bấm ở chỗ khác...) thì không tự đảo chiều.
  if ((body.expect === 'in' && open) || (body.expect === 'out' && !open)) {
    return fail(`${name} đang ${open ? 'trong ca' : 'ngoài ca'} — bấm lại tên để ${open ? 'ra' : 'vào'} ca.`, 409, { name });
  }
  const lastAt = open ? open.clock_in : last?.clock_out;
  if (lastAt && nowMs() - Date.parse(lastAt) < MIN_TOGGLE_MS) {
    return fail(`${name} vừa ${open ? 'vào' : 'ra'} ca lúc ${hhmm(lastAt)}. Đợi 3 phút rồi bấm lại nếu muốn ${open ? 'ra' : 'vào'} ca.`, 409, { name });
  }
  const at = new Date(nowMs()).toISOString();
  let done;
  try {
    done = await applyClock(db, { staffId, at, scan: { kiosk_id: kioskId, method: 'tap', warnings: [], enforced: !!settings.enforce, ip: clientIp(request.headers),
      user_agent: String(request.headers?.get?.('user-agent') || '').slice(0, 200) } });
  } catch (error) {
    // Hai lần bấm cùng lúc: lần sau gặp ca đang mở do lần trước vừa tạo.
    if (error?.code === 'already_open') return fail(`${name} vừa vào ca. Đợi 3 phút rồi bấm lại nếu muốn ra ca.`, 409, { name });
    throw error;
  }
  const sessions = await sessionsOfDay(db, staffId, done.session, settings);
  return NextResponse.json({ ok: true, name, clocked: done.clocked, at, note: punctuality(done.clocked, done.session, sessions, settings, staffId) }, { headers });
}
