-- Thông báo lỗi cho nhân viên (mục 🔔 Thông báo lỗi): nhân viên bấm "Tôi đã xem" từng thông báo, máy chủ ghi giờ — chủ quán xem lại
-- khi cần đối chiếu (nhân viên không chối là không biết). Không bỏ được (chỉ ghi khi đang trống).
--   payroll_peer_reports.seen_at   : người bị báo đã xem lần bị báo lỗi này (chủ đã phạt hoặc bỏ qua).
--   payroll_closes.fines_seen_at   : người đó đã xem thông báo "lương tháng đã chốt: N lỗi, trừ X".
-- Cả hai bảng đã có nhật ký (staff_data_audit) / chỉ máy chủ ghi. Chạy lại được nhiều lần.

ALTER TABLE public.payroll_peer_reports ADD COLUMN IF NOT EXISTS seen_at timestamptz;
ALTER TABLE public.payroll_closes ADD COLUMN IF NOT EXISTS fines_seen_at timestamptz;

-- Thông báo của một người: các lần mình bị báo, mới xử lý trước.
CREATE INDEX IF NOT EXISTS payroll_peer_reports_staff ON public.payroll_peer_reports(staff_id, decided_at DESC);
