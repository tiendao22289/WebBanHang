-- Item edits and payment must lock the same order row. A late item write after
-- settlement would otherwise leave a kitchen item outside the paid bill.
CREATE OR REPLACE FUNCTION public.require_open_order_for_item_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  old_status text;
  new_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO old_status FROM public.orders WHERE id = OLD.order_id FOR UPDATE;
    IF old_status NOT IN ('pending', 'preparing', 'completed') THEN
      RAISE EXCEPTION 'Không được sửa món của bill đã chốt hoặc huỷ';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    SELECT status INTO new_status FROM public.orders WHERE id = NEW.order_id FOR UPDATE;
    IF new_status NOT IN ('pending', 'preparing', 'completed') THEN
      RAISE EXCEPTION 'Không được thêm món vào bill đã chốt hoặc huỷ';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS require_open_order_for_item_change ON public.order_items;
CREATE TRIGGER require_open_order_for_item_change
BEFORE INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.require_open_order_for_item_change();
