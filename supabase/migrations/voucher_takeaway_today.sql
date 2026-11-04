-- ============================================================
--  redeem_voucher — mang về chỉ tính bill HÔM NAY chưa giao
--  (thay bản trong vouchers.sql, cùng chữ ký; cài SAU vouchers.sql).
--
--  Bill mang về giao xong ("✓ Đã giao đi") vẫn ở trạng thái 'completed' và không bao giờ thu
--  tiền trên hệ thống, nên bản cũ coi chúng là bill "đang mở" mãi: bill tuần trước 300k đủ mức
--  tối thiểu cho voucher của đơn 50k hôm nay, dòng giảm ghi vào bill cũ đó, và từ đó mọi voucher
--  khác của SĐT này đều báo 'bill_has_voucher'.
--  Bây giờ với bàn mang về: chỉ bill tạo từ 05:00 hôm nay (ngày bán hàng, giờ VN) và chưa giao
--  (pending / preparing) mới nhận voucher, tính mức tối thiểu và "1 bill 1 voucher". Bàn ăn tại
--  quán giữ nguyên như cũ. Chạy lại được nhiều lần.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_voucher(
  p_code text, p_order_ids uuid[], p_staff_id uuid, p_staff_name text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v public.vouchers%ROWTYPE;
  wanted uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_order_ids, '{}')) x ORDER BY 1);
  locked uuid[];
  scope uuid[];
  group_id uuid;
  takeaway boolean;
  target uuid;
  base numeric;
  bill_now numeric;
  reduction integer;
  line_id uuid;
  day_start timestamptz := (date_trunc('day', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '5 hours')
    + interval '5 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh';
BEGIN
  IF COALESCE((SELECT value FROM public.voucher_settings WHERE key = 'voucher_enabled'), 'false') <> 'true' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'disabled');
  END IF;
  SELECT * INTO v FROM public.vouchers WHERE code = upper(btrim(p_code)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v.status = 'used' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'used', 'used_at', v.used_at,
      'table_number', (SELECT table_number FROM public.tables WHERE id = v.used_table_id));
  END IF;
  IF v.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'cancelled'); END IF;
  IF now() < v.valid_from THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet', 'valid_from', v.valid_from);
  END IF;
  IF now() >= v.valid_until THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired', 'valid_until', v.valid_until);
  END IF;
  IF cardinality(wanted) = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_bill'); END IF;

  IF (SELECT count(DISTINCT COALESCE(t.merged_with, t.id))
      FROM public.orders o JOIN public.tables t ON t.id = o.table_id
      WHERE o.id = ANY(wanted)) <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bill_changed');
  END IF;
  SELECT COALESCE(t.merged_with, t.id), COALESCE(t.table_type = 'takeaway', false) INTO group_id, takeaway
  FROM public.orders o JOIN public.tables t ON t.id = o.table_id WHERE o.id = wanted[1];

  -- Mang về: bỏ bill đã giao / từ hôm trước khỏi danh sách máy gửi lên (trang Bàn / trang khách cũ
  -- còn gửi) — không còn bill nào thì coi như chưa có bill.
  IF takeaway THEN
    wanted := ARRAY(SELECT o.id FROM public.orders o WHERE o.id = ANY(wanted)
      AND o.status IN ('pending', 'preparing') AND o.created_at >= day_start ORDER BY o.id);
    IF cardinality(wanted) = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_bill'); END IF;
  END IF;

  -- Phạm vi "1 bill 1 voucher": mọi bill đang mở của nhóm bàn (kể cả bill máy không gửi
  -- lên — gửi thiếu bill không lách được). Mang về chung 1 bàn ảo: chỉ bill cùng khách (SĐT),
  -- hôm nay từ 05:00, chưa giao.
  scope := ARRAY(
    SELECT o.id FROM public.orders o JOIN public.tables t ON t.id = o.table_id
    WHERE COALESCE(t.merged_with, t.id) = group_id
      AND CASE WHEN takeaway THEN o.status IN ('pending', 'preparing') AND o.created_at >= day_start
               ELSE o.status IN ('pending', 'preparing', 'completed') END
      AND (NOT takeaway OR o.id = ANY(wanted)
           OR o.customer_phone IN (SELECT customer_phone FROM public.orders WHERE id = ANY(wanted)))
    ORDER BY o.id);
  -- Khoá cả nhóm (cùng thứ tự id với thanh toán / gộp bill): 2 máy dùng 2 mã cho cùng
  -- bàn thì máy sau chờ máy trước xong rồi mới kiểm tra.
  SELECT array_agg(id ORDER BY id) INTO locked FROM (
    SELECT id FROM public.orders WHERE id = ANY(scope) ORDER BY id FOR UPDATE) l;
  IF NOT (wanted <@ COALESCE(locked, '{}')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bill_changed');
  END IF;

  IF EXISTS (SELECT 1 FROM public.vouchers x JOIN public.order_items i ON i.id = x.used_item_id
             WHERE x.status = 'used' AND i.order_id = ANY(locked)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bill_has_voucher');
  END IF;

  -- Tiền món: dòng giá dương, không phải quà (giống "Giảm %" ở trang Bàn), cả nhóm bàn.
  -- bill_now: tổng bill hiện tại (đã trừ các giảm giá khác) — số sẽ thanh toán.
  SELECT COALESCE(SUM(unit_price::numeric * quantity) FILTER (WHERE unit_price > 0 AND NOT COALESCE(is_gift, false)), 0),
         COALESCE(SUM(unit_price::numeric * quantity), 0)
    INTO base, bill_now
  FROM public.order_items WHERE order_id = ANY(locked);
  IF v.min_bill > 0 AND base < v.min_bill THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'min_bill', 'min_bill', v.min_bill, 'base', base);
  END IF;

  IF v.discount_type = 'percent' THEN
    reduction := floor(base * v.discount_value / 100 / 1000) * 1000;
    IF v.max_discount > 0 THEN reduction := LEAST(reduction, v.max_discount); END IF;
  ELSE
    reduction := v.discount_value;
  END IF;
  -- Không giảm quá tiền món, và chừa bill ít nhất 1.000đ: thanh toán không nhận bill 0đ / âm
  -- (bill đã có giảm tay / vòng xoay mà voucher kéo về 0 thì bàn không đóng được).
  reduction := LEAST(reduction, floor(base)::integer, floor(bill_now)::integer - 1000);
  IF reduction <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero'); END IF;

  -- Bill hệ thống "Gọi nhân viên" (BAO_BEP) không vào Sổ thu chi: dòng giảm ở đó làm lệch sổ.
  SELECT id INTO target FROM public.orders WHERE id = ANY(wanted) AND customer_phone IS DISTINCT FROM 'BAO_BEP'
  ORDER BY created_at, id LIMIT 1;
  IF target IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'bill_changed'); END IF;
  INSERT INTO public.order_items (order_id, menu_item_id, item_name, quantity, unit_price, is_gift,
                                  added_by_id, added_by_name)
  VALUES (target, NULL, 'Voucher ' || v.code, 1, -reduction, false, p_staff_id, p_staff_name)
  RETURNING id INTO line_id;

  UPDATE public.vouchers SET status = 'used', used_at = now(), used_order_id = target,
    used_item_id = line_id, used_table_id = (SELECT table_id FROM public.orders WHERE id = target),
    used_by_name = p_staff_name, discount_amount = reduction, bill_total = floor(base)::integer
  WHERE id = v.id;

  RETURN jsonb_build_object('ok', true, 'code', v.code, 'discount', reduction,
    'order_id', target, 'item_id', line_id);
END $$;

REVOKE ALL ON FUNCTION public.redeem_voucher(text, uuid[], uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_voucher(text, uuid[], uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
