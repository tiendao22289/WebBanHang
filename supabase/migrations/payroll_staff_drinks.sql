-- Nước / bia nhân viên uống ở quán: nhân viên tự ghi ở mục Đơn từ (uống gì, ngày nào, mấy chai, giá 1 chai do nhân viên tự ghi),
-- trừ thẳng vào lương tháng của ngày uống (không chờ duyệt). Ghi xong người ghi không sửa / xoá được, chỉ chủ quán xoá.
-- Chỉ máy chủ (service_role) đọc / ghi; mọi thay đổi vào nhật ký staff_data_audit. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_staff_drinks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  drink_date date NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  qty integer NOT NULL CHECK (qty BETWEEN 1 AND 100),
  unit_price integer NOT NULL CHECK (unit_price BETWEEN 1000 AND 1000000),
  amount integer NOT NULL CHECK (amount BETWEEN 1000 AND 100000000),
  year integer NOT NULL CHECK (year BETWEEN 2024 AND 2100),
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_staff_drinks_staff ON public.payroll_staff_drinks(staff_id, drink_date DESC);
CREATE INDEX IF NOT EXISTS payroll_staff_drinks_month ON public.payroll_staff_drinks(year, month);

ALTER TABLE public.payroll_staff_drinks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_staff_drinks FROM anon, authenticated;
GRANT ALL ON public.payroll_staff_drinks TO service_role;

DO $$
BEGIN
  IF to_regprocedure('public.audit_staff_data()') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_staff_data'
      AND tgrelid = 'public.payroll_staff_drinks'::regclass) THEN
    CREATE TRIGGER audit_staff_data AFTER INSERT OR UPDATE OR DELETE ON public.payroll_staff_drinks FOR EACH ROW EXECUTE FUNCTION public.audit_staff_data();
  END IF;
END $$;
