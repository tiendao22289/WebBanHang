-- 1. Tạo bảng cancellation_logs
CREATE TABLE IF NOT EXISTS cancellation_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    order_id UUID,
    table_number VARCHAR(50),
    customer_name VARCHAR(255),
    staff_name VARCHAR(255),
    total_amount NUMERIC DEFAULT 0,
    action_type VARCHAR(100),
    items_detail JSONB
);

-- 2. Đảm bảo bảng có RLS nhưng tạm thời cho phép tất cả (tương tự các bảng khác)
ALTER TABLE cancellation_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on cancellation_logs" ON cancellation_logs FOR ALL USING (true);

-- 3. Tạo hàm Trigger
CREATE OR REPLACE FUNCTION log_order_cancellation()
RETURNS TRIGGER AS $$
DECLARE
    v_table_number VARCHAR;
    v_items JSONB;
BEGIN
    -- Chỉ kích hoạt khi status đổi sang 'cancelled'
    IF NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
        -- Lấy tên bàn
        SELECT table_number INTO v_table_number FROM tables WHERE id = NEW.table_id;
        
        -- Lấy chi tiết món ăn (cần group lại thành JSON array)
        SELECT jsonb_agg(
            jsonb_build_object(
                'name', mi.name,
                'quantity', oi.quantity,
                'price_at_time', oi.price_at_time,
                'note', oi.note
            )
        )
        INTO v_items
        FROM order_items oi
        LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
        WHERE oi.order_id = NEW.id;

        -- Ghi log
        INSERT INTO cancellation_logs (
            order_id, 
            table_number, 
            customer_name, 
            staff_name, 
            total_amount, 
            action_type, 
            items_detail
        ) VALUES (
            NEW.id,
            COALESCE(v_table_number, 'Không rõ bàn'),
            NEW.customer_name,
            'Web System',
            NEW.total_amount,
            'Huỷ trên hệ thống',
            COALESCE(v_items, '[]'::jsonb)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Gắn Trigger vào bảng orders
DROP TRIGGER IF EXISTS on_order_cancelled ON orders;
CREATE TRIGGER on_order_cancelled
AFTER UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION log_order_cancellation();
