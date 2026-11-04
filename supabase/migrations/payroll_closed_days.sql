-- Ngày quán nghỉ (cả quán đóng cửa, vd. 2 ngày mỗi tháng) và từng người có được nhận lương ngày đó không.
-- Ngày quán nghỉ trả đủ 1 ngày công (lương cơ bản ÷ 26; người theo giờ: số giờ của ca × lương 1 giờ) cho
-- người được nhận; mặc định (chưa có dòng trong payroll_holiday_pay): lương tháng có, theo giờ không.
-- Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.shop_closed_days (
  day date PRIMARY KEY,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payroll_holiday_pay (
  staff_id uuid PRIMARY KEY,
  paid boolean NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_closed_days', 'payroll_holiday_pay'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
