/**
 * POST /api/admin/customer-cart — nhân viên nhận giỏ khách chưa gửi để Gửi hộ / Sửa rồi gửi (trang Bàn).
 *
 * body: { action: 'take', table_id, cart_id, updated_at }
 *   → { ok: true, items } | { ok: false, reason: 'changed' (khách vừa sửa giỏ) | 'gone' (khách đã gửi / xoá) }
 *
 * Chạy ở máy chủ (kiểm cookie đăng nhập nhân viên) vì nhận giỏ làm điện thoại khách tự bớt các món đó:
 * để khoá công khai gọi được thì người ngoài xoá được giỏ của khách (supabase/migrations/customer_cart_alert.sql).
 */
import { NextResponse } from 'next/server';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request) {
  const session = await getStaffSession(request);
  if (session.code !== 200) {
    const message = session.code === 401 ? 'Chưa đăng nhập nhân viên.' : 'Máy chủ đang bận, thử lại giúp ạ.';
    return NextResponse.json({ ok: false, message }, { status: session.code, headers });
  }
  const body = await request.json().catch(() => ({}));
  if (body?.action !== 'take') {
    return NextResponse.json({ ok: false, message: 'Không rõ thao tác.' }, { status: 400, headers });
  }
  const tableId = String(body.table_id || '');
  const cartId = String(body.cart_id || '');
  const updatedAt = String(body.updated_at || '');
  if (!UUID.test(tableId) || !/^[0-9a-f]{64}$/.test(cartId) || !updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    return NextResponse.json({ ok: false, message: 'Thiếu thông tin giỏ khách.' }, { status: 400, headers });
  }
  const { data, error } = await staffDatabase(session.user.id).rpc('take_customer_cart', {
    p_table_id: tableId, p_cart_id: cartId, p_updated_at: updatedAt,
  });
  if (error) {
    console.error('[admin/customer-cart] take', error.message);
    return NextResponse.json({ ok: false, message: 'Máy chủ chưa nhận được giỏ, thử lại giúp ạ.' }, { status: 503, headers });
  }
  console.info('[admin/customer-cart] take', session.user.id, tableId, data?.ok ? 'ok' : data?.reason);
  return NextResponse.json(data || { ok: false, reason: 'gone' }, { headers });
}
