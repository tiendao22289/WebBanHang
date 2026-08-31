-- ============================================================
-- get_lucky_wheel_public_stats: cho khách xem "đã có bao nhiêu lượt quay"
-- và "10 người trúng gần nhất trúng gì" ngay trong popup vòng xoay, kiểu
-- khoe trúng thưởng để khách hứng thú quay hơn.
--
-- An toàn PII: hàm này SECURITY DEFINER và tự ẩn danh tên khách NGAY TRONG
-- SQL trước khi trả ra ngoài — never để tên/SĐT thật rời khỏi DB, dù chỉ để
-- client tự che sau đó (đây đúng là kiểu lỗi lộ SĐT đã từng vá ở
-- lucky_wheel_security_fixes.sql, không lặp lại kiểu đó nữa).
-- ============================================================

-- Ẩn danh tên: nhiều từ thì viết tắt hết trừ từ cuối (tên gọi hàng ngày,
-- vd "Nguyễn Văn An" -> "N. V. An"); 1 từ thì giữ ký tự đầu, che phần còn
-- lại bằng dấu *.
CREATE OR REPLACE FUNCTION mask_customer_name(full_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parts text[];
  n int;
  result text := '';
  i int;
  cleaned text;
BEGIN
  cleaned := trim(coalesce(full_name, ''));
  IF cleaned = '' THEN
    RETURN 'Khách';
  END IF;

  parts := regexp_split_to_array(cleaned, '\s+');
  n := array_length(parts, 1);

  IF n <= 1 THEN
    RETURN left(cleaned, 1) || repeat('*', greatest(length(cleaned) - 1, 1));
  END IF;

  FOR i IN 1..(n - 1) LOOP
    result := result || left(parts[i], 1) || '. ';
  END LOOP;
  RETURN result || parts[n];
END;
$$;

CREATE OR REPLACE FUNCTION get_lucky_wheel_public_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_winners json;
BEGIN
  SELECT count(*) INTO v_total FROM lucky_spins;

  SELECT coalesce(json_agg(row_to_json(w)), '[]'::json) INTO v_winners
  FROM (
    SELECT
      mask_customer_name(customer_name) AS name,
      prize_label,
      prize_type,
      prize_value
    FROM lucky_spins
    WHERE status = 'applied'
    ORDER BY verified_at DESC NULLS LAST, created_at DESC
    LIMIT 10
  ) w;

  RETURN json_build_object('totalSpins', v_total, 'recentWinners', v_winners);
END;
$$;

GRANT EXECUTE ON FUNCTION get_lucky_wheel_public_stats() TO anon, authenticated;
