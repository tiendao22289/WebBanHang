-- Thêm vai trò Quản lý ('manager') cho tài khoản: chấm công bằng quét mã như nhân viên,
-- được thêm Thực đơn, Sổ tay và Đánh giá khách hàng (quyền từng trang ở src/lib/staffRoles.mjs).
-- Chạy lại được nhiều lần.
ALTER TABLE public.staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE public.staff ADD CONSTRAINT staff_role_check CHECK (role IN ('admin', 'manager', 'staff'));
