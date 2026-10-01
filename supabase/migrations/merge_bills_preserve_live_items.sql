-- Move the actual database rows. Never delete/recreate them from a browser
-- snapshot: an item added while the request is in flight would be lost, and
-- print/reward references to its original ID would be broken.
CREATE OR REPLACE FUNCTION public.merge_bills_atomic(
  p_all_bill_ids uuid[], p_main_bill_id uuid, p_other_bill_ids uuid[],
  p_new_total numeric, p_new_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  actual_ids uuid[];
  group_id uuid;
  item_count integer;
BEGIN
  IF p_main_bill_id IS NULL OR cardinality(p_all_bill_ids) < 2
     OR cardinality(p_all_bill_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_all_bill_ids)))
     OR ARRAY(SELECT unnest(p_all_bill_ids) ORDER BY 1)
        IS DISTINCT FROM ARRAY(SELECT unnest(ARRAY[p_main_bill_id] || p_other_bill_ids) ORDER BY 1) THEN
    RAISE EXCEPTION 'Danh sách bill gộp không hợp lệ';
  END IF;

  -- Serialise merges/payments on the order rows before reading live items.
  SELECT array_agg(id ORDER BY id) INTO actual_ids
  FROM (SELECT id FROM public.orders WHERE id = ANY(p_all_bill_ids)
        AND status IN ('pending', 'preparing', 'completed') ORDER BY id FOR UPDATE) locked;
  IF actual_ids IS DISTINCT FROM ARRAY(SELECT unnest(p_all_bill_ids) ORDER BY 1) THEN
    RAISE EXCEPTION 'Bill đã đổi trạng thái; tải lại trước khi gộp';
  END IF;

  SELECT COALESCE(t.merged_with, t.id) INTO group_id
  FROM public.orders o JOIN public.tables t ON t.id = o.table_id
  WHERE o.id = p_main_bill_id;
  IF EXISTS (
    SELECT 1 FROM public.orders o JOIN public.tables t ON t.id = o.table_id
    WHERE o.id = ANY(p_all_bill_ids) AND COALESCE(t.merged_with, t.id) IS DISTINCT FROM group_id
  ) THEN RAISE EXCEPTION 'Các bill không cùng một nhóm bàn'; END IF;

  -- Keep every order_item ID, including rows added after the browser loaded.
  UPDATE public.lucky_spins SET applied_order_id = p_main_bill_id
    WHERE applied_order_id = ANY(p_other_bill_ids) AND status = 'applied';
  UPDATE public.order_items SET order_id = p_main_bill_id
    WHERE order_id = ANY(p_other_bill_ids);
  GET DIAGNOSTICS item_count = ROW_COUNT;

  UPDATE public.orders SET status = 'cancelled', total_amount = 0
    WHERE id = ANY(p_other_bill_ids);
  PERFORM public.refresh_lucky_percent_for_order(p_main_bill_id);
  UPDATE public.orders SET total_amount = (
    SELECT COALESCE(SUM(unit_price::numeric * quantity), 0)
    FROM public.order_items WHERE order_id = p_main_bill_id
  ) WHERE id = p_main_bill_id;

  RETURN jsonb_build_object('success', true, 'moved_item_count', item_count);
END $$;

NOTIFY pgrst, 'reload schema';
