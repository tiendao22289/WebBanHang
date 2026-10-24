-- Sổ thu chi của chủ quán (tab /admin/finance, chỉ admin, chỉ đọc qua server).
--
-- finance_revenue_ledger: mỗi bill thanh toán xong ghi 1 dòng với số tiền thật,
-- lúc trạng thái chuyển sang 'paid' — trước mọi bước dọn bill sau thanh toán —
-- và không bao giờ bị xoá theo bill (không có khoá ngoại tới orders). Không
-- liên quan và không thay đổi trang /admin/stats.
--
-- finance_entries: các khoản chủ quán tự nhập (nước ngọt, lương từng nhân
-- viên, chi cố định theo tháng).
--
-- finance_day_closes: chốt sổ cuối ngày (tiền mặt đếm được, tiền thật từng
-- tài khoản) để thấy chênh lệch với sổ.
--
-- Các bảng này chỉ service_role đọc/ghi: repo công khai và trang web dùng anon
-- key, nên anon/authenticated không được chạm vào. Chạy lại được nhiều lần.
BEGIN;

CREATE TABLE IF NOT EXISTS public.finance_revenue_ledger (
  order_id uuid PRIMARY KEY,
  paid_at timestamptz NOT NULL,
  business_date date NOT NULL,
  table_number text,
  customer_name text,
  payment_method text,
  account_id uuid,
  amount numeric NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_revenue_ledger_date ON public.finance_revenue_ledger(business_date);

CREATE TABLE IF NOT EXISTS public.finance_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('drink', 'salary', 'fixed', 'custom')),
  category text,
  label text NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  note text,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_entries_date ON public.finance_entries(entry_date);
-- Bản cài trước chỉ cho drink/salary/fixed → mở thêm 'custom' (tab tự tạo).
ALTER TABLE public.finance_entries DROP CONSTRAINT IF EXISTS finance_entries_kind_check;
ALTER TABLE public.finance_entries ADD CONSTRAINT finance_entries_kind_check
  CHECK (kind IN ('drink', 'salary', 'fixed', 'custom'));

-- Mục do chủ quán tự đặt: loại lương (Thưởng, Tạm ứng...), mục chi cố định
-- (Tiền rác, Thuế...) và tab chi riêng (Gas, Sửa chữa...). Tab nhập theo
-- ngày ('daily') hoặc theo tháng ('monthly', chia đều cho từng ngày).
-- Ẩn (archived) chứ không xoá để khoản đã nhập vẫn có tên.
CREATE TABLE IF NOT EXISTS public.finance_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('salary', 'fixed', 'tab')),
  name text NOT NULL,
  schedule text NOT NULL DEFAULT 'daily' CHECK (schedule IN ('daily', 'monthly')),
  archived boolean NOT NULL DEFAULT false,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Chốt sổ cuối ngày: tiền mặt đếm được trong két và số tiền thật từng tài
-- khoản ngân hàng nhận được ({account_id: số tiền}), để so với sổ.
CREATE TABLE IF NOT EXISTS public.finance_day_closes (
  business_date date PRIMARY KEY,
  cash_counted numeric CHECK (cash_counted >= 0),
  bank_counted jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  closed_by_name text,
  closed_at timestamptz NOT NULL DEFAULT now()
);

-- Bill giấy: khách gọi món bằng giấy, không qua hệ thống. Thu ngân nhập số
-- tiền tổng + ảnh tờ bill (bắt buộc), chuyển khoản thì kèm ảnh CK nếu có.
-- Ảnh nằm trong bucket riêng tư finance-receipts, tự xoá sau 3 tháng.
CREATE TABLE IF NOT EXISTS public.finance_manual_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date date NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  amount numeric NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'transfer')),
  account_id uuid,
  table_label text,
  note text,
  image_path text,
  transfer_image_path text,
  images_purged_at timestamptz,
  created_by_id uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_manual_receipts_date ON public.finance_manual_receipts(business_date);
-- Ảnh màn hình chuyển khoản của khách cho bill trên hệ thống.
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS transfer_image_path text;
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS transfer_image_by text;

-- Đóng bàn bắt buộc có ảnh (trang Bàn, /api/admin/receipts table_pay): tiền mặt khách
-- đưa → cash_image_path; không chụp được (máy lỗi...) → lý do + người ghi.
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS cash_image_path text;
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS photo_skip_reason text;
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS photo_by text;

-- Chủ quán đánh dấu "đã đối chiếu" bill chuyển khoản với app ngân hàng.
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS verified_by text;
ALTER TABLE public.finance_manual_receipts ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE public.finance_manual_receipts ADD COLUMN IF NOT EXISTS verified_by text;

-- Bill giấy tự ghi từ trang Mã QR: 'qr:<mã giao dịch>' / 'cash:<id phiếu thu>'
-- (xem capture_qr_page_receipt). Bill nhập tay để trống.
ALTER TABLE public.finance_manual_receipts ADD COLUMN IF NOT EXISTS source text;
CREATE UNIQUE INDEX IF NOT EXISTS finance_manual_receipts_source ON public.finance_manual_receipts(source);

-- Cài đặt sổ thu chi (vd. 'zalo_report': Zalo nhận báo cáo hằng ngày).
CREATE TABLE IF NOT EXISTS public.finance_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.finance_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_settings FROM anon, authenticated;
GRANT ALL ON public.finance_settings TO service_role;

ALTER TABLE public.finance_manual_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_manual_receipts FROM anon, authenticated;
GRANT ALL ON public.finance_manual_receipts TO service_role;

ALTER TABLE public.finance_revenue_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_day_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_revenue_ledger FROM anon, authenticated;
REVOKE ALL ON public.finance_entries FROM anon, authenticated;
REVOKE ALL ON public.finance_day_closes FROM anon, authenticated;
REVOKE ALL ON public.finance_categories FROM anon, authenticated;
GRANT ALL ON public.finance_revenue_ledger TO service_role;
GRANT ALL ON public.finance_entries TO service_role;
GRANT ALL ON public.finance_day_closes TO service_role;
GRANT ALL ON public.finance_categories TO service_role;

CREATE OR REPLACE FUNCTION public.capture_finance_revenue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE items jsonb; total numeric; settled_at timestamptz; account uuid;
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    IF NEW.customer_phone = 'BAO_BEP' THEN RETURN NEW; END IF;
    settled_at := COALESCE(NEW.paid_at, now());
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'name', COALESCE(i.item_name, m.name), 'quantity', i.quantity, 'unit_price', i.unit_price,
        'options', i.item_options, 'is_gift', i.is_gift) ORDER BY i.id), '[]'::jsonb),
      COALESCE(sum(COALESCE(i.unit_price, 0) * COALESCE(i.quantity, 0)), 0)
      INTO items, total
      FROM public.order_items i LEFT JOIN public.menu_items m ON m.id = i.menu_item_id
      WHERE i.order_id = NEW.id;
    IF NEW.payment_method = 'transfer' THEN
      SELECT tx.account_id INTO account FROM public.payment_transactions tx
        WHERE NEW.id::text = ANY(string_to_array(tx.order_ids, ','))
          AND tx.status IN ('pending', 'completed')
        ORDER BY (tx.status = 'completed') DESC, tx.transaction_code DESC LIMIT 1;
    END IF;
    INSERT INTO public.finance_revenue_ledger(order_id, paid_at, business_date, table_number,
        customer_name, payment_method, account_id, amount, items)
      VALUES (NEW.id, settled_at, (settled_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
        (SELECT table_number::text FROM public.tables WHERE id = NEW.table_id),
        NEW.customer_name, NEW.payment_method, account, GREATEST(total, 0), items)
      ON CONFLICT (order_id) DO UPDATE SET paid_at = EXCLUDED.paid_at,
        business_date = EXCLUDED.business_date, table_number = EXCLUDED.table_number,
        customer_name = EXCLUDED.customer_name, payment_method = EXCLUDED.payment_method,
        account_id = EXCLUDED.account_id, amount = EXCLUDED.amount, items = EXCLUDED.items,
        recorded_at = now();
  ELSIF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid' THEN
    -- Bill mở lại / huỷ sau khi đã thu: bỏ khỏi sổ, thu lại thì ghi lại.
    DELETE FROM public.finance_revenue_ledger WHERE order_id = NEW.id;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Sổ thu chi là phụ: lỗi ở đây không bao giờ được chặn việc thanh toán.
  RAISE WARNING 'Finance revenue capture failed (SQLSTATE %)', SQLSTATE;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_finance_revenue() FROM PUBLIC, anon, authenticated;

-- Chỉ tạo khi chưa có: orders thuộc supabase_admin nên vai trò postgres
-- (SQL Editor) tạo được trigger nhưng không DROP được → DROP/CREATE lại sẽ
-- làm file không chạy lại được. Sửa thân trigger qua CREATE OR REPLACE ở trên.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgname = 'capture_finance_revenue' AND tgrelid = 'public.orders'::regclass) THEN
    CREATE TRIGGER capture_finance_revenue AFTER UPDATE OF status ON public.orders
      FOR EACH ROW EXECUTE FUNCTION public.capture_finance_revenue();
  END IF;
END $$;

-- Tiền thu ở trang Mã QR (/admin/qr) không có bill trên hệ thống → tự ghi
-- thành bill giấy (chưa có ảnh, chụp bổ sung sau) để Sổ thu chi, /thongke và
-- tin Zalo tính đủ. Ghi cùng giao dịch với việc xác nhận nên không sót, source
-- duy nhất nên bấm lại không ghi trùng. Trang Thống kê / S2a-HKD không đọc
-- bảng này nên không đổi.
CREATE OR REPLACE FUNCTION public.capture_qr_page_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE at timestamptz := now();
BEGIN
  IF TG_TABLE_NAME = 'payment_transactions' THEN
    IF NEW.order_ids = 'shadow_qr' AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
      INSERT INTO public.finance_manual_receipts(source, business_date, received_at, amount, payment_method,
          account_id, note, created_by_name)
        VALUES ('qr:' || NEW.transaction_code, (at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, at, NEW.total_amount,
          -- account_id của bảng thật là text
          'transfer', NULLIF(NEW.account_id::text, '')::uuid, 'Mã QR ' || NEW.transaction_code, 'Trang Mã QR')
        ON CONFLICT (source) DO NOTHING;
    END IF;
  ELSE -- custom_cash_receipts: nút "Nhận tiền mặt"
    at := COALESCE(NEW.created_at, at);
    INSERT INTO public.finance_manual_receipts(source, business_date, received_at, amount, payment_method, created_by_name)
      VALUES ('cash:' || NEW.id, (at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, at, NEW.amount, 'cash', 'Trang Mã QR')
      ON CONFLICT (source) DO NOTHING;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Sổ thu chi là phụ: lỗi ở đây không bao giờ được chặn việc thu tiền.
  RAISE WARNING 'QR page receipt capture failed (SQLSTATE %)', SQLSTATE;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.capture_qr_page_receipt() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.payment_transactions') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgname = 'capture_qr_page_receipt' AND tgrelid = to_regclass('public.payment_transactions')) THEN
    CREATE TRIGGER capture_qr_page_receipt AFTER UPDATE OF status ON public.payment_transactions
      FOR EACH ROW EXECUTE FUNCTION public.capture_qr_page_receipt();
  END IF;
  IF to_regclass('public.custom_cash_receipts') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgname = 'capture_qr_page_receipt' AND tgrelid = to_regclass('public.custom_cash_receipts')) THEN
    CREATE TRIGGER capture_qr_page_receipt AFTER INSERT ON public.custom_cash_receipts
      FOR EACH ROW EXECUTE FUNCTION public.capture_qr_page_receipt();
  END IF;
END $$;

COMMIT;
