-- Nhân viên xác nhận đã nhận lương: chủ quán đánh dấu đã trả (lương tháng — payroll_closes.paid_at, trả theo kỳ —
-- payroll_payouts.paid_at), nhân viên bấm "Tôi đã nhận" trên điện thoại → received_at. Đã xác nhận thì chủ không bỏ dấu
-- "đã trả" / không bỏ lần trả được nữa (tránh cãi "chưa nhận" / trả hai lần). Chạy lại được nhiều lần.

ALTER TABLE public.payroll_closes ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE public.payroll_payouts ADD COLUMN IF NOT EXISTS received_at timestamptz;
