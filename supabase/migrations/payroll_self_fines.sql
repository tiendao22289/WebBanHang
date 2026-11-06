-- Nhân viên tự ghi lỗi của chính mình (làm vỡ ly, ghi sai món…) trên trang Lương của họ. Tiền phạt theo danh sách lỗi
-- chủ quán đặt; "lỗi khác" thì 0đ chờ chủ định tiền. Ghi xong nhân viên không sửa / xoá được (chỉ máy chủ ghi bảng phạt,
-- sửa / xoá là việc của chủ quán, mọi thay đổi vào nhật ký staff_data_audit).
-- self_reported: khoản do chính nhân viên đó tự ghi; note: nhân viên ghi thêm (bàn nào, mấy cái…). Chạy lại được nhiều lần.

ALTER TABLE public.payroll_violation_meta ADD COLUMN IF NOT EXISTS self_reported boolean NOT NULL DEFAULT false;
ALTER TABLE public.payroll_violation_meta ADD COLUMN IF NOT EXISTS note text;

DO $$
BEGIN
  ALTER TABLE public.payroll_violation_meta ADD CONSTRAINT payroll_violation_meta_note_len CHECK (note IS NULL OR length(note) <= 300);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
