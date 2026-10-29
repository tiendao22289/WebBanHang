/**
 * GET /api/voucher/mine?orderId=… | ?spinId=… — trang gọi món hỏi "voucher lần sau"
 * của chính khách: mã tặng khi bill của mình vừa thanh toán, hoặc mã trúng vòng xoay.
 *
 * Bảng vouchers khoá với khoá công khai, nên trang khách đi qua route này. Chỉ trả
 * mã gắn đúng bill / lượt quay mà máy khách đang giữ id (UUID khó đoán), không tra
 * theo SĐT — tránh người lạ gõ SĐT của khách khác để lấy mã. Bàn gộp nhiều người:
 * chỉ máy có bill mang đúng SĐT nhận mã mới thấy mã.
 */
import { NextResponse } from 'next/server';
import { statusDatabase } from '@/lib/statusAuth';
import { normalizePhone } from '@/lib/voucher.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const headers = { 'Cache-Control': 'no-store' };
const COLS = 'code, source, discount_type, discount_value, max_discount, min_bill, valid_from, valid_until, status, sent_at, customer_phone';

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const orderId = params.get('orderId') || '';
  const spinId = params.get('spinId') || '';
  if (!UUID.test(orderId) && !UUID.test(spinId)) return NextResponse.json({ voucher: null }, { status: 400, headers });
  try {
    const db = statusDatabase();
    let voucher = null;
    if (UUID.test(spinId)) {
      const { data, error } = await db.from('vouchers').select(COLS).eq('issued_spin_id', spinId).limit(1);
      if (error) throw error;
      voucher = data?.[0] || null;
    } else {
      const [{ data, error }, { data: order, error: orderError }] = await Promise.all([
        db.from('vouchers').select(COLS).eq('source', 'next_visit').contains('issued_order_ids', [orderId]).limit(1),
        db.from('orders').select('customer_phone').eq('id', orderId).maybeSingle(),
      ]);
      if (error || orderError) throw error || orderError;
      voucher = data?.[0] || null;
      if (voucher && normalizePhone(order?.customer_phone) !== voucher.customer_phone) voucher = null;
    }
    if (!voucher) return NextResponse.json({ voucher: null }, { headers });
    const { customer_phone: _phone, ...pub } = voucher;
    return NextResponse.json({ voucher: pub }, { headers });
  } catch {
    return NextResponse.json({ voucher: null }, { headers });
  }
}
