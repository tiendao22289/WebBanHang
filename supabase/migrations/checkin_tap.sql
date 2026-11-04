-- Chấm công bằng nút trên máy quầy cho người không có điện thoại: chủ chọn tài khoản nào được bấm nút (kèm tên
-- hiện trên nút và ảnh nhỏ), bấm nút trên máy quầy = quét mã thành công. Lượt chấm ghi method = 'tap' trong
-- checkin_scans để chủ phân biệt với quét mã. Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.checkin_tap_staff (
  staff_id uuid PRIMARY KEY,
  label text CHECK (label IS NULL OR length(label) <= 30),
  -- Ảnh nhỏ (data:image/jpeg;base64,…) do trang Lương thu nhỏ trước khi gửi.
  photo text CHECK (photo IS NULL OR length(photo) <= 150000),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.checkin_scans ADD COLUMN IF NOT EXISTS method text;

ALTER TABLE public.checkin_tap_staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.checkin_tap_staff FROM anon, authenticated;
GRANT ALL ON public.checkin_tap_staff TO service_role;

-- Mỗi người chỉ một ca đang mở: hai lượt chấm cùng lúc (bấm 2 lần, mạng gửi lại) không mở 2 ca. Dữ liệu cũ đang có
-- người 2 ca mở (hoặc DB không cho tạo chỉ mục) thì bỏ qua, web vẫn chạy như cũ.
DO $$
BEGIN
  IF NOT EXISTS (SELECT staff_id FROM public.attendance_sessions WHERE clock_out IS NULL GROUP BY staff_id HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_open ON public.attendance_sessions(staff_id) WHERE clock_out IS NULL;
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'attendance_one_open: %', SQLERRM;
END $$;
