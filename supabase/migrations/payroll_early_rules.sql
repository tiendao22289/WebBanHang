-- Luật đi trễ thêm công tắc và luật về sớm (cùng dòng, cùng ngày áp dụng, mặc định của quán hoặc riêng từng người):
--   late_on  = false: được phép đi trễ — vẫn ghi lại, không trừ tiền.
--   early_*: về sớm cho phép bao nhiêu phút, quá thì trừ theo phút về sớm (lương ngày ÷ số phút của ca) và / hoặc tiền cố định
--            mỗi lần; early_on = false: được phép về sớm. early_allowed_minutes trống = như cũ (về sớm từ 30 phút trừ theo phút).
-- Chạy lại được nhiều lần.

ALTER TABLE public.payroll_late_rules ADD COLUMN IF NOT EXISTS late_on boolean NOT NULL DEFAULT true;
ALTER TABLE public.payroll_late_rules ADD COLUMN IF NOT EXISTS early_on boolean NOT NULL DEFAULT true;
ALTER TABLE public.payroll_late_rules ADD COLUMN IF NOT EXISTS early_allowed_minutes integer;
ALTER TABLE public.payroll_late_rules ADD COLUMN IF NOT EXISTS early_per_minute boolean;
ALTER TABLE public.payroll_late_rules ADD COLUMN IF NOT EXISTS early_fixed_amount integer;

DO $$
BEGIN
  ALTER TABLE public.payroll_late_rules ADD CONSTRAINT payroll_late_rules_early_check CHECK (
    (early_allowed_minutes IS NULL OR early_allowed_minutes BETWEEN 0 AND 600)
    AND (early_fixed_amount IS NULL OR early_fixed_amount BETWEEN 0 AND 10000000));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
