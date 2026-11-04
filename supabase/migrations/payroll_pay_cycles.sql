-- Trả lương theo kỳ cho người trả theo ngày / theo giờ: mỗi người một kỳ N ngày (vd. 7 ngày, 10 ngày) tính từ start_day.
-- Chủ bấm "Đã thanh toán lương" thì lưu một lần trả (payroll_payouts): trả từ ngày đầu kỳ tới hết ngày to_day, số tiền,
-- chi tiết tiền từng ngày đã trả + ứng / phạt / thưởng đã trừ / cộng. Kỳ sau bắt đầu ngày sau to_day.
-- Chỉ máy chủ (service_role) đọc / ghi. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.payroll_pay_cycles (
  staff_id uuid PRIMARY KEY,
  every_days integer NOT NULL CHECK (every_days BETWEEN 1 AND 31),
  start_day date NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payroll_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL,
  from_day date NOT NULL,
  to_day date NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  -- { days: { 'YYYY-MM-DD': tiền }, advances: [{ id, key, amount }], fines: [...], bonuses: [{ key, amount }] }
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at timestamptz NOT NULL DEFAULT now(),
  paid_by text,
  CHECK (to_day >= from_day),
  -- Bấm hai lần / hai máy cùng lúc: chỉ một lần trả cho một kỳ.
  UNIQUE (staff_id, from_day)
);

CREATE INDEX IF NOT EXISTS payroll_payouts_staff_to ON public.payroll_payouts(staff_id, to_day);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_pay_cycles', 'payroll_payouts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
