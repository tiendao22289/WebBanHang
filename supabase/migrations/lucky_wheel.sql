-- ============================================================
--  VÒNG XOAY MAY MẮN
--  Khách điền tên + SĐT → quay 1 lần / lượt khách của bàn.
--  Tỉ lệ trúng 100%. Kết quả do SERVER quyết định (/api/lucky/spin),
--  khách không thể tự chọn giải.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.lucky_spins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  table_id      UUID REFERENCES public.tables(id) ON DELETE SET NULL,
  host_table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,

  customer_name  TEXT,
  customer_phone TEXT NOT NULL,

  -- Phần quay được
  prize_key   TEXT NOT NULL,          -- p1..p5 | drink | dish
  prize_type  TEXT NOT NULL,          -- percent | gift_drink | gift_dish
  prize_value NUMERIC DEFAULT 0,      -- % giảm (0 với quà món)
  prize_label TEXT,

  bill_total      INTEGER DEFAULT 0,
  discount_amount INTEGER DEFAULT 0,  -- tiền đã bớt (quà món = 0)

  -- Dòng đã ghi vào bill
  applied_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  applied_item_id  UUID,

  -- Mốc lượt khách, trigger tự điền (không tin client)
  session_started_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT now()
);

-- Dùng lại trigger của ưu đãi Zalo (cùng cột host_table_id)
DROP TRIGGER IF EXISTS trg_lucky_spin_session ON public.lucky_spins;
CREATE TRIGGER trg_lucky_spin_session
BEFORE INSERT ON public.lucky_spins
FOR EACH ROW EXECUTE FUNCTION public.set_review_reward_session();

-- Mỗi lượt khách của bàn chỉ quay 1 lần
CREATE UNIQUE INDEX IF NOT EXISTS lucky_spins_one_per_session
  ON public.lucky_spins (host_table_id, session_started_at);

CREATE INDEX IF NOT EXISTS lucky_spins_phone_idx
  ON public.lucky_spins (customer_phone, created_at DESC);

ALTER TABLE public.lucky_spins ENABLE ROW LEVEL SECURITY;

-- Khách CHỈ được đọc (để xem lại kết quả). Ghi hoàn toàn qua server
-- (SERVICE_ROLE) nên không thể tự tạo lượt quay hay tự chọn giải.
DROP POLICY IF EXISTS "lucky_spins_select" ON public.lucky_spins;
CREATE POLICY "lucky_spins_select" ON public.lucky_spins
  FOR SELECT TO anon, authenticated USING (true);

-- ── Cấu hình (chỉnh trong bảng settings) ────────────────────
INSERT INTO public.settings (key, value) VALUES
  ('lucky_wheel_enabled',       'true'),
  ('lucky_wheel_min_bill',      '0'),       -- 0 = không yêu cầu hoá đơn tối thiểu
  ('lucky_wheel_max',           '50000'),   -- trần tiền giảm cho phần %
  ('lucky_wheel_cooldown_days', '1')        -- mỗi SĐT quay 1 lần / N ngày
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
