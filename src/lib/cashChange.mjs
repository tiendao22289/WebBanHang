// Tiền mặt ở trang Bàn: nút chọn nhanh "khách đưa" và tiền thối.

/** Đưa đủ + các mức tròn kế tiếp: 328.000 → 328k, 330k, 350k, 400k; 300.000 → 300k, 500k, 1 triệu. */
export function cashChoices(total) {
  const rounded = [10000, 50000, 100000, 500000, 1000000].map(step => Math.ceil(total / step) * step);
  return [...new Set([total, ...rounded])].filter(v => v >= total).sort((a, b) => a - b).slice(0, 4);
}

/** { change } khi đưa đủ, { short } khi còn thiếu; null khi chưa nhập. */
export function cashChange(total, given) {
  if (!(given > 0)) return null;
  return given >= total ? { change: given - total } : { short: total - given };
}
