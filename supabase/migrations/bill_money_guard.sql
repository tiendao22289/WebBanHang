-- Khoá phần TIỀN khỏi khoá công khai (anon key nằm sẵn trong JS trang khách / trang Bàn).
-- Sau file này, chỉ máy chủ (service_role: /api/admin/receipts) và việc chạy trong DB
-- (pg_cron, workflow cài đặt, Studio) mới được:
--   * đóng bàn "đã thu" (complete_table_payment_atomic), xác nhận mã QR / tiền mặt trang Mã QR,
--     cộng tiền vào thẻ (process_bank_payment, bank_daily_totals);
--   * đặt bill thành 'paid', sửa / huỷ / mở lại / xoá bill đã thu (bill đã thu đổi trạng thái là
--     biến khỏi Sổ thu chi — capture_finance_revenue). Khách vẫn góp ý / sửa địa chỉ được;
--   * đổi mã QR (payment_transactions) sang 'completed', ghi "Nhận tiền mặt" (custom_cash_receipts) —
--     cả hai tự ghi vào Sổ thu chi (capture_qr_page_receipt).
-- Trình duyệt vẫn: tạo mã QR 'pending', huỷ mã 'pending' → 'failed', và mọi thao tác trên bill đang mở.
--
-- Chạy lại được nhiều lần (scripts/apply-finance-migration.cjs). orders thuộc supabase_admin nên
-- postgres không DROP / DISABLE được trigger trên đó: chỉ tạo trigger khi chưa có, sửa thân hàm
-- bằng CREATE OR REPLACE. Trigger để SECURITY INVOKER để current_user là người ghi thật.
--
-- Mở lại khi cần gấp (chạy bằng SQL, không cần quyền chủ bảng):
--   CREATE OR REPLACE FUNCTION public.trusted_db_caller() RETURNS boolean LANGUAGE sql AS $f$ SELECT true $f$;
--   GRANT EXECUTE ON FUNCTION public.complete_table_payment_atomic(uuid, uuid[], numeric, text, uuid, boolean, uuid, text, text) TO anon, authenticated;
-- rồi chạy lại file này để khoá lại.

-- Người gọi có phải máy chủ / chính DB không. Không tin khi MỘT trong ba:
--   - JWT của PostgREST là anon / authenticated (kể cả khi đang chạy trong hàm SECURITY DEFINER,
--     nơi current_user là chủ hàm);
--   - current_user là anon / authenticated (ghi thẳng bảng qua /rest/v1);
--   - kết nối của PostgREST (session_user 'authenticator') mà JWT không phải service_role.
-- pg_cron, workflow cài (/pg/query), Studio không có JWT và không đăng nhập bằng authenticator → tin.
-- anon phải EXECUTE được hàm này vì trigger chạy với quyền người ghi.
CREATE OR REPLACE FUNCTION public.trusted_db_caller()
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE jwt_role text;
BEGIN
  BEGIN
    jwt_role := NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role';
  EXCEPTION WHEN OTHERS THEN jwt_role := NULL;
  END;
  -- PostgREST cũ (< v9) để vai trò ở request.jwt.claim.role.
  jwt_role := COALESCE(jwt_role, NULLIF(current_setting('request.jwt.claim.role', true), ''));
  IF jwt_role IN ('anon', 'authenticated') OR current_user IN ('anon', 'authenticated') THEN
    RETURN false;
  END IF;
  IF session_user = 'authenticator' AND jwt_role IS DISTINCT FROM 'service_role' THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION public.trusted_db_caller() TO PUBLIC;

-- Bill đã thu: chỉ máy chủ được đặt / đổi / xoá. Chạy SAU order_total_from_items_before_write
-- (tên xếp sau) nên tổng tiền đã tính lại từ món trước khi so.
CREATE OR REPLACE FUNCTION public.paid_bill_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF public.trusted_db_caller() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'Bill đã thu chỉ máy chủ được xoá' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.status = 'paid' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'paid') THEN
    RAISE EXCEPTION 'Chỉ máy chủ được chốt bill đã thu' USING ERRCODE = '42501';
  END IF;
  -- Khách góp ý / sửa địa chỉ giao sau khi trả tiền vẫn được.
  IF TG_OP = 'UPDATE' AND OLD.status = 'paid'
    AND to_jsonb(NEW) - ARRAY['customer_rating', 'customer_feedback', 'delivery_address', 'updated_at']
      IS DISTINCT FROM to_jsonb(OLD) - ARRAY['customer_rating', 'customer_feedback', 'delivery_address', 'updated_at'] THEN
    RAISE EXCEPTION 'Bill đã thu chỉ máy chủ được sửa' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- Mã QR: trình duyệt chỉ tạo 'pending' và huỷ 'pending' → 'failed'.
CREATE OR REPLACE FUNCTION public.payment_transaction_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF public.trusted_db_caller() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'failed'
    AND to_jsonb(NEW) - ARRAY['status', 'updated_at'] IS NOT DISTINCT FROM to_jsonb(OLD) - ARRAY['status', 'updated_at'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Chỉ máy chủ được xác nhận / sửa / xoá mã QR thanh toán' USING ERRCODE = '42501';
END $$;

-- Tiền vào thẻ trong ngày: trình duyệt không còn ghi (đóng bàn / Mã QR đều qua máy chủ).
CREATE OR REPLACE FUNCTION public.bank_total_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.trusted_db_caller() THEN
    RAISE EXCEPTION 'Chỉ máy chủ được ghi tiền vào thẻ' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
-- "Nhận tiền mặt" ở trang Mã QR (record_custom_cash_receipt) → Sổ thu chi. Hàm đó có thể thuộc
-- supabase_admin (không thu được quyền) nên chặn ở bảng.
CREATE OR REPLACE FUNCTION public.cash_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.trusted_db_caller() THEN
    RAISE EXCEPTION 'Chỉ máy chủ được ghi tiền mặt trang Mã QR' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.paid_bill_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payment_transaction_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_total_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_receipt_guard() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'paid_bill_guard' AND tgrelid = 'public.orders'::regclass) THEN
    CREATE TRIGGER paid_bill_guard BEFORE INSERT OR UPDATE OR DELETE ON public.orders
      FOR EACH ROW EXECUTE FUNCTION public.paid_bill_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_transaction_guard'
      AND tgrelid = 'public.payment_transactions'::regclass) THEN
    CREATE TRIGGER payment_transaction_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_transactions
      FOR EACH ROW EXECUTE FUNCTION public.payment_transaction_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bank_total_guard'
      AND tgrelid = 'public.bank_daily_totals'::regclass) THEN
    CREATE TRIGGER bank_total_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bank_daily_totals
      FOR EACH ROW EXECUTE FUNCTION public.bank_total_guard();
  END IF;
  IF to_regclass('public.custom_cash_receipts') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgname = 'cash_receipt_guard' AND tgrelid = to_regclass('public.custom_cash_receipts')) THEN
    CREATE TRIGGER cash_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.custom_cash_receipts
      FOR EACH ROW EXECUTE FUNCTION public.cash_receipt_guard();
  END IF;
END $$;

-- Hàm chốt tiền: trang web đã gọi qua máy chủ (/api/admin/receipts) từ trước. Thu quyền mọi bản
-- (kể cả bản cũ khác tham số). Hàm thuộc supabase_admin (DB khôi phục từ bản sao) thì postgres không
-- thu được → chỉ cảnh báo; khoá công khai gọi được nhưng trigger ở trên chặn mọi chỗ hàm đó ghi tiền.
DO $$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('complete_table_payment_atomic',
      'complete_table_payment_atomic_legacy', 'confirm_custom_qr_payment', 'confirm_shadow_qr_atomic',
      'record_custom_cash_receipt', 'process_bank_payment')
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'Không thu được quyền gọi % (không phải chủ hàm)', fn;
    END;
  END LOOP;
END $$;

-- Tự kiểm trên chính DB đang cài: JWT anon không được tin, service_role và người cài thì được.
DO $$
DECLARE before text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  IF public.trusted_db_caller() THEN RAISE EXCEPTION 'trusted_db_caller tin nhầm JWT anon'; END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  IF NOT public.trusted_db_caller() THEN RAISE EXCEPTION 'trusted_db_caller không tin service_role'; END IF;
  PERFORM set_config('request.jwt.claims', COALESCE(before, ''), true);
  IF before IS NULL AND NOT public.trusted_db_caller() THEN
    RAISE EXCEPTION 'trusted_db_caller không tin chính người cài (%)', session_user;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
