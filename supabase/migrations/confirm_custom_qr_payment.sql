-- Trang Mã QR (/admin/qr), nút "Xác nhận đã nhận tiền": đổi trạng thái mã và cộng
-- bank_daily_totals của thẻ Ẩn trong một giao dịch, đúng một lần.
--
-- Thay confirm_shadow_qr_atomic: hàm đó dùng tx.id nhưng bảng thật không có cột id
-- (khoá là transaction_code, account_id kiểu text) → từ 01/10/2026 mọi lần xác nhận
-- đều lỗi "record tx has no field id". Hàm cũ thuộc supabase_admin nên workflow
-- "Apply Finance Migration" (vai trò postgres) không thay được → đặt tên mới.
CREATE OR REPLACE FUNCTION public.confirm_custom_qr_payment(
  p_code text, p_expected_amount numeric, p_account_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tx public.payment_transactions%ROWTYPE;
  vn_date date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  SELECT * INTO tx FROM public.payment_transactions
  WHERE transaction_code = p_code FOR UPDATE;
  IF NOT FOUND OR tx.order_ids <> 'shadow_qr'
     OR tx.total_amount IS DISTINCT FROM p_expected_amount
     OR tx.account_id::text IS DISTINCT FROM p_account_id::text THEN
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
  UPDATE public.payment_transactions SET status = 'completed' WHERE transaction_code = tx.transaction_code;
  RETURN jsonb_build_object('success', true, 'already_completed', false);
END $$;

GRANT EXECUTE ON FUNCTION public.confirm_custom_qr_payment(text, numeric, uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
