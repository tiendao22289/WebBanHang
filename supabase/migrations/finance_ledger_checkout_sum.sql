-- ============================================================
-- Sổ thu chi = đúng số tiền đã thu của mỗi lần đóng bàn.
--
-- Dòng Giảm % / Voucher / Vòng xoay / Đánh giá luôn nằm ở bill CŨ NHẤT của nhóm bàn, nên bill đó
-- có thể âm (vd bill 40k bia + "Giảm 10%" −64k của cả bàn 640k). capture_finance_revenue
-- (owner_finance.sql) ghi mỗi bill GREATEST(tổng, 0) → bill âm thành 0đ, phần giảm mất khỏi sổ:
-- bàn trả 576k nhưng sổ ghi 40k→0 + 600k = 600k.
--
-- Sửa ở sổ, không đụng bill / món / thanh toán: một lần thu (cùng giờ thu + cách trả + thẻ, như
-- checkoutKey trong ownerFinance.mjs) được tính lại từ tiền món chụp trong sổ (cột items): bill âm
-- ghi 0đ, phần âm trừ vào bill LỚN NHẤT (không đủ thì bill lớn kế tiếp). Tổng các dòng sổ của lần
-- thu luôn bằng tiền thu. Bill không có món chụp trong sổ (dòng cũ) giữ nguyên số tiền.
--
-- Trigger capture_finance_revenue_balance chạy NGAY SAU capture_finance_revenue (tên xếp sau) mỗi
-- lần bill thành 'paid' (và khi bill đã thu bị mở lại: tính lại các bill còn lại của lần thu đó).
-- Lỗi ở đây không bao giờ chặn việc thanh toán. Cuối file sửa luôn các lần thu cũ đang lệch.
--
-- Cài SAU owner_finance.sql. Chạy lại được nhiều lần (workflow "Apply Finance Migration").
-- ============================================================
BEGIN;

-- Tìm các bill cùng lần thu theo giờ thu (cũng giúp Tra cứu gom đủ bill một lần đóng bàn).
CREATE INDEX IF NOT EXISTS finance_revenue_ledger_paid_at ON public.finance_revenue_ledger(paid_at);

-- Tiền món của 1 dòng sổ (có thể âm). Không có món chụp lại thì lấy số tiền đang ghi.
CREATE OR REPLACE FUNCTION public.finance_ledger_bill_total(p_items jsonb, p_amount numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0
    THEN (SELECT COALESCE(sum(COALESCE((e->>'unit_price')::numeric, 0) * COALESCE((e->>'quantity')::numeric, 0)), 0)
          FROM jsonb_array_elements(p_items) e)
    ELSE COALESCE(p_amount, 0) END
$$;

-- Chia lại tiền các lần thu có giờ thu p_paid_at. Trả số dòng sổ đã đổi.
CREATE OR REPLACE FUNCTION public.balance_finance_checkout(p_paid_at timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  checkout record;
  r record;
  owed numeric;
  keep numeric;
  changed integer := 0;
BEGIN
  IF p_paid_at IS NULL THEN RETURN 0; END IF;
  FOR checkout IN
    SELECT DISTINCT payment_method, account_id FROM public.finance_revenue_ledger WHERE paid_at = p_paid_at
  LOOP
    owed := 0;
    -- Bill âm trước (cộng dồn phần cần trừ), rồi bill dương từ lớn đến nhỏ.
    FOR r IN
      SELECT t.order_id, t.total, t.amount FROM (
        SELECT l.order_id, l.amount, public.finance_ledger_bill_total(l.items, l.amount) AS total
        FROM public.finance_revenue_ledger l
        WHERE l.paid_at = p_paid_at AND l.payment_method IS NOT DISTINCT FROM checkout.payment_method
          AND l.account_id IS NOT DISTINCT FROM checkout.account_id) t
      ORDER BY (t.total < 0) DESC, t.total DESC, t.order_id
    LOOP
      IF r.total <= 0 THEN
        owed := owed - r.total;
        keep := 0;
      ELSE
        keep := GREATEST(r.total - owed, 0);
        owed := owed - (r.total - keep);
      END IF;
      IF r.amount IS DISTINCT FROM keep THEN
        UPDATE public.finance_revenue_ledger SET amount = keep WHERE order_id = r.order_id;
        changed := changed + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION public.balance_finance_checkout(timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.capture_finance_revenue_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    -- Giờ thu đúng như dòng sổ capture_finance_revenue vừa ghi.
    PERFORM public.balance_finance_checkout(l.paid_at) FROM public.finance_revenue_ledger l WHERE l.order_id = NEW.id;
  ELSIF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid' THEN
    PERFORM public.balance_finance_checkout(OLD.paid_at);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Sổ thu chi là phụ: lỗi ở đây không bao giờ được chặn việc thanh toán.
  RAISE WARNING 'Finance checkout balance failed (SQLSTATE %)', SQLSTATE;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.capture_finance_revenue_balance() FROM PUBLIC, anon, authenticated;

-- Chỉ tạo khi chưa có (orders thuộc supabase_admin: không DROP được, xem owner_finance.sql).
-- Tên xếp sau capture_finance_revenue → Postgres chạy trigger này sau khi bill đã vào sổ.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgname = 'capture_finance_revenue_balance' AND tgrelid = 'public.orders'::regclass) THEN
    CREATE TRIGGER capture_finance_revenue_balance AFTER UPDATE OF status ON public.orders
      FOR EACH ROW EXECUTE FUNCTION public.capture_finance_revenue_balance();
  END IF;
END $$;

-- Sửa các lần thu đã ghi lệch (có bill âm). Chạy lại thì không còn gì để sửa.
SELECT public.balance_finance_checkout(c.paid_at)
FROM (SELECT DISTINCT paid_at FROM public.finance_revenue_ledger
      WHERE public.finance_ledger_bill_total(items, amount) < 0) c;

COMMIT;

NOTIFY pgrst, 'reload schema';
