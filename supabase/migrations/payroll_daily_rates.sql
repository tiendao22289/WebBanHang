-- Nhân viên trả lương theo ngày (vd. 120.000đ một ngày công): dùng chung bảng lương theo giờ, cột unit cho biết
-- mức lương (hourly_rate) là của 1 giờ ('hour') hay 1 ngày ('day'). Ngày có chấm công được lương 1 ngày (làm dưới
-- nửa ca tính nửa ngày, trễ / về sớm trừ như lương tháng); ngày không chấm là nghỉ, không lương. Chạy lại được nhiều lần.

ALTER TABLE public.payroll_hourly_rates ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'hour';

DO $$
BEGIN
  ALTER TABLE public.payroll_hourly_rates ADD CONSTRAINT payroll_hourly_rates_unit_check CHECK (unit IN ('hour', 'day'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
