/**
 * POST /api/admin/lucky-remove-gift — nhân viên xoá 1 dòng QUÀ VÒNG XOAY khỏi bill.
 *
 * Phải chạy bằng SERVICE_ROLE_KEY vì: (1) khoá lucky_spins (bảng đã siết quyền
 * anon), (2) xoá dòng quà + tính lại tổng bill trong cùng một bước server để
 * quà không bị trang khách (claim-ready) ghi trở lại. Xem removeLuckyGiftItem.
 */
import { NextResponse } from 'next/server';
import { getServiceClient, removeLuckyGiftItem } from '@/lib/zaloRewardServer';
import { isAdminRequest } from '@/lib/adminApiAuth';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ ok: false, message: 'Chưa đăng nhập nhân viên.' }, { status: 401 });
  }
  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ ok: false, message: 'Máy chủ chưa cấu hình.' });
  try {
    const { orderId, itemId } = await request.json().catch(() => ({}));
    if (!orderId || !itemId) {
      return NextResponse.json({ ok: false, message: 'Thiếu orderId/itemId.' }, { status: 400 });
    }
    const result = await removeLuckyGiftItem(supabase, orderId, itemId);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[admin/lucky-remove-gift] lỗi:', err);
    return NextResponse.json({ ok: false, message: err.message || 'Không xoá được, thử lại.' }, { status: 500 });
  }
}
