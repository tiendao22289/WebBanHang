-- Reapply only the capture function from table_bill_history_10h.sql.
-- Existing installations must also receive the non-blocking exception handler.
BEGIN;
CREATE OR REPLACE FUNCTION public.capture_table_bill_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE host_id uuid; group_ids uuid[]; items jsonb; bill jsonb; settled_at timestamptz;
BEGIN
  IF NEW.status <> 'paid' OR OLD.status IS NOT DISTINCT FROM 'paid' THEN RETURN NEW; END IF;
  IF NEW.customer_phone = 'BAO_BEP' THEN RETURN NEW; END IF;
  settled_at := COALESCE(NEW.paid_at, now());
  SELECT COALESCE(merged_with, id) INTO host_id FROM public.tables WHERE id = NEW.table_id;
  SELECT array_agg(id ORDER BY id) INTO group_ids FROM public.tables
    WHERE id = host_id OR merged_with = host_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(i) || jsonb_build_object(
    'menu_item', jsonb_build_object('name', COALESCE(i.item_name, m.name))) ORDER BY i.id), '[]'::jsonb)
    INTO items FROM public.order_items i LEFT JOIN public.menu_items m ON m.id = i.menu_item_id
    WHERE i.order_id = NEW.id;
  bill := to_jsonb(NEW) || jsonb_build_object('order_items', items,
    'bill_code', COALESCE(to_jsonb(NEW)->>'bill_code', (
      SELECT transaction_code FROM public.payment_transactions
      WHERE NEW.id::text = ANY(string_to_array(order_ids, ','))
        AND status IN ('pending', 'completed') ORDER BY transaction_code DESC LIMIT 1)),
    'table_number', (SELECT table_number FROM public.tables WHERE id = NEW.table_id));
  INSERT INTO public.table_bill_history(order_id, table_id, table_ids, paid_at, expires_at, snapshot)
    VALUES (NEW.id, NEW.table_id, COALESCE(group_ids, ARRAY[NEW.table_id]),
      settled_at, settled_at + interval '10 hours', bill)
    ON CONFLICT (order_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Table bill history capture failed (SQLSTATE %)', SQLSTATE;
  RETURN NEW;
END $$;
COMMIT;
