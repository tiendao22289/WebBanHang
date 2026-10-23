/**
 * /api/admin/workforce — chấm công, ứng lương / báo nghỉ, phạt, cấu hình lương,
 * tài khoản nhân viên. Trước đây trang Lương / Sổ tay / Chấm công ghi thẳng
 * vào DB bằng khoá công khai, nên ai cũng tự sửa được giờ công, lương, PIN.
 * Giờ mọi thao tác ghi đi qua đây: kiểm cookie đăng nhập, quyền, giờ máy chủ.
 *
 * GET  ?qr=1                 → mã QR chấm công hiện tại (admin)
 * POST {action}:
 *   clock {token}            → vào / ra ca; nhân viên phải quét QR ở quán
 *   legacy_clock_in|out      → nút chấm công cũ trong Sổ tay (bảng attendance_logs)
 *   request {type, amount|days, reason} → ứng lương / báo nghỉ của chính mình
 *   edit_attendance, decide_request, add_violation, delete_violation,
 *   save_config, create_account, set_pin, delete_account   (admin)
 *   hash_all_pins            → băm PIN còn lưu chữ thường (admin / workflow)
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';
import { hashPin, isHashedPin, validPin } from '@/lib/staffPin.mjs';
import { checkinToken, checkinTokenValid } from '@/lib/checkinToken.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_MONEY = 1_000_000_000;
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });
const vnNow = () => new Date(Date.now() + 7 * 3600000);
const vnToday = () => vnNow().toISOString().slice(0, 10);
const secret = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const money = v => { const n = Math.round(Number(String(v ?? '').replace(/\./g, ''))); return Number.isFinite(n) && n >= 0 && n <= MAX_MONEY ? n : null; };
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);

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

export async function GET(request) {
  try {
    const s = await session(request);
    if (s.error) return s.error;
    if (!new URL(request.url).searchParams.get('qr')) return fail('Thiếu yêu cầu.');
    if (!s.isAdmin) return fail('Chỉ admin xem mã QR chấm công.', 403);
    return NextResponse.json(checkinToken(secret()), { headers });
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
      // Nhân viên phải quét mã QR ở quán; admin chấm hộ được không cần mã.
      if (!isAdmin && !checkinTokenValid(body.token, secret())) {
        return fail('Mã QR đã hết hạn hoặc không đúng. Quét lại mã QR ở quán để chấm công.', 403);
      }
      const { data: sessions, error } = await db.from('attendance_sessions').select('*').eq('staff_id', user.id).eq('date', today).order('clock_in');
      if (error) throw error;
      const open = (sessions || []).find(x => !x.clock_out);
      const at = new Date().toISOString();
      const result = open
        ? await db.from('attendance_sessions').update({ clock_out: at }).eq('id', open.id).select('*').single()
        : await db.from('attendance_sessions').insert({ staff_id: user.id, date: today, clock_in: at }).select('*').single();
      if (result.error) throw result.error;
      const { data: fresh } = await db.from('attendance_sessions').select('*').eq('staff_id', user.id).eq('date', today).order('clock_in');
      return NextResponse.json({ ok: true, clocked: open ? 'out' : 'in', at, session: result.data, sessions: fresh || [] }, { headers });
    }

    if (body.action === 'legacy_clock_in' || body.action === 'legacy_clock_out') {
      const { data: row, error } = await db.from('attendance_logs').select('*').eq('staff_id', user.id).eq('date', today).maybeSingle();
      if (error) throw error;
      const now = new Date();
      if (body.action === 'legacy_clock_in') {
        if (row) return fail('Hôm nay đã bắt đầu ca.');
        const r = await db.from('attendance_logs').insert({ staff_id: user.id, date: today, clock_in: now.toISOString() });
        if (r.error) throw r.error;
      } else {
        if (!row || row.clock_out) return fail('Chưa có ca đang mở.');
        const h = (now - new Date(row.clock_in)) / 3600000;
        const r = await db.from('attendance_logs').update({ clock_out: now.toISOString(), work_hours: Math.round(h * 10) / 10, overtime_hours: Math.max(0, Math.round((h - 8) * 10) / 10) }).eq('id', row.id);
        if (r.error) throw r.error;
      }
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'request') {
      const type = body.type === 'absent' ? 'absent' : body.type === 'advance' ? 'advance' : null;
      const reason = text(body.reason);
      if (!type || !reason) return fail('Vui lòng điền đầy đủ!');
      const now = vnNow();
      const row = { staff_id: user.id, request_type: type, reason, month: now.getUTCMonth() + 1, year: now.getUTCFullYear(), status: 'pending' };
      if (type === 'advance') {
        const amount = money(body.amount);
        if (!amount) return fail('Số tiền ứng không hợp lệ.');
        row.amount = amount;
      } else {
        const days = Number(body.days);
        if (!(days > 0 && days <= 31)) return fail('Số ngày nghỉ không hợp lệ.');
        row.days = days;
      }
      const r = await db.from('payroll_requests').insert(row);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    const denied = adminOnly();
    if (denied) return denied;

    if (body.action === 'edit_attendance') {
      if (!UUID.test(body.id || '')) return fail('Thiếu ca cần sửa.');
      const { data: orig, error } = await db.from('attendance_sessions').select('*').eq('id', body.id).maybeSingle();
      if (error) throw error;
      if (!orig) return fail('Không tìm thấy ca.', 404);
      const updates = {}, logs = [];
      for (const f of ['clock_in', 'clock_out', 'note']) {
        if (!(f in body)) continue;
        const next = body[f] === '' || body[f] === null ? null : f === 'note' ? text(body[f]) : new Date(body[f]);
        if (f !== 'note' && next && Number.isNaN(next.getTime())) return fail('Giờ không hợp lệ.');
        const value = next instanceof Date ? next.toISOString() : next;
        const same = f === 'note' ? String(orig[f] ?? '') === String(value ?? '')
          : (orig[f] ? new Date(orig[f]).getTime() : null) === (value ? new Date(value).getTime() : null);
        if (same) continue;
        if (f === 'note' && !('note' in orig)) continue;
        updates[f] = value;
        logs.push({ attendance_id: orig.id, staff_id: orig.staff_id, field_name: f, old_value: String(orig[f] ?? ''), new_value: String(value ?? ''), changed_by: user.full_name || null });
      }
      if (!logs.length) return NextResponse.json({ ok: true, changed: 0 }, { headers });
      const r = await db.from('attendance_sessions').update(updates).eq('id', orig.id);
      if (r.error) throw r.error;
      await db.from('attendance_edit_log').insert(logs).then(({ error: e }) => { if (e) console.error('[workforce] edit log', e); });
      return NextResponse.json({ ok: true, changed: logs.length }, { headers });
    }

    if (body.action === 'decide_request') {
      if (!UUID.test(body.id || '') || !['approved', 'rejected'].includes(body.status)) return fail('Yêu cầu không hợp lệ.');
      const r = await db.from('payroll_requests').update({ status: body.status, admin_note: text(body.admin_note), updated_at: new Date().toISOString() }).eq('id', body.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'add_violation') {
      const amount = money(body.amount);
      const month = Number(body.month), year = Number(body.year);
      if (!UUID.test(body.staff_id || '') || !amount || !text(body.reason) || !(month >= 1 && month <= 12) || !(year >= 2024 && year <= 2100)) return fail('Vui lòng điền đầy đủ!');
      const r = await db.from('payroll_violations').insert({ staff_id: body.staff_id, amount, reason: text(body.reason), month, year });
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'delete_violation') {
      if (!UUID.test(body.id || '')) return fail('Thiếu khoản phạt.');
      const r = await db.from('payroll_violations').delete().eq('id', body.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'save_config') {
      if (!UUID.test(body.staff_id || '')) return fail('Thiếu nhân viên.');
      const payload = { staff_id: body.staff_id, base_salary: money(body.base_salary) || 0, overtime_rate: money(body.overtime_rate) || 25000,
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
