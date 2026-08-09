-- ============================================================
-- Tự động dọn đơn ẩn khỏi thống kê mỗi ngày (pg_cron)
--
-- Bối cảnh: khi thẻ chính đầy hạn mức trong ngày, các bill sau đó
-- được gắn cờ is_hidden_from_stats = true (xem process_bank_payment).
-- Job này XOÁ HẲN các đơn ẩn đó vào 03:00 giờ VN mỗi ngày, coi như
-- chưa từng tồn tại. order_items & print_jobs tự xoá theo FK CASCADE.
--
-- Lưu ý:
--   - pg_cron chạy theo UTC → 03:00 giờ VN (UTC+7) = 20:00 UTC.
--   - Đơn đang ăn dở vắt qua nửa đêm KHÔNG bị đụng: lúc job chạy chúng
--     chưa thanh toán nên is_hidden_from_stats vẫn là null.
--   - Đơn "báo bếp" (BAO_BEP) cũng mang cờ này và sẽ bị dọn cùng — đúng ý.
--   - bank_daily_totals không bị đụng (khóa theo date, tự reset mỗi ngày).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Idempotent: gỡ job cũ (nếu có) rồi tạo lại
SELECT cron.unschedule('purge-hidden-orders')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-hidden-orders');

SELECT cron.schedule(
  'purge-hidden-orders',
  '0 20 * * *',   -- 20:00 UTC = 03:00 giờ VN mỗi ngày
  $$DELETE FROM orders WHERE is_hidden_from_stats = true$$
);
