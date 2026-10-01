-- Cash collected on the custom QR page is not a bank transfer and must not
-- inflate bank_daily_totals. Keep a separate durable, idempotent receipt.
CREATE TABLE IF NOT EXISTS public.custom_cash_receipts (
  id uuid PRIMARY KEY,
  amount numeric NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.custom_cash_receipts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.record_custom_cash_receipt(
  p_id uuid, p_amount numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE saved_amount numeric;
BEGIN
  IF p_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Phiếu thu tiền mặt không hợp lệ';
  END IF;
  INSERT INTO public.custom_cash_receipts(id, amount) VALUES (p_id, p_amount)
  ON CONFLICT (id) DO NOTHING;
  SELECT amount INTO saved_amount FROM public.custom_cash_receipts WHERE id = p_id;
  IF saved_amount IS DISTINCT FROM p_amount THEN
    RAISE EXCEPTION 'Mã phiếu thu đã dùng với số tiền khác';
  END IF;
  RETURN jsonb_build_object('success', true, 'receipt_id', p_id, 'amount', saved_amount);
END $$;

GRANT EXECUTE ON FUNCTION public.record_custom_cash_receipt(uuid, numeric) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
