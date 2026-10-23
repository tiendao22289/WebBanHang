-- Khoá ghi trực tiếp từ trình duyệt vào dữ liệu nhân viên / Sổ tay / chấm công /
-- lương, ghi nhật ký mọi thay đổi, và ghi riêng từng lần trả nợ Sổ tay.
--
-- Các bảng cũ thuộc supabase_admin nên vai trò postgres (SQL Editor / workflow)
-- không REVOKE hay bật RLS được. Thay vào đó gắn trigger: khoá anon /
-- authenticated (khoá công khai trong trang web) thì không được thêm / sửa /
-- xoá; chỉ máy chủ (service_role) ghi được, qua các API có kiểm tra đăng nhập.
-- Chạy lại được nhiều lần.

-- 1. Chặn ghi từ khoá công khai ------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_client_writes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Bảng % chỉ được ghi qua máy chủ', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

-- 2. Nhật ký thay đổi (không ai sửa / xoá được ngoài máy chủ) -----------------
CREATE TABLE IF NOT EXISTS public.staff_data_audit (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_id uuid,
  op text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  old_row jsonb,
  new_row jsonb,
  db_role text NOT NULL DEFAULT current_user,
  -- Người đang đăng nhập (máy chủ gửi kèm header x-staff-id).
  staff_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_data_audit_row ON public.staff_data_audit(table_name, row_id, changed_at);
ALTER TABLE public.staff_data_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_data_audit FROM anon, authenticated;
GRANT SELECT, INSERT ON public.staff_data_audit TO service_role;
GRANT USAGE ON SEQUENCE public.staff_data_audit_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.audit_staff_data()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor uuid; caller text;
BEGIN
  BEGIN
    actor := NULLIF(current_setting('request.headers', true)::json->>'x-staff-id', '')::uuid;
  EXCEPTION WHEN OTHERS THEN actor := NULL;
  END;
  -- Hàm chạy quyền chủ hàm nên current_user luôn là postgres; vai trò thật của người gọi
  -- (anon / service_role) nằm trong JWT của PostgREST.
  BEGIN
    caller := current_setting('request.jwt.claims', true)::json->>'role';
  EXCEPTION WHEN OTHERS THEN caller := NULL;
  END;
  INSERT INTO public.staff_data_audit(table_name, row_id, op, old_row, new_row, db_role, staff_id)
  VALUES (TG_TABLE_NAME, COALESCE((to_jsonb(NEW)->>'id')::uuid, (to_jsonb(OLD)->>'id')::uuid), TG_OP,
    -- Không lưu mã PIN vào nhật ký.
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) - 'pin' END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) - 'pin' END,
    COALESCE(caller, session_user::text), actor);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Nhật ký hỏng không được chặn việc lưu.
  RAISE WARNING 'staff audit failed (SQLSTATE %)', SQLSTATE;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.audit_staff_data() FROM PUBLIC, anon, authenticated;

-- 3. Từng lần trả nợ Sổ tay: ngày trả, trả cho phiếu nào, lấy tiền từ phiếu nào.
CREATE TABLE IF NOT EXISTS public.staff_note_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL,
  item_index integer,
  amount integer NOT NULL CHECK (amount > 0),
  paid_at timestamptz NOT NULL DEFAULT now(),
  -- Phiếu đi chợ mới có tiền dùng để trả (null = trả thẳng, không qua phiếu mới).
  paid_from_note_id uuid,
  staff_id uuid,
  created_by_name text
);
CREATE INDEX IF NOT EXISTS staff_note_payments_note ON public.staff_note_payments(note_id);
CREATE INDEX IF NOT EXISTS staff_note_payments_paid_at ON public.staff_note_payments(paid_at);
ALTER TABLE public.staff_note_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_note_payments FROM anon, authenticated;
GRANT ALL ON public.staff_note_payments TO service_role;

-- 4. Gắn trigger (chỉ tạo khi chưa có: bảng thuộc supabase_admin nên không DROP được).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff', 'staff_notes', 'attendance_sessions', 'attendance_logs', 'attendance_edit_log',
                           'payroll_requests', 'payroll_config', 'payroll_violations'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'block_client_writes' AND tgrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER block_client_writes BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.block_client_writes()', t);
    END IF;
    IF t <> 'attendance_edit_log' AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_staff_data' AND tgrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER audit_staff_data AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_staff_data()', t);
    END IF;
  END LOOP;
END $$;
