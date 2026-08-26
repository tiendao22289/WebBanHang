// ============================================================
//  ƯU ĐÃI MẠNG XÃ HỘI — logic dùng chung
//  cho trang khách (order) và màn hình nhân viên (admin/tables).
//
//  Mỗi "kênh" (Google / TikTok / Facebook...) có cấu hình riêng
//  trong bảng settings, theo tiền tố `prefix` khai báo bên dưới.
//  Muốn thêm kênh mới (Zalo, Instagram...) chỉ cần thêm 1 dòng
//  vào REWARD_CHANNELS + insert settings mặc định trong SQL.
// ============================================================

export const REWARD_CHANNELS = [
  {
    key: 'google',
    color: '#f59e0b', colorDark: '#b45309', colorSoft: '#fffbeb', colorBorder: '#fde68a',
    prefix: 'gmap_review',              // giữ nguyên key cũ — không phải cấu hình lại
    icon: '⭐',
    // `name` dùng cho màn hình nhân viên + trang Cài đặt (cần gọn, chuẩn xác).
    // `custName` là lời khách đọc — thân mật hơn.
    name: 'Đánh giá Google',
    custName: 'Chấm cho quán vài sao Google',
    short: 'Google',
    cta: 'Mở Google, chấm sao nào!',
    steps: [
      'Bấm nút dưới, Google Maps của quán mở ra liền.',
      'Chấm sao và viết vài dòng thật lòng thôi ạ.',
    ],
    discountLabel: 'Giảm giá đánh giá Google',
    urlHint: 'Google Business Profile → Nhận thêm bài đánh giá → sao chép liên kết.',
  },
  {
    key: 'tiktok',
    color: '#111827', colorDark: '#111827', colorSoft: '#f8fafc', colorBorder: '#cbd5e1',
    prefix: 'tiktok_follow',
    icon: '🎵',
    name: 'Theo dõi TikTok',
    custName: 'Follow TikTok của quán',
    short: 'TikTok',
    cta: 'Mở TikTok, bấm Follow!',
    steps: [
      'Bấm nút dưới để qua TikTok của quán.',
      'Bấm Follow một cái là xong ạ.',
    ],
    discountLabel: 'Giảm giá theo dõi TikTok',
    urlHint: 'Mở TikTok quán → Chia sẻ → Sao chép liên kết (dạng tiktok.com/@tenquan).',
  },
  {
    key: 'zalo',
    // Màu chọn theo tiêu chí PHÂN BIỆT được với 3 kênh kia (xanh ngọc),
    // không lấy đúng màu thương hiệu vì Zalo xanh dương sẽ trùng Facebook.
    color: '#0d9488', colorDark: '#0f766e', colorSoft: '#f0fdfa', colorBorder: '#99f6e4',
    prefix: 'zalo_follow',
    icon: '💬',
    name: 'Quan tâm Zalo OA',
    custName: 'Quan tâm Zalo của quán',
    short: 'Zalo',
    cta: 'Mở Zalo, bấm Quan tâm!',
    // auto: kênh này KHÔNG qua nhân viên duyệt — webhook Zalo xác nhận
    // follow thật rồi server tự trừ tiền (xem /api/zalo/webhook).
    auto: true,
    steps: [
      'Bấm nút dưới để mở Zalo của quán.',
      'Bấm QUAN TÂM ở đầu trang — xong luôn ạ!',
    ],
    discountLabel: 'Giảm giá kết bạn Zalo',
    urlHint: 'Dán link Zalo OA (zalo.me/<id OA>) — lấy trong oa.zalo.me → Thông tin OA.',
  },
  {
    key: 'facebook',
    color: '#2563eb', colorDark: '#1d4ed8', colorSoft: '#eff6ff', colorBorder: '#bfdbfe',
    prefix: 'fb_follow',
    icon: '👍',
    name: 'Theo dõi Facebook',
    custName: 'Thích Fanpage của quán',
    short: 'Facebook',
    cta: 'Mở Facebook, thả Like!',
    steps: [
      'Bấm nút dưới để qua Fanpage của quán.',
      'Bấm Thích hoặc Theo dõi trang là xong ạ.',
    ],
    discountLabel: 'Giảm giá theo dõi Facebook',
    urlHint: 'Mở Fanpage → sao chép địa chỉ trang (dạng facebook.com/tenquan).',
  },
];

export function getChannel(key) {
  return REWARD_CHANNELS.find(c => c.key === key) || REWARD_CHANNELS[0];
}

const FIELDS = ['enabled', 'url', 'percent', 'max', 'min_bill', 'cooldown_days', 'wait_seconds'];

/** Toàn bộ key settings của mọi kênh — dùng cho 1 query duy nhất. */
export const ALL_SETTING_KEYS = REWARD_CHANNELS.flatMap(c => FIELDS.map(f => `${c.prefix}_${f}`));

/** Đọc cấu hình 1 kênh từ mảng rows của bảng settings. */
export function parseChannelConfig(rows, channelKey) {
  const ch = getChannel(channelKey);
  const map = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  const g = (f) => map[`${ch.prefix}_${f}`];
  const url = (g('url') || '').trim();
  return {
    ...ch,
    // Thiếu link thì coi như tắt — tránh mở tab trắng cho khách
    enabled: g('enabled') === 'true' && !!url,
    url,
    percent: Number(g('percent')) || 0,
    max: Number(g('max')) || 0,
    minBill: Number(g('min_bill')) || 0,
    cooldownDays: Number(g('cooldown_days')) || 0,
    waitSeconds: Number(g('wait_seconds')) || 20,
  };
}

/** Cấu hình của cả 3 kênh, theo thứ tự khai báo. */
export function parseAllChannelConfigs(rows) {
  return REWARD_CHANNELS.map(c => parseChannelConfig(rows, c.key));
}

export async function fetchAllChannelConfigs(supabase) {
  const { data } = await supabase.from('settings').select('key, value').in('key', ALL_SETTING_KEYS);
  return parseAllChannelConfigs(data);
}

export async function fetchChannelConfig(supabase, channelKey) {
  const all = await fetchAllChannelConfigs(supabase);
  return all.find(c => c.key === channelKey) || all[0];
}

/**
 * Số tiền được giảm, làm tròn XUỐNG bội số 1.000đ và chặn trần theo cấu hình.
 * Dùng chung cho cả phần xem trước ở máy khách lẫn lúc nhân viên duyệt,
 * để hai bên không bao giờ lệch số.
 */
export function calcReviewDiscount(billTotal, cfg) {
  const total = Number(billTotal) || 0;
  const percent = Number(cfg?.percent) || 0;
  const max = Number(cfg?.max) || 0;
  if (total <= 0 || percent <= 0) return 0;
  let amount = Math.floor((total * percent) / 100 / 1000) * 1000;
  if (max > 0) amount = Math.min(amount, max);
  return Math.max(0, amount);
}

/** Mốc 00:00 hôm nay (giờ máy) — dùng để giới hạn "mỗi bàn 1 lần/ngày". */
export function startOfTodayISO() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString();
}

/** Tổng tiền của cả nhóm bàn (các bill chưa thanh toán). */
export async function fetchGroupBillTotal(supabase, tableIds, phoneFilter = null) {
  const ids = (tableIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  let q = supabase
    .from('orders')
    .select('total_amount, customer_phone')
    .in('table_id', ids)
    .in('status', ['pending', 'preparing', 'completed'])
    .gte('created_at', startOfTodayISO());
  if (phoneFilter) q = q.eq('customer_phone', phoneFilter);
  const { data } = await q;
  return (data || [])
    .filter(o => o.customer_phone !== 'BAO_BEP') // order hệ thống "Gọi nhân viên"
    .reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
}

/** Dòng order_items này có phải dòng giảm giá ưu đãi không? */
export function isReviewDiscountItem(item) {
  return !!item && item.menu_item_id == null && (Number(item.unit_price) || 0) < 0;
}
