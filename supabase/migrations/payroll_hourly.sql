-- Nhân viên trả lương theo giờ: lương 1 giờ của từng người, có ngày áp dụng (như ca riêng).
-- Ngày làm trả theo giờ = giờ trong ca × lương 1 giờ (trễ / về sớm mất đúng số phút đó);
-- giờ ngoài ca chủ cho tính trả theo giá tăng ca. hourly_rate = 0: từ ngày đó quay về trả
-- theo tháng (ngày công). Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_hourly_rates (
  staff_id uuid NOT NULL,
  valid_from date NOT NULL,
  hourly_rate integer NOT NULL DEFAULT 0 CHECK (hourly_rate BETWEEN 0 AND 10000000),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, valid_from)
);

ALTER TABLE public.payroll_hourly_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_hourly_rates FROM anon, authenticated;
GRANT ALL ON public.payroll_hourly_rates TO service_role;
