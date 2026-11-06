-- Luật đi trễ / về sớm: chủ tự điền số tiền trừ mỗi phút trễ / về sớm (khi bật "trừ theo phút").
--   minute_amount / early_minute_amount trống = như cũ, theo lương (lương ngày ÷ số phút của ca × số phút).
-- Chạy lại được nhiều lần.

ALTER TABLE public.payroll_late_rules ADD COLUMN IF NOT EXISTS minute_amount integer;
ALTER TABLE public.payroll_late_rules ADD COLUMN IF NOT EXISTS early_minute_amount integer;

DO $$
BEGIN
  ALTER TABLE public.payroll_late_rules ADD CONSTRAINT payroll_late_rules_minute_amount_check CHECK (
    (minute_amount IS NULL OR minute_amount BETWEEN 1 AND 1000000)
    AND (early_minute_amount IS NULL OR early_minute_amount BETWEEN 1 AND 1000000));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
