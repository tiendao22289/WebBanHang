-- Preserve the bill contents seen when a print job was queued. This is audit
-- evidence when items are later moved/edited; it does not assert printer output.
ALTER TABLE public.print_jobs
ADD COLUMN IF NOT EXISTS order_items_at_queue jsonb;

CREATE OR REPLACE FUNCTION public.capture_print_job_order_items()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.order_items_at_queue := (
    SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
    FROM public.order_items i
    WHERE i.order_id = ANY(COALESCE(NEW.order_ids, ARRAY[NEW.order_id]))
      AND (NEW.only_item_ids IS NULL OR i.id = ANY(NEW.only_item_ids))
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS capture_print_job_order_items ON public.print_jobs;
CREATE TRIGGER capture_print_job_order_items
BEFORE INSERT ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION public.capture_print_job_order_items();
