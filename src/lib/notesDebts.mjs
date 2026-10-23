/**
 * Các khoản Sổ tay đang còn nợ — dùng chung cho trang Sổ tay (chọn khoản trả) và
 * máy chủ (kiểm tra số trả). Một khoản = một dòng hàng còn nợ; phiếu không có
 * dòng hàng (chỉ ghi số nợ) thì cả phiếu là một khoản (item_index = null).
 */
import { parsePrice, parseQty } from './notesMath.mjs';

const readContent = content => { try { const d = JSON.parse(content); return d && typeof d === 'object' ? d : null; } catch { return null; } };

export const debtKey = line => `${line.note_id}:${line.item_index ?? 'note'}`;

/** Phần nợ lúc mua của một dòng (đã tính "nợ một phần"). 0 = dòng trả đủ. */
export function lineDebtBase(item) {
  const total = Math.round(parsePrice(item?.price) * parseQty(item?.qty));
  const owed = item?.paymentStatus === 'debt' || Number(item?.paid_amount) > 0;
  if (!owed || total <= 0) return 0;
  return String(item.debtAmount || '').trim() ? Math.min(parsePrice(String(item.debtAmount).replace(/\./g, '')) || total, total) : total;
}

export function openDebtLines(note) {
  const data = readContent(note?.content);
  const items = data?.type === 'structured_expense' && Array.isArray(data.items) ? data.items : [];
  const base = { note_id: note.id, created_at: note.created_at, writer: note.staff?.full_name || '', staff_id: note.staff_id };
  const lines = [];
  items.forEach((item, index) => {
    if (!String(item?.name || '').trim()) return;
    const left = lineDebtBase(item) - (Number(item.paid_amount) || 0);
    if (left > 0) lines.push({ ...base, item_index: index, name: item.name, creditor: String(item.creditor || '').trim(), left });
  });
  // Phiếu chỉ ghi số nợ (không có dòng hàng còn nợ) → trả theo cả phiếu.
  const noteLeft = (Number(note?.debt) || 0) - (Number(note?.paid_debt) || 0);
  if (!lines.length && noteLeft > 0) lines.push({ ...base, item_index: null, name: 'Nợ của phiếu', creditor: '', left: noteLeft });
  return lines;
}

/** Mọi khoản đang nợ, phiếu cũ nhất trước. */
export const allOpenDebts = notes => notes.flatMap(openDebtLines).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

/**
 * Chia một số tiền (vd. tiền dư) vào các khoản nợ: các khoản ưu tiên (đã tích)
 * trước, rồi phiếu cũ nhất. Trả về { key: số tiền }.
 */
export function allocateToDebts(amount, lines, preferredKeys = []) {
  let left = Math.max(0, Math.round(Number(amount) || 0));
  const order = [...lines.filter(l => preferredKeys.includes(debtKey(l))), ...lines.filter(l => !preferredKeys.includes(debtKey(l)))];
  const out = {};
  for (const line of order) {
    if (left <= 0) break;
    const pay = Math.min(line.left, left);
    out[debtKey(line)] = pay;
    left -= pay;
  }
  return out;
}
