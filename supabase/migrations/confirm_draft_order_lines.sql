-- ============================================================
-- confirm_draft_order — bản an toàn khi nhân viên "Gửi đi" / "Xác nhận gọi món"
-- (thay bản trong confirm_draft_order_rpc.sql, cùng chữ ký nên trang cũ vẫn gọi được).
--
-- 1. Mỗi dòng nháp mang line_id (uuid do điện thoại tạo). Dòng nào đã ghi vào bill
--    thì gửi lại sẽ bị bỏ qua → mạng rớt phản hồi rồi bấm gửi lại không cộng món 2 lần.
-- 2. Chỉ cộng dồn vào dòng CÙNG giá và KHÔNG phải quà: trước đây thêm 2 phần nghêu
--    trả tiền mà bàn đã có nghêu quà 8 tặng 1 (0đ) thì bị cộng vào dòng quà → mất tiền.
-- 3. Từ chối số lượng < 1 hoặc giá âm (trước đây số lượng âm làm bớt món đã ăn).
--
-- Chạy lại được nhiều lần. Cài bằng workflow "Apply Finance Migration".
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.draft_order_lines (
  line_id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_order_lines_created_at_idx ON public.draft_order_lines(created_at);
ALTER TABLE public.draft_order_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.draft_order_lines FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.confirm_draft_order(
  p_table_id uuid,
  p_items jsonb,
  p_staff_id uuid DEFAULT NULL,
  p_staff_name text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_id      uuid;
  v_table_status  text;
  v_new_total     numeric;
  v_item          jsonb;
  v_existing_id   uuid;
  v_existing_qty  integer;
  v_line_id       uuid;
  v_qty           integer;
  v_price         numeric;
  v_skipped       integer := 0;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Danh sách món trống';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'menu_item_id') IS NULL
       OR COALESCE((v_item->>'quantity')::integer, 0) < 1
       OR COALESCE((v_item->>'unit_price')::numeric, -1) < 0 THEN
      RAISE EXCEPTION 'Món, số lượng hoặc giá không hợp lệ';
    END IF;
  END LOOP;

  -- Serialize theo bàn — tránh 2 request cùng lúc cùng tạo order Admin mới
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  -- 1. Tìm order "Admin" đang mở của bàn, tạo mới nếu chưa có
  SELECT id INTO v_order_id
  FROM orders
  WHERE table_id = p_table_id
    AND customer_name = 'Admin'
    AND status IN ('pending', 'preparing', 'completed')
  LIMIT 1;

  IF v_order_id IS NULL THEN
    INSERT INTO orders (table_id, customer_name, customer_phone, status, total_amount, created_by_id, created_by_name)
    VALUES (p_table_id, 'Admin', 'Quản lý', 'pending', 0, p_staff_id, p_staff_name)
    RETURNING id INTO v_order_id;

    SELECT status INTO v_table_status FROM tables WHERE id = p_table_id;
    IF v_table_status = 'available' THEN
      UPDATE tables SET status = 'occupied', occupied_at = now() WHERE id = p_table_id;
    END IF;
  END IF;

  DELETE FROM draft_order_lines WHERE created_at < now() - interval '2 days';

  -- 2. Ghi từng dòng — cộng dồn vào dòng CÙNG (món + tuỳ chọn + ghi chú + người thêm + giá), không phải quà.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'quantity')::integer;
    v_price := (v_item->>'unit_price')::numeric;
    v_line_id := NULLIF(v_item->>'line_id', '')::uuid;
    IF v_line_id IS NOT NULL THEN
      INSERT INTO draft_order_lines(line_id, order_id) VALUES (v_line_id, v_order_id)
      ON CONFLICT (line_id) DO NOTHING;
      IF NOT FOUND THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
    END IF;

    v_existing_id := NULL;
    SELECT id, quantity INTO v_existing_id, v_existing_qty
    FROM order_items
    WHERE order_id = v_order_id
      AND menu_item_id = (v_item->>'menu_item_id')::uuid
      AND COALESCE(item_options, '[]'::jsonb) = COALESCE(v_item->'item_options', '[]'::jsonb)
      AND COALESCE(note, '') = COALESCE(v_item->>'note', '')
      AND added_by_id IS NOT DISTINCT FROM p_staff_id
      AND is_gift IS NOT TRUE
      AND unit_price = v_price
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE order_items SET quantity = v_existing_qty + v_qty WHERE id = v_existing_id;
    ELSE
      INSERT INTO order_items (
        order_id, menu_item_id, quantity, unit_price, item_options, note, item_name, added_by_id, added_by_name
      ) VALUES (
        v_order_id,
        (v_item->>'menu_item_id')::uuid,
        v_qty,
        v_price,
        COALESCE(v_item->'item_options', '[]'::jsonb),
        COALESCE(v_item->>'note', ''),
        v_item->>'item_name',
        p_staff_id,
        p_staff_name
      );
    END IF;
  END LOOP;

  -- 3. Tính lại tổng tiền từ chính DB rồi ghi lại — không tin số cũ ở client
  SELECT COALESCE(SUM(unit_price * quantity), 0) INTO v_new_total
  FROM order_items WHERE order_id = v_order_id;

  UPDATE orders SET total_amount = v_new_total WHERE id = v_order_id;

  RETURN jsonb_build_object('order_id', v_order_id, 'new_total', v_new_total, 'skipped_lines', v_skipped);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Lỗi khi gửi món (confirm_draft_order): %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_draft_order(uuid, jsonb, uuid, text) TO anon, authenticated;

COMMIT;
