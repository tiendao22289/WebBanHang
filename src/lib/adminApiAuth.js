/**
 * Chặn người ngoài gọi thẳng các route /api/admin/*.
 *
 * VÌ SAO CẦN: các route này chạy bằng SERVICE_ROLE_KEY nên bỏ qua toàn bộ RLS.
 * Nếu không kiểm gì, bất kỳ ai biết URL đều gọi được — /api/admin/lucky-status
 * lộ tên + SĐT khách, còn /api/admin/lucky-grant cho phép tự cộng quà vào bill
 * mà không cần Quan tâm Zalo (khách có sẵn spinId của chính mình trong
 * localStorage).
 *
 * CÁCH KIỂM: trang admin gửi header `x-staff-id` lấy từ phiên đăng nhập
 * (localStorage `staffUser`.id). Route đối chiếu với bảng `staff` bằng
 * SERVICE_ROLE_KEY. Khách không có staffId nên không gọi được.
 *
 * GIỚI HẠN ĐÃ BIẾT: bảng `staff` hiện đang TẮT RLS và cấp toàn quyền cho anon,
 * nên người rành kỹ thuật vẫn đọc được staffId (và cả mã PIN) bằng anon key.
 * Lớp này chặn được việc lạm dụng thông thường, nhưng chỉ thật sự vững khi
 * khoá quyền anon trên bảng `staff` và chuyển đăng nhập admin sang server.
 */
import { createClient } from '@supabase/supabase-js';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Nhớ staffId đã xác thực trong instance serverless đang "ấm" — trang admin
// poll lucky-status vài lần/phút trên mỗi máy, không cần hỏi bảng staff mỗi lần.
// TTL ngắn để nhân viên bị xoá mất quyền trong vài phút.
const STAFF_CACHE_TTL_MS = 5 * 60 * 1000;
const verifiedStaff = new Map(); // staffId → hết hạn lúc (ms)

/** true nếu request đến từ một nhân viên đã đăng nhập trang admin. */
export async function isAdminRequest(request) {
  const staffId = request.headers.get('x-staff-id');
  if (!staffId || !UUID.test(staffId)) return false;
  if ((verifiedStaff.get(staffId) || 0) > Date.now()) return true;
  const supabase = getServiceClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from('staff').select('id').eq('id', staffId).maybeSingle();
    if (error) return false;
    if (data) verifiedStaff.set(staffId, Date.now() + STAFF_CACHE_TTL_MS);
    else verifiedStaff.delete(staffId);
    return !!data;
  } catch {
    return false;
  }
}
