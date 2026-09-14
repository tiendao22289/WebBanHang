-- lucky_wheel_follow_prompt.sql
--
-- Thêm cột follow_prompt_at cho lucky_spins: MỐC khách BẤM nút "Quan tâm Zalo"
-- trên web (gắn đúng lượt quay, không đoán mò theo thời gian).
--
-- DÙNG ĐỂ: trang admin phân biệt 2 trạng thái đang chờ:
--   • 'waiting'    — khách quay xong nhưng CHƯA bấm Quan tâm.
--   • 'need_phone' — khách ĐÃ bấm Quan tâm nhưng CHƯA nhắn SĐT vào khung chat
--                    (follow_prompt_at có, mà zalo_user_id còn trống) → nhân viên
--                    nhắc khách nhắn SĐT để nhận quà.
--
-- An toàn: cột nullable, không backfill. Code chạy được kể cả khi chưa chạy
-- migration (đọc/ghi cột này đều fail-safe) — nhưng nên chạy để có trạng thái mới.

ALTER TABLE public.lucky_spins
  ADD COLUMN IF NOT EXISTS follow_prompt_at timestamptz;

COMMENT ON COLUMN public.lucky_spins.follow_prompt_at IS
  'Mốc khách bấm nút "Quan tâm Zalo" trên web cho lượt quay này. Có giá trị mà zalo_user_id trống = đã bấm Quan tâm nhưng chưa nhắn SĐT.';
