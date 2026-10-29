/**
 * POST /api/voucher/redeem { code, tableId, orderId } — KHÁCH tự nhập mã voucher ở trang gọi món.
 *
 * Trừ tiền + chốt "đã dùng" vẫn do SQL redeem_voucher (khoá mã + cả nhóm bàn, mỗi mã 1 lần,
 * mỗi bill 1 voucher). Route này chỉ cho dùng khi khách đang có bill MỞ ở đúng bàn đó
 * (orderId là bill của chính máy khách), tự tính các bill của bàn ở máy chủ (không tin danh
 * sách bill từ máy khách), và chặn đoán mã: nhập sai quá nhiều lần thì khoá một lúc.
 */
import { NextResponse } from 'next/server';
import { statusDatabase } from '@/lib/statusAuth';
import { normalizeVoucherCode, normalizePhone, customerRedeemText, CUSTOMER_REDEEM_NAME } from '@/lib/voucher.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const OPEN = ['pending', 'preparing', 'completed'];
const headers = { 'Cache-Control': 'no-store' };
const reply = (body, status = 200) => NextResponse.json(body, { status, headers });

// Đếm lần nhập SAI theo bàn và theo máy (IP): quá MAX_FAILS trong WINDOW_MS thì khoá.
// Máy chủ quán chạy 1 tiến trình Node nên giữ trong bộ nhớ là đủ.
const MAX_FAILS = 6;
const WINDOW_MS = 30 * 60000;
const fails = new Map();
function blocked(keys, now) {
  return keys.some(k => { const f = fails.get(k); return f && f.until > now && f.count >= MAX_FAILS; });
}
function countFail(keys, now) {
  for (const k of keys) {
    const f = fails.get(k);
    fails.set(k, f && f.until > now ? { count: f.count + 1, until: f.until } : { count: 1, until: now + WINDOW_MS });
  }
  if (fails.size > 5000) for (const [k, f] of fails) if (f.until <= now) fails.delete(k);
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const tableId = String(body.tableId || '');
  const orderId = String(body.orderId || '');
  if (!UUID.test(tableId) || !UUID.test(orderId)) return reply({ ok: false, message: customerRedeemText({ reason: 'no_bill' }) }, 400);
  const ip = (request.headers?.get?.('x-forwarded-for') || '').split(',')[0].trim() || 'local';
  const keys = [`t:${tableId}`, `ip:${ip}`];
  const now = Date.now();
  if (blocked(keys, now)) return reply({ ok: false, reason: 'too_many', message: customerRedeemText({ reason: 'too_many' }) }, 429);

  const code = normalizeVoucherCode(body.code);
  if (!code) {
    countFail(keys, now);
    return reply({ ok: false, reason: 'not_found', message: customerRedeemText({ reason: 'not_found' }) });
  }
  try {
    const db = statusDatabase();
    const { data: table, error: tableError } = await db.from('tables').select('id, merged_with').eq('id', tableId).maybeSingle();
    if (tableError) throw tableError;
    if (!table) return reply({ ok: false, message: customerRedeemText({ reason: 'no_bill' }) });
    const hostId = table.merged_with || table.id;
    const { data: group, error: groupError } = await db.from('tables').select('id, table_type')
      .or(`id.eq.${hostId},merged_with.eq.${hostId}`);
    if (groupError) throw groupError;
    const tableIds = (group || []).map(t => t.id);
    const takeaway = (group || []).find(t => t.id === hostId)?.table_type === 'takeaway';
    const ids = tableIds.length ? tableIds : [hostId];
    const [{ data: orders, error: ordersError }, { data: mine, error: mineError }] = await Promise.all([
      db.from('orders').select('id, customer_phone, status').in('table_id', ids).in('status', OPEN),
      db.from('orders').select('id, customer_phone, status, created_at').eq('id', orderId).in('table_id', ids).maybeSingle(),
    ]);
    if (ordersError || mineError) throw ordersError || mineError;
    // Bill của chính máy khách phải thuộc bàn này: đang mở, hoặc vừa bị gộp vào bill khác (≤ 12 giờ).
    const recent = mine && Date.now() - Date.parse(mine.created_at) < 12 * 3600000;
    if (!mine || !(OPEN.includes(mine.status) || (recent && ['merged', 'cancelled'].includes(mine.status)))) {
      return reply({ ok: false, message: customerRedeemText({ reason: 'no_bill' }) });
    }
    let bills = (orders || []).filter(o => o.customer_phone !== 'BAO_BEP');
    if (!bills.length) return reply({ ok: false, message: customerRedeemText({ reason: 'no_bill' }) });
    // Mang về: mọi khách chung 1 bàn ảo → chỉ bill của chính khách này.
    if (takeaway) bills = bills.filter(o => o.id === orderId || (normalizePhone(o.customer_phone) && normalizePhone(o.customer_phone) === normalizePhone(mine.customer_phone)));

    const { data, error } = await db.rpc('redeem_voucher', {
      p_code: code, p_order_ids: bills.map(o => o.id), p_staff_id: null, p_staff_name: CUSTOMER_REDEEM_NAME,
    });
    if (error) throw error;
    if (data?.ok) return reply({ ok: true, code: data.code, discount: data.discount });
    if (['not_found', 'used', 'cancelled', 'expired'].includes(data?.reason)) countFail(keys, now);
    return reply({ ok: false, reason: data?.reason || null, message: customerRedeemText(data) });
  } catch (error) {
    console.error('[voucher/redeem]', error);
    return reply({ ok: false, message: 'Quán chưa áp được mã, Quý khách thử lại hoặc nhờ nhân viên giúp nhé.' }, 500);
  }
}
