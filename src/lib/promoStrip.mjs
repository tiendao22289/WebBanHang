// Thanh "8 tặng 1" ở đáy trang gọi món (order/page.jsx), nằm ngay trên nút Gửi món.
// Thay cho nút tròn nổi cũ: nút đó che dấu "+" của món và khách không biết là nút bấm.
// Số liệu vào là số trang đã tính (qualifyingQty, giftCount, availableGiftSlots) — hàm này chỉ
// quyết định thanh nói gì và bấm vào thì làm gì.

// Khách chỉ thấy số MÓN nguyên, không thấy "điểm" (chủ quán: ghi món cho dễ hiểu). Món tính nửa
// (SL/1 KM = 2) làm số lẻ: còn thiếu 0,5 → "thêm 1 món"; đã gọi 7,5 → "7 món".

/** Số món còn thiếu cho khách xem: làm tròn lên (0,5 → 1). */
export function dishesLeft(n) {
  return Math.max(0, Math.ceil((Number(n) || 0) - 1e-6));
}

/** Số món đã gọi cho khách xem: làm tròn xuống (7,5 → 7). */
export function dishesDone(n) {
  return Math.max(0, Math.floor((Number(n) || 0) + 1e-6));
}

/**
 * Trạng thái thanh:
 *  - 'progress': chưa đủ suất — còn thiếu `need` món, `progress` 0..1 của suất đầu tiên.
 *  - 'ready':    còn `slots` quà chưa chọn — bấm để chọn quà.
 *  - 'chosen':   đã chọn hết `chosen` quà (đã gửi hoặc đang trong giỏ) — còn `need` món tới suất tiếp theo.
 */
export function promoStripState({ qualifyingQty, threshold, giftCount, availableGiftSlots }) {
  const thr = Number(threshold) > 0 ? Number(threshold) : 8;
  const qty = Math.max(0, Number(qualifyingQty) || 0);
  const earned = Math.max(0, Math.floor(Number(giftCount) || 0));
  const slots = Math.max(0, Math.floor(Number(availableGiftSlots) || 0));
  const inCycle = Math.max(0, qty - earned * thr);
  const need = Math.round((thr - inCycle) * 10000) / 10000;
  const progress = Math.min(1, inCycle / thr);
  if (slots > 0) return { kind: 'ready', slots, need, progress: 1 };
  if (earned > 0) return { kind: 'chosen', chosen: earned, need, progress };
  return { kind: 'progress', need, progress, started: qty > 0 };
}

/**
 * Chữ trên thanh: { lead, strong, tail } (strong in đậm) + action (chữ nút) + open ('gift' mở bảng chọn
 * quà, 'preview' mở danh sách món tặng).
 */
export function promoStripText(state, threshold) {
  const thr = Number(threshold) > 0 ? Number(threshold) : 8;
  if (state.kind === 'ready') {
    return { lead: 'Quý khách được tặng ', strong: `${state.slots} món`, tail: '', action: 'Chọn quà', open: 'gift' };
  }
  if (state.kind === 'chosen') {
    return { lead: `Đã chọn ${state.chosen} quà · gọi thêm `, strong: `${dishesLeft(state.need)} món`,
      tail: ' được tặng tiếp', action: 'Xem quà', open: 'preview' };
  }
  if (!state.started) {
    return { lead: 'Gọi đủ ', strong: `${thr} món`, tail: ' được tặng 1 món', action: 'Xem quà', open: 'preview' };
  }
  return { lead: 'Gọi thêm ', strong: `${dishesLeft(state.need)} món`, tail: ' được tặng 1 món', action: 'Xem quà', open: 'preview' };
}

/**
 * Lời nhắc hiện vài giây trên thanh khi khách vừa thêm món (chưa đủ suất). left: số món còn thiếu (số
 * lẻ được), nextGift: suất thứ mấy, partial: { name, needed } khi còn thiếu < 1 món vì 1 món tính nửa
 * đang lẻ phần (vd 1 phần Sò điệp, 2 phần mới tính 1 món).
 */
export function promoHintText({ left, nextGift, partial = null }) {
  if (left < 1 && partial) return `Thêm ${partial.needed} ${partial.name} nữa cho đủ món, hoặc gọi món khác tuỳ ý nhé! 🔥`;
  const n = dishesLeft(left);
  return nextGift > 1
    ? `Còn thiếu ${n} món nữa là được tặng thêm 1 món! 🔥`
    : `Còn thiếu ${n} món nữa là được tặng 1 món! 🔥`;
}
