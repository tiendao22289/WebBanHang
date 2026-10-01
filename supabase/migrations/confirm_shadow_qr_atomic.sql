-- Staff-confirmed custom QR: status and bank ledger commit together, once.
CREATE OR REPLACE FUNCTION public.confirm_shadow_qr_atomic(
  p_code text, p_expected_amount numeric, p_account_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tx public.payment_transactions%ROWTYPE;
  vn_date date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  SELECT * INTO tx FROM public.payment_transactions
  WHERE transaction_code = p_code FOR UPDATE;
  IF tx.id IS NULL OR tx.order_ids <> 'shadow_qr'
     OR tx.total_amount IS DISTINCT FROM p_expected_amount
     OR tx.account_id IS DISTINCT FROM p_account_id THEN
    RAISE EXCEPTION 'Mã QR, số tiền hoặc tài khoản không khớp';
  END IF;
  IF tx.status = 'completed' THEN
    RETURN jsonb_build_object('success', true, 'already_completed', true);
  END IF;
  IF tx.status <> 'pending' THEN RAISE EXCEPTION 'Mã QR không còn chờ thanh toán'; END IF;

  INSERT INTO public.bank_daily_totals(account_id, date, total_amount)
  VALUES(p_account_id, vn_date, p_expected_amount)
  ON CONFLICT (account_id, date)
  DO UPDATE SET total_amount = public.bank_daily_totals.total_amount + EXCLUDED.total_amount;
  UPDATE public.payment_transactions SET status = 'completed' WHERE id = tx.id;
  RETURN jsonb_build_object('success', true, 'already_completed', false);
END $$;

NOTIFY pgrst, 'reload schema';
