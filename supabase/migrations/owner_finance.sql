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

-- Ai thao tác bill (Sổ thu chi: "Bill đã thu" và Tra cứu theo tên nhân viên): người chốt bàn thu tiền,
-- người mở bill "Admin" của bàn; người thêm / duyệt từng món ở items[].added_by. Ghi lúc thu tiền vì
-- bill gốc và lịch sử bàn (10 giờ) có thể bị dọn sau đó. Trống = không rõ (bill cũ), không đoán.
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS paid_by_name text;
ALTER TABLE public.finance_revenue_ledger ADD COLUMN IF NOT EXISTS created_by_name text;

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
        'options', i.item_options, 'is_gift', i.is_gift, 'added_by', to_jsonb(i)->>'added_by_name') ORDER BY i.id), '[]'::jsonb),
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
    -- Tên nhân viên đọc qua to_jsonb: DB thiếu cột (bản thử cũ) thì để trống, không làm hỏng việc ghi sổ.
    INSERT INTO public.finance_revenue_ledger(order_id, paid_at, business_date, table_number,
        customer_name, payment_method, account_id, amount, items, paid_by_name, created_by_name)
      VALUES (NEW.id, settled_at, (settled_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
        (SELECT table_number::text FROM public.tables WHERE id = NEW.table_id),
        NEW.customer_name, NEW.payment_method, account, GREATEST(total, 0), items,
        to_jsonb(NEW)->>'paid_by_name', to_jsonb(NEW)->>'created_by_name')
      ON CONFLICT (order_id) DO UPDATE SET paid_at = EXCLUDED.paid_at,
        business_date = EXCLUDED.business_date, table_number = EXCLUDED.table_number,
        customer_name = EXCLUDED.customer_name, payment_method = EXCLUDED.payment_method,
        account_id = EXCLUDED.account_id, amount = EXCLUDED.amount, items = EXCLUDED.items,
        paid_by_name = EXCLUDED.paid_by_name, created_by_name = EXCLUDED.created_by_name,
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

-- Bill vào sổ trước khi sổ lưu tên nhân viên: lấy lại từ bill gốc nếu còn. Bill đã bị dọn thì
-- để trống (trang hiện "không rõ"). Chỉ điền chỗ còn trống nên chạy lại được; tên người thêm món
-- chỉ ghi khi mọi món của bill khớp đúng từng dòng (thứ tự, tên, số lượng) với bill gốc.
UPDATE public.finance_revenue_ledger l
  SET paid_by_name = to_jsonb(o)->>'paid_by_name', created_by_name = to_jsonb(o)->>'created_by_name'
  FROM public.orders o
  WHERE o.id = l.order_id AND l.paid_by_name IS NULL AND l.created_by_name IS NULL
    AND (to_jsonb(o)->>'paid_by_name' IS NOT NULL OR to_jsonb(o)->>'created_by_name' IS NOT NULL);
WITH pending AS (
  SELECT order_id, items FROM public.finance_revenue_ledger
  WHERE jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(items) e WHERE (e -> 'added_by') IS NOT NULL)
), lines AS (
  SELECT i.order_id, row_number() OVER (PARTITION BY i.order_id ORDER BY i.id) AS n,
    COALESCE(i.item_name, m.name) AS name, i.quantity, to_jsonb(i)->>'added_by_name' AS added_by
  FROM public.order_items i LEFT JOIN public.menu_items m ON m.id = i.menu_item_id
  WHERE i.order_id IN (SELECT order_id FROM pending)
), matched AS (
  SELECT p.order_id, jsonb_agg(e.value || jsonb_build_object('added_by', li.added_by) ORDER BY e.n) AS items,
    count(li.n) AS hits, jsonb_array_length(p.items) AS total,
    (SELECT count(*) FROM lines x WHERE x.order_id = p.order_id) AS line_count
  FROM pending p
  CROSS JOIN LATERAL jsonb_array_elements(p.items) WITH ORDINALITY AS e(value, n)
  LEFT JOIN lines li ON li.order_id = p.order_id AND li.n = e.n
    AND li.name IS NOT DISTINCT FROM e.value->>'name' AND li.quantity::text IS NOT DISTINCT FROM e.value->>'quantity'
  GROUP BY p.order_id, p.items
)
UPDATE public.finance_revenue_ledger l SET items = m.items
  FROM matched m WHERE m.order_id = l.order_id AND m.hits = m.total AND m.line_count = m.total;

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

-- Kết quả máy tự kiểm tra từng ngày (bill thiếu, CK chưa ảnh, đóng bàn không ảnh, huỷ / bớt món,
-- phiếu Sổ tay lệch) — chạy mỗi sáng cho ngày hôm qua, thay cho việc chủ quán tự chốt sổ.
CREATE TABLE IF NOT EXISTS public.finance_day_checks (
  business_date date PRIMARY KEY,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  problems integer NOT NULL DEFAULT 0,
  checked_by text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.finance_day_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.finance_day_checks FROM anon, authenticated;
GRANT ALL ON public.finance_day_checks TO service_role;

COMMIT;
