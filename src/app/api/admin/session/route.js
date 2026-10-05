import { NextResponse } from 'next/server';
import { getStatusSecret, getStaffSession, statusDatabase } from '@/lib/statusAuth';
import { STATUS_COOKIE, SESSION_SECONDS, signSession } from '@/lib/statusSession.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const attempts = new Map();
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request) {
  try {
    const session = await getStaffSession(request);
    return NextResponse.json(session.user ? { user: session.user } : { error: 'Phiên đăng nhập không còn hiệu lực.' }, { status: session.code, headers });
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
    const { data, error } = await statusDatabase().from('staff').select('id,full_name,phone,role')
      .eq('phone', phone.trim()).eq('pin', pin.trim()).single();
    if (error || !data) return NextResponse.json({ error: 'Sai số điện thoại hoặc mã PIN!' }, { status: 401, headers });
    const response = NextResponse.json({ user: data }, { headers });
    response.cookies.set(STATUS_COOKIE, signSession(data.id, getStatusSecret()), {
      httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS,
      secure: request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:',
    });
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
