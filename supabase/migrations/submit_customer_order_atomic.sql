-- A retry after a lost HTTP response must return the first order, not create a
-- duplicate bill or print ticket. Order, items and occupied table commit as one.
CREATE OR REPLACE FUNCTION public.submit_customer_order_atomic(
  p_order_id uuid, p_table_id uuid, p_customer_id uuid,
  p_customer_name text, p_customer_phone text,
  p_delivery_address text, p_customer_note text, p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  existing public.orders%ROWTYPE;
  v_item jsonb;
  total numeric := 0;
  item_count integer := 0;
  table_row public.tables%ROWTYPE;
BEGIN
  IF p_order_id IS NULL OR p_table_id IS NULL OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Đơn hàng hoặc danh sách món không hợp lệ';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_order_id::text));
  SELECT * INTO existing FROM public.orders WHERE id = p_order_id;
  IF existing.id IS NOT NULL THEN
    IF existing.table_id IS DISTINCT FROM p_table_id
       OR existing.customer_phone IS DISTINCT FROM COALESCE(p_customer_phone, '') THEN
      RAISE EXCEPTION 'Mã gửi đơn đã dùng cho đơn khác';
    END IF;
    RETURN jsonb_build_object('order_id', existing.id, 'already_submitted', true);
  END IF;

  SELECT * INTO table_row FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF table_row.id IS NULL THEN RAISE EXCEPTION 'Không tìm thấy bàn'; END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) AS e(value) LOOP
    IF (v_item->>'menu_item_id') IS NULL OR (v_item->>'quantity')::integer < 1
       OR (v_item->>'unit_price')::numeric < 0 THEN
      RAISE EXCEPTION 'Món hoặc giá không hợp lệ';
    END IF;
    item_count := item_count + 1;
    total := total + (v_item->>'quantity')::integer * (v_item->>'unit_price')::numeric;
  END LOOP;

  INSERT INTO public.orders(id, table_id, customer_id, customer_name,
    customer_phone, status, total_amount, delivery_address, customer_note)
  VALUES(p_order_id, p_table_id, p_customer_id,
    COALESCE(NULLIF(trim(p_customer_name), ''), 'Khách ẩn danh'),
    COALESCE(p_customer_phone, ''), 'pending', total,
    NULLIF(p_delivery_address, ''), NULLIF(p_customer_note, ''));

  INSERT INTO public.order_items(order_id, menu_item_id, quantity, unit_price,
    item_options, note, is_gift)
  SELECT p_order_id, (e.value->>'menu_item_id')::uuid,
    (e.value->>'quantity')::integer, (e.value->>'unit_price')::numeric,
    COALESCE(e.value->'item_options', '[]'::jsonb), NULLIF(e.value->>'note', ''),
    COALESCE((e.value->>'is_gift')::boolean, false)
  FROM jsonb_array_elements(p_items) AS e(value);

  IF table_row.status = 'available' THEN
    UPDATE public.tables SET status = 'occupied', occupied_at = now()
    WHERE id = p_table_id;
  END IF;
  RETURN jsonb_build_object('order_id', p_order_id,
    'already_submitted', false, 'item_count', item_count, 'total', total);
END $$;

NOTIFY pgrst, 'reload schema';
