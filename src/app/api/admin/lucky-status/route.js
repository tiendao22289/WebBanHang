/**
 * GET /api/admin/lucky-status — trạng thái các lượt quay CHƯA vào bill trong
 * ngày, để trang admin/tables hiển thị icon "đang chờ Quan tâm" / "lỗi: đã
 * Quan tâm nhưng quà chưa vào bill" trên từng bàn.
 *
 * VÌ SAO CẦN ROUTE NÀY: bảng lucky_spins đã bị gỡ quyền đọc của anon (chống
 * lộ tên/SĐT của mọi khách đã quay — xem lucky_wheel_security_fixes.sql), nên
 * admin không đọc thẳng bảng được. Route này chạy bằng SERVICE_ROLE_KEY.
 */
import { NextResponse } from 'next/server';
import { getServiceClient, listAdminLuckySpins, listStuckLuckySpins } from '@/lib/zaloRewardServer';
import { isAdminRequest } from '@/lib/adminApiAuth';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  // Trả về tên + SĐT khách → bắt buộc phải là nhân viên đã đăng nhập.
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ ok: false, spins: [], stuck: [] }, { status: 401 });
  }
  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ ok: false, spins: [], stuck: [] });
  try {
    // spins = của HÔM NAY (gắn badge lên thẻ bàn) · stuck = kẹt từ NGÀY TRƯỚC
    // (danh sách riêng, không gắn lên thẻ bàn vì mã bàn dùng lại giữa các ngày).
    const [spins, stuck] = await Promise.all([
      listAdminLuckySpins(supabase),
      listStuckLuckySpins(supabase),
    ]);
    return NextResponse.json({ ok: true, spins, stuck });
  } catch (err) {
    console.error('[admin/lucky-status] lỗi:', err);
    return NextResponse.json({ ok: false, spins: [], stuck: [] });
  }
}
