/**
 * Chặn người ngoài gọi thẳng các route /api/admin/*.
 *
 * VÌ SAO CẦN: các route này chạy bằng SERVICE_ROLE_KEY nên bỏ qua toàn bộ RLS.
 * Nếu không kiểm gì, bất kỳ ai biết URL đều gọi được — /api/admin/lucky-status
 * lộ tên + SĐT khách, còn /api/admin/lucky-grant cho phép tự cộng quà vào bill
 * mà không cần Quan tâm Zalo (khách có sẵn spinId của chính mình trong
 * localStorage).
 *
 * CÁCH KIỂM: cookie phiên đăng nhập admin do máy chủ ký (đăng nhập qua
 * /api/admin/session). Trình duyệt tự gửi cookie với mọi fetch cùng trang, nên
 * trang admin không phải gửi gì thêm; khách không có cookie nên không gọi được.
 */
import { getStaffSession } from '@/lib/statusAuth';

/**
 * true nếu request đến từ một nhân viên đã đăng nhập trang admin — kiểm cookie
 * phiên đăng nhập do máy chủ ký (trình duyệt tự gửi kèm). Không còn tin header
 * x-staff-id, vì mã nhân viên đọc được từ bảng staff bằng khoá công khai.
 */
export async function isAdminRequest(request) {
  try {
    const session = await getStaffSession(request);
    return session.code === 200 && !!session.user;
  } catch {
    return false;
  }
}
