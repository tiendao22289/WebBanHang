// ============================================================
//  VÒNG XOAY MAY MẮN — logic dùng chung cho khách, server và Admin.
//
//  Cơ cấu quà nằm trong bảng `lucky_prizes` (Admin > Cài đặt sửa được:
//  bật/tắt, tên quà, tỉ lệ, thêm/bớt quà). Danh sách dưới đây chỉ là
//  bản dự phòng khi bảng chưa được tạo/nạp.
// ============================================================

/** Cơ cấu quà dự phòng — dùng khi bảng lucky_prizes chưa có dữ liệu. */
export const FALLBACK_PRIZES = [
  { id: 'f1', label: 'Giảm 1% hoá đơn', short: '1%', type: 'percent', value: 1, weight: 30, color: '#f472b6' },
  { id: 'f2', label: 'Giảm 2% hoá đơn', short: '2%', type: 'percent', value: 2, weight: 24, color: '#facc15' },
  { id: 'f3', label: 'Giảm 3% hoá đơn', short: '3%', type: 'percent', value: 3, weight: 18, color: '#4ade80' },
  { id: 'f4', label: 'Giảm 4% hoá đơn', short: '4%', type: 'percent', value: 4, weight: 12, color: '#38bdf8' },
  { id: 'f5', label: 'Giảm 5% hoá đơn', short: '5%', type: 'percent', value: 5, weight: 9, color: '#a78bfa' },
  { id: 'f6', label: 'Tặng 1 nước ngọt tuỳ chọn', short: '🥤 Nước', type: 'gift', value: 0, weight: 5, color: '#fb923c' },
  { id: 'f7', label: 'Tặng 1 món 40.000 – 50.000đ', short: '🍤 Món', type: 'gift', value: 0, weight: 2, color: '#f87171' },
];

export const PRIZE_TYPES = [
  { value: 'percent', label: 'Giảm % hoá đơn' },
  { value: 'amount', label: 'Giảm số tiền' },
  { value: 'gift', label: 'Tặng món / nước' },
];

/** Đọc cơ cấu quà đang bật, đã sắp thứ tự. */
export async function fetchLuckyPrizes(supabase) {
  try {
    const { data, error } = await supabase
      .from('lucky_prizes')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error || !data?.length) return FALLBACK_PRIZES;
    return data.map(normalizePrize);
  } catch {
    return FALLBACK_PRIZES;
  }
}

export function normalizePrize(row) {
  return {
    id: row.id,
    label: row.label || 'Phần quà',
    short: (row.short || row.label || '').slice(0, 14),
    type: row.type || 'percent',
    value: Number(row.value) || 0,
    weight: Math.max(0, Number(row.weight) || 0),
    color: row.color || '#f472b6',
  };
}

export function totalWeight(prizes) {
  return (prizes || []).reduce((s, p) => s + (Number(p.weight) || 0), 0);
}

/** Tỉ lệ trúng thực tế của một phần quà (%), để hiển thị trong Cài đặt. */
export function prizeChance(prize, prizes) {
  const total = totalWeight(prizes);
  if (total <= 0) return 0;
  return (Number(prize.weight) || 0) * 100 / total;
}

/**
 * Quay số theo trọng số. CHỈ gọi trên server — để máy khách tự quay là
 * mở đường cho khách tự chọn giải nhất.
 */
export function drawLuckyPrize(prizes, random = Math.random) {
  const list = (prizes || []).filter(p => (Number(p.weight) || 0) > 0);
  if (list.length === 0) return null;
  let r = random() * totalWeight(list);
  for (const p of list) {
    r -= Number(p.weight) || 0;
    if (r < 0) return p;
  }
  return list[list.length - 1];
}

/** Tên dòng ghi vào bill cho từng loại quà. */
export function luckyItemName(prize) {
  if (prize.type === 'percent') return `Vòng xoay may mắn: giảm ${prize.value}%`;
  if (prize.type === 'amount') return `Vòng xoay may mắn: giảm ${Number(prize.value).toLocaleString('vi-VN')}đ`;
  return `QUÀ VÒNG XOAY: ${prize.label}`;
}

/**
 * 1 order_item có phải dòng quà vòng xoay không — dùng để chặn 1 bill nhận
 * quà 2 lần. So khớp bằng JS (uppercase có dấu) thay vì SQL ilike: chuỗi
 * thật luôn có dấu ("Vòng xoay"/"VÒNG XOAY"), còn ilike '%VONG XOAY%' (không
 * dấu) không bao giờ khớp — JS .toUpperCase() xử lý dấu tiếng Việt đúng.
 */
export function isLuckyWheelItem(item) {
  return typeof item?.item_name === 'string' && item.item_name.toUpperCase().includes('VÒNG XOAY');
}

/** Số tiền giảm của một phần quà: làm tròn XUỐNG bội 1.000đ, chặn trần. */
export function calcLuckyDiscount(billTotal, prize, maxAmount = 0) {
  const total = Number(billTotal) || 0;
  if (total <= 0 || !prize) return 0;

  let amount = 0;
  if (prize.type === 'percent') {
    amount = Math.floor((total * (Number(prize.value) || 0)) / 100 / 1000) * 1000;
  } else if (prize.type === 'amount') {
    amount = Math.floor((Number(prize.value) || 0) / 1000) * 1000;
  } else {
    return 0; // quà là món → không trừ tiền
  }

  if (maxAmount > 0) amount = Math.min(amount, maxAmount);
  // Không bao giờ giảm quá tổng bill
  amount = Math.min(amount, total);
  return Math.max(0, amount);
}

export const LUCKY_SETTING_KEYS = [
  'lucky_wheel_enabled',
  'lucky_wheel_min_bill',
  'lucky_wheel_max',
  'lucky_wheel_cooldown_days',
  'lucky_wheel_require_follow',
];

export function parseLuckyConfig(rows) {
  const map = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  return {
    enabled: map.lucky_wheel_enabled === 'true',
    minBill: Number(map.lucky_wheel_min_bill) || 0,
    max: Number(map.lucky_wheel_max) || 0,
    cooldownDays: Number(map.lucky_wheel_cooldown_days) || 0,
    // Mặc định BẬT: chưa cấu hình thì vẫn yêu cầu quan tâm Zalo mới nhận quà
    requireFollow: map.lucky_wheel_require_follow !== 'false',
  };
}
