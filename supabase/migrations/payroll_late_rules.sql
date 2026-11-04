-- Luật đi trễ: cho phép trễ bao nhiêu phút, trễ quá thì trừ theo phút (lương ngày ÷ số phút của ca × số
-- phút trễ) và / hoặc trừ một số tiền cố định mỗi lần trễ. scope = 'shop' là mặc định cả quán, hoặc mã
-- nhân viên (luật riêng; use_shop = true: từ ngày đó quay về theo mặc định của quán). Có ngày áp dụng
-- như ca riêng: đổi luật chỉ áp dụng từ hôm đó. Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_late_rules (
  scope text NOT NULL CHECK (scope = 'shop' OR scope ~ '^[0-9a-f-]{36}$'),
  valid_from date NOT NULL,
  allowed_minutes integer NOT NULL DEFAULT 10 CHECK (allowed_minutes BETWEEN 0 AND 600),
  per_minute boolean NOT NULL DEFAULT true,
  fixed_amount integer NOT NULL DEFAULT 0 CHECK (fixed_amount BETWEEN 0 AND 10000000),
  use_shop boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, valid_from)
);

-- Mặc định cả quán chủ chọn 2026-11-04: trễ quá 10 phút trừ 50.000đ mỗi lần và trừ thêm theo phút.
INSERT INTO public.payroll_late_rules(scope, valid_from, allowed_minutes, per_minute, fixed_amount, updated_by)
SELECT 'shop', '2026-11-04', 10, true, 50000, 'Mặc định'
WHERE NOT EXISTS (SELECT 1 FROM public.payroll_late_rules WHERE scope = 'shop');

ALTER TABLE public.payroll_late_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_late_rules FROM anon, authenticated;
GRANT ALL ON public.payroll_late_rules TO service_role;
