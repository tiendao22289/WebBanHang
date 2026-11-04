-- ============================================================
-- submit_customer_order_atomic — bản đọc thực đơn trước khi ghi đơn khách
-- (thay bản trong submit_customer_order_atomic.sql, cùng chữ ký nên trang gọi món cũ vẫn gọi được).
--
-- Bản cũ nhận nguyên giá / cờ quà trình duyệt gửi lên: giỏ lưu từ hôm trước còn giá cũ, món tắt
-- "hết hôm nay" mở lại giỏ vẫn gửi được, và dòng 0đ tự đánh dấu "quà" thì vào bill miễn phí.
-- Bây giờ, trước khi ghi gì:
--  1. Giá 1 phần lấy từ menu_items, đúng cách trang gọi món tính (computeModalPrice): có lựa chọn
--     đặt giá thì giá = tổng giá các lựa chọn đã chọn, không thì giá món. Khác giá máy khách gửi
--     → không ghi, trả 'price_changed' kèm giá mới để trang sửa giỏ cho khách xem lại rồi gửi.
--  2. Món tắt (is_available = false, hidden_until chưa qua), lựa chọn tắt (hiddenChoices) hoặc không
--     còn trong thực đơn → không ghi, trả 'item_off' để trang bỏ khỏi giỏ và báo khách.
--  3. Dòng quà (is_gift) qua hàm này chỉ có thể là quà "8 tặng 1" khách chọn: món phải là món tặng
--     (is_gift_item) đang bán, và số quà không vượt số suất của nhóm bàn — cùng cách tính với trang
--     gọi món (promoGiftStatus): tổng món tính KM (chia theo SL/1 KM) của các bill đang mở + đơn này,
--     chia ngưỡng, trừ quà đã chọn (không tính quà vòng xoay). Không thì trả 'gift_not_allowed'.
--     Quà vòng xoay do máy chủ ghi thẳng vào bill (zaloRewardServer.js, lucky_wheel_*), không qua đây.
-- Gửi lại sau khi mất phản hồi vẫn trả đơn đầu tiên (kiểm tra trước mọi thứ khác).
-- Trả { rejected: true, reason, lines: [{ index, menu_item_id, name, problem: off|price|gift, price?, choice? }] }
-- khi từ chối (index = vị trí dòng trong p_items). Chạy lại được nhiều lần.
-- ============================================================
BEGIN;

-- Số trong jsonb của thực đơn (giá / SL/1 KM có thể là số hoặc chữ số); còn lại NULL.
CREATE OR REPLACE FUNCTION public.menu_json_number(v jsonb)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'number' THEN (v #>> '{}')::numeric
    WHEN 'string' THEN CASE WHEN btrim(v #>> '{}') ~ '^-?\d+(\.\d+)?$' THEN btrim(v #>> '{}')::numeric END
  END
$$;

-- Cờ ẩn của 1 lựa chọn (như isChoiceOff, menuAvailability.mjs): true, hoặc giờ chưa qua.
CREATE OR REPLACE FUNCTION public.menu_flag_off(flag jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(flag) = 'boolean' THEN RETURN flag = 'true'::jsonb; END IF;
  IF jsonb_typeof(flag) = 'string' THEN
    BEGIN
      RETURN (flag #>> '{}')::timestamptz > now();
    EXCEPTION WHEN OTHERS THEN
      RETURN false; -- chữ không phải giờ: trang khách cũng coi là đang bán
    END;
  END IF;
  RETURN false;
END $$;

-- SL/1 KM của 1 dòng (như getPromoDivisor ở trang gọi món): theo lựa chọn đã chọn, không thì
-- __promo_divisor của món, không thì 1.
CREATE OR REPLACE FUNCTION public.menu_promo_divisor(p_options jsonb, p_item_options jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  sel jsonb;
  menu_opt jsonb;
  idx integer;
  d numeric;
BEGIN
  IF p_options IS NULL OR jsonb_typeof(p_options) <> 'array' THEN RETURN 1; END IF;
  IF jsonb_typeof(p_item_options) = 'array' THEN
    FOR sel IN SELECT value FROM jsonb_array_elements(p_item_options) LOOP
      SELECT o.value INTO menu_opt FROM jsonb_array_elements(p_options) o
        WHERE o.value->>'name' = sel->>'name' AND jsonb_typeof(o.value->'choices') = 'array' LIMIT 1;
      CONTINUE WHEN menu_opt IS NULL OR jsonb_typeof(menu_opt->'promoDivisors') IS DISTINCT FROM 'array';
      SELECT (c.n - 1)::integer INTO idx FROM jsonb_array_elements_text(menu_opt->'choices') WITH ORDINALITY AS c(value, n)
        WHERE c.value = sel->>'choice' ORDER BY c.n LIMIT 1;
      CONTINUE WHEN idx IS NULL;
      d := public.menu_json_number(menu_opt->'promoDivisors'->idx);
      IF d > 0 THEN RETURN d; END IF;
    END LOOP;
  END IF;
  SELECT public.menu_json_number(o.value->'__promo_divisor') INTO d FROM jsonb_array_elements(p_options) o
    WHERE jsonb_typeof(o.value) = 'object' AND public.menu_json_number(o.value->'__promo_divisor') > 0 LIMIT 1;
  RETURN COALESCE(d, 1);
END $$;

REVOKE ALL ON FUNCTION public.menu_json_number(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_flag_off(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.menu_promo_divisor(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_customer_order_atomic(
  p_order_id uuid, p_table_id uuid, p_customer_id uuid,
  p_customer_name text, p_customer_phone text,
  p_delivery_address text, p_customer_note text, p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  existing public.orders%ROWTYPE;
  table_row public.tables%ROWTYPE;
  v_item jsonb;
  v_pos integer;
  v_opt jsonb;
  v_parts text[];
  v_part text;
  v_idx integer;
  v_qty integer;
  v_gift boolean;
  v_price numeric;
  v_off text;
  v_p numeric;
  dish jsonb;
  menu_opt jsonb;
  option_sum numeric;
  option_priced boolean;
  problems jsonb := '[]'::jsonb;
  lines jsonb := '[]'::jsonb;
  gift_lines jsonb := '[]'::jsonb;
  total numeric := 0;
  item_count integer := 0;
  gift_qty integer := 0;
  new_points numeric := 0;
  old_points numeric;
  used_gifts integer;
  host_id uuid;
  takeaway boolean;
  promo_on boolean;
  threshold integer;
  phone text := COALESCE(p_customer_phone, '');
BEGIN
  IF p_order_id IS NULL OR p_table_id IS NULL OR p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Đơn hàng hoặc danh sách món không hợp lệ';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_order_id::text));
  SELECT * INTO existing FROM public.orders WHERE id = p_order_id;
  IF existing.id IS NOT NULL THEN
    IF existing.table_id IS DISTINCT FROM p_table_id
       OR existing.customer_phone IS DISTINCT FROM phone THEN
      RAISE EXCEPTION 'Mã gửi đơn đã dùng cho đơn khác';
    END IF;
    RETURN jsonb_build_object('order_id', existing.id, 'already_submitted', true);
  END IF;

  SELECT * INTO table_row FROM public.tables WHERE id = p_table_id FOR UPDATE;
  IF table_row.id IS NULL THEN RAISE EXCEPTION 'Không tìm thấy bàn'; END IF;

  FOR v_item, v_pos IN
    SELECT e.value, (e.n - 1)::integer FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, n)
  LOOP
    IF (v_item->>'menu_item_id') IS NULL OR (v_item->>'quantity')::integer < 1
       OR (v_item->>'unit_price')::numeric < 0 THEN
      RAISE EXCEPTION 'Món hoặc giá không hợp lệ';
    END IF;
    v_qty := (v_item->>'quantity')::integer;
    v_gift := COALESCE((v_item->>'is_gift')::boolean, false);
    SELECT to_jsonb(m) INTO dish FROM public.menu_items m WHERE m.id = (v_item->>'menu_item_id')::uuid;

    -- Món đang tắt / không còn.
    IF dish IS NULL OR NOT COALESCE((dish->>'is_available')::boolean, false)
       OR ((dish->>'hidden_until') IS NOT NULL AND (dish->>'hidden_until')::timestamptz >= now()) THEN
      problems := problems || jsonb_build_object('index', v_pos, 'menu_item_id', v_item->>'menu_item_id',
        'name', dish->>'name', 'problem', 'off');
      CONTINUE;
    END IF;

    -- Lựa chọn: phải còn trong thực đơn và đang bật; cộng giá các lựa chọn có giá.
    -- Nhiều lựa chọn của 1 nhóm (khẩu vị / thêm) được trang ghép bằng ", ".
    option_sum := 0;
    option_priced := false;
    v_off := NULL;
    FOR v_opt IN SELECT o.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_item->'item_options') = 'array'
        THEN v_item->'item_options' ELSE '[]'::jsonb END) o
    LOOP
      CONTINUE WHEN COALESCE(v_opt->>'choice', '') = '';
      SELECT o.value INTO menu_opt FROM jsonb_array_elements(CASE WHEN jsonb_typeof(dish->'options') = 'array'
          THEN dish->'options' ELSE '[]'::jsonb END) o
        WHERE o.value->>'name' = v_opt->>'name' AND jsonb_typeof(o.value->'choices') = 'array' LIMIT 1;
      IF menu_opt IS NULL THEN v_off := v_opt->>'choice'; EXIT; END IF;
      v_parts := CASE WHEN menu_opt->'choices' ? (v_opt->>'choice') THEN ARRAY[v_opt->>'choice']
        ELSE string_to_array(v_opt->>'choice', ', ') END;
      FOREACH v_part IN ARRAY v_parts LOOP
        SELECT (c.n - 1)::integer INTO v_idx FROM jsonb_array_elements_text(menu_opt->'choices') WITH ORDINALITY AS c(value, n)
          WHERE c.value = v_part ORDER BY c.n LIMIT 1;
        IF v_idx IS NULL OR public.menu_flag_off(menu_opt->'hiddenChoices'->v_idx) THEN v_off := v_part; EXIT; END IF;
        v_p := public.menu_json_number(menu_opt->'prices'->v_idx);
        IF v_p IS NOT NULL THEN
          option_sum := option_sum + v_p;
          option_priced := true;
        END IF;
      END LOOP;
      EXIT WHEN v_off IS NOT NULL;
    END LOOP;
    IF v_off IS NOT NULL THEN
      problems := problems || jsonb_build_object('index', v_pos, 'menu_item_id', dish->>'id',
        'name', dish->>'name', 'choice', v_off, 'problem', 'off');
      CONTINUE;
    END IF;

    IF v_gift THEN
      IF NOT COALESCE((dish->>'is_gift_item')::boolean, false)
         OR v_item->>'note' = 'Quà tặng từ vòng quay may mắn' THEN
        problems := problems || jsonb_build_object('index', v_pos, 'menu_item_id', dish->>'id',
          'name', dish->>'name', 'problem', 'gift');
        CONTINUE;
      END IF;
      v_price := 0;
      gift_qty := gift_qty + v_qty;
      gift_lines := gift_lines || jsonb_build_object('index', v_pos, 'menu_item_id', dish->>'id',
        'name', dish->>'name', 'problem', 'gift');
    ELSE
      v_price := CASE WHEN option_priced THEN option_sum ELSE COALESCE(public.menu_json_number(dish->'price'), 0) END;
      IF v_price IS DISTINCT FROM (v_item->>'unit_price')::numeric THEN
        problems := problems || jsonb_build_object('index', v_pos, 'menu_item_id', dish->>'id',
          'name', dish->>'name', 'problem', 'price', 'price', v_price);
      END IF;
      IF COALESCE((dish->>'counts_for_promotion')::boolean, false) THEN
        new_points := new_points + v_qty / public.menu_promo_divisor(dish->'options', v_item->'item_options');
      END IF;
    END IF;
    lines := lines || jsonb_build_object('menu_item_id', dish->>'id', 'quantity', v_qty, 'unit_price', v_price,
      'item_options', COALESCE(v_item->'item_options', '[]'::jsonb), 'note', NULLIF(v_item->>'note', ''), 'is_gift', v_gift);
    item_count := item_count + 1;
    total := total + v_qty * v_price;
  END LOOP;

  -- Quà "8 tặng 1": đủ suất của nhóm bàn (mang về: các bill hôm nay — từ 5h sáng — của cùng SĐT).
  IF gift_qty > 0 THEN
    host_id := COALESCE((to_jsonb(table_row)->>'merged_with')::uuid, table_row.id);
    takeaway := COALESCE(to_jsonb(table_row)->>'table_type', '') = 'takeaway';
    PERFORM pg_advisory_xact_lock(hashtext('promo-gift:' || host_id::text));
    SELECT COALESCE(max(s.value) FILTER (WHERE s.key = 'promotion_enabled'), '') = 'true',
           COALESCE(NULLIF(substring(max(s.value) FILTER (WHERE s.key = 'promotion_threshold') FROM '^\s*(\d+)')::integer, 0), 8)
      INTO promo_on, threshold
    FROM public.settings s WHERE s.key IN ('promotion_enabled', 'promotion_threshold');
    SELECT COALESCE(sum(i.quantity::numeric / public.menu_promo_divisor(m.options, i.item_options))
             FILTER (WHERE NOT COALESCE(i.is_gift, false) AND COALESCE(m.counts_for_promotion, false)), 0),
           COALESCE(sum(COALESCE(i.quantity, 1)) FILTER (WHERE COALESCE(i.is_gift, false)
             AND i.note IS DISTINCT FROM 'Quà tặng từ vòng quay may mắn'), 0)
      INTO old_points, used_gifts
    FROM public.orders o
    JOIN public.tables t ON t.id = o.table_id
    JOIN public.order_items i ON i.order_id = o.id
    LEFT JOIN public.menu_items m ON m.id = i.menu_item_id
    WHERE COALESCE(t.merged_with, t.id) = host_id
      AND o.status IN ('pending', 'preparing', 'completed')
      AND o.customer_phone IS DISTINCT FROM 'BAO_BEP'
      AND (NOT takeaway OR (phone <> '' AND o.customer_phone = phone
        AND o.created_at >= (date_trunc('day', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '5 hours')
          + interval '5 hours') AT TIME ZONE 'Asia/Ho_Chi_Minh'));
    IF NOT promo_on
       OR gift_qty > floor(round(old_points + new_points, 4) / threshold) - used_gifts THEN
      problems := problems || gift_lines;
    END IF;
  END IF;

  IF jsonb_array_length(problems) > 0 THEN
    RETURN jsonb_build_object('order_id', NULL, 'already_submitted', false, 'rejected', true,
      'reason', CASE WHEN problems @> '[{"problem": "off"}]' THEN 'item_off'
                     WHEN problems @> '[{"problem": "gift"}]' THEN 'gift_not_allowed'
                     ELSE 'price_changed' END,
      'lines', problems);
  END IF;

  INSERT INTO public.orders(id, table_id, customer_id, customer_name,
    customer_phone, status, total_amount, delivery_address, customer_note)
  VALUES(p_order_id, p_table_id, p_customer_id,
    COALESCE(NULLIF(trim(p_customer_name), ''), 'Khách ẩn danh'),
    phone, 'pending', total,
    NULLIF(p_delivery_address, ''), NULLIF(p_customer_note, ''));

  INSERT INTO public.order_items(order_id, menu_item_id, quantity, unit_price,
    item_options, note, is_gift)
  SELECT p_order_id, (l.value->>'menu_item_id')::uuid, (l.value->>'quantity')::integer,
    (l.value->>'unit_price')::numeric, l.value->'item_options', l.value->>'note', (l.value->>'is_gift')::boolean
  FROM jsonb_array_elements(lines) WITH ORDINALITY AS l(value, n) ORDER BY l.n;

  IF table_row.status = 'available' THEN
    UPDATE public.tables SET status = 'occupied', occupied_at = now()
    WHERE id = p_table_id;
  END IF;
  RETURN jsonb_build_object('order_id', p_order_id,
    'already_submitted', false, 'item_count', item_count, 'total', total);
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
