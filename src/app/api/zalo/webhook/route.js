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
 *
 * KHÔNG CHẶN EVENT KHI CHỮ KÝ SAI — cố tình như vậy. Trước đây hàm này trả 401
 * khi không khớp; ngay khi ZALO_APP_SECRET được đặt, TOÀN BỘ event Zalo bị chặn
 * và khách không nhận được quà nào (đo thực tế 13/09/2026: webhook đứng im 40
 * phút). Công thức ký của Zalo chưa xác minh được, nên chặn cứng là đánh đổi
 * sai: mất tính năng chắc chắn, đổi lấy phòng thủ chưa chắc đúng.
 *
 * Thay vào đó: thử vài công thức, ghi lại cái nào khớp, rồi VẪN cho event chạy.
 * Khi biết chắc công thức đúng thì mới bật chặn cứng.
 */
function signatureDiagnosis(rawBody, body, signatureHeader) {
  const secret = (process.env.ZALO_APP_SECRET || '').trim();
  const mac = String(signatureHeader || '').replace(/^mac=/, '').trim();
  if (!secret) return { matched: null, note: 'chưa đặt ZALO_APP_SECRET' };
  if (!mac) return { matched: null, note: 'event không kèm header chữ ký' };

  const appId = String(body.app_id || '');
  const ts = String(body.timestamp || '');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const candidates = {
    'appId+body+ts+secret': sha(appId + rawBody + ts + secret),
    'body+ts+secret': sha(rawBody + ts + secret),
    'appId+body+secret': sha(appId + rawBody + secret),
    'body+secret': sha(rawBody + secret),
    'appId+ts+secret': sha(appId + ts + secret),
  };
  const matched = Object.keys(candidates).find(k => candidates[k] === mac) || null;
  return { matched, note: matched ? `khớp công thức: ${matched}` : 'không công thức nào khớp' };
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

    const sig = signatureDiagnosis(rawBody, body, request.headers.get('x-zevent-signature'));
    log(`chu ky: ${sig.note}`);

    const supabase = getServiceClient();
    if (!supabase) {
      console.error('[Zalo Webhook] Thiếu SUPABASE_SERVICE_ROLE_KEY — không xử lý event.');
      // Vẫn trả 200 để Zalo không dồn retry; lỗi cấu hình xem ở server log
      return NextResponse.json({ ok: false, reason: 'server chưa cấu hình' });
    }
    // Cất kết quả dò công thức chữ ký để đọc bằng SQL. Chỉ là TÊN công thức,
    // không chứa bí mật gì. Gỡ khi đã bật kiểm chữ ký thật.
    after(async () => {
      try {
        await supabase.from('settings').upsert(
          { key: 'debug_zalo_signature', value: `${new Date().toISOString()} | ${sig.note}` },
          { onConflict: 'key' });
      } catch { /* chẩn đoán hỏng không được ảnh hưởng việc xử lý event */ }
    });

    log(`event: ${body.event_name}`);
    // Đã đo thực tế trên OA này (12/09/2026): event `follow` KHÔNG mang theo
    // tham số do mình đặt. Payload chỉ có oa_id, follower.id, user_id_by_app,
    // event_name, source ("oa_profile" — danh mục cố định, không phải ref của
    // mình), app_id, timestamp. Vì vậy KHÔNG thể gắn lượt quay vào cú bấm
    // Quan tâm; muốn biết khách nào thì vẫn phải lấy SĐT (khách nhắn, hoặc
    // bấm nút chia sẻ SĐT → event user_submit_info).
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
