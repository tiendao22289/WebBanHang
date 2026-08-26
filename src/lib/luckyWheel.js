// ============================================================
//  VÒNG XOAY MAY MẮN — định nghĩa dùng chung cho khách và server.
//
//  Tỉ lệ trúng 100%: khách luôn nhận được một phần quà.
//  `weight` là trọng số quay, tổng đúng 100 nên đọc như phần trăm.
//  Muốn đổi cơ cấu quà chỉ cần sửa bảng này (nhớ giữ tổng weight = 100).
// ============================================================

export const LUCKY_PRIZES = [
  { key: 'p1',    type: 'percent',    value: 1, weight: 30, label: 'Giảm 1% hoá đơn',  short: '1%',      color: '#f472b6' },
  { key: 'p2',    type: 'percent',    value: 2, weight: 24, label: 'Giảm 2% hoá đơn',  short: '2%',      color: '#facc15' },
  { key: 'p3',    type: 'percent',    value: 3, weight: 18, label: 'Giảm 3% hoá đơn',  short: '3%',      color: '#4ade80' },
  { key: 'p4',    type: 'percent',    value: 4, weight: 12, label: 'Giảm 4% hoá đơn',  short: '4%',      color: '#38bdf8' },
  { key: 'p5',    type: 'percent',    value: 5, weight: 9,  label: 'Giảm 5% hoá đơn',  short: '5%',      color: '#a78bfa' },
  { key: 'drink', type: 'gift_drink', value: 0, weight: 5,  label: 'Tặng 1 nước ngọt tuỳ chọn', short: '🥤 Nước', color: '#fb923c' },
  { key: 'dish',  type: 'gift_dish',  value: 0, weight: 2,  label: 'Tặng 1 món 40.000 – 50.000đ', short: '🍤 Món', color: '#f87171' },
];

export const LUCKY_TOTAL_WEIGHT = LUCKY_PRIZES.reduce((s, p) => s + p.weight, 0);

export function getLuckyPrize(key) {
  return LUCKY_PRIZES.find(p => p.key === key) || null;
}

/**
 * Quay số theo trọng số. CHỈ gọi trên server — để máy khách tự quay là
 * mở đường cho khách tự chọn giải nhất.
 */
export function drawLuckyPrize(random = Math.random) {
  let r = random() * LUCKY_TOTAL_WEIGHT;
  for (const p of LUCKY_PRIZES) {
    r -= p.weight;
    if (r < 0) return p;
  }
  return LUCKY_PRIZES[0];
}

/** Tên dòng ghi vào bill cho từng loại quà. */
export function luckyItemName(prize) {
  if (prize.type === 'percent') return `Vòng xoay may mắn: giảm ${prize.value}%`;
  if (prize.type === 'gift_drink') return 'QUÀ VÒNG XOAY: 1 nước ngọt (khách chọn)';
  return 'QUÀ VÒNG XOAY: 1 món 40–50k (khách chọn)';
}

/** Số tiền giảm: làm tròn XUỐNG bội 1.000đ, chặn trần theo cấu hình. */
export function calcLuckyDiscount(billTotal, percent, maxAmount = 0) {
  const total = Number(billTotal) || 0;
  const pct = Number(percent) || 0;
  if (total <= 0 || pct <= 0) return 0;
  let amount = Math.floor((total * pct) / 100 / 1000) * 1000;
  if (maxAmount > 0) amount = Math.min(amount, maxAmount);
  return Math.max(0, amount);
}

export const LUCKY_SETTING_KEYS = [
  'lucky_wheel_enabled',
  'lucky_wheel_min_bill',
  'lucky_wheel_max',
  'lucky_wheel_cooldown_days',
];

export function parseLuckyConfig(rows) {
  const map = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  return {
    enabled: map.lucky_wheel_enabled === 'true',
    minBill: Number(map.lucky_wheel_min_bill) || 0,
    max: Number(map.lucky_wheel_max) || 0,
    cooldownDays: Number(map.lucky_wheel_cooldown_days) || 0,
  };
}
