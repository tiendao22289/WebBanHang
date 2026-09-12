/**
 * /api/zalo/oauth-callback — Nhận mã uỷ quyền OA từ Zalo, đổi lấy token và cất
 * vào bảng `zalo_oa_tokens` (chỉ service_role đọc được).
 *
 * Chủ quán chạy MỘT LẦN: mở /api/zalo/oauth-callback?start=1 → bị đẩy sang
 * trang uỷ quyền của Zalo → bấm Cho phép → Zalo quay lại đây kèm ?code=... →
 * route tự đổi mã lấy token. Từ đó hệ thống tự làm mới token, không cần làm gì
 * thêm. Token KHÔNG bao giờ hiện ra màn hình.
 */
import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/zaloRewardServer';
import { exchangeCodeForTokens, buildPermissionUrl } from '@/lib/zaloOa';

export const dynamic = 'force-dynamic';

function page(title, body, ok = true) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <div style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:24px;
                 border-radius:16px;border:2px solid ${ok ? '#16a34a' : '#dc2626'};
                 background:${ok ? '#f0fdf4' : '#fef2f2'}">
       <h2 style="margin:0 0 10px;color:${ok ? '#15803d' : '#b91c1c'}">${title}</h2>
       <div style="color:#334155;line-height:1.6">${body}</div>
     </div>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function GET(request) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/zalo/oauth-callback`;

  // Bước 1: chủ quán mở ?start=1 → đẩy sang trang uỷ quyền của Zalo.
  if (url.searchParams.get('start')) {
    if (!process.env.ZALO_APP_ID || !process.env.ZALO_APP_SECRET) {
      return page('Thiếu cấu hình', 'Chưa có ZALO_APP_ID / ZALO_APP_SECRET trên máy chủ.', false);
    }
    return NextResponse.redirect(buildPermissionUrl(redirectUri));
  }

  // Bước 2: Zalo quay lại kèm mã uỷ quyền.
  const code = url.searchParams.get('code');
  if (!code) {
    const err = url.searchParams.get('error_description') || url.searchParams.get('error');
    return page('Chưa uỷ quyền được',
      err ? `Zalo báo: ${err}` : 'Không nhận được mã uỷ quyền. Mở lại link uỷ quyền giúp ạ.', false);
  }

  const supabase = getServiceClient();
  if (!supabase) return page('Thiếu cấu hình', 'Máy chủ chưa có SUPABASE_SERVICE_ROLE_KEY.', false);

  try {
    await exchangeCodeForTokens(supabase, code);
    return page('✅ Đã kết nối Zalo OA thành công!',
      'Quán đã có thể gửi tin nhắn cho khách. Token được lưu an toàn trên máy chủ và '
      + 'tự động gia hạn — bạn không cần làm gì thêm. Có thể đóng trang này.');
  } catch (err) {
    console.error('[Zalo OAuth] lỗi:', err);
    return page('Chưa kết nối được', `Lý do: ${err.message}`, false);
  }
}
