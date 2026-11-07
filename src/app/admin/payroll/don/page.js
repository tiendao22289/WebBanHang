'use client';

// Đơn từ (mục riêng trên thanh menu của nhân viên / quản lý): tự ghi lỗi, chi hộ quán, ứng lương, báo nghỉ — chọn nhanh một
// loại rồi điền; dưới là các đơn đã gửi. Dùng chung trang Lương (cùng dữ liệu, cùng cách gửi), chỉ hiện phần đơn từ.
import PayrollPage from '../page';

export default function StaffFormsPage() {
  return <PayrollPage staffSection="forms" />;
}
