/**
 * POST /api/admin/lucky-move-table — sau khi nhân viên chuyển bill sang bàn
 * khác, dời lượt quay vòng xoay của khách sang bàn mới (xem
 * moveLuckySpinsWithBill). Chạy bằng SERVICE_ROLE_KEY vì lucky_spins đã gỡ
 * quyền anon.
 */
import { NextResponse } from 'next/server';
import { getServiceClient, moveLuckySpinsWithBill } from '@/lib/zaloRewardServer';
import { isAdminRequest } from '@/lib/adminApiAuth';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ ok: false, message: 'Chưa đăng nhập nhân viên.' }, { status: 401 });
  }
  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ ok: false, message: 'Máy chủ chưa cấu hình.' });
  try {
    const { orderId, sourceTableIds, targetTableId } = await request.json().catch(() => ({}));
    if (!orderId || !targetTableId || !Array.isArray(sourceTableIds)) {
      return NextResponse.json({ ok: false, message: 'Thiếu orderId/sourceTableIds/targetTableId.' }, { status: 400 });
    }
    const result = await moveLuckySpinsWithBill(supabase, { orderId, sourceTableIds, targetTableId });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[admin/lucky-move-table] lỗi:', err);
    return NextResponse.json({ ok: false, message: err.message || 'Không chuyển được lượt quay.' }, { status: 500 });
  }
}
