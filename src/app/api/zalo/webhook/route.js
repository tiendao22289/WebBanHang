/**
 * /api/zalo/webhook — Nhận sự kiện từ Zalo OA và TỰ ĐỘNG trả quà
 * "Quan tâm Zalo OA" (không cần nhân viên duyệt).
 *
 * ── Luồng hoạt động ─────────────────────────────────────────────
 *  1. Khách nhập SĐT trên web order → tạo zalo_reward_claims
 *     (status waiting_follow) → bấm nút mở OA.
 *  2. Khách bấm QUAN TÂM  → Zalo bắn event `follow` về đây.
 *  3. Khách nhắn SĐT vào chat OA (hoặc bấm nút chia sẻ SĐT nếu OA
 *     có gửi request-info) → event `user_send_text` / `user_submit_info`.
 *  4. Server khớp SĐT ↔ yêu cầu đang chờ → kiểm tra đủ điều kiện →
 *     chèn dòng giảm giá vào bill → verified → realtime đẩy xuống
 *     máy khách "đã bớt tiền".
 *
 * Khách làm NGƯỢC thứ tự (quan tâm + nhắn SĐT trước, bấm nút sau)
 * thì /api/zalo/claim-ready lo — xem file đó.
 *
 * ── Vì sao khách không gian lận được ────────────────────────────
 *  * Route này chạy bằng SUPABASE_SERVICE_ROLE_KEY; RLS chặn anon
 *    UPDATE zalo_reward_claims và chặn toàn bộ zalo_followers.
 *  * "Đã follow" chỉ có thể do Zalo bắn event vào đây — khách không
 *    tự ghi được.
 *  * Cooldown khoá theo CẢ SĐT lẫn zalo_user_id: đổi số khai láo
 *    cũng kẹt vì tài khoản Zalo đã nhận rồi; đổi tài khoản Zalo
 *    thì cần SIM mới — chi phí cao hơn giá trị quà (trần 10k).
 *  * Mọi con số (tổng bill, % giảm, trần) đều server tự tính lại
 *    từ DB, không tin bất kỳ giá trị nào client gửi.
 *
 * ── Cấu hình cần có ─────────────────────────────────────────────
 *  ENV  SUPABASE_SERVICE_ROLE_KEY  (bắt buộc — Supabase Dashboard > Settings > API)
 *  ENV  ZALO_APP_SECRET            (khuyến nghị — bật kiểm chữ ký X-ZEvent-Signature)
 *  Webhook URL khai trên developers.zalo.me: https://<domain>/api/zalo/webhook
 */

import { NextResponse, after } from 'next/server';
import crypto from 'crypto';
import { getServiceClient, handleZaloEvent } from '@/lib/zaloRewardServer';

export const dynamic = 'force-dynamic';

/**
 * Kiểm chữ ký Zalo (X-ZEvent-Signature: "mac=<sha256>").
 * Công thức theo docs OA: sha256(appId + rawBody + timestamp + OASecretKey).
 * Chỉ kiểm khi có ZALO_APP_SECRET; sai công thức sẽ thấy log để đối chiếu.
 */
function verifySignature(rawBody, body, signatureHeader) {
  const secret = process.env.ZALO_APP_SECRET;
  if (!secret) return { ok: true, skipped: true };
  const mac = String(signatureHeader || '').replace(/^mac=/, '').trim();
  if (!mac) return { ok: false, reason: 'thiếu header X-ZEvent-Signature' };
  const appId = String(body.app_id || '');
  const ts = String(body.timestamp || '');
  const expected = crypto.createHash('sha256').update(appId + rawBody + ts + secret).digest('hex');
  return expected === mac
    ? { ok: true }
    : { ok: false, reason: 'chữ ký không khớp' };
}

// Zalo gọi GET khi khai báo webhook — chỉ cần 200
export async function GET() {
  return NextResponse.json({ ok: true, service: 'zalo-oa-webhook' });
}

export async function POST(request) {
  const log = (m) => console.log('[Zalo Webhook]', m);

  try {
    const rawBody = await request.text();
    let body;
    try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }

    const sig = verifySignature(rawBody, body, request.headers.get('x-zevent-signature'));
    if (!sig.ok) {
      console.warn('[Zalo Webhook] từ chối:', sig.reason);
      return NextResponse.json({ ok: false, reason: sig.reason }, { status: 401 });
    }

    const supabase = getServiceClient();
    if (!supabase) {
      console.error('[Zalo Webhook] Thiếu SUPABASE_SERVICE_ROLE_KEY — không xử lý event.');
      // Vẫn trả 200 để Zalo không dồn retry; lỗi cấu hình xem ở server log
      return NextResponse.json({ ok: false, reason: 'server chưa cấu hình' });
    }

    log(`event: ${body.event_name}`);
    // Trả 200 NGAY cho Zalo (yêu cầu phản hồi < 2s), phần xử lý
    // (khớp SĐT, trừ tiền) chạy nền sau khi response đã gửi.
    after(async () => {
      try {
        await handleZaloEvent(supabase, body, log);
      } catch (err) {
        console.error('[Zalo Webhook] xử lý nền lỗi:', err);
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[Zalo Webhook] lỗi:', err);
    // 200 để tránh Zalo retry dồn dập; chi tiết nằm trong log
    return NextResponse.json({ ok: false });
  }
}
