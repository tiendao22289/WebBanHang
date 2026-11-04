-- ============================================================
-- "Nhận tiền mặt" ở trang Mã QR: báo lại khi mã phiếu thu ĐÃ được ghi trước đó
-- (thay bản trong custom_cash_receipts.sql, cùng chữ ký và kết quả, thêm already_completed).
--
-- Mã phiếu chống ghi trùng khi bấm lại sau lỗi mạng. Nếu mã cũ bị dùng lại cho một khoản tiền
-- khác cùng số tiền, máy chủ bỏ qua khoản đó mà trước đây vẫn báo "Đã nhận" → mất tiền trong sổ.
-- Bây giờ hàm trả already_completed = true khi phiếu đã có sẵn; /api/admin/receipts chuyển thành
-- alreadyDone và trang Mã QR hỏi nhân viên có phải khoản mới không.
--
-- Hàm cũ có thể thuộc supabase_admin (xem bill_money_guard.sql): không thay được thì chỉ báo,
-- trang Mã QR vẫn chống dùng lại mã cũ ở phía máy. Chạy lại được nhiều lần.
-- ============================================================
DO $do$
BEGIN
  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.record_custom_cash_receipt(
  p_id uuid, p_amount numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  saved_amount numeric;
  inserted boolean;
BEGIN
  IF p_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Phiếu thu tiền mặt không hợp lệ';
  END IF;
  INSERT INTO public.custom_cash_receipts(id, amount) VALUES (p_id, p_amount)
  ON CONFLICT (id) DO NOTHING;
  inserted := FOUND;
  SELECT amount INTO saved_amount FROM public.custom_cash_receipts WHERE id = p_id;
  IF saved_amount IS DISTINCT FROM p_amount THEN
    RAISE EXCEPTION 'Mã phiếu thu đã dùng với số tiền khác';
  END IF;
  RETURN jsonb_build_object('success', true, 'receipt_id', p_id, 'amount', saved_amount,
    'already_completed', NOT inserted);
END $$;
$fn$;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Không thay được record_custom_cash_receipt (không phải chủ hàm)';
END $do$;

NOTIFY pgrst, 'reload schema';
