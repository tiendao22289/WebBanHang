-- Giỏ của khách chưa gửi (trang gọi món QR) → trang Bàn hiện 🛒 trên đúng bàn đó; giỏ để yên
-- 5 phút mà chưa gửi thì ô bàn chớp vàng "Khách quên gửi món" (src/lib/customerCartAlert.mjs).
-- Chỉ là tín hiệu nhắc nhân viên: không có tiền, không có tên / SĐT khách. Chạy lại được nhiều lần.
--
-- Mỗi máy khách 1 dòng, khoá là sha256 của mã bí mật trong máy (người khác đọc được bảng cũng
-- không sửa được giỏ của máy này). Giỏ trống / khách gửi đơn → xoá dòng. Bàn thanh toán xong
-- (tables.last_payment_at) thì giỏ cũ hơn lúc đó không còn tính; giỏ để yên quá 2 tiếng cũng vậy.

CREATE TABLE IF NOT EXISTS public.customer_cart_drafts (
  device_hash text PRIMARY KEY CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 5940),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ id: món, q: số phần, o?: lựa chọn, g?: quà }]
  first_added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_cart_drafts_table_idx ON public.customer_cart_drafts (table_id);
CREATE INDEX IF NOT EXISTS customer_cart_drafts_updated_idx ON public.customer_cart_drafts (updated_at);

-- Giỏ nhân viên đã nhận để gửi hộ / sửa rồi gửi (2026-11-14). Điện thoại khách hỏi thấy thì bớt đúng
-- các món đó khỏi giỏ và báo "nhân viên đã nhận giỏ", rồi đánh dấu đã biết (customer_cart_taken_ack).
-- Giữ 1 ngày (source_updated_at): trang Bàn nhận xong mà ghi bill lỗi, bấm gửi lại vẫn được nhận.
-- Không cho trình duyệt đọc thẳng: chỉ máy có mã bí mật mới hỏi được giỏ của chính mình.
CREATE TABLE IF NOT EXISTS public.customer_cart_taken (
  device_hash text PRIMARY KEY CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  table_id uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  taken_at timestamptz NOT NULL DEFAULT now(),
  source_updated_at timestamptz,   -- bản giỏ đã nhận (customer_cart_drafts.updated_at)
  acked_at timestamptz              -- điện thoại khách đã bớt các món đó khỏi giỏ
);
ALTER TABLE public.customer_cart_taken ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_cart_taken FROM PUBLIC, anon, authenticated;

-- Trình duyệt chỉ đọc (để realtime báo trang Bàn); ghi / xoá qua các hàm bên dưới.
ALTER TABLE public.customer_cart_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_cart_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_cart_drafts TO anon, authenticated;
DROP POLICY IF EXISTS customer_cart_drafts_read ON public.customer_cart_drafts;
CREATE POLICY customer_cart_drafts_read ON public.customer_cart_drafts FOR SELECT TO anon, authenticated USING (true);

-- Trang khách gọi mỗi khi giỏ đổi (đợi ~1 giây). p_items: [{ id, q, o?, p?, t?, g? }] như cartAlertItems():
-- o = lựa chọn ghép chữ (để đọc), p = [{ n: nhóm, c: lựa chọn }] (để nhân viên gửi hộ đúng món), t = ghi chú.
-- Giỏ giống hệt lần trước thì không đổi giờ (tải lại trang không làm mất mốc "để yên 5 phút").
-- Nhân viên đã nhận giỏ của máy này mà máy chưa biết → trả taken, không ghi lại giỏ cũ (khỏi báo lại bàn).
CREATE OR REPLACE FUNCTION public.report_customer_cart(p_device_key text, p_table_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_device text;
  v_items jsonb;
  v_count integer;
BEGIN
  IF p_device_key IS NULL OR p_device_key !~ '^[A-Za-z0-9_-]{32,128}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_key');
  END IF;
  v_device := encode(sha256(convert_to(p_device_key, 'UTF8')), 'hex');

  -- Dọn giỏ bỏ quên lâu ngày (máy khách tắt luôn không báo lại).
  DELETE FROM customer_cart_drafts WHERE updated_at < now() - interval '1 day';
  DELETE FROM customer_cart_taken WHERE taken_at < now() - interval '1 day';

  IF EXISTS (SELECT 1 FROM customer_cart_taken k WHERE k.device_hash = v_device AND k.acked_at IS NULL) THEN
    RETURN jsonb_build_object('ok', true, 'taken', true);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'q', x.q)
           || CASE WHEN x.o <> '' THEN jsonb_build_object('o', x.o) ELSE '{}'::jsonb END
           || CASE WHEN jsonb_array_length(x.p) > 0 THEN jsonb_build_object('p', x.p) ELSE '{}'::jsonb END
           || CASE WHEN x.t <> '' THEN jsonb_build_object('t', x.t) ELSE '{}'::jsonb END
           || CASE WHEN x.g THEN '{"g": true}'::jsonb ELSE '{}'::jsonb END ORDER BY x.ord), '[]'::jsonb),
         coalesce(sum(x.q), 0)::integer
    INTO v_items, v_count
  FROM (
    SELECT e.ord,
      CASE WHEN e.v->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e.v->>'id')::uuid END AS id,
      CASE WHEN e.v->>'q' ~ '^[0-9]{1,2}$' THEN (e.v->>'q')::integer END AS q,
      CASE WHEN jsonb_typeof(e.v->'o') = 'string' THEN left(e.v->>'o', 120) ELSE '' END AS o,
      -- Lựa chọn hợp lệ (nhóm + lựa chọn là chữ, lựa chọn không trống), giữ thứ tự, tối đa 8 — y như cartAlertItems().
      (SELECT coalesce(jsonb_agg(jsonb_build_object('n', z.n, 'c', z.c) ORDER BY z.ord), '[]'::jsonb)
       FROM (SELECT left(o.v->>'n', 60) AS n, left(o.v->>'c', 200) AS c, o.ord
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.v->'p') = 'array' THEN e.v->'p' ELSE '[]'::jsonb END)
               WITH ORDINALITY AS o(v, ord)
             WHERE jsonb_typeof(o.v) = 'object' AND jsonb_typeof(o.v->'n') = 'string' AND jsonb_typeof(o.v->'c') = 'string'
               AND o.v->>'n' <> '' AND o.v->>'c' <> ''
             ORDER BY o.ord LIMIT 8) z) AS p,
      CASE WHEN jsonb_typeof(e.v->'t') = 'string' THEN left(e.v->>'t', 120) ELSE '' END AS t,
      coalesce(e.v->'g' = 'true'::jsonb, false) AS g
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e(v, ord)
    WHERE e.ord <= 60 AND jsonb_typeof(e.v) = 'object'
  ) x
  WHERE x.id IS NOT NULL AND x.q BETWEEN 1 AND 99
    AND EXISTS (SELECT 1 FROM menu_items m WHERE m.id = x.id);

  IF v_count = 0 OR p_table_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM tables t WHERE t.id = p_table_id AND coalesce(t.table_type, '') <> 'takeaway') THEN
    DELETE FROM customer_cart_drafts WHERE device_hash = v_device;
    RETURN jsonb_build_object('ok', true, 'count', 0);
  END IF;

  -- Chặn rác: 1 bàn tối đa 12 máy có giỏ cùng lúc.
  IF (SELECT count(*) FROM customer_cart_drafts c
      WHERE c.table_id = p_table_id AND c.device_hash <> v_device AND c.updated_at > now() - interval '2 hours') >= 12 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many');
  END IF;

  INSERT INTO customer_cart_drafts AS c (device_hash, table_id, item_count, items)
  VALUES (v_device, p_table_id, v_count, v_items)
  ON CONFLICT (device_hash) DO UPDATE
    SET table_id = EXCLUDED.table_id,
        item_count = EXCLUDED.item_count,
        items = EXCLUDED.items,
        updated_at = now(),
        first_added_at = CASE WHEN c.table_id = EXCLUDED.table_id THEN c.first_added_at ELSE now() END
    WHERE c.table_id IS DISTINCT FROM EXCLUDED.table_id OR c.items IS DISTINCT FROM EXCLUDED.items;
  RETURN jsonb_build_object('ok', true, 'count', v_count);
END $$;

-- Trang Bàn đọc: giỏ còn tính + đã để yên bao lâu theo giờ MÁY CHỦ (máy ở quán có thể lệch giờ).
-- cart_id + updated_at: nhân viên bấm Gửi hộ thì nhận đúng bản giỏ đang xem (khách sửa sau đó → từ chối).
DROP FUNCTION IF EXISTS public.get_customer_carts();
CREATE FUNCTION public.get_customer_carts()
RETURNS TABLE (table_id uuid, item_count integer, items jsonb, idle_ms bigint, age_ms bigint, cart_id text, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.table_id, c.item_count, c.items,
    floor(extract(epoch FROM now() - c.updated_at) * 1000)::bigint,
    floor(extract(epoch FROM now() - c.first_added_at) * 1000)::bigint,
    c.device_hash, c.updated_at
  FROM customer_cart_drafts c
  JOIN tables t ON t.id = c.table_id
  LEFT JOIN tables h ON h.id = t.merged_with
  WHERE coalesce(t.table_type, '') <> 'takeaway'
    AND c.updated_at > now() - interval '2 hours'
    AND c.updated_at > coalesce(greatest(t.last_payment_at, h.last_payment_at), '-infinity'::timestamptz)
  ORDER BY c.updated_at;
$$;

-- Nhân viên đã nhắc khách (hoặc khách nhờ nhân viên gọi giúp) → tắt báo của bàn. Khách sửa giỏ thì báo lại.
CREATE OR REPLACE FUNCTION public.dismiss_customer_carts(p_table_id uuid)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (DELETE FROM customer_cart_drafts WHERE table_id = p_table_id RETURNING 1)
  SELECT count(*)::integer FROM gone;
$$;

-- Nhân viên nhận giỏ của 1 máy khách để gửi hộ / sửa rồi gửi. Chỉ máy chủ gọi (/api/admin/customer-cart,
-- có kiểm đăng nhập nhân viên): khoá công khai mà gọi được thì người ngoài xoá được giỏ của khách.
-- Đúng bản giỏ nhân viên đang xem (p_updated_at) mới nhận; khách vừa sửa → changed, khách đã gửi / xoá → gone.
CREATE OR REPLACE FUNCTION public.take_customer_cart(p_table_id uuid, p_cart_id text, p_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r customer_cart_drafts%ROWTYPE;
  v_again jsonb;
BEGIN
  -- Đã nhận đúng bản này rồi (lần trước ghi bill lỗi / mất phản hồi) → vẫn coi là nhận được, kể cả khi
  -- điện thoại khách đã bớt món và khách chọn tiếp giỏ mới.
  SELECT k.items INTO v_again FROM customer_cart_taken k
  WHERE k.device_hash = p_cart_id AND k.table_id = p_table_id AND k.source_updated_at = p_updated_at;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'items', v_again, 'again', true);
  END IF;
  SELECT * INTO r FROM customer_cart_drafts c
  WHERE c.device_hash = p_cart_id AND c.table_id = p_table_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'gone');
  END IF;
  IF p_updated_at IS NULL OR r.updated_at <> p_updated_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'changed', 'items', r.items, 'updated_at', r.updated_at);
  END IF;
  INSERT INTO customer_cart_taken AS k (device_hash, table_id, items, taken_at, source_updated_at, acked_at)
  VALUES (r.device_hash, r.table_id, r.items, now(), r.updated_at, NULL)
  ON CONFLICT (device_hash) DO UPDATE
    -- Lần nhận trước điện thoại chưa biết → cộng dồn để máy bớt đủ cả hai lần; đã biết rồi → thay mới.
    SET items = CASE WHEN k.acked_at IS NULL THEN k.items || EXCLUDED.items ELSE EXCLUDED.items END,
        table_id = EXCLUDED.table_id, taken_at = now(), source_updated_at = EXCLUDED.source_updated_at, acked_at = NULL;
  DELETE FROM customer_cart_drafts c WHERE c.device_hash = r.device_hash;
  RETURN jsonb_build_object('ok', true, 'items', r.items);
END $$;

-- Điện thoại khách hỏi: nhân viên đã nhận giỏ của máy mình chưa → { items, at } hoặc null.
CREATE OR REPLACE FUNCTION public.customer_cart_taken_get(p_device_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('items', k.items, 'at', k.taken_at)
  FROM customer_cart_taken k
  WHERE p_device_key ~ '^[A-Za-z0-9_-]{32,128}$'
    AND k.device_hash = encode(sha256(convert_to(p_device_key, 'UTF8')), 'hex')
    AND k.acked_at IS NULL;
$$;

-- Điện thoại sắp bớt các món đó khỏi giỏ → đánh dấu đã biết (đúng lần nhận p_at; nhận thêm sau đó vẫn báo).
CREATE OR REPLACE FUNCTION public.customer_cart_taken_ack(p_device_key text, p_at timestamptz)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH seen AS (
    UPDATE customer_cart_taken k SET acked_at = now()
    WHERE p_device_key ~ '^[A-Za-z0-9_-]{32,128}$'
      AND k.device_hash = encode(sha256(convert_to(p_device_key, 'UTF8')), 'hex')
      AND k.taken_at = p_at AND k.acked_at IS NULL
    RETURNING 1)
  SELECT count(*) > 0 FROM seen;
$$;

REVOKE ALL ON FUNCTION public.report_customer_cart(text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_carts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dismiss_customer_carts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.take_customer_cart(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_cart_taken_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_cart_taken_ack(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_customer_cart(text, uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_carts() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_customer_carts(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_cart_taken_get(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_cart_taken_ack(text, timestamptz) TO anon, authenticated;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.take_customer_cart(uuid, text, timestamptz) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; -- DB thử (PGlite) không có service_role
END $$;

-- Realtime để trang Bàn thấy 🛒 ngay (không có thì trang Bàn tự hỏi lại mỗi 30 giây).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_cart_drafts;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
