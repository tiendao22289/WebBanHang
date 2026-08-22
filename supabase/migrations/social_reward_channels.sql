-- ============================================================
--  MỞ RỘNG ƯU ĐÃI SANG NHIỀU KÊNH (TikTok / Facebook)
--
--  CHẠY SAU file google_review_reward.sql
--  (nếu chưa chạy file đó thì chạy file đó trước, rồi tới file này)
--
--  File này chạy lại nhiều lần vẫn an toàn.
-- ============================================================

-- 1) Mỗi yêu cầu thuộc về 1 kênh. Dữ liệu cũ mặc định là 'google'.
ALTER TABLE public.review_rewards
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'google';

-- 2) Ràng buộc "mỗi bàn 1 lần/ngày" phải tính RIÊNG cho từng kênh,
--    nếu không thì khách đánh giá Google rồi sẽ không follow TikTok được.
DROP INDEX IF EXISTS public.review_rewards_one_per_table_day;

CREATE UNIQUE INDEX IF NOT EXISTS review_rewards_one_per_table_day_channel
  ON public.review_rewards (host_table_id, reward_date, channel)
  WHERE status = 'approved';

-- 3) Index tra cứu theo kênh
DROP INDEX IF EXISTS public.review_rewards_pending_idx;
CREATE INDEX IF NOT EXISTS review_rewards_pending_idx
  ON public.review_rewards (host_table_id, status, channel);

DROP INDEX IF EXISTS public.review_rewards_phone_idx;  -- bản cũ, không có channel
CREATE INDEX IF NOT EXISTS review_rewards_phone_channel_idx
  ON public.review_rewards (customer_phone, channel, status, created_at DESC);

-- ── 4) Cấu hình mặc định 2 kênh mới (chỉnh trong Admin > Cài đặt) ──
--    Kênh Google giữ nguyên key gmap_review_* đã có, không phải làm lại.
INSERT INTO public.settings (key, value) VALUES
  ('tiktok_follow_enabled',       'false'),
  ('tiktok_follow_url',           ''),
  ('tiktok_follow_percent',       '5'),
  ('tiktok_follow_max',           '50000'),
  ('tiktok_follow_min_bill',      '100000'),
  ('tiktok_follow_cooldown_days', '30'),
  ('tiktok_follow_wait_seconds',  '20'),

  ('fb_follow_enabled',       'false'),
  ('fb_follow_url',           ''),
  ('fb_follow_percent',       '5'),
  ('fb_follow_max',           '50000'),
  ('fb_follow_min_bill',      '100000'),
  ('fb_follow_cooldown_days', '30'),
  ('fb_follow_wait_seconds',  '20')
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
