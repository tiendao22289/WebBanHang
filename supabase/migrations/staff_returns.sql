-- Nhân viên nghỉ việc rồi đi làm lại: chủ bấm "Đi làm lại" thì dòng nghỉ việc (staff_departures) bị xoá, nên ghi
-- lại ở đây ngày làm cuối của lần nghỉ và ngày đi làm lại. Lương ngày quán nghỉ chỉ tính lúc đang làm: không tính
-- những ngày giữa hai ngày đó (bảng staff cũ không thêm cột được). Mỗi lần đi làm lại một dòng.
-- Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.staff_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  left_day date NOT NULL,
  return_day date NOT NULL,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (return_day > left_day)
);

CREATE INDEX IF NOT EXISTS staff_returns_staff ON public.staff_returns(staff_id);

ALTER TABLE public.staff_returns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_returns FROM anon, authenticated;
GRANT ALL ON public.staff_returns TO service_role;
