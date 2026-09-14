/**
 * POST /api/lucky/follow-tapped — máy khách báo đã BẤM nút "Quan tâm Zalo" cho
 * một lượt quay. Chỉ ghi một mốc thời gian (follow_prompt_at) để trang admin
 * biết "khách đã bấm Quan tâm nhưng chưa nhắn SĐT" mà nhắc khách.
 *
 * KHÔNG cấp quà, KHÔNG cần đăng nhập — chỉ nhận spinId. Chạy bằng SERVICE_ROLE_KEY
 * vì lucky_spins đã siết quyền ghi của anon. Mọi lỗi đều trả ok:false êm, không
 * làm hỏng trải nghiệm nhận quà của khách.
 */
import { NextResponse } from 'next/server';
import { getServiceClient, markFollowTapped } from '@/lib/zaloRewardServer';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const { spinId } = await request.json().catch(() => ({}));
    if (!spinId || typeof spinId !== 'string') {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const supabase = getServiceClient();
    if (!supabase) return NextResponse.json({ ok: false });
    await markFollowTapped(supabase, spinId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[lucky/follow-tapped] lỗi:', err);
    return NextResponse.json({ ok: false });
  }
}
