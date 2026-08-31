-- ============================================================
-- Tách quà "gift" chung chung thành 2 loại rõ ràng: gift_drink (Tặng nước)
-- và gift_dish (Tặng món) — khách được chọn ĐÚNG món/nước cụ thể ngay khi
-- quay trúng, thay vì chỉ ghi 1 dòng chữ chung chung vào bill (menu_item_id
-- luôn NULL như trước đây, nhân viên phải tự đoán mang gì ra).
-- ============================================================

-- Khách chọn xong món/nước nào thì lưu lại đây — applyLuckySpin() (server)
-- đọc cột này để ghi ĐÚNG món đó vào order_items thay vì nhãn chung chung.
ALTER TABLE lucky_spins
  ADD COLUMN IF NOT EXISTS gift_menu_item_id uuid REFERENCES menu_items(id),
  ADD COLUMN IF NOT EXISTS gift_item_options jsonb;

-- Cơ cấu quà cũ (2 dòng type='gift' có sẵn) migrate sang loại mới tương ứng,
-- dựa theo tên đã đặt sẵn — không có dòng nào khác dùng type='gift' nên an
-- toàn để suy luận theo nhãn.
UPDATE lucky_prizes SET type = 'gift_drink' WHERE type = 'gift' AND label ILIKE '%nước%';
UPDATE lucky_prizes SET type = 'gift_dish'  WHERE type = 'gift' AND label ILIKE '%món%';

-- get_my_lucky_spin() phải trả thêm applied_item_id + gift_menu_item_id +
-- gift_item_options — khách quay trúng "Tặng nước/món" cần phân biệt được
-- "status='applied' nhưng CHƯA chọn món" (còn phải chọn) với "đã chọn và
-- món đã vào bill" (applied_item_id có giá trị). Trước đây hàm chỉ trả
-- discount_amount vì quà % là đủ biết xong hay chưa; giờ quà tặng cần thêm.
-- RETURNS TABLE đổi danh sách cột thì phải DROP trước, CREATE OR REPLACE
-- không cho đổi chữ ký cột của hàm đã tồn tại.
DROP FUNCTION IF EXISTS get_my_lucky_spin(uuid);

CREATE FUNCTION get_my_lucky_spin(p_spin_id uuid)
RETURNS TABLE(
  id uuid, status text, prize_key text, prize_type text, prize_value numeric,
  prize_label text, discount_amount integer, block_reason text, created_at timestamptz,
  applied_item_id uuid, gift_menu_item_id uuid, gift_item_options jsonb
)
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
  SELECT id, status, prize_key, prize_type, prize_value, prize_label,
         discount_amount, block_reason, created_at,
         applied_item_id, gift_menu_item_id, gift_item_options
  FROM lucky_spins
  WHERE id = p_spin_id;
$$;

GRANT EXECUTE ON FUNCTION get_my_lucky_spin(uuid) TO anon, authenticated;
