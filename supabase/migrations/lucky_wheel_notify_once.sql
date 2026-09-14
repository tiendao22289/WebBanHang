-- lucky_wheel_notify_once.sql
--
-- Thêm cột notified_at cho lucky_spins để NHẮN TIN CHÚC MỪNG ĐÚNG MỘT LẦN.
--
-- VÌ SAO: tin chúc mừng qua Zalo OA được bắn từ notifyLuckyPrizeApplied, mà hàm
-- này có thể bị gọi nhiều lần cho cùng một lượt quay (webhook follow bắn lại,
-- client poll /api/lucky/claim-ready, và — sau bản vá này — cả nhánh khách chọn
-- quà sau khi follow trong pickGiftItem). Trước đây chỉ chặn bằng applied_item_id
-- nên vẫn có thể nhắn trùng khi 2 luồng chạy song song.
--
-- CÁCH DÙNG: notifyLuckyPrizeApplied làm compare-and-set nguyên tử
--   UPDATE lucky_spins SET notified_at = now() WHERE id = ? AND notified_at IS NULL
-- chỉ luồng thắng (trả về 1 dòng) mới gửi tin. Nếu gửi hỏng thì nhả cờ về NULL
-- để lần sau thử lại (tránh mất tin vĩnh viễn).
--
-- An toàn/không phá dữ liệu cũ: cột nullable, không backfill. NULL = chưa nhắn.
-- PHẢI CHẠY MIGRATION NÀY TRƯỚC KHI DEPLOY code mới (code có đọc/ghi notified_at).

ALTER TABLE public.lucky_spins
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

COMMENT ON COLUMN public.lucky_spins.notified_at IS
  'Mốc đã gửi tin chúc mừng qua Zalo OA. Set-once bằng CAS trong notifyLuckyPrizeApplied để tránh nhắn trùng. NULL = chưa nhắn.';
