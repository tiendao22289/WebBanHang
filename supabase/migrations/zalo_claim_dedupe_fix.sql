-- ============================================================
--  VÁ LỖ HỔNG PHÁT QUÀ NHIỀU LẦN CHO CÙNG MỘT BILL
--
--  Ràng buộc cũ: UNIQUE (host_table_id, session_started_at)
--  WHERE status = 'verified'.
--  VẤN ĐỀ: Postgres bỏ qua ràng buộc UNIQUE khi có cột NULL. Bàn nào
--  chưa có tables.occupied_at (mở bàn từ màn hình khác, dữ liệu cũ...)
--  thì session_started_at = NULL → ràng buộc VÔ HIỆU → cùng một bàn
--  nhận quà nhiều lần trong ngày.
--
--  CÁCH SỬA: trigger không bao giờ để trống nữa — thiếu occupied_at thì
--  lấy mốc 00:00 hôm nay (giờ VN), tức bàn đó vẫn chỉ nhận 1 lần/ngày.
--
--  Chạy lại nhiều lần vẫn an toàn.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_review_reward_session()
RETURNS TRIGGER AS $$
BEGIN
  SELECT t.occupied_at INTO NEW.session_started_at
  FROM public.tables t
  WHERE t.id = NEW.host_table_id;

  -- Không có mốc mở bàn → dùng đầu ngày (giờ VN) để ràng buộc vẫn hiệu lực
  IF NEW.session_started_at IS NULL THEN
    NEW.session_started_at :=
      ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::timestamptz;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Bản ghi cũ đang để trống → điền để không còn dòng nào lọt ràng buộc
UPDATE public.zalo_reward_claims
SET session_started_at = ((created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::timestamptz
WHERE session_started_at IS NULL;

-- Tạo lại index cho chắc (bỏ qua nếu đã có)
CREATE UNIQUE INDEX IF NOT EXISTS zalo_claims_one_per_session
  ON public.zalo_reward_claims (host_table_id, session_started_at)
  WHERE status = 'verified';

NOTIFY pgrst, 'reload schema';
