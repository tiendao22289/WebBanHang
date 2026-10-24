-- Chấm công chống gian lận: máy quầy hiện mã QR, mỗi mã dùng 1 lần, phải cùng
-- wifi với máy quầy, mỗi nhân viên một điện thoại, tự đóng ca khi quên ra ca,
-- nhân viên xin sửa giờ để chủ duyệt. Giờ làm (chung hoặc riêng từng người):
-- chỉ tính lương trong ca, giờ ngoài ca chờ chủ duyệt.
--
-- Chỉ tạo bảng mới (bảng cũ thuộc supabase_admin, không ALTER được). Chỉ máy
-- chủ (service_role) đọc / ghi; khoá công khai trong trang web không thấy gì.
-- Chạy lại được nhiều lần.

-- Máy quầy (điện thoại / máy tính bảng chỉ để hiện mã QR).
CREATE TABLE IF NOT EXISTS public.checkin_kiosks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  -- Địa chỉ mạng máy quầy dùng gần đây: [{ "ip": "...", "at": "..." }]
  recent_ips jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Mỗi mã QR chỉ dùng được một lần (khoá chính chặn hai người dùng chung).
CREATE TABLE IF NOT EXISTS public.checkin_nonces (
  nonce text PRIMARY KEY,
  staff_id uuid,
  used_at timestamptz NOT NULL DEFAULT now()
);

-- Mọi lần chấm công (kể cả bị chặn) để chủ xem lại.
CREATE TABLE IF NOT EXISTS public.checkin_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid,
  kiosk_id uuid,
  nonce text,
  action text NOT NULL CHECK (action IN ('in', 'out', 'blocked')),
  -- Cảnh báo: other_network, unknown_device, shared_device, admin_no_qr
  warnings text[] NOT NULL DEFAULT '{}',
  enforced boolean NOT NULL DEFAULT false,
  ip text,
  device_id text,
  user_agent text,
  attendance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkin_scans_created ON public.checkin_scans(created_at);
CREATE INDEX IF NOT EXISTS checkin_scans_nonce ON public.checkin_scans(nonce);

-- Điện thoại đã đăng ký của từng nhân viên (một người một máy, một máy một người).
CREATE TABLE IF NOT EXISTS public.staff_checkin_devices (
  staff_id uuid PRIMARY KEY,
  device_id text NOT NULL UNIQUE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cài đặt chấm công (một dòng id = 1).
CREATE TABLE IF NOT EXISTS public.checkin_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- false = chạy thử: chỉ ghi lại khác wifi / máy lạ, chưa chặn.
  enforce boolean NOT NULL DEFAULT false,
  -- Tính giờ theo ca từ ngày này (ngày sau khi cài); ngày trước vẫn tính như cũ.
  hours_from date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.checkin_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Giờ làm chung của quán, áp dụng từ ngày valid_from (đổi giờ không tính lại ngày cũ).
-- Giờ đóng trước giờ mở = sau nửa đêm. Vào trễ / về sớm trong grace_minutes phút vẫn tính đủ.
CREATE TABLE IF NOT EXISTS public.checkin_hours (
  valid_from date PRIMARY KEY,
  opening_time text NOT NULL CHECK (opening_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  closing_time text NOT NULL CHECK (closing_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  grace_minutes integer NOT NULL DEFAULT 10 CHECK (grace_minutes BETWEEN 0 AND 60),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (opening_time <> closing_time)
);
INSERT INTO public.checkin_hours(valid_from, opening_time, closing_time, grace_minutes) VALUES ('2000-01-01', '14:00', '23:00', 10) ON CONFLICT (valid_from) DO NOTHING;

-- Ca riêng của từng nhân viên, áp dụng từ ngày valid_from. Giờ để trống = quay về giờ quán.
CREATE TABLE IF NOT EXISTS public.staff_shifts (
  staff_id uuid NOT NULL,
  valid_from date NOT NULL,
  start_time text CHECK (start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  end_time text CHECK (end_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, valid_from),
  CHECK ((start_time IS NULL AND end_time IS NULL) OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time <> end_time))
);

-- Nhật ký sửa giờ các ca: admin sửa, duyệt đơn sửa giờ, máy tự đóng ca quên ra ca.
-- (attendance_edit_log cũ có khoá ngoại sang bảng attendance_logs cũ nên không ghi được
-- cho attendance_sessions — mọi lần ghi trước đây đều bị từ chối.)
CREATE TABLE IF NOT EXISTS public.attendance_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id uuid NOT NULL,
  staff_id uuid,
  field_name text NOT NULL,
  old_value text,
  new_value text,
  changed_by text,
  note text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_changes_attendance ON public.attendance_changes(attendance_id);
CREATE INDEX IF NOT EXISTS attendance_changes_by ON public.attendance_changes(changed_by, changed_at);

-- Chủ duyệt giờ ngoài ca của một ca làm: cho tính (bao nhiêu phút) hoặc không tính.
CREATE TABLE IF NOT EXISTS public.attendance_extra_reviews (
  attendance_id uuid PRIMARY KEY,
  staff_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('approved', 'rejected')),
  minutes integer NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  decided_by text,
  decided_at timestamptz NOT NULL DEFAULT now()
);

-- Nhân viên xin sửa giờ vào / ra của một ca, chủ duyệt.
CREATE TABLE IF NOT EXISTS public.attendance_fix_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  attendance_id uuid NOT NULL,
  clock_in timestamptz,
  clock_out timestamptz,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_fix_requests_status ON public.attendance_fix_requests(status, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['checkin_kiosks', 'checkin_nonces', 'checkin_scans', 'staff_checkin_devices', 'checkin_settings', 'checkin_hours', 'attendance_fix_requests', 'staff_shifts', 'attendance_extra_reviews', 'attendance_changes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
