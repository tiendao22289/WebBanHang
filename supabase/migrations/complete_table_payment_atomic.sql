-- Close the entire live merged group, record transfer totals, and release its
-- tables in one database transaction. Any mismatch/error rolls back all steps.
CREATE OR REPLACE FUNCTION public.complete_table_payment_atomic(
  p_table_id uuid,
  p_expected_order_ids uuid[],
  p_expected_amount numeric,
  p_payment_method text,
  p_account_id uuid DEFAULT NULL,
  p_hide_stats boolean DEFAULT false,
  p_staff_id uuid DEFAULT NULL,
  p_staff_name text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  host_id uuid;
  table_ids uuid[];
  order_ids uuid[];
  live_total numeric;
  account_row public.bank_accounts%ROWTYPE;
  bank_result jsonb;
  hide_stats boolean := COALESCE(p_hide_stats, false);
  vn_date date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  IF p_payment_method NOT IN ('cash', 'transfer') OR p_expected_amount IS NULL
     OR p_expected_amount <= 0 OR cardinality(p_expected_order_ids) < 1 THEN
    RAISE EXCEPTION 'Thông tin thanh toán không hợp lệ';
  END IF;

  SELECT COALESCE(merged_with, id) INTO host_id
  FROM public.tables WHERE id = p_table_id;
  IF host_id IS NULL THEN RAISE EXCEPTION 'Không tìm thấy bàn'; END IF;

  SELECT array_agg(id ORDER BY id) INTO table_ids
  FROM (SELECT id FROM public.tables
        WHERE id = host_id OR merged_with = host_id
        ORDER BY id FOR UPDATE) locked_tables;
  IF NOT p_table_id = ANY(table_ids) THEN
    RAISE EXCEPTION 'Nhóm bàn đã thay đổi';
  END IF;

  SELECT array_agg(id ORDER BY id) INTO order_ids
  FROM (SELECT id FROM public.orders
        WHERE table_id = ANY(table_ids)
          AND status IN ('pending', 'preparing', 'completed')
        ORDER BY id FOR UPDATE) locked_orders;
  IF order_ids IS NULL OR order_ids IS DISTINCT FROM
     ARRAY(SELECT unnest(p_expected_order_ids) ORDER BY 1) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'bill_changed');
  END IF;

  SELECT COALESCE(SUM(i.unit_price::numeric * i.quantity), 0) INTO live_total
  FROM public.order_items i WHERE i.order_id = ANY(order_ids);
  IF live_total IS DISTINCT FROM p_expected_amount OR live_total <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_changed', 'total', live_total);
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_items i
             WHERE i.order_id = ANY(order_ids) AND i.menu_item_id IS NOT NULL
               AND NOT COALESCE(i.is_gift, false) AND i.unit_price <= 0) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'unpriced_item');
  END IF;

  IF p_payment_method = 'transfer' THEN
    IF p_account_id IS NOT NULL THEN
      SELECT * INTO account_row FROM public.bank_accounts
      WHERE id = p_account_id AND is_active = true FOR UPDATE;
      IF account_row.id IS NULL THEN RAISE EXCEPTION 'Tài khoản QR không còn hoạt động'; END IF;
      INSERT INTO public.bank_daily_totals(account_id, date, total_amount)
      VALUES (p_account_id, vn_date, live_total)
      ON CONFLICT (account_id, date)
      DO UPDATE SET total_amount = public.bank_daily_totals.total_amount + EXCLUDED.total_amount;
      hide_stats := hide_stats OR NOT account_row.is_visible;
    ELSE
      bank_result := public.process_bank_payment(live_total::integer, vn_date);
      hide_stats := hide_stats OR COALESCE((bank_result->>'should_hide_stats')::boolean, false);
    END IF;
  ELSE
    hide_stats := false;
  END IF;

  UPDATE public.orders o SET
    total_amount = (SELECT COALESCE(SUM(i.unit_price::numeric * i.quantity), 0)
                    FROM public.order_items i WHERE i.order_id = o.id),
    status = 'paid', payment_method = p_payment_method,
    paid_at = now(), paid_by_id = p_staff_id, paid_by_name = p_staff_name,
    created_at = now(), is_hidden_from_stats = hide_stats
  WHERE o.id = ANY(order_ids);

  UPDATE public.tables SET status = 'available', occupied_at = NULL, merged_with = NULL
  WHERE id = ANY(table_ids);

  RETURN jsonb_build_object('success', true, 'total', live_total,
    'order_ids', order_ids, 'table_ids', table_ids,
    'account_id', CASE WHEN p_payment_method = 'transfer' THEN
      COALESCE(p_account_id, (bank_result->>'account_id')::uuid) ELSE NULL END);
END $$;

NOTIFY pgrst, 'reload schema';
