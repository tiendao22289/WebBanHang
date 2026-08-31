-- ============================================================
-- Vá 2 lỗ hổng ở vòng xoay may mắn:
--
-- 1) lucky_prizes có policy "lucky_prizes_write" cho anon/authenticated
--    ghi tự do (ALL, qual=true, with_check=true). anon key là khoá PUBLIC
--    nằm ngay trong JS gửi cho khách — ai cũng lấy được và tự đổi tỉ lệ/
--    giá trị quà thẳng qua REST API của Supabase, không cần vào /admin.
--    Việc ghi giờ chuyển hết sang /api/admin/lucky-prizes (SERVICE_ROLE_KEY),
--    nên gỡ hẳn policy ghi công khai này — anon chỉ còn được ĐỌC.
--
-- 2) lucky_spins có policy SELECT cho anon với qual=true — không giới hạn
--    dòng nào cả, nên 1 câu SELECT không lọc gì cũng lấy được tên, SĐT,
--    tổng bill, số tiền giảm của MỌI khách đã từng quay. Gỡ policy này,
--    thay bằng hàm get_my_lucky_spin(uuid) — khách đưa đúng spin_id của
--    mình (một UUID ngẫu nhiên, không đoán được) thì mới đọc được, và hàm
--    chỉ trả về các cột cần cho giao diện, không có tên/SĐT/tổng bill.
-- ============================================================

DROP POLICY IF EXISTS lucky_prizes_write ON public.lucky_prizes;

DROP POLICY IF EXISTS lucky_spins_select ON public.lucky_spins;

-- lucky_spins đang nằm trong publication supabase_realtime (dùng cho tính
-- năng "quà vào hoá đơn thì báo ngay"). Gỡ bảng này ra khỏi publication vì
-- không rõ dự án đã bật enforce RLS cho Realtime hay chưa — nếu chưa, việc
-- chỉ xoá policy SELECT ở trên không chặn được ai đó tự subscribe thẳng
-- bằng anon key và vẫn nhận được đầy đủ tên/SĐT của mọi lượt quay theo thời
-- gian thực. Trang khách chuyển sang polling mỗi 7s (đã có sẵn) qua hàm
-- get_my_lucky_spin() thay cho việc lắng nghe Realtime trên bảng này.
ALTER PUBLICATION supabase_realtime DROP TABLE public.lucky_spins;

CREATE OR REPLACE FUNCTION get_my_lucky_spin(p_spin_id uuid)
RETURNS TABLE (
  id uuid,
  status text,
  prize_key text,
  prize_type text,
  prize_value numeric,
  prize_label text,
  discount_amount integer,
  block_reason text,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT id, status, prize_key, prize_type, prize_value, prize_label,
         discount_amount, block_reason, created_at
  FROM lucky_spins
  WHERE id = p_spin_id;
$$;

GRANT EXECUTE ON FUNCTION get_my_lucky_spin(uuid) TO anon, authenticated;
