-- Apply after complete_table_payment_atomic.sql, protect_settled_order_items.sql,
-- order_total_follows_items.sql and add_order_feedback_columns.sql.
-- Disabled until the matching POS client has been deployed. Never purges history.
BEGIN;

CREATE TABLE IF NOT EXISTS public.stats_quota_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  start_hour integer NOT NULL DEFAULT 16 CHECK (start_hour BETWEEN 0 AND 22),
  end_hour integer NOT NULL DEFAULT 23 CHECK (end_hour BETWEEN 1 AND 23),
  CHECK (end_hour > start_hour)
);
INSERT INTO public.stats_quota_config(id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.stats_daily_quotas (
  date date PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.bank_accounts(id),
  base_amount numeric NOT NULL CHECK (base_amount > 0),
  target_amount numeric NOT NULL CHECK (target_amount > 0),
  cash_amount numeric NOT NULL DEFAULT 0,
  transfer_amount numeric NOT NULL DEFAULT 0,
  start_hour integer NOT NULL,
  end_hour integer NOT NULL
);
CREATE TABLE IF NOT EXISTS public.stats_bill_allocations (
  table_id uuid PRIMARY KEY REFERENCES public.tables(id) ON DELETE CASCADE,
  date date NOT NULL REFERENCES public.stats_daily_quotas(date),
  order_ids uuid[] NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  selected boolean NOT NULL,
  account_id uuid REFERENCES public.bank_accounts(id)
);
ALTER TABLE public.stats_quota_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stats_daily_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stats_bill_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS stats_quota_selected boolean;
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;

CREATE OR REPLACE FUNCTION public.stamp_stats_quota_checkout()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'available' AND OLD.status IS DISTINCT FROM 'available'
    AND current_setting('app.stats_quota_settlement', true) = 'on' THEN
    NEW.last_payment_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stamp_stats_quota_checkout ON public.tables;
CREATE TRIGGER stamp_stats_quota_checkout BEFORE UPDATE OF status ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.stamp_stats_quota_checkout();

CREATE OR REPLACE FUNCTION public.stats_quota_allowance(
  p_target numeric, p_start integer, p_end integer, p_at timestamptz
) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT floor(p_target * GREATEST(0, LEAST(1,
    (EXTRACT(epoch FROM (p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time) / 3600 - p_start + 0.5) /
      (p_end - p_start + 0.5))));
$$;

CREATE OR REPLACE FUNCTION public.get_stats_quota_summary()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('enabled', c.enabled) || COALESCE(to_jsonb(q), '{}'::jsonb)
  FROM public.stats_quota_config c LEFT JOIN public.stats_daily_quotas q
    ON q.date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date WHERE c.id;
$$;

-- The function takes the same table/order locks as settlement, then locks one
-- daily row. Reservations include cash and prevent two QR screens overbooking A.
CREATE OR REPLACE FUNCTION public.prepare_stats_payment(
  p_table_id uuid, p_expected_order_ids uuid[], p_expected_amount numeric,
  p_payment_method text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cfg public.stats_quota_config%ROWTYPE;
  quota public.stats_daily_quotas%ROWTYPE;
  allocation public.stats_bill_allocations%ROWTYPE;
  primary_account public.bank_accounts%ROWTYPE;
  chosen_account public.bank_accounts%ROWTYPE;
  host_id uuid;
  group_ids uuid[];
  live_ids uuid[];
  live_total numeric;
  vn_now timestamp := now() AT TIME ZONE 'Asia/Ho_Chi_Minh';
  vn_date date := vn_now::date;
  reserved numeric;
  allowance numeric;
  include_bill boolean;
  probability numeric;
BEGIN
  SELECT * INTO cfg FROM public.stats_quota_config WHERE id;
  IF NOT COALESCE(cfg.enabled, false) THEN RETURN jsonb_build_object('enabled', false); END IF;
  IF p_payment_method NOT IN ('cash', 'transfer') OR p_expected_amount IS NULL
     OR p_expected_amount <= 0 OR COALESCE(cardinality(p_expected_order_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Thong tin thanh toan khong hop le';
  END IF;
  SELECT COALESCE(merged_with, id) INTO host_id FROM public.tables WHERE id = p_table_id;
  IF host_id IS NULL THEN RAISE EXCEPTION 'Khong tim thay ban'; END IF;
  SELECT array_agg(id ORDER BY id) INTO group_ids FROM (
    SELECT id FROM public.tables WHERE id = host_id OR merged_with = host_id
    ORDER BY id FOR UPDATE
  ) locked_tables;
  IF NOT p_table_id = ANY(group_ids) THEN RAISE EXCEPTION 'Nhom ban da thay doi'; END IF;
  SELECT array_agg(id ORDER BY id) INTO live_ids FROM (
    SELECT id FROM public.orders WHERE table_id = ANY(group_ids)
    AND status IN ('pending', 'preparing', 'completed') ORDER BY id FOR UPDATE
  ) locked_orders;
  IF live_ids IS NULL OR live_ids IS DISTINCT FROM ARRAY(SELECT unnest(p_expected_order_ids) ORDER BY 1) THEN
    RETURN jsonb_build_object('enabled', true, 'success', false, 'reason', 'bill_changed');
  END IF;
  SELECT COALESCE(SUM(quantity * unit_price::numeric), 0) INTO live_total
  FROM public.order_items WHERE order_id = ANY(live_ids);
  IF live_total IS DISTINCT FROM p_expected_amount THEN
    RETURN jsonb_build_object('enabled', true, 'success', false, 'reason', 'amount_changed', 'total', live_total);
  END IF;

  SELECT * INTO primary_account FROM public.bank_accounts
  WHERE is_visible = true AND is_active = true ORDER BY sort_order, id LIMIT 1;
  IF primary_account.id IS NULL THEN RAISE EXCEPTION 'Chua co the A dang hoat dong'; END IF;
  -- Seed only with actual existing visible receipts; do not reclassify old bills.
  INSERT INTO public.stats_daily_quotas(date, account_id, base_amount, target_amount,
    cash_amount, transfer_amount, start_hour, end_hour)
  SELECT vn_date, primary_account.id, primary_account.daily_limit,
    GREATEST(1, primary_account.daily_limit - 1000000) +
      floor(random() * (primary_account.daily_limit + 2000000 - GREATEST(1, primary_account.daily_limit - 1000000) + 1)),
    COALESCE(SUM(total_amount) FILTER (WHERE payment_method = 'cash'), 0),
    COALESCE(SUM(total_amount) FILTER (WHERE payment_method = 'transfer'), 0),
    cfg.start_hour, cfg.end_hour
  FROM public.orders
  WHERE created_at >= vn_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
    AND created_at < (vn_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
    AND status IN ('paid', 'completed') AND payment_method IN ('cash', 'transfer')
    AND NOT COALESCE(is_hidden_from_stats, false)
  ON CONFLICT (date) DO NOTHING;
  SELECT * INTO quota FROM public.stats_daily_quotas WHERE date = vn_date FOR UPDATE;

  SELECT * INTO allocation FROM public.stats_bill_allocations WHERE table_id = host_id;
  IF allocation.date = vn_date AND allocation.order_ids = live_ids AND allocation.amount = live_total THEN
    IF p_payment_method = 'transfer' AND allocation.account_id IS NULL THEN
      IF allocation.selected THEN
        SELECT * INTO chosen_account FROM public.bank_accounts WHERE id = quota.account_id AND is_active;
      ELSE
        SELECT a.* INTO chosen_account FROM public.bank_accounts a
        LEFT JOIN public.bank_daily_totals d ON d.account_id = a.id AND d.date = vn_date
        WHERE NOT a.is_visible AND a.is_active
        ORDER BY (COALESCE(d.total_amount, 0) >= a.daily_limit), a.sort_order, a.id LIMIT 1;
      END IF;
      IF chosen_account.id IS NULL THEN RAISE EXCEPTION 'Khong co tai khoan nhan tien phu hop'; END IF;
      UPDATE public.stats_bill_allocations SET account_id = chosen_account.id WHERE table_id = host_id;
      allocation.account_id := chosen_account.id;
    END IF;
    RETURN jsonb_build_object('enabled', true, 'success', true, 'selected', allocation.selected,
      'account_id', allocation.account_id, 'target', quota.target_amount);
  END IF;

  -- Changed/cancelled bills cannot hold budget indefinitely. A bill that still
  -- matches its QR keeps its original decision, even after the window advances.
  DELETE FROM public.stats_bill_allocations a WHERE a.table_id = host_id OR a.date <> vn_date
    OR a.order_ids IS DISTINCT FROM ARRAY(
      SELECT o.id FROM public.orders o JOIN public.tables t ON t.id = o.table_id
      WHERE COALESCE(t.merged_with, t.id) = a.table_id
        AND o.status IN ('pending', 'preparing', 'completed') ORDER BY o.id
    ) OR a.amount IS DISTINCT FROM (
      SELECT COALESCE(SUM(i.quantity * i.unit_price::numeric), 0)
      FROM public.order_items i WHERE i.order_id = ANY(a.order_ids)
    );
  SELECT COALESCE(SUM(amount), 0) INTO reserved FROM public.stats_bill_allocations
  WHERE date = vn_date AND selected;
  -- Continuous opening of the budget from 16:00 through 23:00, with a small
  -- initial slice. There is no full-day budget available in the afternoon.
  allowance := public.stats_quota_allowance(quota.target_amount, quota.start_hour, quota.end_hour, now());
  probability := CASE WHEN EXTRACT(hour FROM vn_now) >= quota.end_hour - 1 THEN 1 ELSE 0.5 END;
  include_bill := live_total + quota.cash_amount + quota.transfer_amount + reserved <= allowance
    AND random() < probability;
  IF p_payment_method = 'transfer' THEN
    IF include_bill THEN
      SELECT * INTO chosen_account FROM public.bank_accounts WHERE id = quota.account_id AND is_active;
    ELSE
      SELECT a.* INTO chosen_account FROM public.bank_accounts a
      LEFT JOIN public.bank_daily_totals d ON d.account_id = a.id AND d.date = vn_date
      WHERE NOT a.is_visible AND a.is_active
      ORDER BY (COALESCE(d.total_amount, 0) >= a.daily_limit), a.sort_order, a.id LIMIT 1;
    END IF;
    IF chosen_account.id IS NULL THEN
      RAISE EXCEPTION 'Khong co tai khoan nhan tien phu hop; khong doi sang the A';
    END IF;
  END IF;
  INSERT INTO public.stats_bill_allocations(table_id, date, order_ids, amount, selected, account_id)
  VALUES (host_id, vn_date, live_ids, live_total, include_bill, chosen_account.id);
  RETURN jsonb_build_object('enabled', true, 'success', true, 'selected', include_bill,
    'account_id', chosen_account.id, 'target', quota.target_amount);
END $$;

-- Protect new selected receipts, while existing review fields remain editable.
CREATE OR REPLACE FUNCTION public.protect_stats_quota_receipt()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.stats_quota_selected = true THEN RAISE EXCEPTION 'Bill thong ke da chot khong duoc xoa'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.stats_quota_selected = true AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
    OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.is_hidden_from_stats IS DISTINCT FROM OLD.is_hidden_from_stats
    OR NEW.stats_quota_selected IS DISTINCT FROM OLD.stats_quota_selected
  ) THEN RAISE EXCEPTION 'Bill thong ke da chot khong duoc sua'; END IF;
  IF NEW.stats_quota_selected IS DISTINCT FROM OLD.stats_quota_selected
    AND current_setting('app.stats_quota_settlement', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Chi giao dich thanh toan duoc quyet dinh bill thong ke';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_stats_quota_receipt ON public.orders;
CREATE TRIGGER protect_stats_quota_receipt BEFORE UPDATE OR DELETE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.protect_stats_quota_receipt();

-- Retain the existing item/payment locking rule, with a narrow purge exception.
CREATE OR REPLACE FUNCTION public.require_open_order_for_item_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE old_status text; new_status text; purge_allowed boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status, stats_quota_selected = false AND status = 'paid'
    INTO old_status, purge_allowed FROM public.orders WHERE id = OLD.order_id FOR UPDATE;
    IF TG_OP = 'DELETE' AND COALESCE(purge_allowed, false)
      AND current_setting('app.stats_quota_purge', true) = 'on' THEN RETURN OLD; END IF;
    IF old_status NOT IN ('pending', 'preparing', 'completed') THEN
      RAISE EXCEPTION 'Khong duoc sua mon cua bill da chot hoac huy';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    SELECT status INTO new_status FROM public.orders WHERE id = NEW.order_id FOR UPDATE;
    IF new_status NOT IN ('pending', 'preparing', 'completed') THEN
      RAISE EXCEPTION 'Khong duoc them mon vao bill da chot hoac huy';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.purge_unselected_quota_bills()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ids uuid[]; removed integer;
BEGIN
  SELECT array_agg(id) INTO ids FROM (
    SELECT o.id FROM public.orders o WHERE o.stats_quota_selected = false AND o.status = 'paid'
      AND NOT EXISTS (SELECT 1 FROM public.print_jobs j
        WHERE (j.order_id = o.id OR o.id = ANY(j.order_ids)) AND j.status IS DISTINCT FROM 'done')
    ORDER BY o.id FOR UPDATE SKIP LOCKED
  ) ready;
  IF ids IS NULL THEN RETURN 0; END IF;
  -- Save feedback independently without copying the bill, its ID or amount.
  INSERT INTO public.customer_reviews(table_id, customer_name, customer_phone, rating, feedback, created_at)
  SELECT table_id, customer_name, customer_phone, customer_rating, customer_feedback, created_at
  FROM public.orders WHERE id = ANY(ids) AND (customer_rating IS NOT NULL OR customer_feedback IS NOT NULL);
  PERFORM set_config('app.stats_quota_purge', 'on', true);
  -- A completed shared print may also cover a retained bill. Preserve that
  -- bill's job and snapshot rather than cascading its audit evidence away.
  UPDATE public.print_jobs j SET
    order_id = COALESCE((SELECT candidate FROM unnest(COALESCE(j.order_ids, ARRAY[j.order_id])) candidate
      WHERE NOT candidate = ANY(ids) ORDER BY candidate LIMIT 1), j.order_id),
    order_ids = ARRAY(SELECT candidate FROM unnest(j.order_ids) candidate WHERE NOT candidate = ANY(ids)),
    order_items_at_queue = CASE WHEN j.order_items_at_queue IS NULL THEN NULL ELSE
      (SELECT COALESCE(jsonb_agg(item), '[]'::jsonb) FROM jsonb_array_elements(j.order_items_at_queue) item
        WHERE NOT COALESCE(item->>'order_id', '') = ANY(ARRAY(SELECT unnest(ids)::text))) END
  WHERE (j.order_id = ANY(ids) OR j.order_ids && ids)
    AND EXISTS (SELECT 1 FROM unnest(COALESCE(j.order_ids, ARRAY[j.order_id])) candidate
      WHERE NOT candidate = ANY(ids));
  DELETE FROM public.print_jobs WHERE order_id = ANY(ids);
  DELETE FROM public.order_items WHERE order_id = ANY(ids);
  DELETE FROM public.payment_transactions
  WHERE string_to_array(order_ids, ',') && ARRAY(SELECT unnest(ids)::text);
  DELETE FROM public.orders WHERE id = ANY(ids);
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('app.stats_quota_purge', 'off', true);
  RETURN removed;
END $$;

-- Keep the original settlement implementation for unchanged/disabled operation.
DO $$ BEGIN
  IF to_regprocedure('public.complete_table_payment_atomic_legacy(uuid,uuid[],numeric,text,uuid,boolean,uuid,text,text)') IS NULL THEN
    ALTER FUNCTION public.complete_table_payment_atomic(uuid, uuid[], numeric, text, uuid, boolean, uuid, text, text)
      RENAME TO complete_table_payment_atomic_legacy;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.complete_table_payment_atomic(
  p_table_id uuid, p_expected_order_ids uuid[], p_expected_amount numeric,
  p_payment_method text, p_account_id uuid DEFAULT NULL, p_hide_stats boolean DEFAULT false,
  p_staff_id uuid DEFAULT NULL, p_staff_name text DEFAULT NULL, p_transaction_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE decision jsonb; settled jsonb; allocation public.stats_bill_allocations%ROWTYPE;
  host_id uuid; vn_date date := (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
BEGIN
  IF NOT COALESCE((SELECT enabled FROM public.stats_quota_config WHERE id), false) THEN
    RETURN public.complete_table_payment_atomic_legacy(p_table_id, p_expected_order_ids, p_expected_amount,
      p_payment_method, p_account_id, p_hide_stats, p_staff_id, p_staff_name, p_transaction_code);
  END IF;
  SELECT COALESCE(merged_with, id) INTO host_id FROM public.tables WHERE id = p_table_id;
  IF p_payment_method = 'transfer' THEN
    -- Never decide again after the customer has seen/paid a QR.
    PERFORM id FROM public.tables WHERE id = host_id OR merged_with = host_id ORDER BY id FOR UPDATE;
    SELECT * INTO allocation FROM public.stats_bill_allocations WHERE table_id = host_id;
    IF allocation.date IS DISTINCT FROM vn_date
      OR allocation.order_ids IS DISTINCT FROM ARRAY(SELECT unnest(p_expected_order_ids) ORDER BY 1)
      OR allocation.amount IS DISTINCT FROM p_expected_amount
      OR allocation.account_id IS DISTINCT FROM p_account_id THEN
      RAISE EXCEPTION 'QR khong con khop quyet dinh thong ke; vui long doi soat truoc khi chot';
    END IF;
    decision := jsonb_build_object('selected', allocation.selected);
  ELSE
    decision := public.prepare_stats_payment(p_table_id, p_expected_order_ids, p_expected_amount, p_payment_method);
    IF NOT COALESCE((decision->>'success')::boolean, false) THEN RETURN decision; END IF;
  END IF;
  PERFORM 1 FROM public.stats_daily_quotas WHERE date = vn_date FOR UPDATE;
  -- Stamp the first available-table event; a later separate update would let
  -- realtime clients interpret the already-deleted receipt as cancellation.
  PERFORM set_config('app.stats_quota_settlement', 'on', true);
  settled := public.complete_table_payment_atomic_legacy(p_table_id, p_expected_order_ids, p_expected_amount,
    p_payment_method, p_account_id, NOT (decision->>'selected')::boolean,
    p_staff_id, p_staff_name, p_transaction_code);
  IF NOT COALESCE((settled->>'success')::boolean, false) THEN
    PERFORM set_config('app.stats_quota_settlement', 'off', true);
    RETURN settled;
  END IF;

  UPDATE public.orders SET stats_quota_selected = (decision->>'selected')::boolean,
    is_hidden_from_stats = NOT (decision->>'selected')::boolean WHERE id = ANY(p_expected_order_ids);
  PERFORM set_config('app.stats_quota_settlement', 'off', true);
  IF (decision->>'selected')::boolean THEN
    UPDATE public.stats_daily_quotas SET
      cash_amount = cash_amount + CASE WHEN p_payment_method = 'cash' THEN p_expected_amount ELSE 0 END,
      transfer_amount = transfer_amount + CASE WHEN p_payment_method = 'transfer' THEN p_expected_amount ELSE 0 END
    WHERE date = vn_date;
  END IF;
  DELETE FROM public.stats_bill_allocations WHERE table_id = host_id;
  IF NOT (decision->>'selected')::boolean THEN PERFORM public.purge_unselected_quota_bills(); END IF;
  RETURN settled || jsonb_build_object('selected_for_stats', (decision->>'selected')::boolean);
END $$;

-- A periodic retry handles offline printers. Only new excluded receipts qualify.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    EXECUTE $job$SELECT cron.schedule('purge-unselected-quota-bills', '*/5 * * * *',
      'SELECT public.purge_unselected_quota_bills()')$job$;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.complete_table_payment_atomic_legacy(uuid, uuid[], numeric, text, uuid, boolean, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_unselected_quota_bills() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_stats_payment(uuid, uuid[], numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prepare_stats_payment(uuid, uuid[], numeric, text) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_stats_quota_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stats_quota_summary() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_table_payment_atomic(uuid, uuid[], numeric, text, uuid, boolean, uuid, text, text) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
