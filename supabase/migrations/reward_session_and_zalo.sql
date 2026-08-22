-- ============================================================
--  1) SỬA LỖI: giới hạn theo LƯỢT KHÁCH thay vì theo NGÀY
--  2) Thêm kênh Zalo
--
--  CHẠY SAU 2 file trước. Chạy lại nhiều lần vẫn an toàn.
--
--  VẤN ĐỀ CŨ: ràng buộc là (bàn + ngày + kênh) nên bàn 1 sáng có
--  khách nhận ưu đãi rồi thì cả ngày hôm đó MỌI khách sau ngồi
--  bàn 1 đều bị chặn — dù là người hoàn toàn khác.
--  CÁCH SỬA: mốc so sánh là tables.occupied_at (thời điểm mở bàn).
--  Bàn thanh toán xong -> occupied_at reset -> lượt khách mới
--  được tính là lượt riêng.
-- ============================================================

ALTER TABLE public.review_rewards
  ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ;

-- Trigger tự điền mốc lượt khách bằng cách ĐỌC TRỰC TIẾP từ bảng tables.
-- Cố tình không tin giá trị client gửi lên — khách sửa request cũng
-- không giả mạo được mốc phiên để xin ưu đãi lần hai.
CREATE OR REPLACE FUNCTION public.set_review_reward_session()
RETURNS TRIGGER AS $$
BEGIN
  SELECT t.occupied_at INTO NEW.session_started_at
  FROM public.tables t
  WHERE t.id = NEW.host_table_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_review_reward_session ON public.review_rewards;
CREATE TRIGGER trg_review_reward_session
BEFORE INSERT ON public.review_rewards
FOR EACH ROW EXECUTE FUNCTION public.set_review_reward_session();

-- Backfill dữ liệu cũ: coi mỗi bản ghi cũ là một lượt riêng
-- (dùng created_at) để không vô tình chặn khách mới.
UPDATE public.review_rewards
SET session_started_at = created_at
WHERE session_started_at IS NULL;

-- Ràng buộc mới: 1 lần / LƯỢT KHÁCH / kênh (thay cho 1 lần/ngày/kênh)
DROP INDEX IF EXISTS public.review_rewards_one_per_table_day_channel;
DROP INDEX IF EXISTS public.review_rewards_one_per_table_day;

CREATE UNIQUE INDEX IF NOT EXISTS review_rewards_one_per_session_channel
  ON public.review_rewards (host_table_id, session_started_at, channel)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS review_rewards_session_idx
  ON public.review_rewards (host_table_id, session_started_at, status);

-- ── Kênh Zalo ────────────────────────────────────────────────
INSERT INTO public.settings (key, value) VALUES
  ('zalo_follow_enabled',       'false'),
  ('zalo_follow_url',           ''),
  ('zalo_follow_percent',       '3'),
  ('zalo_follow_max',           '50000'),
  ('zalo_follow_min_bill',      '100000'),
  ('zalo_follow_cooldown_days', '30'),
  ('zalo_follow_wait_seconds',  '20')
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
