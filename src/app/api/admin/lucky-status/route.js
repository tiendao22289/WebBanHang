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
import { getServiceClient, listAdminLuckySpins } from '@/lib/zaloRewardServer';
import { isAdminRequest } from '@/lib/adminApiAuth';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  // Trả về tên + SĐT khách → bắt buộc phải là nhân viên đã đăng nhập.
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ ok: false, spins: [] }, { status: 401 });
  }
  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ ok: false, spins: [] });
  try {
    const spins = await listAdminLuckySpins(supabase);
    return NextResponse.json({ ok: true, spins });
  } catch (err) {
    console.error('[admin/lucky-status] lỗi:', err);
    return NextResponse.json({ ok: false, spins: [] });
  }
}
