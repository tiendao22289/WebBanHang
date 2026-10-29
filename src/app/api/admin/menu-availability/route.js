/**
 * POST /api/admin/menu-availability — tắt / bật nhanh món và lựa chọn của món (LOẠI, KHẨU VỊ…) từ
 * trang Bàn, nhiều món một lần.
 *
 * body: { dishes: [{ id, off, mode }], choices: [{ id, option, optIndex, choice, index, off, mode }] }
 *   mode (chọn lúc bấm tắt) 'today' = tắt đến 5h sáng mai rồi tự bán lại · '2h' / '4h' = tắt 2 / 4 tiếng ·
 *   'off' = tắt luôn đến khi bật lại.
 *
 * Chạy ở máy chủ để mỗi món được đọc lại ngay trước khi ghi và chỉ đổi cờ ẩn (xem menuAvailability.mjs):
 * trình duyệt không gửi cả danh sách lựa chọn nên không ghi đè được giá / danh mục in người khác vừa sửa.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';
import { cleanAvailabilityChanges, saveAvailability } from '@/lib/menuAvailability.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request) {
  const session = await getStaffSession(request);
  if (session.code !== 200) {
    const message = session.code === 401 ? 'Chưa đăng nhập nhân viên.' : 'Máy chủ đang bận, thử lại giúp ạ.';
    return NextResponse.json({ ok: false, message }, { status: session.code, headers });
  }
  const changes = cleanAvailabilityChanges(await request.json().catch(() => ({})));
  if (!changes.items.length) {
    return NextResponse.json({ ok: false, message: 'Chưa có món nào để lưu.' }, { status: 400, headers });
  }
  const result = await saveAvailability(staffDatabase(session.user.id), changes);
  console.info('[admin/menu-availability]', session.user.id,
    `saved=${result.saved.length} failed=${result.failed.length} missing=${result.missing.length} skipped=${result.skipped.length}`);
  return NextResponse.json({ ok: result.failed.length === 0, ...result }, { headers });
}
