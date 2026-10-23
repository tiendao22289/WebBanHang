/**
 * Ô thống kê trang Sổ tay theo khoảng ngày đang lọc (tách khỏi giao diện để test được).
 */
import { parsePrice, parseQty } from './notesMath.mjs';

/** Khoảng thời gian của bộ lọc Ngày / Tháng / Năm theo giờ trên máy (null = tất cả). */
export function filterRange(day, month, year) {
  const now = new Date();
  const y = parseInt(year) || (day || month ? now.getFullYear() : null);
  if (!y) return null;
  if (day) {
    const m = (parseInt(month) || now.getMonth() + 1) - 1;
    return { start: new Date(y, m, parseInt(day)), end: new Date(y, m, parseInt(day) + 1) };
  }
  if (month) return { start: new Date(y, parseInt(month) - 1, 1), end: new Date(y, parseInt(month), 1) };
  return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
}

const inRange = (iso, range) => {
  if (!range) return true;
  const t = new Date(iso).getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
};
const readContent = content => { try { const d = JSON.parse(content); return d && typeof d === 'object' ? d : null; } catch { return null; } };

/**
 * notes: phiếu đã lọc theo nhân viên (mọi ngày); payments: các lần trả nợ.
 * Trả về số cho các ô:
 *  given     — Chủ đưa (tiền được giao, phiếu trong khoảng)
 *  goods     — Tiền hàng (trả ngay + mua nợ, khớp Sổ thu chi)
 *  cash      — Chi tiền mặt: trả ngay lúc mua + tiền trả nợ trong khoảng
 *  debtPaid  — phần trả nợ trong khoảng (đã gồm trong cash)
 *  giveBack  — Trả lại chủ: tiền giao − trả ngay − trả nợ lấy từ tiền phiếu đó
 *  debtLeft  — Còn nợ tính tới cuối khoảng (cả nợ cũ), creditors: theo chủ nợ (hiện tại)
 */
export function notesSummary(notes, payments, range) {
  const ids = new Set(notes.map(n => n.id));
  const pays = (payments || []).filter(p => ids.has(p.note_id));
  const paidById = new Map();
  for (const p of pays) paidById.set(p.note_id, (paidById.get(p.note_id) || 0) + Number(p.amount || 0));
  // Trả nợ trước khi có sổ trả nợ: không biết ngày → tính vào ngày ghi phiếu.
  const legacy = n => Math.max(0, (Number(n.paid_debt) || 0) - (paidById.get(n.id) || 0));
  const end = range ? range.end.getTime() : Infinity;
  const sum = { given: 0, goods: 0, cashNow: 0, debtPaid: 0, giveBack: 0, hasGiven: false, debtLeft: 0, creditors: {} };
  const fundedBy = new Map();
  for (const p of pays) if (p.paid_from_note_id) fundedBy.set(p.paid_from_note_id, (fundedBy.get(p.paid_from_note_id) || 0) + Number(p.amount || 0));
  for (const n of notes) {
    const created = new Date(n.created_at).getTime();
    if (inRange(n.created_at, range)) {
      const data = n.note_type === 'expense' ? readContent(n.content) : null;
      const given = Number(data?.input_amount) || 0;
      sum.goods += (Number(n.amount) || 0) + (Number(n.debt) || 0);
      sum.cashNow += Number(n.amount) || 0;
      sum.debtPaid += legacy(n);
      if (given > 0) {
        sum.hasGiven = true;
        sum.given += given;
        sum.giveBack += given - (Number(n.amount) || 0) - (fundedBy.get(n.id) || 0);
      }
    }
    if (created < end) {
      const paidBefore = pays.filter(p => p.note_id === n.id && new Date(p.paid_at).getTime() < end).reduce((a, p) => a + Number(p.amount || 0), 0);
      sum.debtLeft += Math.max(0, (Number(n.debt) || 0) - paidBefore - legacy(n));
    }
  }
  for (const p of pays) if (inRange(p.paid_at, range)) sum.debtPaid += Number(p.amount || 0);
  // Còn nợ theo từng chủ nợ (số hiện tại, theo các dòng hàng).
  if (!range || range.end.getTime() > Date.now()) {
    for (const n of notes) {
      const data = readContent(n.content);
      for (const item of data?.items || []) {
        if (!String(item?.name || '').trim()) continue;
        const wasDebt = item.paymentStatus === 'debt' || Number(item.paid_amount) > 0;
        if (!wasDebt) continue;
        const line = Math.round(parsePrice(item.price) * parseQty(item.qty));
        const base = String(item.debtAmount || '').trim() ? Math.min(parsePrice(String(item.debtAmount).replace(/\./g, '')) || line, line) : line;
        const left = base - (Number(item.paid_amount) || 0);
        if (left > 0) { const who = String(item.creditor || '').trim() || 'Không ghi tên'; sum.creditors[who] = (sum.creditors[who] || 0) + left; }
      }
    }
  }
  return { ...sum, cash: sum.cashNow + sum.debtPaid };
}
