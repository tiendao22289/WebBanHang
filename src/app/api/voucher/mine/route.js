/**
 * GET /api/voucher/mine?orderId=… | ?spinId=… — trang gọi món hỏi "voucher lần sau"
 * của chính khách: mã tặng khi bill của mình vừa thanh toán, hoặc mã trúng vòng xoay.
 *
 * Bảng vouchers khoá với khoá công khai, nên trang khách đi qua route này. Không tra theo SĐT.
 *  - orderId: bảng orders đọc được bằng khoá công khai nên mã bill KHÔNG bí mật → phải kèm
 *    chìa khoá máy (header x-voucher-key) đã đăng ký cho bill trước khi gửi món (/api/voucher/bind).
 *    Bàn gộp nhiều người: chỉ máy có bill mang đúng SĐT nhận mã mới thấy mã.
 *  - spinId: mã lượt quay chỉ máy khách quay mới biết (lucky_spins không mở cho khoá công khai).
 */
import { NextResponse } from 'next/server';
import { statusDatabase } from '@/lib/statusAuth';
import { normalizePhone } from '@/lib/voucher.mjs';
import { hashVoucherKey } from '@/lib/voucherServer.mjs';

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
      const key = String(request.headers?.get?.('x-voucher-key') || '');
      if (!key) return NextResponse.json({ voucher: null }, { headers });
      const [{ data, error }, { data: order, error: orderError }, { data: bound, error: boundError }] = await Promise.all([
        db.from('vouchers').select(COLS).eq('source', 'next_visit').contains('issued_order_ids', [orderId]).limit(1),
        db.from('orders').select('customer_phone').eq('id', orderId).maybeSingle(),
        db.from('voucher_order_keys').select('key_hash').eq('order_id', orderId).maybeSingle(),
      ]);
      if (error || orderError || boundError) throw error || orderError || boundError;
      if (!bound || bound.key_hash !== hashVoucherKey(key)) return NextResponse.json({ voucher: null }, { headers });
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
