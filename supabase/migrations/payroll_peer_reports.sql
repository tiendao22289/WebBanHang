-- Báo lỗi chéo: nhân viên / quản lý thấy đồng nghiệp làm sai (làm vỡ ly, ghi sai món…) thì báo ở mục Đơn từ. Báo xong CHƯA trừ
-- tiền: chủ quán xem ở Lương → Yêu cầu rồi phạt (tự định số tiền, mặc định theo danh sách lỗi) hoặc bỏ qua. Phạt thì thành một
-- khoản ở payroll_violations (violation_id) như chủ tự ghi; người bị báo không thấy tên người báo, chỉ chủ quán thấy.
-- Chỉ máy chủ (service_role) đọc / ghi; mọi thay đổi vào nhật ký staff_data_audit. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_peer_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  report_date date NOT NULL,
  rule_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  note text CHECK (note IS NULL OR length(note) <= 300),
  suggested_amount integer NOT NULL DEFAULT 0 CHECK (suggested_amount BETWEEN 0 AND 100000000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  amount integer CHECK (amount IS NULL OR amount BETWEEN 0 AND 100000000),
  violation_id uuid,
  admin_note text CHECK (admin_note IS NULL OR length(admin_note) <= 300),
  decided_by text,
  decided_at timestamptz,
  reporter_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_id <> staff_id)
);
CREATE INDEX IF NOT EXISTS payroll_peer_reports_reporter ON public.payroll_peer_reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_peer_reports_pending ON public.payroll_peer_reports(created_at) WHERE status = 'pending';

ALTER TABLE public.payroll_peer_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_peer_reports FROM anon, authenticated;
GRANT ALL ON public.payroll_peer_reports TO service_role;

DO $$
BEGIN
  IF to_regprocedure('public.audit_staff_data()') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_staff_data'
      AND tgrelid = 'public.payroll_peer_reports'::regclass) THEN
    CREATE TRIGGER audit_staff_data AFTER INSERT OR UPDATE OR DELETE ON public.payroll_peer_reports FOR EACH ROW EXECUTE FUNCTION public.audit_staff_data();
  END IF;
END $$;
