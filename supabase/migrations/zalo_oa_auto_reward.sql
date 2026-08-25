-- ============================================================
--  QUÀ QUAN TÂM ZALO OA — TỰ ĐỘNG 100%, KHÔNG CẦN NHÂN VIÊN DUYỆT
--
--  Luồng: khách nhập SĐT trên web → bấm Quan tâm OA → webhook Zalo
--  báo về server → server (SERVICE_ROLE) tự kiểm tra + trừ tiền.
--
--  CHỐNG GIAN LẬN — điểm mấu chốt của thiết kế:
--  * Bảng zalo_reward_claims KHÔNG có policy UPDATE cho anon.
--    Khách chỉ tạo được yêu cầu (status waiting_follow) và xem
--    trạng thái. Chuyển sang 'verified' + trừ tiền CHỈ server làm
--    được qua SERVICE_ROLE_KEY (webhook /api/zalo/webhook).
--  * Bảng zalo_followers hoàn toàn không mở cho anon — khách không
--    tự ghi "tôi đã follow" được. Nguồn duy nhất là webhook Zalo.
--  * Cooldown tính theo CẢ SĐT lẫn zalo_user_id — đổi SĐT khai láo
--    cũng không qua được vì tài khoản Zalo đã nhận rồi.
--
--  Chạy lại nhiều lần vẫn an toàn.
-- ============================================================

-- ── 1) Follower của OA (webhook ghi, chỉ server đọc) ─────────
CREATE TABLE IF NOT EXISTS public.zalo_followers (
  zalo_user_id  TEXT PRIMARY KEY,
  phone         TEXT,
  display_name  TEXT,
  followed_at   TIMESTAMPTZ,          -- null = nhắn tin nhưng chưa từng follow
  unfollowed_at TIMESTAMPTZ,          -- có giá trị = đã bỏ theo dõi
  last_event_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.zalo_followers ENABLE ROW LEVEL SECURITY;
-- KHÔNG tạo policy nào → anon/authenticated bị chặn hết, chỉ service role vào được.

CREATE INDEX IF NOT EXISTS zalo_followers_phone_idx ON public.zalo_followers (phone);

-- ── 2) Yêu cầu nhận quà của khách ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.zalo_reward_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  table_id      UUID REFERENCES public.tables(id) ON DELETE SET NULL,
  host_table_id UUID REFERENCES public.tables(id) ON DELETE SET NULL,

  customer_name  TEXT,
  customer_phone TEXT NOT NULL,

  -- waiting_follow : khách vừa bấm mở OA, chờ webhook xác nhận
  -- verified       : webhook xác nhận follow + khớp SĐT, ĐÃ trừ tiền
  -- blocked        : không đủ điều kiện (cooldown/bill nhỏ/đã nhận...)
  status TEXT NOT NULL DEFAULT 'waiting_follow',

  zalo_user_id    TEXT,               -- ai đã quan tâm (server điền)
  bill_total      INTEGER DEFAULT 0,
  discount_amount INTEGER DEFAULT 0,
  block_reason    TEXT,

  applied_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  applied_item_id  UUID,

  -- Mốc lượt khách (trigger server tự đọc tables.occupied_at — khách
  -- không giả mạo được, giống review_rewards)
  session_started_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ DEFAULT now(),
  verified_at TIMESTAMPTZ
);

-- Dùng lại trigger function của review_rewards (cùng cột host_table_id)
DROP TRIGGER IF EXISTS trg_zalo_claim_session ON public.zalo_reward_claims;
CREATE TRIGGER trg_zalo_claim_session
BEFORE INSERT ON public.zalo_reward_claims
FOR EACH ROW EXECUTE FUNCTION public.set_review_reward_session();

-- Mỗi lượt khách của bàn chỉ nhận quà Zalo 1 lần
CREATE UNIQUE INDEX IF NOT EXISTS zalo_claims_one_per_session
  ON public.zalo_reward_claims (host_table_id, session_started_at)
  WHERE status = 'verified';

CREATE INDEX IF NOT EXISTS zalo_claims_phone_idx
  ON public.zalo_reward_claims (customer_phone, status, created_at DESC);
CREATE INDEX IF NOT EXISTS zalo_claims_uid_idx
  ON public.zalo_reward_claims (zalo_user_id, status, verified_at DESC);

ALTER TABLE public.zalo_reward_claims ENABLE ROW LEVEL SECURITY;

-- Khách: chỉ TẠO yêu cầu chờ (không tự điền tiền/trạng thái) + XEM.
DROP POLICY IF EXISTS "zalo_claims_insert" ON public.zalo_reward_claims;
CREATE POLICY "zalo_claims_insert" ON public.zalo_reward_claims
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    status = 'waiting_follow'
    AND discount_amount = 0
    AND applied_order_id IS NULL
    AND applied_item_id IS NULL
    AND zalo_user_id IS NULL
    AND verified_at IS NULL
  );

DROP POLICY IF EXISTS "zalo_claims_select" ON public.zalo_reward_claims;
CREATE POLICY "zalo_claims_select" ON public.zalo_reward_claims
  FOR SELECT TO anon, authenticated USING (true);

-- CỐ TÌNH không có policy UPDATE/DELETE → khách không tự duyệt được.

-- ── 3) Realtime để máy khách thấy "đã bớt tiền" ngay ─────────
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.zalo_reward_claims;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- ── 4) CRM: gắn tài khoản Zalo vào hồ sơ khách ────────────────
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS zalo_user_id TEXT;

-- ── 5) Bật/tắt chế độ tự động (mặc định BẬT sau khi chạy file này)
--     Mức giảm/trần/bill tối thiểu/cooldown dùng chung cấu hình
--     zalo_follow_* sẵn có trong Admin > Cài đặt.
INSERT INTO public.settings (key, value) VALUES ('zalo_auto_enabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true';

NOTIFY pgrst, 'reload schema';
