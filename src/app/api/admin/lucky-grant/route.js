/**
 * POST /api/admin/lucky-grant { spinId } — admin cấp quà TAY cho 1 lượt quay
 * bị kẹt (khách đã Quan tâm Zalo nhưng quà chưa vào bill, hoặc cần giải quyết
 * cho khách). Bỏ qua yêu cầu follow + cooldown; vẫn dùng chung khoá chốt slot
 * để không ghi trùng / không vượt 1 quà/bill.
 *
 * Chạy bằng SERVICE_ROLE_KEY, cùng kiểu bảo vệ với các route /api/admin/* khác.
 */
import { NextResponse } from 'next/server';
import { getServiceClient, grantLuckySpinManually } from '@/lib/zaloRewardServer';
import { isAdminRequest } from '@/lib/adminApiAuth';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  // Ghi quà vào bill, bỏ qua bước Quan tâm Zalo → chỉ nhân viên đã đăng nhập.
  // Không chặn thì khách tự gọi bằng spinId của chính mình là có quà miễn phí.
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ ok: false, message: 'Không có quyền.' }, { status: 401 });
  }
  const supabase = getServiceClient();
  if (!supabase) return NextResponse.json({ ok: false, message: 'Thiếu cấu hình server' }, { status: 500 });
  try {
    const body = await request.json().catch(() => ({}));
    const spinId = String(body.spinId || '').trim();
    if (!spinId) return NextResponse.json({ ok: false, message: 'Thiếu lượt quay.' });
    const result = await grantLuckySpinManually(supabase, spinId, m => console.log('[admin/lucky-grant]', m));
    return NextResponse.json(result);
  } catch (err) {
    console.error('[admin/lucky-grant] lỗi:', err);
    return NextResponse.json({ ok: false, message: 'Quán gặp lỗi khi cấp quà, thử lại giúp ạ.' });
  }
}
