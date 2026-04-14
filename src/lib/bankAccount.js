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

/**
 * Lấy tài khoản ngân hàng đang hoạt động theo logic:
 * 1. Lấy tất cả tài khoản is_active=true, sắp xếp theo sort_order ASC
 * 2. Chọn tài khoản đầu tiên chưa đạt hạn mức ngày (total < daily_limit)
 * 3. Nếu tất cả đã đạt hạn mức → trả về tài khoản cuối cùng + overLimit=true
 *
 * @returns {{ account: object|null, overLimit: boolean }}
 */
export async function getActiveAccount() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const { data: accounts, error } = await supabase
    .from('bank_accounts')
    .select('*, bank_daily_totals(date, total_amount)')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error || !accounts || accounts.length === 0) {
    return { account: null, overLimit: false };
  }

  // Tìm tài khoản đầu tiên chưa đạt hạn mức hôm nay
  for (const acc of accounts) {
    const todayRow = (acc.bank_daily_totals || []).find(r => r.date === today);
    const todayTotal = todayRow?.total_amount || 0;
    if (todayTotal < acc.daily_limit) {
      return { account: acc, overLimit: false };
    }
  }

  // Tất cả đều hết hạn mức → trả về tài khoản cuối cùng, đánh dấu overLimit
  const last = accounts[accounts.length - 1];
  return { account: last, overLimit: true };
}

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
