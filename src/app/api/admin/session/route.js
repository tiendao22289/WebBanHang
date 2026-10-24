import { NextResponse } from 'next/server';
import { getStatusSecret, getStaffSession, statusDatabase } from '@/lib/statusAuth';
import { STATUS_COOKIE, SESSION_SECONDS, signSession } from '@/lib/statusSession.mjs';
import { hashPin, isHashedPin, pinMatches } from '@/lib/staffPin.mjs';
import { hasLeft } from '@/lib/staffDeparture.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const attempts = new Map();
const headers = { 'Cache-Control': 'no-store' };

function persistSession(response, request, staffId) {
  response.cookies.set(STATUS_COOKIE, signSession(staffId, getStatusSecret()), {
    httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS,
    secure: request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:',
  });
  return response;
}

export async function GET(request) {
  try {
    const session = await getStaffSession(request);
    const response = NextResponse.json(session.user ? { user: session.user } : { error: 'Phiên đăng nhập không còn hiệu lực.' }, { status: session.code, headers });
    // Renew only after the signed cookie and current staff record are verified.
    return session.code === 200 && session.user ? persistSession(response, request, session.user.id) : response;
  } catch { return NextResponse.json({ error: 'Không kiểm tra được phiên đăng nhập.' }, { status: 503, headers }); }
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).host === (request.headers.get('x-forwarded-host') || request.headers.get('host')); }
  catch { return false; }
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Yêu cầu không hợp lệ.' }, { status: 403, headers });
  const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'local';
  const now = Date.now();
  for (const [key, entry] of attempts) { if (now > entry.until) attempts.delete(key); }
  const entry = attempts.get(address) || { count: 0, until: now + 10 * 60 * 1000 };
  if (entry.count >= 10 || attempts.size > 10000) return NextResponse.json({ error: 'Thử lại sau 10 phút.' }, { status: 429, headers });
  entry.count++;
  attempts.set(address, entry);
  try {
    const { phone, pin } = await request.json();
    if (typeof phone !== 'string' || typeof pin !== 'string' || phone.length > 30 || pin.length > 100) {
      return NextResponse.json({ error: 'Thông tin đăng nhập không hợp lệ.' }, { status: 400, headers });
    }
    const db = statusDatabase();
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { data: rows, error } = await db.from('staff').select('id,full_name,phone,role,pin').eq('phone', phone.trim()).limit(5);
    if (error) throw error;
    const match = (rows || []).find(r => pinMatches(r.pin, r.id, pin, secret));
    if (!match) return NextResponse.json({ error: 'Sai số điện thoại hoặc mã PIN!' }, { status: 401, headers });
    if (await hasLeft(db, match.id)) return NextResponse.json({ error: 'Tài khoản này đã nghỉ việc. Liên hệ chủ quán nếu cần.' }, { status: 403, headers });
    const { pin: stored, ...data } = match;
    // PIN cũ lưu chữ thường → băm luôn; ghi giờ đăng nhập (trước đây trang tự ghi bằng khoá công khai).
    await db.from('staff').update({ last_login: new Date().toISOString(), ...(isHashedPin(stored) ? {} : { pin: hashPin(data.id, pin, secret) }) })
      .eq('id', data.id).then(({ error: e }) => { if (e) console.error('[session] last_login', e); });
    const response = NextResponse.json({ user: data }, { headers });
    persistSession(response, request, data.id);
    attempts.delete(address);
    return response;
  } catch { return NextResponse.json({ error: 'Không thể đăng nhập lúc này.' }, { status: 503, headers }); }
}

export async function DELETE(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
  const response = NextResponse.json({ ok: true }, { headers });
  response.cookies.set(STATUS_COOKIE, '', { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 0 });
  return response;
}
