-- So khuôn mặt ở máy quầy (app iPhone "Chấm công"): app tính dấu mặt (128 số, mô hình SFace) ngay
-- trên máy; máy chủ chỉ lưu dấu mặt mẫu, KHÔNG lưu ảnh. Quét mã xong máy quầy so mặt: đúng → ghi giờ,
-- sai → lượt đó không tính, sai 3 lần liền → ghi giờ nhưng ca chờ chủ duyệt (chưa tính lương).
--
-- Chỉ tạo bảng mới, không ALTER bảng cũ. Chỉ máy chủ (service_role) đọc / ghi; khoá công khai trong
-- trang web không thấy gì (dấu mặt là dữ liệu nhạy cảm). Chạy lại được nhiều lần.

-- Dấu mặt mẫu của từng người (3–5 dấu mặt lấy một lần trên máy quầy, có chủ đăng nhập).
CREATE TABLE IF NOT EXISTS public.staff_face_templates (
  staff_id uuid PRIMARY KEY,
  model text NOT NULL,
  -- [[128 số], ...]
  embeddings jsonb NOT NULL,
  kiosk_id uuid,
  enrolled_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Mỗi lần quét mã cần so mặt: chờ máy quầy so (waiting) → ok / wrong / review / expired / cancelled.
CREATE TABLE IF NOT EXISTS public.checkin_face_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  kiosk_id uuid NOT NULL,
  nonce text,
  -- Thông tin lần quét (wifi, điện thoại, cảnh báo) để ghi vào checkin_scans khi được tính.
  scan jsonb NOT NULL DEFAULT '{}'::jsonb,
  clocked text CHECK (clocked IN ('in', 'out')),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'ok', 'wrong', 'review', 'expired', 'cancelled')),
  score real,
  reason text,
  attendance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS checkin_face_checks_kiosk ON public.checkin_face_checks(kiosk_id, status, created_at);
CREATE INDEX IF NOT EXISTS checkin_face_checks_staff ON public.checkin_face_checks(staff_id, created_at);
CREATE INDEX IF NOT EXISTS checkin_face_checks_nonce ON public.checkin_face_checks(nonce);

-- Ca ghi sau 3 lần sai mặt: chờ chủ duyệt (Đúng người → tính; Không phải → bỏ lượt đó).
CREATE TABLE IF NOT EXISTS public.attendance_face_reviews (
  attendance_id uuid NOT NULL,
  clocked text NOT NULL CHECK (clocked IN ('in', 'out')),
  staff_id uuid NOT NULL,
  check_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz,
  PRIMARY KEY (attendance_id, clocked)
);
CREATE INDEX IF NOT EXISTS attendance_face_reviews_status ON public.attendance_face_reviews(status, created_at);

-- Bật / tắt so mặt và độ khắt khe (một dòng id = 1).
CREATE TABLE IF NOT EXISTS public.checkin_face_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT true,
  level text NOT NULL DEFAULT 'normal' CHECK (level IN ('loose', 'normal', 'strict')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.checkin_face_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Máy quầy nào đang chạy app (so mặt được): app hỏi mã vài giây một lần.
CREATE TABLE IF NOT EXISTS public.checkin_kiosk_apps (
  kiosk_id uuid PRIMARY KEY,
  version text,
  seen_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_face_templates', 'checkin_face_checks', 'attendance_face_reviews', 'checkin_face_settings', 'checkin_kiosk_apps'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
