-- Apply after lucky_wheel_one_discount_per_bill.sql and lucky_wheel_gift_items.sql.
-- Percent rewards follow submitted items across the customer's open table bill.
-- Keep the original percentage and snapshot the cap; never re-draw the reward.
BEGIN;

ALTER TABLE public.lucky_spins ADD COLUMN IF NOT EXISTS discount_max_amount integer;
CREATE INDEX IF NOT EXISTS lucky_spins_applied_order_idx ON public.lucky_spins(applied_order_id)
WHERE status = 'applied';

CREATE OR REPLACE FUNCTION public.lucky_percent_cap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.prize_type = 'percent' AND NEW.status = 'applied'
     AND NEW.discount_max_amount IS NULL THEN
    SELECT CASE WHEN value ~ '^[0-9]+$' THEN value::integer ELSE 0 END
      INTO NEW.discount_max_amount FROM public.settings WHERE key = 'lucky_wheel_max';
    NEW.discount_max_amount := COALESCE(NEW.discount_max_amount, 0);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lucky_percent_cap ON public.lucky_spins;
CREATE TRIGGER lucky_percent_cap BEFORE INSERT OR UPDATE ON public.lucky_spins
FOR EACH ROW EXECUTE FUNCTION public.lucky_percent_cap();

-- Existing claimed rewards adopt the current cap once. Closed bills are not repriced.
UPDATE public.lucky_spins SET discount_max_amount = NULL
WHERE prize_type = 'percent' AND status = 'applied' AND discount_max_amount IS NULL;

CREATE OR REPLACE FUNCTION public.refresh_lucky_percent_reward(p_spin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.lucky_spins%ROWTYPE;
  target public.orders%ROWTYPE;
  line public.order_items%ROWTYPE;
  host_id uuid;
  takeaway boolean;
  bill_ids uuid[];
  subtotal numeric;
  available_total numeric;
  reduction integer;
  line_id uuid;
  legacy_ids uuid[];
BEGIN
  SELECT * INTO s FROM public.lucky_spins WHERE id = p_spin_id;
  IF NOT FOUND OR s.status <> 'applied' OR s.prize_type <> 'percent' THEN
    RAISE EXCEPTION 'Phần quà phần trăm chưa được xác nhận';
  END IF;
  -- Same table lock as claim_lucky_wheel_slot / confirm_draft_order.
  PERFORM pg_advisory_xact_lock(hashtext(s.host_table_id::text));
  SELECT * INTO s FROM public.lucky_spins WHERE id = p_spin_id FOR UPDATE;
  SELECT * INTO target FROM public.orders WHERE id = s.applied_order_id;
  IF NOT FOUND OR target.status NOT IN ('pending', 'preparing', 'completed') THEN
    -- Paid/cancelled history must not change on a delayed webhook or a new visit.
    RETURN NULL;
  END IF;
  SELECT COALESCE(merged_with, id), table_type = 'takeaway'
    INTO host_id, takeaway FROM public.tables WHERE id = target.table_id;
  IF host_id IS NULL THEN RAISE EXCEPTION 'Không tìm thấy bàn nhận quà'; END IF;

  SELECT array_agg(o.id) INTO bill_ids
  FROM public.orders o JOIN public.tables t ON t.id = o.table_id
  WHERE COALESCE(t.merged_with, t.id) = host_id
    AND o.status IN ('pending', 'preparing', 'completed')
    AND o.created_at >= LEAST(target.created_at,
      COALESCE(s.session_started_at, date_trunc('day', s.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'))
    AND (NOT takeaway OR o.customer_phone = s.customer_phone);

  line_id := COALESCE(s.applied_item_id, s.id);
  IF s.applied_item_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.order_items WHERE id = line_id) THEN
    SELECT array_agg(id) INTO legacy_ids FROM public.order_items
      WHERE order_id = target.id AND menu_item_id IS NULL
        AND item_name = 'Vòng xoay may mắn: giảm ' || trim_scale(s.prize_value)::text || '%';
    IF cardinality(legacy_ids) > 1 THEN RAISE EXCEPTION 'Có nhiều dòng giảm giá cũ; vui lòng gọi nhân viên'; END IF;
    IF cardinality(legacy_ids) = 1 THEN line_id := legacy_ids[1]; END IF;
  END IF;
  -- Read items, never the cached orders.total_amount. Exclude the reward itself
  -- so repeated edits do not compound the discount. Free gifts do not earn money.
  SELECT COALESCE(SUM(CASE WHEN i.unit_price > 0 AND NOT COALESCE(i.is_gift, false)
    THEN i.unit_price::numeric * i.quantity ELSE 0 END), 0),
    GREATEST(0, COALESCE(SUM(i.unit_price::numeric * i.quantity), 0))
    INTO subtotal, available_total
  FROM public.order_items i WHERE i.order_id = ANY(bill_ids) AND i.id <> line_id;
  reduction := LEAST(available_total, GREATEST(0,
    floor(subtotal * GREATEST(0, s.prize_value) / 100 / 1000) * 1000));
  IF s.discount_max_amount > 0 THEN reduction := LEAST(reduction, s.discount_max_amount); END IF;

  INSERT INTO public.order_items (id, order_id, menu_item_id, item_name, quantity, unit_price, is_gift)
  VALUES (line_id, target.id, NULL, 'Vòng xoay may mắn: giảm ' || trim_scale(s.prize_value)::text || '%', 1, -reduction, false)
  ON CONFLICT (id) DO UPDATE SET unit_price = EXCLUDED.unit_price, quantity = 1
    WHERE order_items.order_id = EXCLUDED.order_id AND order_items.menu_item_id IS NULL
      AND (order_items.unit_price IS DISTINCT FROM EXCLUDED.unit_price OR order_items.quantity <> 1);
  SELECT * INTO line FROM public.order_items WHERE id = line_id;
  IF line.order_id <> target.id OR line.menu_item_id IS NOT NULL OR line.unit_price <> -reduction THEN
    RAISE EXCEPTION 'Dòng giảm giá không khớp phần quà';
  END IF;
  UPDATE public.lucky_spins SET bill_total = subtotal, discount_amount = reduction, applied_item_id = line_id
    WHERE id = s.id AND (bill_total IS DISTINCT FROM subtotal OR discount_amount IS DISTINCT FROM reduction
      OR applied_item_id IS DISTINCT FROM line_id);
  UPDATE public.orders o SET total_amount = q.total
    FROM (SELECT b.id, COALESCE(SUM(i.unit_price::numeric * i.quantity), 0) AS total
      FROM public.orders b LEFT JOIN public.order_items i ON i.order_id = b.id
      WHERE b.id = ANY(bill_ids) GROUP BY b.id) q
    WHERE o.id = q.id AND o.total_amount IS DISTINCT FROM q.total;
  RETURN to_jsonb(line);
END $$;

CREATE OR REPLACE FUNCTION public.refresh_lucky_percent_for_order(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE spin_id uuid;
BEGIN
  FOR spin_id IN
    SELECT s.id FROM public.lucky_spins s
    JOIN public.orders reward_order ON reward_order.id = s.applied_order_id
    JOIN public.tables reward_table ON reward_table.id = reward_order.table_id
    JOIN public.orders changed ON changed.id = p_order_id
    JOIN public.tables changed_table ON changed_table.id = changed.table_id
    WHERE s.status = 'applied' AND s.prize_type = 'percent' AND s.applied_item_id IS NOT NULL
      AND reward_order.status IN ('pending', 'preparing', 'completed')
      AND COALESCE(reward_table.merged_with, reward_table.id) = COALESCE(changed_table.merged_with, changed_table.id)
      AND (reward_table.table_type <> 'takeaway' OR changed.customer_phone = s.customer_phone)
    ORDER BY s.id
  LOOP
    PERFORM public.refresh_lucky_percent_reward(spin_id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.lucky_percent_items_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM public.refresh_lucky_percent_for_order(OLD.order_id); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    PERFORM public.refresh_lucky_percent_for_order(NEW.order_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS lucky_percent_items_changed ON public.order_items;
CREATE TRIGGER lucky_percent_items_changed AFTER INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.lucky_percent_items_changed();

-- Older clients write their cached total AFTER changing an item. Repair that
-- value at transaction end too, including RPCs that write a total after a batch.
CREATE OR REPLACE FUNCTION public.lucky_percent_order_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.refresh_lucky_percent_for_order(NEW.id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS lucky_percent_order_changed ON public.orders;
CREATE CONSTRAINT TRIGGER lucky_percent_order_changed AFTER UPDATE ON public.orders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.total_amount IS DISTINCT FROM NEW.total_amount OR OLD.status IS DISTINCT FROM NEW.status
  OR OLD.table_id IS DISTINCT FROM NEW.table_id)
EXECUTE FUNCTION public.lucky_percent_order_changed();

REVOKE ALL ON FUNCTION public.refresh_lucky_percent_reward(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_lucky_percent_reward(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.refresh_lucky_percent_for_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lucky_percent_items_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lucky_percent_order_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lucky_percent_cap() FROM PUBLIC, anon, authenticated;

-- Preserve reward IDs when the admin consolidates the table's separate orders.
-- The old RPC deleted/recreated every row, breaking applied_item_id references.
CREATE OR REPLACE FUNCTION public.merge_bills_atomic(
  p_all_bill_ids uuid[], p_main_bill_id uuid, p_other_bill_ids uuid[],
  p_new_total numeric, p_new_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE reward_ids uuid[]; reward_names text[]; reward_rows jsonb;
BEGIN
  IF NOT p_main_bill_id = ANY(p_all_bill_ids) OR EXISTS (
    SELECT 1 FROM public.orders WHERE id = ANY(p_all_bill_ids)
      AND status NOT IN ('pending', 'preparing', 'completed')
  ) THEN RAISE EXCEPTION 'Chỉ được gộp các bill đang mở'; END IF;
  SELECT array_agg(i.id), array_agg(i.item_name), jsonb_agg(to_jsonb(i)) INTO reward_ids, reward_names, reward_rows
    FROM public.lucky_spins s JOIN public.order_items i ON i.id = s.applied_item_id
    WHERE s.status = 'applied' AND i.order_id = ANY(p_all_bill_ids);
  reward_ids := COALESCE(reward_ids, '{}'::uuid[]);
  -- Move intact reward rows before cancelling the secondary orders.
  UPDATE public.lucky_spins SET applied_order_id = p_main_bill_id
    WHERE applied_item_id = ANY(reward_ids);
  UPDATE public.order_items SET order_id = p_main_bill_id WHERE id = ANY(reward_ids);
  DELETE FROM public.order_items WHERE order_id = ANY(p_all_bill_ids) AND NOT id = ANY(reward_ids);
  INSERT INTO public.order_items (order_id, menu_item_id, quantity, unit_price, item_options, note, is_gift, item_name)
    SELECT p_main_bill_id, (e->>'menu_item_id')::uuid, (e->>'quantity')::integer,
      (e->>'unit_price')::numeric, e->'item_options', e->>'note', (e->>'is_gift')::boolean, e->>'item_name'
    FROM jsonb_array_elements(p_new_items) e
    WHERE NOT COALESCE((e->>'id')::uuid = ANY(reward_ids), false)
      -- Compatible with old clients which did not pass item IDs (percent/amount).
      AND NOT (e->>'menu_item_id' IS NULL AND COALESCE(e->>'item_name' = ANY(reward_names), false))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(reward_rows, '[]'::jsonb)) saved
        WHERE saved->>'menu_item_id' IS NOT NULL AND e->>'menu_item_id' = saved->>'menu_item_id'
          AND e->>'note' IS NOT DISTINCT FROM saved->>'note'
          AND e->>'is_gift' = 'true' AND e->>'unit_price' = saved->>'unit_price');
  UPDATE public.orders SET status = 'cancelled', total_amount = 0
    WHERE id = ANY(p_other_bill_ids) AND id = ANY(p_all_bill_ids) AND id <> p_main_bill_id;
  PERFORM public.refresh_lucky_percent_for_order(p_main_bill_id);
  UPDATE public.orders SET total_amount = (
    SELECT COALESCE(SUM(unit_price::numeric * quantity), 0) FROM public.order_items WHERE order_id = p_main_bill_id
  ) WHERE id = p_main_bill_id;
  RETURN jsonb_build_object('success', true);
END $$;

-- Only existing, acknowledged percent lines on open bills; do not claim waiting gifts.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT s.id FROM public.lucky_spins s JOIN public.orders o ON o.id = s.applied_order_id
    WHERE s.status = 'applied' AND s.prize_type = 'percent' AND s.applied_item_id IS NOT NULL
      AND o.status IN ('pending', 'preparing', 'completed')
  LOOP PERFORM public.refresh_lucky_percent_reward(r.id); END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
