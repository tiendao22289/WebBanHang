-- ============================================================
--  CƠ CẤU QUÀ VÒNG XOAY — chuyển từ code sang database
--  để chỉnh trong Admin > Cài đặt (bật/tắt, tên quà, tỉ lệ,
--  thêm/bớt quà) mà không cần deploy lại.
--
--  CHẠY SAU file lucky_wheel.sql. Chạy lại nhiều lần vẫn an toàn.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.lucky_prizes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  label TEXT NOT NULL,              -- tên quà khách đọc
  short TEXT,                       -- chữ hiện trên múi vòng xoay (ngắn)

  -- percent : giảm % hoá đơn (value = số %)
  -- amount  : giảm số tiền cố định (value = số tiền)
  -- gift    : tặng món/nước — ghi dòng giá 0 vào bill cho nhân viên mang ra
  type  TEXT NOT NULL DEFAULT 'percent',
  value NUMERIC NOT NULL DEFAULT 0,

  weight     NUMERIC NOT NULL DEFAULT 1,   -- tỉ lệ quay (không cần tổng = 100)
  color      TEXT DEFAULT '#f472b6',       -- màu múi
  is_active  BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lucky_prizes_active_idx
  ON public.lucky_prizes (is_active, sort_order);

ALTER TABLE public.lucky_prizes ENABLE ROW LEVEL SECURITY;

-- Khách cần đọc để vẽ vòng xoay. Sửa cơ cấu quà thì làm ở trang Cài đặt
-- (app dùng chung anon key nên policy mở như các bảng cấu hình khác).
DROP POLICY IF EXISTS "lucky_prizes_select" ON public.lucky_prizes;
CREATE POLICY "lucky_prizes_select" ON public.lucky_prizes
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "lucky_prizes_write" ON public.lucky_prizes;
CREATE POLICY "lucky_prizes_write" ON public.lucky_prizes
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- ── Nạp cơ cấu quà mặc định (chỉ khi bảng còn trống) ────────
INSERT INTO public.lucky_prizes (label, short, type, value, weight, color, sort_order)
SELECT * FROM (VALUES
  ('Giảm 1% hoá đơn',            '1%',       'percent', 1, 30, '#f472b6', 1),
  ('Giảm 2% hoá đơn',            '2%',       'percent', 2, 24, '#facc15', 2),
  ('Giảm 3% hoá đơn',            '3%',       'percent', 3, 18, '#4ade80', 3),
  ('Giảm 4% hoá đơn',            '4%',       'percent', 4, 12, '#38bdf8', 4),
  ('Giảm 5% hoá đơn',            '5%',       'percent', 5,  9, '#a78bfa', 5),
  ('Tặng 1 nước ngọt tuỳ chọn',  '🥤 Nước',  'gift',    0,  5, '#fb923c', 6),
  ('Tặng 1 món 40.000 – 50.000đ','🍤 Món',   'gift',    0,  2, '#f87171', 7)
) AS seed(label, short, type, value, weight, color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.lucky_prizes);

NOTIFY pgrst, 'reload schema';
