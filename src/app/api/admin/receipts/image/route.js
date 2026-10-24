/**
 * /api/admin/receipts/image?p=<đường dẫn>&token=<mã ký> — trả 1 ảnh bill giấy / ảnh CK.
 *
 * Supabase chạy trong máy quán (prod: http://localhost:8000); điện thoại mở
 * ocbaokhang.online không vào được địa chỉ đó, nên web lấy hộ ảnh. Không cần
 * đăng nhập: mã ký do Sổ thu chi / Bill giấy cấp (signReceiptImages) chỉ mở đúng
 * ảnh đó và hết hạn sau 1 giờ — Supabase tự kiểm tra.
 */
import { receiptImageSource } from '@/lib/receiptImages.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const IMAGE_TYPE = /^image\/(jpeg|png|webp)$/;
const text = (body, status) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const source = receiptImageSource(params.get('p'), params.get('token'), process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!source) return text('Không có ảnh.', 404);
  let upstream;
  try {
    upstream = await fetch(source, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  } catch {
    return text('Không lấy được ảnh từ máy chủ quán.', 502);
  }
  const type = upstream.headers.get('content-type') || '';
  if (!upstream.ok || !IMAGE_TYPE.test(type)) {
    await upstream.body?.cancel();
    // Mã ký hết hạn / sai: Supabase trả 400 → tải lại trang để lấy link mới.
    return text('Link xem ảnh đã hết hạn hoặc ảnh không còn. Tải lại trang rồi thử lại.', upstream.status >= 500 ? 502 : 404);
  }
  return new Response(upstream.body, { headers: {
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
    // Ảnh không bao giờ đổi (ảnh mới = đường dẫn mới) → giữ trong máy người xem,
    // mở lại ảnh lớn không cần tải lại kể cả khi mã ký đã hết hạn.
    'Cache-Control': 'private, max-age=86400, immutable',
  } });
}
