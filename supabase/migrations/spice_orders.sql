-- Gọi gia vị (2026-11-25): nhân viên / quản lý / admin gửi đơn gia vị cho chủ gia vị (người ngoài quán, mở bằng link riêng
-- có mã bí mật — spice_suppliers.token), chủ gia vị soạn hàng và tự điền giá, nhân viên bấm "Đã nhận". Đơn đã nhận là chi phí
-- gia vị của ngày nhận (Sổ thu chi) và ghi nợ chủ gia vị; chủ quán trả gom (spice_payments). Chỉ máy chủ (service_role) đọc /
-- ghi; mọi thay đổi vào nhật ký staff_data_audit. Chạy lại được nhiều lần.

CREATE TABLE IF NOT EXISTS public.spice_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  phone text CHECK (phone IS NULL OR length(phone) <= 20),
  token text NOT NULL UNIQUE CHECK (length(token) >= 24),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Danh sách món nhân viên chọn khi gọi (tự thêm khi nhân viên gõ món mới).
CREATE TABLE IF NOT EXISTS public.spice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  unit text CHECK (unit IS NULL OR length(unit) <= 20),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS spice_items_name ON public.spice_items (lower(name));
-- Số lượng mặc định khi bấm món (vd Tiêu 0,5 kg) và thứ tự chủ quán xếp (2026-11-25).
ALTER TABLE public.spice_items ADD COLUMN IF NOT EXISTS default_qty numeric CHECK (default_qty IS NULL OR (default_qty > 0 AND default_qty <= 10000));
ALTER TABLE public.spice_items ADD COLUMN IF NOT EXISTS sort integer NOT NULL DEFAULT 0;
-- Danh sách gia vị hay gọi, chỉ thêm khi danh sách đang trống (chủ quán xoá / ẩn món thì chạy lại không thêm lại).
INSERT INTO public.spice_items (name, unit, default_qty, sort)
SELECT v.name, v.unit, v.qty, v.sort FROM (VALUES
  ('Muối', 'kg', 1, 1), ('Đường', 'kg', 2, 2), ('Bột ngọt', 'kg', 1, 3), ('Hạt nêm', 'gói', 1, 4), ('Tiêu xay', 'kg', 0.5, 5),
  ('Ớt', 'kg', 1, 6), ('Tỏi', 'kg', 1, 7), ('Hành tím', 'kg', 1, 8), ('Sả', 'kg', 1, 9), ('Gừng', 'kg', 0.5, 10),
  ('Chanh', 'kg', 2, 11), ('Hành lá', 'kg', 0.5, 12), ('Rau răm', 'bó', 2, 13), ('Ngò gai', 'bó', 2, 14), ('Nước mắm', 'chai', 2, 15),
  ('Dầu ăn', 'can', 1, 16), ('Bơ', 'hộp', 1, 17), ('Sa tế', 'hũ', 2, 18), ('Tương ớt', 'chai', 2, 19), ('Me', 'kg', 0.5, 20)
) AS v(name, unit, qty, sort)
WHERE NOT EXISTS (SELECT 1 FROM public.spice_items);

-- items: [{ name, unit, qty, received_qty, price, old_price, added_by, added_at }] (src/lib/spiceOrders.mjs). total = tiền theo giá đang có.
-- log: lịch sử để sau không tranh cãi [{ at, by, who ('staff'|'supplier'), type, ... }] — ai gọi, thêm món, đổi giá, nhận, huỷ, lúc nào.
-- supplier_note: ghi chú của chủ gia vị. received_date = ngày nhận theo giờ Việt Nam (ngày tính chi phí).
CREATE TABLE IF NOT EXISTS public.spice_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.spice_suppliers(id),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  total integer NOT NULL DEFAULT 0 CHECK (total BETWEEN 0 AND 1000000000),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  priced_at timestamptz,
  received_at timestamptz,
  received_date date,
  received_by_name text,
  cancelled_at timestamptz,
  cancelled_by_name text,
  log jsonb NOT NULL DEFAULT '[]'::jsonb,
  supplier_note text CHECK (supplier_note IS NULL OR length(supplier_note) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((received_at IS NULL) = (received_date IS NULL))
);
CREATE INDEX IF NOT EXISTS spice_orders_created ON public.spice_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS spice_orders_received ON public.spice_orders (received_date) WHERE received_date IS NOT NULL;
-- Chủ gia vị tự đánh dấu đơn đã nhận tiền (sổ riêng của chủ gia vị, 2026-11-27). Nợ của quán vẫn tính theo spice_payments.
ALTER TABLE public.spice_orders ADD COLUMN IF NOT EXISTS supplier_paid_at timestamptz;
-- Chủ quán xác nhận lời báo "đã nhận tiền" của chủ gia vị (2026-11-27): chỉ khi xác nhận mới trừ nợ; xác nhận rồi thì
-- chủ gia vị không sửa / bỏ được gì trên đơn đó nữa.
ALTER TABLE public.spice_orders ADD COLUMN IF NOT EXISTS paid_confirmed_at timestamptz;
ALTER TABLE public.spice_orders ADD COLUMN IF NOT EXISTS paid_confirmed_by text;
CREATE INDEX IF NOT EXISTS spice_orders_supplier ON public.spice_orders (supplier_id, created_at DESC);

-- Chủ quán trả nợ chủ gia vị (gom nhiều đơn): tiền mặt hay chuyển khoản.
CREATE TABLE IF NOT EXISTS public.spice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.spice_suppliers(id),
  amount integer NOT NULL CHECK (amount BETWEEN 1000 AND 1000000000),
  method text NOT NULL CHECK (method IN ('cash', 'transfer')),
  paid_date date NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spice_payments_date ON public.spice_payments (paid_date);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['spice_suppliers', 'spice_items', 'spice_orders', 'spice_payments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    IF to_regprocedure('public.audit_staff_data()') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_staff_data'
        AND tgrelid = format('public.%I', t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER audit_staff_data AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_staff_data()', t);
    END IF;
  END LOOP;
END $$;
