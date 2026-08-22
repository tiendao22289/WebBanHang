-- ============================================================
--  ƯU ĐÃI ĐÁNH GIÁ GOOGLE MAPS
--  Khách bấm đánh giá -> nhân viên duyệt -> chèn 1 dòng
--  order_items giá ÂM vào bill để giảm giá cho cả bàn.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.review_rewards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Bàn khách đang ngồi + bàn host của nhóm gộp (dùng để tính tổng cả bàn)
  table_id      UUID REFERENCES public.tables(id) ON DELETE SET NULL,
  host_table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,

  -- Bill của chính khách bấm đánh giá (để biết ai xin)
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,

  customer_name  TEXT,
  customer_phone TEXT,

  -- pending        : khách vừa mở link Google, chưa xác nhận
  -- awaiting_staff : khách đã bấm "Tôi đã đánh giá xong", chờ NV duyệt
  -- approved       : NV đã duyệt, đã trừ tiền
  -- rejected       : NV từ chối
  -- cancelled      : khách đóng overlay / hết hạn
  status TEXT NOT NULL DEFAULT 'pending',

  -- Số liệu chốt tại thời điểm DUYỆT
  bill_total       INTEGER DEFAULT 0,
  discount_percent NUMERIC DEFAULT 0,
  discount_amount  INTEGER DEFAULT 0,

  -- Dòng order_items giá âm đã chèn
  applied_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  applied_item_id  UUID,

  approved_by TEXT,
  reject_reason TEXT,

  -- Kênh ưu đãi: google | tiktok | facebook
  channel TEXT NOT NULL DEFAULT 'google',

  -- Ngày (giờ VN) — dùng cho ràng buộc "mỗi bàn 1 lần/ngày/kênh"
  reward_date DATE,

  created_at   TIMESTAMPTZ DEFAULT now(),
  requested_at TIMESTAMPTZ,
  decided_at   TIMESTAMPTZ
);

-- ── Nâng cấp bảng đã tồn tại từ bản trước ──────────────────
-- CREATE TABLE IF NOT EXISTS ở trên sẽ BỎ QUA nếu bảng đã có,
-- nên các cột thêm sau phải khai báo lại ở đây thì chạy lại file
-- này trên database cũ mới không lỗi "column does not exist".
ALTER TABLE public.review_rewards
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'google';
ALTER TABLE public.review_rewards
  ADD COLUMN IF NOT EXISTS reward_date DATE;
ALTER TABLE public.review_rewards
  ADD COLUMN IF NOT EXISTS reject_reason TEXT;

-- Index cũ (chưa có channel) — bỏ đi để thay bằng bản mới bên dưới
DROP INDEX IF EXISTS public.review_rewards_one_per_table_day;
DROP INDEX IF EXISTS public.review_rewards_phone_idx;
DROP INDEX IF EXISTS public.review_rewards_pending_idx;

-- Tự điền reward_date theo giờ Việt Nam
CREATE OR REPLACE FUNCTION public.set_review_reward_date()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reward_date IS NULL THEN
    NEW.reward_date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_review_reward_date ON public.review_rewards;
CREATE TRIGGER trg_review_reward_date
BEFORE INSERT ON public.review_rewards
FOR EACH ROW EXECUTE FUNCTION public.set_review_reward_date();

-- Mỗi nhóm bàn chỉ được DUYỆT 1 lần/ngày/kênh
-- (chống 5 khách cùng bàn cùng xin một ưu đãi)
CREATE UNIQUE INDEX IF NOT EXISTS review_rewards_one_per_table_day_channel
  ON public.review_rewards (host_table_id, reward_date, channel)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS review_rewards_pending_idx
  ON public.review_rewards (host_table_id, status, channel);

CREATE INDEX IF NOT EXISTS review_rewards_phone_channel_idx
  ON public.review_rewards (customer_phone, channel, status, created_at DESC);

-- RLS: giữ đúng mức bảo mật hiện tại của dự án (app chạy bằng anon key,
-- cả trang khách lẫn trang nhân viên) — xem ghi chú ở cuối file.
ALTER TABLE public.review_rewards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "review_rewards_select" ON public.review_rewards;
CREATE POLICY "review_rewards_select" ON public.review_rewards
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "review_rewards_insert" ON public.review_rewards;
CREATE POLICY "review_rewards_insert" ON public.review_rewards
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "review_rewards_update" ON public.review_rewards;
CREATE POLICY "review_rewards_update" ON public.review_rewards
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- ── Cấu hình mặc định (chỉnh trong Admin > Cài đặt) ──────────
INSERT INTO public.settings (key, value) VALUES
  ('gmap_review_enabled',       'false'),
  ('gmap_review_url',           ''),
  ('gmap_review_percent',       '5'),
  ('gmap_review_max',           '50000'),
  ('gmap_review_min_bill',      '100000'),
  ('gmap_review_cooldown_days', '30'),
  ('gmap_review_wait_seconds',  '20')
ON CONFLICT (key) DO NOTHING;

-- Cho phép realtime để máy khách nhận được kết quả duyệt ngay
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.review_rewards;
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- đã thêm rồi thì bỏ qua
  WHEN undefined_object THEN NULL;  -- chưa bật realtime thì bỏ qua
END $$;

NOTIFY pgrst, 'reload schema';

-- ============================================================
--  GHI CHÚ BẢO MẬT
--  Policy ở trên mở như các bảng khác trong dự án (customer_reviews,
--  orders...) vì toàn bộ app — kể cả màn hình nhân viên — dùng anon key.
--  Nghĩa là về lý thuyết khách rành kỹ thuật có thể tự set status='approved'.
--  Muốn khoá chặt thì phải chuyển bước duyệt sang API route dùng
--  SERVICE_ROLE_KEY và siết policy UPDATE lại. Chưa làm ở bản này.
-- ============================================================

-- ============================================================
--  Tên hiển thị cho các dòng order_items KHÔNG gắn menu_item
--  (dòng giảm giá đánh giá Google). Không có cột này thì bill
--  sẽ hiện "Món đã xoá".
-- ============================================================
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS item_name TEXT;

NOTIFY pgrst, 'reload schema';
