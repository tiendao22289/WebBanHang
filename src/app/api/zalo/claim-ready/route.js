/**
 * /api/zalo/claim-ready — máy khách vừa tạo yêu cầu nhận quà Zalo,
 * nhờ server kiểm tra NGAY thay vì đợi event Zalo tiếp theo.
 *
 * VẤN ĐỀ CẦN GIẢI: rất nhiều khách làm NGƯỢC thứ tự — bấm Quan tâm và
 * nhắn SĐT cho OA xong rồi mới quay lại web bấm nút. Lúc event tới,
 * yêu cầu chưa tồn tại → webhook không tìm thấy gì; đến khi yêu cầu
 * được tạo thì không còn event nào nữa → treo waiting_follow mãi.
 * Route này đóng nốt khoảng trống đó.
 *
 * AN TOÀN — client chỉ "đánh thức", KHÔNG quyết định gì:
 *  * Client chỉ gửi claimId. Server tự đọc SĐT từ DB, tự tìm follower,
 *    tự tính lại tiền — y hệt đường webhook.
 *  * Chỉ xử lý nếu tài khoản Zalo đó ĐANG follow và VỪA tương tác với
 *    OA (trong RECENT_ACTIVITY_MINUTES). Nhờ vậy không thể lấy SĐT của
 *    người đã follow từ lâu để hưởng quà.
 *  * Cooldown theo SĐT + tài khoản Zalo vẫn áp dụng như thường.
 */

import { NextResponse } from 'next/server';
import {
  getServiceClient, tryApplyReward, tryApplyRewardForClaim, CLAIM_FRESH_MINUTES,
} from '@/lib/zaloRewardServer';

export const dynamic = 'force-dynamic';

// Follower phải vừa tương tác với OA trong khoảng này mới được khớp ngay
const RECENT_ACTIVITY_MINUTES = 30;

export async function POST(request) {
  try {
    const { claimId } = await request.json().catch(() => ({}));
    if (!claimId || typeof claimId !== 'string') {
      return NextResponse.json({ ok: false, reason: 'thiếu claimId' }, { status: 400 });
    }

    const supabase = getServiceClient();
    if (!supabase) {
      console.error('[Zalo claim-ready] Thiếu SUPABASE_SERVICE_ROLE_KEY.');
      return NextResponse.json({ ok: false, reason: 'server chưa cấu hình' });
    }

    const freshCutoff = new Date(Date.now() - CLAIM_FRESH_MINUTES * 60000).toISOString();
    const { data: claim } = await supabase
      .from('zalo_reward_claims')
      .select('id, customer_phone, status, created_at')
      .eq('id', claimId)
      .eq('status', 'waiting_follow')
      .gte('created_at', freshCutoff)
      .maybeSingle();

    if (!claim) return NextResponse.json({ ok: true, matched: false });

    // Tài khoản Zalo đang follow + vừa nhắn đúng SĐT này cho OA
    const activeCutoff = new Date(Date.now() - RECENT_ACTIVITY_MINUTES * 60000).toISOString();
    const { data: followers } = await supabase
      .from('zalo_followers')
      .select('zalo_user_id, last_event_at')
      .eq('phone', claim.customer_phone)
      .is('unfollowed_at', null)
      .not('followed_at', 'is', null)
      .gte('last_event_at', activeCutoff)
      .order('last_event_at', { ascending: false })
      .limit(1);

    const log = (m) => console.log('[Zalo claim-ready]', m);
    const follower = followers?.[0];

    if (follower) {
      // Đã biết SĐT (khách từng nhắn cho OA) → khớp chắc chắn
      await tryApplyReward(supabase, follower.zalo_user_id, claim.customer_phone, log);
      return NextResponse.json({ ok: true, matched: true });
    }

    // Khách chỉ bấm Quan tâm, không nhắn gì → ghép với người vừa quan tâm
    const r = await tryApplyRewardForClaim(supabase, claim, log);
    return NextResponse.json({ ok: true, matched: !!r.matched });
  } catch (err) {
    console.error('[Zalo claim-ready] lỗi:', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
