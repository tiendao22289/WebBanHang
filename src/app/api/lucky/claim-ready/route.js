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
import { getServiceClient, tryApplyLuckyForSpin, completeLuckySpin, applyLuckySpin } from '@/lib/zaloRewardServer';
import { LUCKY_SETTING_KEYS, parseLuckyConfig } from '@/lib/luckyWheel';

export const dynamic = 'force-dynamic';


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

    const { data: spin, error } = await supabase
      .from('lucky_spins')
      .select('*')
      .eq('id', spinId)
      .maybeSingle();
    if (error) throw error;

    if (!spin) return NextResponse.json({ ok: true, matched: false });
    if (spin.status === 'applied') {
      await completeLuckySpin(supabase, spin);
      return NextResponse.json({ ok: true, matched: true });
    }
    if (spin.status !== 'waiting_follow') return NextResponse.json({ ok: true, matched: false });
    const { data: settings, error: settingsError } = await supabase.from('settings')
      .select('key, value').in('key', LUCKY_SETTING_KEYS);
    if (settingsError) throw settingsError;
    if (!parseLuckyConfig(settings).requireFollow) {
      await applyLuckySpin(supabase, spin, null);
      return NextResponse.json({ ok: true, matched: true });
    }

    const r = await tryApplyLuckyForSpin(supabase, spin, (m) => console.log('[Lucky claim-ready]', m));
    return NextResponse.json({ ok: true, matched: !!r.matched });
  } catch (err) {
    console.error('[Lucky claim-ready] lỗi:', err);
    return NextResponse.json({ ok: false,
      message: 'Quà chưa hoàn tất trên bill hoặc lệnh in. Quý khách bấm kiểm tra lại; nếu vẫn lỗi, vui lòng gọi nhân viên hỗ trợ.' }, { status: 500 });
  }
}
