/**
 * Khuyến mãi "8 món tặng 1" của một bàn (hoặc nhóm bàn gộp): bao nhiêu suất quà được, đã chọn bao nhiêu,
 * còn bao nhiêu suất chưa chọn, và — khi khách bớt món sau khi đã chọn quà — đang thiếu bao nhiêu món.
 * Quà đã chọn KHÔNG bị máy tự xoá khi thiếu món (bếp có thể đã in / làm rồi, chủ quán 2026-10-27):
 * ô bàn hiện cảnh báo để nhân viên báo khách gọi thêm.
 */
export const WHEEL_GIFT_NOTE = 'Quà tặng từ vòng quay may mắn';

/**
 * items: các dòng món của bàn; threshold: số món mỗi suất quà (vd 8);
 * divisorOf(item): món tính khuyến mãi thì trả số chia (1 = 1 món, 2 = nửa món…), không tính thì null.
 * Quà vòng xoay (ghi chú WHEEL_GIFT_NOTE) không thuộc khuyến mãi này.
 */
export function promoGiftStatus(items, threshold, divisorOf) {
  let points = 0, used = 0, hasGiftInBill = false;
  for (const oi of items || []) {
    if (oi.is_gift) {
      if (oi.note === WHEEL_GIFT_NOTE) continue;
      used += Number(oi.quantity) || 1;
      hasGiftInBill = true;
    } else {
      const divisor = divisorOf(oi);
      if (divisor) points += (Number(oi.quantity) || 0) / divisor;
    }
  }
  const qualifyingQty = Math.round(points * 10000) / 10000;
  const giftCount = threshold > 0 ? Math.floor(qualifyingQty / threshold) : 0;
  const shortGifts = Math.max(0, used - giftCount);
  return {
    qualifyingQty, giftCount, usedGiftSlots: used, hasGiftInBill,
    availableGiftSlots: Math.max(0, giftCount - used),
    // Quà đã chọn nhiều hơn số suất được (khách bớt món): thiếu bao nhiêu món nữa thì đủ.
    shortGifts,
    missingItems: shortGifts ? Math.max(1, Math.ceil(used * threshold - qualifyingQty - 1e-9)) : 0,
  };
}
