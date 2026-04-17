CREATE OR REPLACE FUNCTION get_menu_sales_stats()
RETURNS TABLE(menu_item_id UUID, total_sold BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    oi.menu_item_id, 
    SUM(oi.quantity) as total_sold
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status IN ('completed', 'paid') 
    AND oi.is_gift = false
  GROUP BY oi.menu_item_id;
END;
$$ LANGUAGE plpgsql;
