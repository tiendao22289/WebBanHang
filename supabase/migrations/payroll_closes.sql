-- Chốt lương tháng (lưu số lương từng người lúc trả, để tháng đã trả không tự đổi),
-- ngày nghỉ của đơn báo nghỉ (bảng payroll_requests cũ không thêm cột được) và
-- nhân viên nghỉ việc (bảng staff cũ cũng không thêm cột được).
-- Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_closes (
  year integer NOT NULL CHECK (year BETWEEN 2024 AND 2100),
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  staff_id uuid NOT NULL,
  -- Số đã chốt: tên, lương cơ bản, ngày công, giờ làm, tăng ca, ứng, nghỉ, phạt, thực lĩnh.
  snapshot jsonb NOT NULL,
  closed_by text,
  closed_at timestamptz NOT NULL DEFAULT now(),
  -- Đã trả lương cho người này chưa (chủ bấm "Đã trả").
  paid_at timestamptz,
  paid_by text,
  PRIMARY KEY (year, month, staff_id)
);

CREATE TABLE IF NOT EXISTS public.payroll_leave_days (
  request_id uuid PRIMARY KEY,
  staff_id uuid NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  CHECK (to_date >= from_date)
);

-- Nghỉ việc: qua ngày làm cuối thì không đăng nhập / chấm công được nữa, không hiện
-- trong bảng lương các tháng sau. Xoá dòng = đi làm lại.
CREATE TABLE IF NOT EXISTS public.staff_departures (
  staff_id uuid PRIMARY KEY,
  last_day date NOT NULL,
  reason text,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_closes', 'payroll_leave_days', 'staff_departures'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
