/**
 * /api/lucky/claim-ready — máy khách vừa quay xong (hoặc vừa quay lại trang),
 * nhờ server kiểm tra ngay xem đã có lượt Quan tâm Zalo nào để áp quà.
 *
 * Cần thiết vì khách rất hay Quan tâm OA trước rồi mới quay, hoặc lượt quan
 * tâm về đúng lúc chưa có lượt quay nào đang chờ — khi đó webhook không tìm
 * thấy gì và quà sẽ treo mãi.
 *
 * AN TOÀN: client chỉ gửi spinId. Server tự đọc lượt quay, tự tìm người vừa
 * quan tâm, tự tính lại tiền — y hệt đường webhook.
 */

import { NextResponse } from 'next/server';
import { getServiceClient, tryApplyLuckyForSpin } from '@/lib/zaloRewardServer';

export const dynamic = 'force-dynamic';

// Lượt quay quá lâu không hoàn tất thì bỏ qua
const SPIN_FRESH_MINUTES = 30;

export async function POST(request) {
  try {
    const { spinId } = await request.json().catch(() => ({}));
    if (!spinId || typeof spinId !== 'string') {
      return NextResponse.json({ ok: false, reason: 'thiếu spinId' }, { status: 400 });
    }

    const supabase = getServiceClient();
    if (!supabase) {
      console.error('[Lucky claim-ready] Thiếu SUPABASE_SERVICE_ROLE_KEY.');
      return NextResponse.json({ ok: false, reason: 'server chưa cấu hình' });
    }

    const freshCutoff = new Date(Date.now() - SPIN_FRESH_MINUTES * 60000).toISOString();
    const { data: spin } = await supabase
      .from('lucky_spins')
      .select('*')
      .eq('id', spinId)
      .eq('status', 'waiting_follow')
      .gte('created_at', freshCutoff)
      .maybeSingle();

    if (!spin) return NextResponse.json({ ok: true, matched: false });

    const r = await tryApplyLuckyForSpin(supabase, spin, (m) => console.log('[Lucky claim-ready]', m));
    return NextResponse.json({ ok: true, matched: !!r.matched });
  } catch (err) {
    console.error('[Lucky claim-ready] lỗi:', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
