/**
 * /api/admin/lock — mã PIN mở các tab nhạy cảm của chủ quán (Lương, Thống kê & Kế toán, Khách hàng, Cài đặt,
 * Sổ thu chi). Chỉ tài khoản chủ quán (role admin) đã đăng nhập. Mỗi lần mở tab là mỗi lần hỏi PIN:
 * máy chủ không nhớ lần mở trước (không có cookie mở khoá).
 *
 * GET  → { hasPin, wait, length }
 * POST {action}:
 *   unlock { pin }                 đúng → { ok }; sai 5 lần liền → khoá 5 phút
 *   set    { pin, current? }       đặt PIN lần đầu, hoặc đổi PIN (phải nhập đúng PIN đang dùng)
 *   reset  { loginPin, pin }       quên PIN: nhập mã đăng nhập của tài khoản chủ quán để đặt PIN mới
 */
import { NextResponse } from 'next/server';
import { getStaffSession, getStatusSecret, statusDatabase } from '@/lib/statusAuth';
import { pinMatches } from '@/lib/staffPin.mjs';
import { PIN_KEY, afterFail, lockWait, newPinRecord, pinMatchesRecord, pinValid } from '@/lib/adminPin.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const fail = (error, status = 400, extra = {}) => NextResponse.json({ error, ...extra }, { status, headers });
const ok = () => NextResponse.json({ ok: true }, { headers });

async function readRecord(db) {
  const { data, error } = await db.from('finance_settings').select('value').eq('key', PIN_KEY).maybeSingle();
  if (error) throw error;
  return data?.value?.hash ? data.value : null;
}
async function saveRecord(db, record) {
  const { error } = await db.from('finance_settings').upsert({ key: PIN_KEY, value: record, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function owner(request) {
  const s = await getStaffSession(request);
  if (s.code !== 200) return { code: s.code };
  return s.user.role === 'admin' ? { code: 200, user: s.user } : { code: 403 };
}

export async function GET(request) {
  try {
    const s = await owner(request);
    if (s.code !== 200) return fail(s.code === 403 ? 'Chỉ chủ quán.' : 'Cần đăng nhập.', s.code);
    const record = await readRecord(statusDatabase());
    return NextResponse.json({ hasPin: !!record, wait: lockWait(record), length: record?.len || null }, { headers });
  } catch (error) {
    console.error('[lock] GET', error);
    return fail('Không kiểm tra được mã PIN, thử lại.', 503);
  }
}

export async function POST(request) {
  try {
    const s = await owner(request);
    if (s.code !== 200) return fail(s.code === 403 ? 'Chỉ chủ quán.' : 'Cần đăng nhập.', s.code);
    const db = statusDatabase();
    const secret = getStatusSecret();
    const body = await request.json().catch(() => ({}));
    const record = await readRecord(db);

    // Sai nhiều lần thì chờ, cho cả mở khoá / đổi PIN / quên PIN.
    const wait = lockWait(record);
    if (wait) return fail(`Nhập sai nhiều lần. Thử lại sau ${Math.ceil(wait / 60)} phút.`, 429, { wait });
    const wrong = async message => {
      if (record) await saveRecord(db, afterFail(record));
      const next = record ? lockWait(afterFail(record)) : 0;
      return fail(next ? `Sai mã. Đã khoá ${Math.ceil(next / 60)} phút.` : message, next ? 429 : 401, { wait: next });
    };

    if (body.action === 'unlock') {
      if (!record) return fail('Chưa đặt mã PIN.', 409);
      if (!pinMatchesRecord(record, body.pin, secret)) return wrong('Sai mã PIN.');
      if (record.fails) await saveRecord(db, { ...record, fails: 0, lockedUntil: null });
      return ok();
    }

    if (body.action === 'set' || body.action === 'reset') {
      if (!pinValid(body.pin)) return fail('Mã PIN gồm 4 đến 6 chữ số.');
      if (body.action === 'set' && record && !pinMatchesRecord(record, body.current, secret)) return wrong('Mã PIN đang dùng không đúng.');
      if (body.action === 'reset') {
        // Quên PIN: mã đăng nhập (PIN tài khoản) của chính chủ quán đang đăng nhập.
        const { data, error } = await db.from('staff').select('id, pin').eq('id', s.user.id).maybeSingle();
        if (error) throw error;
        if (!pinMatches(data?.pin, s.user.id, String(body.loginPin || ''), process.env.SUPABASE_SERVICE_ROLE_KEY)) return wrong('Mã đăng nhập không đúng.');
      }
      await saveRecord(db, newPinRecord(String(body.pin), secret));
      return ok();
    }

    return fail('Thao tác không hợp lệ.');
  } catch (error) {
    console.error('[lock] POST', error);
    return fail('Không lưu được, thử lại.', 500);
  }
}
