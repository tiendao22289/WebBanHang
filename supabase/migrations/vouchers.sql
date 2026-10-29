-- ============================================================
--  VOUCHER — mã giảm giá tặng khách
--
--  3 nguồn mã:
--   * gift       : chủ quán tặng tay (trang Admin > Voucher), nhắn khách qua Zalo OA
--   * next_visit : "hẹn lần sau" — thanh toán xong máy tự tặng cho SĐT của bill
--   * wheel      : trúng ô "Voucher lần sau" trên vòng xoay may mắn
--
--  Mỗi mã dùng ĐÚNG 1 LẦN, có hạn dùng. Nhân viên dùng mã ở trang Bàn →
--  redeem_voucher() khoá mã + bill, ghi dòng giảm giá (giá âm, như "Giảm giá"
--  tay) và chốt mã 'used' TRONG CÙNG MỘT GIAO DỊCH: 2 máy bấm cùng lúc thì chỉ
--  1 máy trừ được, lỗi giữa chừng thì không có gì được ghi.
--
--  Bảng chỉ cho service_role (route /api/admin/vouchers, /api/voucher/mine):
--  khách không đọc được mã/SĐT của người khác, không tự đổi trạng thái.
--  Chạy lại nhiều lần vẫn an toàn.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source IN ('gift', 'next_visit', 'wheel')),
  batch_name text,
  discount_type text NOT NULL CHECK (discount_type IN ('amount', 'percent')),
  discount_value integer NOT NULL CHECK (discount_value > 0),
  max_discount integer NOT NULL DEFAULT 0,       -- trần cho voucher %, 0 = không trần
  min_bill integer NOT NULL DEFAULT 0,           -- tiền món tối thiểu lúc dùng
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,              -- hết hạn = qua mốc này (không đổi status)
  customer_phone text,
  customer_name text,
  -- Chống tặng trùng khi gọi lại: 'pay:<bill>' cho hẹn lần sau, 'spin:<lượt quay>' cho vòng xoay.
  issue_key text UNIQUE,
  issued_order_ids uuid[] NOT NULL DEFAULT '{}',
  issued_spin_id uuid,
  -- active: chưa dùng · used: đã trừ vào bill · cancelled: chủ quán huỷ
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'cancelled')),
  used_at timestamptz,
  used_order_id uuid,
  used_item_id uuid,
  used_table_id uuid,
  used_by_name text,
  discount_amount integer NOT NULL DEFAULT 0,    -- tiền thật đã giảm
  bill_total integer NOT NULL DEFAULT 0,         -- tiền món của bill lúc dùng
  message text,                                  -- lời nhắn Zalo đã soạn cho mã này (tặng tay)
  sent_at timestamptz,                           -- đã nhắn mã qua Zalo
  send_error text,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vouchers_phone_idx ON public.vouchers (customer_phone, status);
CREATE INDEX IF NOT EXISTS vouchers_status_idx ON public.vouchers (status, valid_until);
CREATE INDEX IF NOT EXISTS vouchers_used_item_idx ON public.vouchers (used_item_id);
CREATE INDEX IF NOT EXISTS vouchers_spin_idx ON public.vouchers (issued_spin_id);
CREATE INDEX IF NOT EXISTS vouchers_orders_idx ON public.vouchers USING gin (issued_order_ids);
CREATE INDEX IF NOT EXISTS vouchers_created_idx ON public.vouchers (created_at DESC);
-- Mỗi SĐT chỉ 1 mã "lần sau" cho mỗi ngày bán hàng (2 bàn cùng SĐT thanh toán cùng lúc).
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_next_visit_once
  ON public.vouchers (customer_phone, valid_from) WHERE source = 'next_visit';

ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;
-- KHÔNG tạo policy → anon/authenticated bị chặn hết, chỉ service_role vào được.
REVOKE ALL ON public.vouchers FROM anon, authenticated;

-- ── Chìa khoá máy khách của bill ─────────────────────────────
-- Bảng orders đọc được bằng khoá công khai, nên mã bill KHÔNG phải bí mật. Trang gọi món
-- tự sinh mã bill TRƯỚC khi gửi món; ngay lúc đó nó đăng ký chìa khoá riêng của máy
-- (lưu băm). Chỉ máy có chìa khoá mới xem được mã "lần sau" của bill (/api/voucher/mine).
CREATE TABLE IF NOT EXISTS public.voucher_order_keys (
  order_id uuid PRIMARY KEY,
  table_id uuid NOT NULL,
  key_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voucher_order_keys_table_idx ON public.voucher_order_keys (table_id, created_at);
ALTER TABLE public.voucher_order_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_order_keys FROM anon, authenticated;

-- ── Dùng mã vào bill ─────────────────────────────────────────
-- p_order_ids: các bill đang mở của bàn (nhóm gộp) mà trang Bàn đang thấy.
-- Trả { ok, reason?, ... } — không RAISE cho lỗi thường gặp để trang Bàn báo rõ.
CREATE OR REPLACE FUNCTION public.redeem_voucher(
  p_code text, p_order_ids uuid[], p_staff_id uuid, p_staff_name text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v public.vouchers%ROWTYPE;
  wanted uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_order_ids, '{}')) x ORDER BY 1);
  locked uuid[];
  scope uuid[];
  group_id uuid;
  takeaway boolean;
  target uuid;
  base numeric;
  bill_now numeric;
  reduction integer;
  line_id uuid;
BEGIN
  SELECT * INTO v FROM public.vouchers WHERE code = upper(btrim(p_code)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v.status = 'used' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'used', 'used_at', v.used_at,
      'table_number', (SELECT table_number FROM public.tables WHERE id = v.used_table_id));
  END IF;
  IF v.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'cancelled'); END IF;
  IF now() < v.valid_from THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet', 'valid_from', v.valid_from);
  END IF;
  IF now() >= v.valid_until THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired', 'valid_until', v.valid_until);
  END IF;
  IF cardinality(wanted) = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_bill'); END IF;

  IF (SELECT count(DISTINCT COALESCE(t.merged_with, t.id))
      FROM public.orders o JOIN public.tables t ON t.id = o.table_id
      WHERE o.id = ANY(wanted)) <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bill_changed');
  END IF;
  SELECT COALESCE(t.merged_with, t.id), COALESCE(t.table_type = 'takeaway', false) INTO group_id, takeaway
  FROM public.orders o JOIN public.tables t ON t.id = o.table_id WHERE o.id = wanted[1];

  -- Phạm vi "1 bill 1 voucher": mọi bill đang mở của nhóm bàn (kể cả bill máy không gửi
  -- lên — gửi thiếu bill không lách được). Mang về chung 1 bàn ảo: chỉ bill cùng khách (SĐT).
  scope := ARRAY(
    SELECT o.id FROM public.orders o JOIN public.tables t ON t.id = o.table_id
    WHERE COALESCE(t.merged_with, t.id) = group_id AND o.status IN ('pending', 'preparing', 'completed')
      AND (NOT takeaway OR o.id = ANY(wanted)
           OR o.customer_phone IN (SELECT customer_phone FROM public.orders WHERE id = ANY(wanted)))
    ORDER BY o.id);
  -- Khoá cả nhóm (cùng thứ tự id với thanh toán / gộp bill): 2 máy dùng 2 mã cho cùng
  -- bàn thì máy sau chờ máy trước xong rồi mới kiểm tra.
  SELECT array_agg(id ORDER BY id) INTO locked FROM (
    SELECT id FROM public.orders WHERE id = ANY(scope) ORDER BY id FOR UPDATE) l;
  IF NOT (wanted <@ COALESCE(locked, '{}')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bill_changed');
  END IF;

  IF EXISTS (SELECT 1 FROM public.vouchers x JOIN public.order_items i ON i.id = x.used_item_id
             WHERE x.status = 'used' AND i.order_id = ANY(locked)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bill_has_voucher');
  END IF;

  -- Tiền món: dòng giá dương, không phải quà (giống "Giảm %" ở trang Bàn), cả nhóm bàn.
  -- bill_now: tổng bill hiện tại (đã trừ các giảm giá khác) — số sẽ thanh toán.
  SELECT COALESCE(SUM(unit_price::numeric * quantity) FILTER (WHERE unit_price > 0 AND NOT COALESCE(is_gift, false)), 0),
         COALESCE(SUM(unit_price::numeric * quantity), 0)
    INTO base, bill_now
  FROM public.order_items WHERE order_id = ANY(locked);
  IF v.min_bill > 0 AND base < v.min_bill THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'min_bill', 'min_bill', v.min_bill, 'base', base);
  END IF;

  IF v.discount_type = 'percent' THEN
    reduction := floor(base * v.discount_value / 100 / 1000) * 1000;
    IF v.max_discount > 0 THEN reduction := LEAST(reduction, v.max_discount); END IF;
  ELSE
    reduction := v.discount_value;
  END IF;
  -- Không giảm quá tiền món, và chừa bill ít nhất 1.000đ: thanh toán không nhận bill 0đ / âm
  -- (bill đã có giảm tay / vòng xoay mà voucher kéo về 0 thì bàn không đóng được).
  reduction := LEAST(reduction, floor(base)::integer, floor(bill_now)::integer - 1000);
  IF reduction <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero'); END IF;

  SELECT id INTO target FROM public.orders WHERE id = ANY(wanted) ORDER BY created_at, id LIMIT 1;
  INSERT INTO public.order_items (order_id, menu_item_id, item_name, quantity, unit_price, is_gift,
                                  added_by_id, added_by_name)
  VALUES (target, NULL, 'Voucher ' || v.code, 1, -reduction, false, p_staff_id, p_staff_name)
  RETURNING id INTO line_id;

  UPDATE public.vouchers SET status = 'used', used_at = now(), used_order_id = target,
    used_item_id = line_id, used_table_id = (SELECT table_id FROM public.orders WHERE id = target),
    used_by_name = p_staff_name, discount_amount = reduction, bill_total = floor(base)::integer
  WHERE id = v.id;

  RETURN jsonb_build_object('ok', true, 'code', v.code, 'discount', reduction,
    'order_id', target, 'item_id', line_id);
END $$;

REVOKE ALL ON FUNCTION public.redeem_voucher(text, uuid[], uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_voucher(text, uuid[], uuid, text) TO service_role;

-- ── Trả mã lại khi dòng voucher rời bill đang mở ─────────────
-- Nhân viên xoá dòng voucher (bấm nhầm) → mã dùng lại được. Bill ĐÃ thanh toán
-- rồi bị dọn (xoá theo hạn mức thống kê) thì đơn không còn mở → mã vẫn 'used'.
CREATE OR REPLACE FUNCTION public.release_voucher_on_line_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.menu_item_id IS NULL AND OLD.unit_price < 0 AND EXISTS (
    SELECT 1 FROM public.orders WHERE id = OLD.order_id AND status IN ('pending', 'preparing', 'completed')
  ) THEN
    UPDATE public.vouchers SET status = 'active', used_at = NULL, used_order_id = NULL,
      used_item_id = NULL, used_table_id = NULL, used_by_name = NULL, discount_amount = 0, bill_total = 0
    WHERE used_item_id = OLD.id AND status = 'used';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS release_voucher_on_line_delete ON public.order_items;
CREATE TRIGGER release_voucher_on_line_delete
AFTER DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.release_voucher_on_line_delete();

-- Huỷ bill còn dòng voucher → trả mã. Gộp bill chuyển dòng sang bill chính
-- TRƯỚC khi huỷ bill phụ, nên dòng không còn ở bill bị huỷ → mã vẫn 'used'.
CREATE OR REPLACE FUNCTION public.release_voucher_on_bill_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.vouchers v SET status = 'active', used_at = NULL, used_order_id = NULL,
    used_item_id = NULL, used_table_id = NULL, used_by_name = NULL, discount_amount = 0, bill_total = 0
  FROM public.order_items i
  WHERE i.id = v.used_item_id AND i.order_id = NEW.id AND v.status = 'used';
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS release_voucher_on_bill_cancel ON public.orders;
CREATE TRIGGER release_voucher_on_bill_cancel
AFTER UPDATE OF status ON public.orders
FOR EACH ROW WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
EXECUTE FUNCTION public.release_voucher_on_bill_cancel();

-- Mở lại bill đã huỷ (huỷ đã trả mã): dòng voucher trong bill phải lấy lại được đúng mã,
-- nếu không thì chặn — không cho "huỷ rồi mở lại" để giữ dòng giảm mà mã đã dùng lại được.
CREATE OR REPLACE FUNCTION public.voucher_guard_bill_reopen()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT i.id, i.unit_price * i.quantity AS amount, substring(i.item_name from '^Voucher (BK-[A-Z0-9]{6})$') AS code
    FROM public.order_items i
    WHERE i.order_id = NEW.id AND i.menu_item_id IS NULL AND i.unit_price < 0 AND i.item_name LIKE 'Voucher BK-%'
  LOOP
    UPDATE public.vouchers SET status = 'used', used_at = now(), used_order_id = NEW.id, used_item_id = r.id,
      used_table_id = NEW.table_id, discount_amount = -r.amount
    WHERE code = r.code AND status = 'active';
    IF NOT EXISTS (SELECT 1 FROM public.vouchers WHERE code = r.code AND status = 'used' AND used_item_id = r.id) THEN
      RAISE EXCEPTION 'Bill có dòng voucher % nhưng mã đã dùng ở nơi khác / đã huỷ — không mở lại bill được', r.code;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS voucher_guard_bill_reopen ON public.orders;
CREATE TRIGGER voucher_guard_bill_reopen
BEFORE UPDATE OF status ON public.orders
FOR EACH ROW WHEN (OLD.status = 'cancelled' AND NEW.status IN ('pending', 'preparing', 'completed'))
EXECUTE FUNCTION public.voucher_guard_bill_reopen();

REVOKE ALL ON FUNCTION public.release_voucher_on_line_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_voucher_on_bill_cancel() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.voucher_guard_bill_reopen() FROM PUBLIC, anon, authenticated;

-- ── Cấu hình "Hẹn lần sau" (Admin > Voucher sửa được) ───────
-- Hạn dùng + bill tối thiểu lúc dùng cũng áp cho voucher trúng vòng xoay.
INSERT INTO public.settings (key, value) VALUES
  ('voucher_next_enabled',      'false'),
  ('voucher_next_min_bill',     '300000'),  -- bill từ bao nhiêu thì được tặng
  ('voucher_next_type',         'amount'),  -- amount | percent
  ('voucher_next_value',        '30000'),
  ('voucher_next_max',          '0'),       -- trần cho voucher %
  ('voucher_next_use_min_bill', '200000'),  -- lần sau bill từ bao nhiêu mới dùng được
  ('voucher_next_days',         '14'),      -- dùng trong bao nhiêu ngày (từ 5h sáng hôm sau)
  ('voucher_next_repeat',       'true')     -- bill đã dùng voucher vẫn được tặng mã mới
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
