// Mã bản đang chạy trên máy chủ. Trang admin so với mã bản của chính nó (nhúng lúc build) để biết đã
// "Đưa lên" bản mới và tự tải lại lúc an toàn (src/lib/useBuildRefresh.js). Không có gì bí mật.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID || '' },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
