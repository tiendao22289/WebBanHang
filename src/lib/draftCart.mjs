/**
 * Giỏ nháp của nhân viên ở trang Bàn (món chọn rồi mới bấm "Gửi đi").
 * Mỗi dòng có lineId: máy chủ (confirm_draft_order) nhớ dòng nào đã vào bill, nên
 * mạng rớt phản hồi rồi gửi lại không cộng món 2 lần.
 * Dòng đang gửi / gửi chưa rõ kết quả là "khoá": bấm thêm món thì mở dòng mới,
 * không cộng vào dòng khoá (nếu không, phần cộng thêm bị máy chủ bỏ qua khi gửi lại).
 */

export function newLineId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const NO_DRAFT = [];

/** Giỏ nháp giữ riêng theo bàn: { [tableId]: lines }. update là mảng mới hoặc hàm (lines cũ) => lines mới. */
export function updateDraftOf(drafts, tableId, update) {
  const cur = drafts[tableId] || NO_DRAFT;
  const next = typeof update === 'function' ? update(cur) : update;
  if (next === cur) return drafts;
  const copy = { ...drafts };
  if (next.length) copy[tableId] = next;
  else delete copy[tableId];
  return copy;
}

const sameLine = (d, l) => d.menuItemId === l.menuItemId
  && JSON.stringify(d.options || []) === JSON.stringify(l.options || [])
  && (d.note || '') === (l.note || '')
  && Number(d.price) === Number(l.price);

/** Thêm qty phần: cộng vào dòng giống hệt (món, tuỳ chọn, ghi chú, giá) chưa khoá, không có thì mở dòng mới. */
export function addDraftLine(lines, line, locked = new Set()) {
  const idx = lines.findIndex(d => !locked.has(d.lineId) && sameLine(d, line));
  if (idx === -1) return [...lines, { ...line, lineId: line.lineId || newLineId() }];
  const next = [...lines];
  next[idx] = { ...next[idx], qty: next[idx].qty + line.qty };
  return next;
}

/** Bớt 1 phần của món ở dòng mới nhất không đang gửi. */
export function decreaseDraftLine(lines, menuItemId, sending = new Set()) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].menuItemId !== menuItemId || sending.has(lines[i].lineId)) continue;
    const next = [...lines];
    if (next[i].qty <= 1) next.splice(i, 1);
    else next[i] = { ...next[i], qty: next[i].qty - 1 };
    return next;
  }
  return lines;
}

/** Gõ tổng số phần của 1 món (mọi kiểu chế biến cộng lại): thêm / bớt phần chênh lệch ở dòng mới nhất. */
export function setDraftItemTotal(lines, menuItemId, total, locked = new Set(), sending = new Set()) {
  let current = lines.filter(d => d.menuItemId === menuItemId).reduce((s, d) => s + d.qty, 0);
  let next = lines;
  if (total > current) {
    const last = [...lines].reverse().find(d => d.menuItemId === menuItemId);
    if (!last) return lines;
    return addDraftLine(lines, { ...last, lineId: undefined, qty: total - current }, locked);
  }
  while (current > Math.max(0, total)) {
    const after = decreaseDraftLine(next, menuItemId, sending);
    if (after === next) break;
    next = after;
    current--;
  }
  return next;
}

/** Sau khi máy chủ nhận: bỏ đúng các dòng đã gửi, giữ món bấm thêm trong lúc chờ. */
export function removeSentLines(lines, sentIds) {
  const sent = new Set(sentIds);
  return lines.filter(d => !sent.has(d.lineId));
}
