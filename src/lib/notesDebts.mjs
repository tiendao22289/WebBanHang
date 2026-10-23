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

const sumAmounts = list => (Array.isArray(list) ? list : []).reduce((a, r) => a + (Number(r?.amount) || 0), 0);

/**
 * Tiền của một phiếu đi chợ: given (chủ giao), carriedIn (tiền dư phiếu cũ cộng vào),
 * spent (trả ngay), funded (phiếu này dùng trả nợ cũ), returned (đã trả lại chủ),
 * carriedOut (đã chuyển sang phiếu sau). balance = given + carriedIn − spent − funded
 * (âm = bỏ thêm); left = số người đi chợ còn cầm chưa trả chủ.
 */
export function noteMoney(note, payments = []) {
  const data = note?.note_type === 'expense' ? readContent(note.content) : null;
  const given = Number(data?.input_amount) || 0;
  const carriedIn = sumAmounts(data?.carried_in);
  const spent = Number(note?.amount) || 0;
  const funded = payments.filter(p => p.paid_from_note_id === note?.id).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const returned = sumAmounts(data?.returned_logs);
  const carriedOut = sumAmounts(data?.carried_out);
  const balance = given + carriedIn - spent - funded;
  const left = given + carriedIn > 0 ? Math.max(0, balance - returned - carriedOut) : 0;
  return { given, carriedIn, spent, funded, returned, carriedOut, balance, left };
}

/** Tiền thừa người đi chợ còn cầm (chưa trả chủ, chưa chuyển sang phiếu sau). */
export const noteLeftover = (note, payments = []) => noteMoney(note, payments).left;

/** Các phiếu từ ngày `since` (YYYY-MM-DD, giờ VN) còn tiền thừa chưa trả chủ, cũ nhất trước. */
export function openLeftovers(notes, payments, since) {
  const from = since ? Date.parse(`${since}T00:00:00+07:00`) : 0;
  return notes.filter(n => Date.parse(n.created_at) >= from)
    .map(n => ({ note_id: n.id, created_at: n.created_at, writer: n.staff?.full_name || '', staff_id: n.staff_id, left: noteLeftover(n, payments) }))
    .filter(l => l.left > 0)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/**
 * Gán nguồn tiền cho từng khoản trả nợ: lần lượt dùng các nguồn (tiền thừa phiếu
 * trước, rồi tiền của phiếu mới = id null). pays: [{ key, amount }], sources:
 * [{ id, left }] (id null = phiếu mới, không giới hạn). Trả về [{ key, amount, from_note_id }].
 */
export function fundDebtPayments(pays, sources) {
  const pool = sources.map(s => ({ id: s.id ?? null, left: s.id ? Math.max(0, Number(s.left) || 0) : Infinity }));
  if (!pool.some(s => s.id === null)) pool.push({ id: null, left: Infinity });
  const out = [];
  for (const p of pays) {
    let need = Math.max(0, Math.round(Number(p.amount) || 0));
    for (const s of pool) {
      if (need <= 0) break;
      if (s.left <= 0) continue;
      const take = Math.min(need, s.left);
      out.push({ key: p.key, amount: take, from_note_id: s.id });
      s.left -= take; need -= take;
    }
  }
  return out;
}
