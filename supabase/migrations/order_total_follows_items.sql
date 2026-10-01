-- Keep the cached order total equal to its item rows even when two browsers
-- edit the same bill, or an older client writes a stale computed total.
CREATE OR REPLACE FUNCTION public.order_total_from_items_before_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.total_amount := (
    SELECT COALESCE(SUM(i.unit_price::numeric * i.quantity), 0)
    FROM public.order_items i WHERE i.order_id = NEW.id
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS order_total_from_items_before_write ON public.orders;
CREATE TRIGGER order_total_from_items_before_write
BEFORE UPDATE OF total_amount ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.order_total_from_items_before_write();

CREATE OR REPLACE FUNCTION public.order_items_sync_total()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.orders o SET total_amount = q.total
    FROM (SELECT COALESCE(SUM(i.unit_price::numeric * i.quantity), 0) AS total
          FROM public.order_items i WHERE i.order_id = OLD.order_id) q
    WHERE o.id = OLD.order_id AND o.total_amount IS DISTINCT FROM q.total;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    UPDATE public.orders o SET total_amount = q.total
    FROM (SELECT COALESCE(SUM(i.unit_price::numeric * i.quantity), 0) AS total
          FROM public.order_items i WHERE i.order_id = NEW.order_id) q
    WHERE o.id = NEW.order_id AND o.total_amount IS DISTINCT FROM q.total;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS order_items_sync_total ON public.order_items;
CREATE TRIGGER order_items_sync_total
AFTER INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.order_items_sync_total();

-- Reconcile only open bills here. Historical paid totals require human audit
-- because changing an already settled amount would rewrite that record.
UPDATE public.orders o SET total_amount = q.total
FROM (SELECT o2.id, COALESCE(SUM(i.unit_price::numeric * i.quantity), 0) AS total
      FROM public.orders o2 LEFT JOIN public.order_items i ON i.order_id = o2.id
      WHERE o2.status IN ('pending', 'preparing', 'completed')
      GROUP BY o2.id) q
WHERE o.id = q.id AND o.total_amount IS DISTINCT FROM q.total;
