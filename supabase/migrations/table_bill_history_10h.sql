BEGIN;

CREATE TABLE IF NOT EXISTS public.table_bill_history (
  order_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  table_ids uuid[] NOT NULL,
  paid_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS table_bill_history_expiry ON public.table_bill_history(expires_at);
CREATE INDEX IF NOT EXISTS table_bill_history_tables ON public.table_bill_history USING gin(table_ids);
ALTER TABLE public.table_bill_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_recent_table_bill_history ON public.table_bill_history;
CREATE POLICY read_recent_table_bill_history ON public.table_bill_history
  FOR SELECT TO anon, authenticated USING (expires_at > now());
REVOKE ALL ON public.table_bill_history FROM anon, authenticated;
GRANT SELECT ON public.table_bill_history TO anon, authenticated;
GRANT ALL ON public.table_bill_history TO service_role;

CREATE OR REPLACE FUNCTION public.capture_table_bill_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE host_id uuid; group_ids uuid[]; items jsonb; bill jsonb; settled_at timestamptz;
BEGIN
  IF NEW.status <> 'paid' OR OLD.status IS NOT DISTINCT FROM 'paid' THEN RETURN NEW; END IF;
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
  -- No FK to orders: the original receipt may be purged in this transaction.
  INSERT INTO public.table_bill_history(order_id, table_id, table_ids, paid_at, expires_at, snapshot)
    VALUES (NEW.id, NEW.table_id, COALESCE(group_ids, ARRAY[NEW.table_id]),
      settled_at, settled_at + interval '10 hours', bill)
    ON CONFLICT (order_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- The snapshot is optional; its failure must never abort settlement.
  RAISE WARNING 'Table bill history capture failed (SQLSTATE %)', SQLSTATE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capture_table_bill_history ON public.orders;
CREATE TRIGGER capture_table_bill_history AFTER UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.capture_table_bill_history();

CREATE OR REPLACE FUNCTION public.purge_expired_table_bill_history()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM public.table_bill_history WHERE expires_at <= now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION public.capture_table_bill_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_table_bill_history() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_table_bill_history() TO service_role;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule('purge-expired-table-bill-history', '* * * * *',
      'SELECT public.purge_expired_table_bill_history()');
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
