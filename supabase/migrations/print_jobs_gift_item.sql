-- ============================================================
-- Cho phép 1 print_job chỉ in ĐÚNG 1 (hoặc vài) order_item cụ thể, thay vì
-- luôn lọc theo category như sendSmartPrintJobs() đang làm.
--
-- Vì sao cần: món quà vòng xoay (Tặng nước/Tặng món) được thêm vào bill
-- SAU KHI đơn đã in xong lần đầu. Nếu dùng lại sendSmartPrintJobs() để in
-- lại theo category thì mọi món KHÁC cùng category đã in trước đó sẽ bị
-- in trùng lần nữa. Cột này mở đường cho 1 job in riêng đúng 1 dòng, không
-- đụng gì tới luồng in đơn hàng bình thường.
--
-- Cột nullable, sendSmartPrintJobs() không bao giờ set cột này — job cũ
-- (luồng gửi đơn bình thường) không bị ảnh hưởng gì.
-- ============================================================

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS only_item_ids uuid[];
