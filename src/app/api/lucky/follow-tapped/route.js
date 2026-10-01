/**
 * POST /api/lucky/follow-tapped — máy khách báo đã BẤM nút "Quan tâm Zalo" cho
 * một lượt quay. Ghi mốc mở Zalo và tự duyệt quà theo chính sách của quán.
 *
 * Không xác nhận danh tính/follow Zalo. Dùng chung khoá slot và ID dòng quà
 * để retry không cộng hoặc in trùng. Lỗi được claim-ready/admin poll thử lại.
 */
import { NextResponse } from 'next/server';
import { getServiceClient, markFollowTapped, autoApproveTappedSpin } from '@/lib/zaloRewardServer';

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
    await autoApproveTappedSpin(supabase, spinId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[lucky/follow-tapped] lỗi:', err);
    return NextResponse.json({ ok: false });
  }
}
