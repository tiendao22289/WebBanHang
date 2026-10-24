-- Thưởng chuyên cần và phạt.
-- Thưởng: máy gợi ý người cả tháng không trễ, không quên ra ca, đủ số ngày công; chủ
-- tự điền tiền rồi duyệt từng người. Phạt: danh sách lỗi có sẵn (chủ đặt tiền), mỗi
-- khoản phạt có ngày và người ghi; máy gợi ý phạt từ chấm công (trễ quá 30 phút, quên
-- ra ca), chủ duyệt hoặc bỏ qua — không tự trừ. Tiền phạt vẫn nằm ở payroll_violations
-- (bảng cũ không thêm cột được nên ngày / người ghi để ở payroll_violation_meta).
-- Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Mức thưởng chuyên cần gợi ý (0 = chưa dùng thưởng chuyên cần).
  bonus_amount integer NOT NULL DEFAULT 0 CHECK (bonus_amount BETWEEN 0 AND 100000000),
  -- Phải đủ chừng này ngày công trong tháng mới được xét thưởng.
  bonus_min_days numeric(4,1) NOT NULL DEFAULT 22 CHECK (bonus_min_days BETWEEN 0 AND 31),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.payroll_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Thưởng chuyên cần đã duyệt: mỗi người mỗi tháng một khoản, số tiền chủ điền.
CREATE TABLE IF NOT EXISTS public.payroll_bonuses (
  year integer NOT NULL CHECK (year BETWEEN 2024 AND 2100),
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  staff_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
  note text,
  decided_by text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (year, month, staff_id)
);

-- Danh sách lỗi có sẵn. kind: lỗi máy tự gợi ý từ chấm công (late = trễ quá 30 phút,
-- forgot = quên ra ca); lỗi khác chủ tự ghi.
CREATE TABLE IF NOT EXISTS public.payroll_fine_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  amount integer NOT NULL DEFAULT 0 CHECK (amount BETWEEN 0 AND 100000000),
  kind text CHECK (kind IN ('late', 'forgot')),
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_fine_rules_kind ON public.payroll_fine_rules(kind) WHERE kind IS NOT NULL;
-- Lỗi mẫu (tiền để 0: chủ tự đặt). Chỉ thêm khi bảng còn trống.
INSERT INTO public.payroll_fine_rules(name, kind, sort)
SELECT v.name, v.kind, v.sort FROM (VALUES
  ('Đi trễ quá 30 phút', 'late', 1),
  ('Quên bấm ra ca', 'forgot', 2),
  ('Nghỉ không báo trước', NULL, 3),
  ('Làm vỡ ly, chén, dĩa', NULL, 4),
  ('Ghi sai món / quên món của khách', NULL, 5),
  ('Dùng điện thoại trong giờ làm', NULL, 6)
) AS v(name, kind, sort)
WHERE NOT EXISTS (SELECT 1 FROM public.payroll_fine_rules);

-- Ngày phạt, lỗi, người ghi của từng khoản trong payroll_violations.
CREATE TABLE IF NOT EXISTS public.payroll_violation_meta (
  violation_id uuid PRIMARY KEY,
  staff_id uuid,
  fine_date date NOT NULL,
  rule_id uuid,
  -- Khoản phạt từ gợi ý chấm công: ca nào, lỗi gì.
  attendance_id uuid,
  kind text CHECK (kind IN ('late', 'forgot')),
  recorded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payroll_violation_meta_date ON public.payroll_violation_meta(fine_date);

-- Gợi ý phạt chủ đã xử lý (phạt / bỏ qua) để không hiện lại.
CREATE TABLE IF NOT EXISTS public.payroll_fine_reviews (
  attendance_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('late', 'forgot')),
  staff_id uuid NOT NULL,
  work_day date NOT NULL,
  status text NOT NULL CHECK (status IN ('fined', 'skipped')),
  violation_id uuid,
  decided_by text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attendance_id, kind)
);
CREATE INDEX IF NOT EXISTS payroll_fine_reviews_day ON public.payroll_fine_reviews(work_day);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_settings', 'payroll_bonuses', 'payroll_fine_rules', 'payroll_violation_meta', 'payroll_fine_reviews'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
