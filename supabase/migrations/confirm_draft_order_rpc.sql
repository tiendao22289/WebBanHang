-- ============================================================
-- confirm_draft_order: gộp toàn bộ luồng "Chọn nhanh" / "Xác nhận gọi món"
-- (confirmDraft() ở admin/tables/page.js) thành 1 lệnh gọi duy nhất.
--
-- TRƯỚC ĐÂY confirmDraft() phải gọi 5 round-trip Supabase TUẦN TỰ:
--   tìm/tạo order Admin → đọc order_items hiện có → ghi từng món
--   → đọc lại toàn bộ order_items → update tổng tiền.
-- Mỗi round-trip đều chịu độ trễ mạng riêng, nên khi wifi/4G tại quán
-- chập chờn, độ trễ CỘNG DỒN qua 5 lượt → có lúc rất nhanh, có lúc
-- 15-20s (khác với 1 câu query chậm cố định — đây là trễ mạng nhân lên
-- theo số round-trip). Gộp về 1 lệnh gọi giúp chỉ còn 1 round-trip chịu
-- ảnh hưởng của độ trễ mạng.
--
-- Advisory lock theo table_id: 2 nhân viên cùng bấm "Gửi đi"/"Xác nhận
-- gọi món" cho 1 bàn CHƯA có order Admin (race) trước đây có thể tạo ra
-- 2 order Admin trùng nhau — nay bị serialize, request thứ 2 chờ request
-- đầu commit xong rồi mới thấy order vừa tạo, không tạo trùng nữa.
--
-- p_items: jsonb array [{menu_item_id, quantity, unit_price, item_options, note, item_name}]
-- Returns jsonb: { order_id, new_total }
-- ============================================================
CREATE OR REPLACE FUNCTION confirm_draft_order(
  p_table_id uuid,
  p_items jsonb,
  p_staff_id uuid DEFAULT NULL,
  p_staff_name text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id      uuid;
  v_table_status  text;
  v_new_total     integer;
  v_item          jsonb;
  v_existing_id   uuid;
  v_existing_qty  integer;
BEGIN
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Danh sách món trống';
  END IF;

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

  -- 2. Upsert từng món — cộng dồn vào dòng CÙNG (món + tuỳ chọn + ghi chú + người thêm),
  --    mỗi người thêm khác nhau vẫn giữ dòng riêng để biết ai gọi món nào.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT id, quantity INTO v_existing_id, v_existing_qty
    FROM order_items
    WHERE order_id = v_order_id
      AND menu_item_id = (v_item->>'menu_item_id')::uuid
      AND COALESCE(item_options, '[]'::jsonb) = COALESCE(v_item->'item_options', '[]'::jsonb)
      AND COALESCE(note, '') = COALESCE(v_item->>'note', '')
      AND added_by_id IS NOT DISTINCT FROM p_staff_id
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE order_items
      SET quantity = v_existing_qty + (v_item->>'quantity')::integer
      WHERE id = v_existing_id;
    ELSE
      INSERT INTO order_items (
        order_id, menu_item_id, quantity, unit_price, item_options, note, item_name, added_by_id, added_by_name
      ) VALUES (
        v_order_id,
        (v_item->>'menu_item_id')::uuid,
        (v_item->>'quantity')::integer,
        (v_item->>'unit_price')::integer,
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

  RETURN jsonb_build_object('order_id', v_order_id, 'new_total', v_new_total);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Lỗi khi gửi món (confirm_draft_order): %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_draft_order(uuid, jsonb, uuid, text) TO anon, authenticated;
