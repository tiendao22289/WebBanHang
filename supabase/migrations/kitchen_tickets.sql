-- ============================================================
-- Báo bếp đúng món mới (đợt 2, 28/10/2026)
--
-- 1. order_items.kitchen_sent_at: lúc món được đưa vào phiếu bếp. Ghi trên CHÍNH
--    dòng món nên gộp bill (dòng chuyển sang bill chính, giữ id) vẫn giữ dấu.
--    Trang Bàn hiện "chưa báo bếp" cho món bếp chưa có dấu này.
-- 2. Trigger trên print_jobs: mỗi phiếu bếp (không phải hoá đơn / tạm tính) đóng
--    dấu đúng các món nó sẽ in. Lỗi đóng dấu không bao giờ chặn phiếu in.
-- 3. kitchen_printer_for(): máy bếp của 1 món, định tuyến giống print.jsx và
--    PrintAgent. Máy in hoá đơn ở quầy (nước, bia, khăn) không tính là bếp.
-- 4. queue_kitchen_tickets(): phiếu chỉ in ĐÚNG các dòng món đưa vào
--    (only_item_ids), mỗi máy bếp 1 phiếu, dòng đã báo bếp thì bỏ qua.
-- 5. add_item_portion(): nhân viên bấm "+" trên món bếp đã báo → thêm dòng mới
--    và in đúng phần thêm. PrintAgent in cả số lượng của dòng, nên cộng vào dòng
--    cũ thì bếp không biết (hoặc làm lại cả phần cũ nếu in lại).
--
-- confirm_draft_order (nút Gửi đi) dùng các hàm này: xem confirm_draft_order_lines.sql.
-- Chạy lại được nhiều lần. Cài bằng workflow "Apply Finance Migration".
-- ============================================================
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'kitchen_sent_at') THEN
    ALTER TABLE public.order_items ADD COLUMN kitchen_sent_at timestamptz;
    -- Món đang trên bàn lúc cài: trước đây nhân viên báo miệng, không biết chắc
    -- món nào đã báo → coi như đã báo, tránh nhắc in lại món bếp đã làm.
    -- Chỉ chạy 1 lần (lúc thêm cột): chạy lại migration không xoá dấu "chưa báo bếp" thật.
    UPDATE public.order_items i SET kitchen_sent_at = COALESCE(i.created_at, now())
    FROM public.orders o
    WHERE o.id = i.order_id AND o.status IN ('pending', 'preparing', 'completed');
  END IF;
END $$;

-- Category dùng để chọn máy in — giống print.jsx: category của món, đổi theo
-- LOẠI đã chọn nếu loại đó có choiceCategories.
CREATE OR REPLACE FUNCTION public.order_item_print_category(p_menu_item_id uuid, p_item_options jsonb)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_category     uuid;
  v_menu_options jsonb;
  v_opt          jsonb;
  v_menu_opt     jsonb;
  v_idx          integer;
  v_choice_cat   text;
BEGIN
  SELECT category_id, options INTO v_category, v_menu_options FROM public.menu_items WHERE id = p_menu_item_id;
  IF jsonb_typeof(p_item_options) IS DISTINCT FROM 'array' OR jsonb_typeof(v_menu_options) IS DISTINCT FROM 'array' THEN
    RETURN v_category;
  END IF;
  FOR v_opt IN SELECT value FROM jsonb_array_elements(p_item_options) LOOP
    SELECT value INTO v_menu_opt FROM jsonb_array_elements(v_menu_options) WITH ORDINALITY
      WHERE value->>'name' = v_opt->>'name' ORDER BY ordinality LIMIT 1;
    CONTINUE WHEN v_menu_opt IS NULL
      OR jsonb_typeof(v_menu_opt->'choices') IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_menu_opt->'choiceCategories') IS DISTINCT FROM 'array';
    SELECT ordinality - 1 INTO v_idx FROM jsonb_array_elements(v_menu_opt->'choices') WITH ORDINALITY
      WHERE value = v_opt->'choice' ORDER BY ordinality LIMIT 1;
    v_choice_cat := v_menu_opt->'choiceCategories'->>v_idx;
    IF v_idx IS NOT NULL AND COALESCE(v_choice_cat, '') <> '' THEN
      -- Mã lạ (không phải uuid) → print.jsx cũng không tìm được máy → máy mặc định.
      v_category := CASE WHEN v_choice_cat ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN v_choice_cat::uuid END;
    END IF;
  END LOOP;
  RETURN v_category;
END $$;

-- Máy bếp của 1 món: máy đang bật đầu tiên (sort_order) nhận category đó, không
-- có thì máy mặc định. NULL nếu máy đó là máy in hoá đơn ở quầy hoặc không có máy.
CREATE OR REPLACE FUNCTION public.kitchen_printer_for(p_menu_item_id uuid, p_item_options jsonb)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_category uuid;
  v_printer  uuid;
  v_is_bill  boolean;
BEGIN
  IF p_menu_item_id IS NULL THEN RETURN NULL; END IF; -- dòng giảm giá / phụ thu
  v_category := public.order_item_print_category(p_menu_item_id, p_item_options);
  IF v_category IS NOT NULL THEN
    SELECT p.id, p.is_bill_printer INTO v_printer, v_is_bill
    FROM public.printers p JOIN public.printer_categories pc ON pc.printer_id = p.id
    WHERE p.is_active AND pc.category_id = v_category
    ORDER BY p.sort_order, p.id LIMIT 1;
  END IF;
  IF v_printer IS NULL THEN
    SELECT p.id, p.is_bill_printer INTO v_printer, v_is_bill
    FROM public.printers p WHERE p.is_active AND p.is_default
    ORDER BY p.sort_order, p.id LIMIT 1;
  END IF;
  RETURN CASE WHEN v_is_bill IS TRUE THEN NULL ELSE v_printer END;
END $$;

-- Đóng dấu "đã báo bếp" cho các món mà phiếu vừa tạo sẽ in (giống cách PrintAgent
-- chọn món: only_item_ids trước, rồi filter_category_ids, không lọc thì cả đơn).
CREATE OR REPLACE FUNCTION public.mark_items_sent_to_kitchen()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Hoá đơn / phiếu tạm tính (order_ids) in ở quầy, không phải báo bếp.
  IF cardinality(COALESCE(NEW.order_ids, '{}')) > 0 THEN RETURN NULL; END IF;
  BEGIN
    UPDATE public.order_items i SET kitchen_sent_at = now()
    FROM public.orders o
    WHERE i.order_id = NEW.order_id AND o.id = i.order_id
      AND o.status IN ('pending', 'preparing', 'completed')
      AND i.kitchen_sent_at IS NULL
      AND CASE
        WHEN cardinality(COALESCE(NEW.only_item_ids, '{}')) > 0 THEN i.id = ANY(NEW.only_item_ids)
        WHEN cardinality(COALESCE(NEW.filter_category_ids, '{}')) > 0 THEN
          array_position(NEW.filter_category_ids, public.order_item_print_category(i.menu_item_id, i.item_options)) IS NOT NULL
        ELSE true
      END;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Không đóng dấu báo bếp cho phiếu %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mark_items_sent_to_kitchen ON public.print_jobs;
CREATE TRIGGER mark_items_sent_to_kitchen
AFTER INSERT ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION public.mark_items_sent_to_kitchen();
REVOKE ALL ON FUNCTION public.mark_items_sent_to_kitchen() FROM PUBLIC, anon, authenticated;

-- Tạo phiếu bếp cho đúng các dòng món (chưa báo bếp) của 1 bill đang mở.
CREATE OR REPLACE FUNCTION public.queue_kitchen_tickets(p_order_id uuid, p_item_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_jobs integer;
BEGIN
  -- 2 máy cùng bấm "In bếp": máy sau chờ máy trước xong rồi thấy món đã báo → không in trùng.
  PERFORM 1 FROM public.order_items WHERE order_id = p_order_id AND id = ANY(p_item_ids) FOR UPDATE;
  INSERT INTO public.print_jobs(order_id, printer_id, only_item_ids, status)
  SELECT p_order_id, r.printer_id, array_agg(r.id ORDER BY r.created_at, r.id), 'pending'
  FROM (
    SELECT i.id, i.created_at, public.kitchen_printer_for(i.menu_item_id, i.item_options) AS printer_id
    FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
    WHERE i.order_id = p_order_id AND i.id = ANY(p_item_ids)
      AND i.kitchen_sent_at IS NULL
      AND o.status IN ('pending', 'preparing', 'completed')
  ) r
  WHERE r.printer_id IS NOT NULL
  GROUP BY r.printer_id;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;
  RETURN v_jobs;
END $$;
GRANT EXECUTE ON FUNCTION public.queue_kitchen_tickets(uuid, uuid[]) TO anon, authenticated;

-- Nhân viên bấm "+" / gõ thêm số lượng trên 1 dòng món trong bill.
CREATE OR REPLACE FUNCTION public.add_item_portion(
  p_item_id uuid,
  p_quantity integer,
  p_staff_id uuid DEFAULT NULL,
  p_staff_name text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item   public.order_items%ROWTYPE;
  v_new_id uuid;
  v_jobs   integer := 0;
BEGIN
  IF COALESCE(p_quantity, 0) < 1 THEN RAISE EXCEPTION 'Số lượng thêm không hợp lệ'; END IF;
  SELECT * INTO v_item FROM public.order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Món đã thay đổi'; END IF;

  -- Món chưa báo bếp (phiếu sau sẽ in đủ số mới), quà, hoặc không phải món bếp → cộng như trước.
  IF v_item.kitchen_sent_at IS NULL OR v_item.is_gift
     OR public.kitchen_printer_for(v_item.menu_item_id, v_item.item_options) IS NULL THEN
    UPDATE public.order_items SET quantity = quantity + p_quantity WHERE id = p_item_id;
    RETURN jsonb_build_object('item_id', p_item_id, 'new_line', false, 'print_jobs', 0);
  END IF;

  INSERT INTO public.order_items (
    order_id, menu_item_id, quantity, unit_price, item_options, note, item_name, added_by_id, added_by_name
  ) VALUES (
    v_item.order_id, v_item.menu_item_id, p_quantity, v_item.unit_price, v_item.item_options,
    v_item.note, v_item.item_name, p_staff_id, p_staff_name
  ) RETURNING id INTO v_new_id;
  v_jobs := public.queue_kitchen_tickets(v_item.order_id, ARRAY[v_new_id]);
  RETURN jsonb_build_object('item_id', v_new_id, 'new_line', true, 'print_jobs', v_jobs);
END $$;
GRANT EXECUTE ON FUNCTION public.add_item_portion(uuid, integer, uuid, text) TO anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
