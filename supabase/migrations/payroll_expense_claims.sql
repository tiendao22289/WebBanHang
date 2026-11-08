-- Khoản chi hộ quán: nhân viên / quản lý tự bỏ tiền chi cho quán (đổ xăng đi chợ, mua đá…), ghi ở trang Lương của mình rồi gửi
-- chủ duyệt. payout: nhân viên chọn nhận lại bằng tiền mặt tại chủ ('cash', chủ đưa lúc duyệt) hay cộng vào lương ('salary').
-- Chủ duyệt: khoản chi vào Sổ thu chi (Chi trong ngày, đúng ngày chi — finance_entry_id); 'salary' cộng vào lương tháng
-- year/month (tháng lúc duyệt; người trả theo kỳ thì vào lần trả kế tiếp). Chỉ máy chủ (service_role) đọc / ghi; mọi thay đổi
-- vào nhật ký staff_data_audit. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  spent_on date NOT NULL,
  item text NOT NULL CHECK (length(item) BETWEEN 1 AND 80),
  amount integer NOT NULL CHECK (amount BETWEEN 1000 AND 50000000),
  note text CHECK (note IS NULL OR length(note) <= 300),
  payout text NOT NULL CHECK (payout IN ('cash', 'salary')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  year integer CHECK (year IS NULL OR year BETWEEN 2024 AND 2100),
  month integer CHECK (month IS NULL OR month BETWEEN 1 AND 12),
  finance_entry_id uuid,
  admin_note text CHECK (admin_note IS NULL OR length(admin_note) <= 300),
  decided_by text,
  decided_at timestamptz,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Chủ đưa tiền trước (vd đưa 100.000đ đi đổ xăng): given_amount = số chủ đưa, amount = số thật đã chi (vào Sổ thu chi).
-- Chi lố (amount > given): phần lố trả lại nhân viên theo payout. Còn thừa (given > amount): nhân viên đưa lại chủ tiền mặt
-- (payout 'cash'), chủ bấm duyệt khi đã nhận. 0 = nhân viên tự bỏ tiền như trước.
ALTER TABLE public.payroll_expense_claims ADD COLUMN IF NOT EXISTS given_amount integer NOT NULL DEFAULT 0
  CHECK (given_amount BETWEEN 0 AND 50000000);
CREATE INDEX IF NOT EXISTS payroll_expense_claims_staff ON public.payroll_expense_claims(staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payroll_expense_claims_month ON public.payroll_expense_claims(year, month) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS payroll_expense_claims_pending ON public.payroll_expense_claims(created_at) WHERE status = 'pending';

ALTER TABLE public.payroll_expense_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_expense_claims FROM anon, authenticated;
GRANT ALL ON public.payroll_expense_claims TO service_role;

DO $$
BEGIN
  IF to_regprocedure('public.audit_staff_data()') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_staff_data'
      AND tgrelid = 'public.payroll_expense_claims'::regclass) THEN
    CREATE TRIGGER audit_staff_data AFTER INSERT OR UPDATE OR DELETE ON public.payroll_expense_claims FOR EACH ROW EXECUTE FUNCTION public.audit_staff_data();
  END IF;
END $$;
