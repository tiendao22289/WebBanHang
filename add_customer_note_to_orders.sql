-- ==============================================================
-- MIGRATION: Thêm cột customer_note vào bảng orders
-- ==============================================================
-- Mục đích: lưu ghi chú khách gửi cho bếp khi order Mang Về
-- (vd: "không cay, ít ngọt, giao trước 6h")
--
-- Cách chạy:
-- 1. Mở Supabase Dashboard → SQL Editor
-- 2. Paste toàn bộ file này
-- 3. Bấm Run
--
-- An toàn:
-- - IF NOT EXISTS → chạy nhiều lần không sao
-- - Cột nullable → không ảnh hưởng đơn cũ
-- - Không động vào bàn dine-in (cột chỉ dùng cho takeaway)
-- ==============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_note TEXT;

COMMENT ON COLUMN public.orders.customer_note IS
  'Ghi chú của khách hàng gửi cho bếp (chủ yếu dùng cho đơn Mang Về)';
