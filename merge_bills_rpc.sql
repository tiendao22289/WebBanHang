-- Tạo RPC để xử lý Gộp Bill an toàn (Atomic Transaction)
CREATE OR REPLACE FUNCTION merge_bills_atomic(
    p_all_bill_ids UUID[],
    p_main_bill_id UUID,
    p_other_bill_ids UUID[],
    p_new_total NUMERIC,
    p_new_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- 1. Xoá tất cả các order_items cũ thuộc về nhóm bill này
    DELETE FROM order_items WHERE order_id = ANY(p_all_bill_ids);

    -- 2. Chèn các món đã được gom nhóm (gộp số lượng) vào bill chính
    -- Lặp qua mảng JSON p_new_items để insert
    INSERT INTO order_items (
        order_id, 
        menu_item_id, 
        quantity, 
        unit_price, 
        item_options, 
        note, 
        is_gift
    )
    SELECT 
        (elem->>'order_id')::UUID,
        (elem->>'menu_item_id')::UUID,
        (elem->>'quantity')::INTEGER,
        (elem->>'unit_price')::NUMERIC,
        elem->'item_options',
        elem->>'note',
        (elem->>'is_gift')::BOOLEAN
    FROM jsonb_array_elements(p_new_items) AS elem;

    -- 3. Đánh dấu các bill phụ là đã Huỷ (cancelled) và set tổng tiền về 0
    IF array_length(p_other_bill_ids, 1) > 0 THEN
        UPDATE orders 
        SET status = 'cancelled', 
            total_amount = 0 
        WHERE id = ANY(p_other_bill_ids);
    END IF;

    -- 4. Cập nhật tổng tiền cho bill chính (không bao gồm món quà)
    UPDATE orders 
    SET total_amount = p_new_total 
    WHERE id = p_main_bill_id;

    -- Trả về thành công
    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    -- Nếu có bất kỳ lỗi nào, PostgreSQL sẽ tự động ROLLBACK
    -- Ta có thể log lại lỗi hoặc ném ra ngoài
    RAISE EXCEPTION 'Lỗi khi gộp bill: %', SQLERRM;
END;
$$;
