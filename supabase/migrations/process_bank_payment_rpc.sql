-- ============================================================
-- Đảm bảo unique constraint để ON CONFLICT hoạt động đúng
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS bank_daily_totals_account_date_idx
  ON bank_daily_totals (account_id, date);

-- ============================================================
-- process_bank_payment: Atomic check hạn mức + ghi tiền
--
-- Thay thế 2 bước riêng (getActiveAccount + recordBankPayment)
-- bằng 1 transaction duy nhất có row-level lock, loại bỏ
-- race condition khi nhiều bill thanh toán cùng lúc.
--
-- Returns jsonb:
--   { account_id, account_name, over_limit, should_hide_stats }
-- ============================================================
CREATE OR REPLACE FUNCTION process_bank_payment(p_amount integer, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_account   bank_accounts%ROWTYPE;
  v_today     bigint;
BEGIN
  -- ── BƯỚC 1: Lock thẻ chính (is_visible = true) ──────────────────────────
  -- FOR UPDATE trên bank_accounts serialize toàn bộ concurrent calls
  SELECT * INTO v_account
  FROM bank_accounts
  WHERE is_visible = true
  ORDER BY sort_order ASC
  LIMIT 1
  FOR UPDATE;

  IF v_account.id IS NOT NULL THEN
    -- Đọc tổng hôm nay SAU KHI đã giữ lock (tránh stale read)
    SELECT COALESCE(total_amount, 0) INTO v_today
    FROM bank_daily_totals
    WHERE account_id = v_account.id AND date = p_date;

    v_today := COALESCE(v_today, 0);

    IF v_today < v_account.daily_limit THEN
      -- ✅ Thẻ chính còn hạn mức → ghi vào đây, bill VÀO thống kê
      INSERT INTO bank_daily_totals (account_id, date, total_amount)
      VALUES (v_account.id, p_date, p_amount)
      ON CONFLICT (account_id, date)
      DO UPDATE SET total_amount = bank_daily_totals.total_amount + EXCLUDED.total_amount;

      RETURN jsonb_build_object(
        'account_id',       v_account.id,
        'account_name',     v_account.account_name,
        'over_limit',       false,
        'should_hide_stats', false
      );
    END IF;
  END IF;

  -- ── BƯỚC 2: Thẻ chính ĐẦY → tìm thẻ dự phòng ──────────────────────────
  -- Lock toàn bộ thẻ dự phòng để serialize chọn thẻ
  FOR v_account IN
    SELECT * FROM bank_accounts
    WHERE is_visible = false
      AND is_active = true
    ORDER BY sort_order ASC
    FOR UPDATE
  LOOP
    SELECT COALESCE(total_amount, 0) INTO v_today
    FROM bank_daily_totals
    WHERE account_id = v_account.id AND date = p_date;

    v_today := COALESCE(v_today, 0);

    IF v_today < v_account.daily_limit THEN
      -- 🔴 Thẻ dự phòng còn hạn mức → ghi vào đây, bill ẨN
      INSERT INTO bank_daily_totals (account_id, date, total_amount)
      VALUES (v_account.id, p_date, p_amount)
      ON CONFLICT (account_id, date)
      DO UPDATE SET total_amount = bank_daily_totals.total_amount + EXCLUDED.total_amount;

      RETURN jsonb_build_object(
        'account_id',       v_account.id,
        'account_name',     v_account.account_name,
        'over_limit',       true,
        'should_hide_stats', true
      );
    END IF;
  END LOOP;

  -- ── BƯỚC 3: Tất cả thẻ đều đầy → dùng thẻ dự phòng đầu tiên ───────────
  SELECT * INTO v_account
  FROM bank_accounts
  WHERE is_visible = false
    AND is_active = true
  ORDER BY sort_order ASC
  LIMIT 1;

  IF v_account.id IS NOT NULL THEN
    INSERT INTO bank_daily_totals (account_id, date, total_amount)
    VALUES (v_account.id, p_date, p_amount)
    ON CONFLICT (account_id, date)
    DO UPDATE SET total_amount = bank_daily_totals.total_amount + EXCLUDED.total_amount;

    RETURN jsonb_build_object(
      'account_id',       v_account.id,
      'account_name',     v_account.account_name,
      'over_limit',       true,
      'should_hide_stats', true
    );
  END IF;

  -- Không có tài khoản nào → trả về ẩn
  RETURN jsonb_build_object(
    'account_id',       null,
    'account_name',     null,
    'over_limit',       true,
    'should_hide_stats', true
  );
END;
$$;
