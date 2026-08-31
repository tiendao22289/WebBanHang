-- ============================================================
-- claim_lucky_wheel_slot: đảm bảo 1 hoá đơn chỉ nhận đúng 1 lần quà vòng
-- xoay, kể cả khi 2 khách CHUNG BÀN bấm "Quan tâm" Zalo đúng cùng lúc.
--
-- Trước đây applyLuckySpin() kiểm tra bill đã có quà chưa rồi MỚI ghi —
-- 2 bước tách rời, không khoá gì cả (race: cả 2 request cùng đọc thấy
-- "chưa có" trước khi request nào kịp ghi). Hàm này gộp bước kiểm tra +
-- chốt trạng thái vào 1 transaction duy nhất, khoá theo host_table_id
-- bằng pg_advisory_xact_lock (cùng kiểu khoá đã dùng cho confirm_draft_order
-- và process_bank_payment) — request thứ 2 phải đợi request thứ 1 chốt
-- xong mới được đọc, nên luôn thấy đúng trạng thái mới nhất.
--
-- Kiểm tra "bill đã có quà" dựa trên applied_order_id (quan hệ thật giữa
-- lucky_spins và orders) chứ không so khớp chữ trong item_name — tránh lặp
-- lại lỗi ilike '%VONG XOAY%' không dấu không bao giờ khớp chuỗi có dấu.
--
-- Returns: true nếu chốt được slot cho spin này, false nếu bill đã có
-- lượt quay khác 'applied' rồi, hoặc chính spin này không còn ở
-- 'waiting_follow' (đã bị xử lý ở nơi khác).
-- ============================================================
CREATE OR REPLACE FUNCTION claim_lucky_wheel_slot(
  p_spin_id uuid,
  p_host_table_id uuid,
  p_check_order_ids uuid[],
  p_target_order_id uuid,
  p_zalo_user_id text,
  p_bill_total integer,
  p_discount_amount integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_dup_exists boolean;
  v_rows integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_host_table_id::text));

  SELECT EXISTS(
    SELECT 1 FROM lucky_spins
    WHERE status = 'applied' AND applied_order_id = ANY(p_check_order_ids)
  ) INTO v_dup_exists;

  IF v_dup_exists THEN
    RETURN false;
  END IF;

  UPDATE lucky_spins
  SET status = 'applied',
      applied_order_id = p_target_order_id,
      zalo_user_id = p_zalo_user_id,
      bill_total = p_bill_total,
      discount_amount = p_discount_amount,
      verified_at = now()
  WHERE id = p_spin_id AND status = 'waiting_follow';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_lucky_wheel_slot(uuid, uuid, uuid[], uuid, text, integer, integer) TO anon, authenticated;
