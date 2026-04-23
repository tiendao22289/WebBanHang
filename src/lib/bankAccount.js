import { supabase } from './supabase';

/**
 * Map tên ngân hàng → mã ngân hàng VietQR
 */
export const BANK_IDS = {
  'Vietcombank':  'VCB',
  'MB Bank':      'MB',
  'Techcombank':  'TCB',
  'Agribank':     'AGRIBANK',
  'Vietinbank':   'ICB',
  'BIDV':         'BIDV',
  'ACB':          'ACB',
  'VPBank':       'VPB',
  'TPBank':       'TPB',
  'Sacombank':    'STB',
  'HDBank':       'HDB',
  'OCB':          'OCB',
  'VIB':          'VIB',
  'SHB':          'SHB',
  'MSB':          'MSB',
  'SeABank':      'SEAB',
  'BaoViet Bank': 'BVBANK',
};

// =============================================================================
// CỔNG THU NGÂN - /admin/tables
// =============================================================================

/**
 * Lấy tài khoản phù hợp để nhận thanh toán tại cổng Thu Ngân (/admin/tables).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  THIẾT KẾ HAI GIAI ĐOẠN:
 *
 *  ── GIAI ĐOẠN 1: THẺ CHÍNH (is_visible = true) CÒN ĐỊNH MỨC ──────────────
 *    - Lấy thẻ is_visible = true đầu tiên theo sort_order (Thẻ A).
 *    - Kiểm tra tổng thu hôm nay (Tiền mặt + CK) trong bank_daily_totals.
 *    - Nếu tổng < daily_limit → CÒN hạn mức.
 *    - Trả về: { account: ThẻA, overLimit: false, shouldHideStats: false }
 *    → Hành động: Cộng tiền vào Thẻ A. Bill ĐƯỢC VÀO thống kê ✅
 *
 *  ── GIAI ĐOẠN 2: THẺ CHÍNH ĐẦY (Thống kê ĐÓNG BĂNG đến hết ngày) ────────
 *    - Thẻ A đã đầy định mức → thống kê đóng băng hoàn toàn.
 *    - Chuyển sang Nhóm Thẻ Dự Phòng (is_visible = false):
 *        * Xoay vòng theo sort_order + daily_limit của từng thẻ B, C, D...
 *        * Tìm thẻ dự phòng chưa đầy → dùng thẻ đó nhận tiền.
 *        * Nếu tất cả dự phòng cũng đầy → dùng thẻ dự phòng đầu tiên.
 *    - Trả về: { account: ThẻB/C/..., overLimit: true, shouldHideStats: true }
 *    → Hành động: Cộng tiền vào thẻ dự phòng (để xoay vòng). Bill BỊ ẨN 🔴
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * @returns {{ account: object|null, overLimit: boolean, shouldHideStats: boolean }}
 */
export async function getActiveAccount() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── BƯỚC 1: Kiểm tra Thẻ Chính (is_visible = true) ──────────────────────
  const { data: primaryAccounts, error: primaryError } = await supabase
    .from('bank_accounts')
    .select('*, bank_daily_totals(date, total_amount)')
    .eq('is_visible', true)
    .order('sort_order', { ascending: true });

  if (!primaryError && primaryAccounts && primaryAccounts.length > 0) {
    const primary = primaryAccounts[0]; // Lấy thẻ chính (sort_order nhỏ nhất)
    const todayRow = (primary.bank_daily_totals || []).find(r => r.date === today);
    const todayTotal = todayRow?.total_amount || 0;

    if (todayTotal < primary.daily_limit) {
      // ✅ GĐ 1: Thẻ Chính CHƯA ĐẦY → bill vào thống kê
      return {
        account: primary,
        overLimit: false,
        shouldHideStats: false,
      };
    }
  }

  // ── BƯỚC 2: Thẻ Chính ĐẦY → Thống kê ĐÓNG BĂNG ──────────────────────────
  // Tìm thẻ Dự Phòng (is_visible = false) phù hợp để nhận tiền & xoay vòng
  const { data: backupAccounts, error: backupError } = await supabase
    .from('bank_accounts')
    .select('*, bank_daily_totals(date, total_amount)')
    .eq('is_visible', false)
    .order('sort_order', { ascending: true });

  if (!backupError && backupAccounts && backupAccounts.length > 0) {
    // Xoay vòng: tìm thẻ dự phòng chưa đầy định mức riêng của nó
    for (const acc of backupAccounts) {
      const todayRow = (acc.bank_daily_totals || []).find(r => r.date === today);
      const todayTotal = todayRow?.total_amount || 0;
      if (todayTotal < acc.daily_limit) {
        // 🔴 GĐ 2: Dùng thẻ dự phòng này, tiền ghi vào đây, nhưng bill ẨN
        return {
          account: acc,
          overLimit: true,
          shouldHideStats: true,
        };
      }
    }
    // Tất cả thẻ dự phòng cũng đầy → dùng thẻ dự phòng đầu tiên
    return {
      account: backupAccounts[0],
      overLimit: true,
      shouldHideStats: true,
    };
  }

  // Fallback: không có thẻ dự phòng → dùng lại thẻ chính nếu có, đánh dấu ẩn
  if (primaryAccounts && primaryAccounts.length > 0) {
    return {
      account: primaryAccounts[0],
      overLimit: true,
      shouldHideStats: true,
    };
  }

  return { account: null, overLimit: true, shouldHideStats: true };
}

// =============================================================================
// CỔNG QR TÙY CHỈNH - /admin/qr
// =============================================================================

/**
 * Lấy tài khoản "Ẩn" (is_visible = false) dành riêng cho cổng QR (/admin/qr).
 *
 * NGUYÊN TẮC BẤT BIẾN:
 *   - TUYỆT ĐỐI không dùng thẻ Hiển thị (is_visible = true).
 *   - shouldHideStats luôn = true — không bao giờ vào thống kê thuế.
 *
 * LOGIC XOAY VÒNG:
 *   1. Quét thẻ is_visible = false, sắp xếp theo sort_order ASC.
 *   2. Tìm thẻ Ẩn chưa đầy daily_limit → dùng thẻ đó.
 *   3. Nếu tất cả đầy → dùng thẻ Ẩn đầu tiên.
 *
 * @returns {{ account: object|null, overLimit: boolean, shouldHideStats: boolean }}
 */
export async function getShadowAccount() {
  const today = new Date().toISOString().slice(0, 10);

  const { data: accounts, error } = await supabase
    .from('bank_accounts')
    .select('*, bank_daily_totals(date, total_amount)')
    .eq('is_visible', false)
    .order('sort_order', { ascending: true });

  if (error || !accounts || accounts.length === 0) {
    return { account: null, overLimit: false, shouldHideStats: true };
  }

  for (const acc of accounts) {
    const todayRow = (acc.bank_daily_totals || []).find(r => r.date === today);
    const todayTotal = todayRow?.total_amount || 0;
    if (todayTotal < acc.daily_limit) {
      return {
        account: acc,
        overLimit: false,
        shouldHideStats: true, // 🔴 Luôn ẩn
      };
    }
  }

  return {
    account: accounts[0],
    overLimit: true,
    shouldHideStats: true,
  };
}

// =============================================================================
// HELPER
// =============================================================================

/**
 * Build URL ảnh QR VietQR
 */
export function buildQrUrl(account, amount = 0, info = '') {
  const bankId = BANK_IDS[account.bank_name] || 'MB';
  const base = `https://img.vietqr.io/image/${bankId}-${account.account_number}-compact2.png`;
  const params = new URLSearchParams({ accountName: account.account_name });
  if (amount > 0) params.set('amount', amount);
  if (info) params.set('addInfo', info);
  return `${base}?${params.toString()}`;
}
