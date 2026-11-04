-- Lịch quán nghỉ lặp lại mỗi tháng theo âm lịch (vd. mùng 1 và rằm), có ngày áp dụng; ngày chủ bấm "mở cửa"
-- (shop_closed_days.skip = true) bỏ khỏi lịch. Ngày thêm tay vẫn nằm ở shop_closed_days (skip = false).
-- Cần payroll_closed_days.sql chạy trước. Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

ALTER TABLE public.shop_closed_days ADD COLUMN IF NOT EXISTS skip boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.shop_closed_rules (
  valid_from date PRIMARY KEY,
  -- Ngày âm lịch quán nghỉ mỗi tháng (1–30); rỗng = từ ngày đó không nghỉ theo lịch.
  lunar_days integer[] NOT NULL DEFAULT '{}' CHECK (lunar_days <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30]),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Chủ quán chọn 2026-11-04: nghỉ mùng 1 và rằm (15) âm lịch mỗi tháng, từ tháng 11/2026.
INSERT INTO public.shop_closed_rules(valid_from, lunar_days, updated_by)
SELECT '2026-11-01', '{1,15}', 'Mặc định'
WHERE NOT EXISTS (SELECT 1 FROM public.shop_closed_rules);

ALTER TABLE public.shop_closed_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shop_closed_rules FROM anon, authenticated;
GRANT ALL ON public.shop_closed_rules TO service_role;
