/**
 * POST /api/voucher/bind { orderId, tableId, key } — trang gọi món đăng ký chìa khoá riêng của máy
 * cho mã bill nó SẮP gửi (mã bill do máy khách tự sinh trước khi gửi món).
 *
 * Bảng orders đọc được bằng khoá công khai nên mã bill không bí mật. Chỉ cho đăng ký khi bill
 * CHƯA tồn tại (người lạ không thể đăng ký cho bill người khác đã gửi), ai đăng ký trước thì giữ.
 * Sau này chỉ máy có chìa khoá mới xem được mã "lần sau" của bill và tự nhập mã voucher.
 * Không giới hạn theo bàn (người ngoài làm đầy giới hạn thì khách thật bị chặn); chỉ giới hạn
 * theo IP thật do Cloudflare gắn (cf-connecting-ip, máy khách không tự đặt được) để chống rác.
 */
import { NextResponse } from 'next/server';
import { statusDatabase } from '@/lib/statusAuth';
import { hashVoucherKey } from '@/lib/voucherServer.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{32,128}$/;
const PER_IP_HOUR = 300; // cả quán chung 1 Wi-Fi vẫn dư
const headers = { 'Cache-Control': 'no-store' };
const reply = (body, status = 200) => NextResponse.json(body, { status, headers });
const perIp = new Map();
function overLimit(ip, now) {
  if (!ip) return false;
  if (perIp.size > 5000) for (const [k, v] of perIp) if (v.until <= now) perIp.delete(k);
  const v = perIp.get(ip);
  const next = v && v.until > now ? { count: v.count + 1, until: v.until } : { count: 1, until: now + 3600000 };
  perIp.set(ip, next);
  return next.count > PER_IP_HOUR;
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const orderId = String(body.orderId || '');
  const tableId = String(body.tableId || '');
  const key = String(body.key || '');
  if (!UUID.test(orderId) || !UUID.test(tableId) || !KEY.test(key)) return reply({ ok: false }, 400);
  if (overLimit(String(request.headers?.get?.('cf-connecting-ip') || ''), Date.now())) return reply({ ok: false }, 429);
  try {
    const db = statusDatabase();
    const hash = hashVoucherKey(key);
    const { data: existing, error: existingError } = await db.from('voucher_order_keys').select('key_hash').eq('order_id', orderId).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return reply({ ok: existing.key_hash === hash }, existing.key_hash === hash ? 200 : 409); // gửi lại cùng máy: được

    const [{ data: order, error: orderError }, { data: table, error: tableError }] = await Promise.all([
      db.from('orders').select('id').eq('id', orderId).maybeSingle(),
      db.from('tables').select('id').eq('id', tableId).maybeSingle(),
    ]);
    if (orderError || tableError) throw orderError || tableError;
    if (order || !table) return reply({ ok: false }, 409);

    const { error } = await db.from('voucher_order_keys').insert({ order_id: orderId, table_id: tableId, key_hash: hash });
    if (error && error.code !== '23505') throw error;
    if (error) {
      const { data: won } = await db.from('voucher_order_keys').select('key_hash').eq('order_id', orderId).maybeSingle();
      return reply({ ok: won?.key_hash === hash }, won?.key_hash === hash ? 200 : 409);
    }
    // Dọn chìa khoá cũ (bill đã qua vài ngày thì không còn vé để xem).
    if (Math.random() < 0.02) {
      await db.from('voucher_order_keys').delete().lt('created_at', new Date(Date.now() - 3 * 86400000).toISOString());
    }
    return reply({ ok: true });
  } catch (error) {
    console.error('[voucher/bind]', error);
    return reply({ ok: false }, 500);
  }
}
