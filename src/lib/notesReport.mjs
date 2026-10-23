/**
 * Tin Zalo "Sổ tay của ngày" gửi kèm báo cáo Sổ thu chi buổi sáng.
 * Mỗi tin Zalo tối đa ~2.000 ký tự → chia thành nhiều tin theo từng phiếu.
 */
import { lineWarnings, noteTotals, parsePrice, parseQty } from './notesMath.mjs';
import { notesSummary } from './notesSummary.mjs';

export const ZALO_TEXT_LIMIT = 1900;
const vnd = n => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const clock = iso => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(11, 16);
const readContent = content => { try { const d = JSON.parse(content); return d && typeof d === 'object' ? d : null; } catch { return null; } };
const TYPE_LABEL = { stock: '📦 Báo thiếu', repair: '🔧 Sửa chữa', other: '📝 Ghi chú' };

/** Các dòng chữ của một phiếu. */
function noteBlock(note, index, fundedBy) {
  const data = readContent(note.content);
  const who = note.staff?.full_name || 'Không rõ';
  if (note.note_type !== 'expense' || data?.type !== 'structured_expense') {
    const text = String(data?.note ?? note.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return [`${index}. ${clock(note.created_at)} · ${who} · ${TYPE_LABEL[note.note_type] || '🛒 Chi tiền'}`, text ? `   ${text}` : null,
      (Number(note.amount) || Number(note.debt)) ? `   Tiền ${vnd((Number(note.amount) || 0) + (Number(note.debt) || 0))}` : null].filter(Boolean);
  }
  const items = (data.items || []).filter(i => String(i?.name || '').trim());
  const given = Number(data.input_amount) || 0;
  const lines = [`${index}. ${clock(note.created_at)} · ${who}${given ? ` · chủ đưa ${vnd(given)}` : ''}`];
  for (const item of items) {
    const total = Math.round(parsePrice(item.price) * parseQty(item.qty));
    if (!total && !String(item.price || '').trim()) continue; // dòng mẫu chưa điền giá ("Tiền rau")
    const owed = item.paymentStatus === 'debt' || Number(item.paid_amount) > 0;
    const qty = String(item.qty || '').trim();
    lines.push(`• ${item.name}${qty ? ` ${qty}` : ''}${item.price ? ` × ${item.price}` : ''} = ${vnd(total)}${owed ? ` (nợ${item.creditor ? ` ${item.creditor}` : ''})` : ''}`);
    for (const w of lineWarnings(item)) lines.push(`  ⚠ ${w}`);
  }
  const t = noteTotals(items);
  const saved = (Number(note.amount) || 0) + (Number(note.debt) || 0);
  const paidNow = Number(note.amount) || 0;
  const giveBack = given - paidNow - (fundedBy.get(note.id) || 0);
  lines.push(`→ Tiền hàng ${vnd(saved)} · trả ${vnd(paidNow)}${note.debt ? ` · nợ ${vnd(note.debt)}` : ''}${given ? ` · ${giveBack >= 0 ? 'trả lại chủ' : 'bỏ thêm'} ${vnd(Math.abs(giveBack))}` : ''}`);
  if (items.length && Math.abs(saved - t.total) >= 1000) lines.push(`⚠ Phiếu lệch tiền: các dòng cộng lại ${vnd(t.total)}`);
  const text = String(data.note || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  if (text) lines.push(`   Ghi chú: ${text.slice(0, 120)}`);
  return lines;
}

/**
 * dayNotes: phiếu ghi trong ngày (kèm staff.full_name); allNotes: mọi phiếu (để tính còn nợ);
 * payments: staff_note_payments; range: { start, end } của ngày (Date).
 */
export function notesReportMessages({ date, dayNotes = [], allNotes = [], payments = [], range }) {
  const [y, m, d] = date.split('-');
  const weekday = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  const head = `🛒 Sổ tay · ${weekday} ${d}/${m}/${y}`;
  const fundedBy = new Map();
  for (const p of payments) if (p.paid_from_note_id) fundedBy.set(p.paid_from_note_id, (fundedBy.get(p.paid_from_note_id) || 0) + Number(p.amount || 0));
  const sorted = [...dayNotes].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const s = notesSummary(allNotes, payments, range);
  const paidToday = payments.filter(p => { const t = new Date(p.paid_at).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); });
  const footer = [
    '',
    `Tổng: tiền hàng ${vnd(s.goods)} · chi tiền mặt ${vnd(s.cash)}${s.debtPaid ? ` (gồm ${vnd(s.debtPaid)} trả nợ)` : ''}`,
    ...(s.hasGiven ? [`Chủ đưa ${vnd(s.given)} · ${s.giveBack >= 0 ? 'trả lại chủ' : 'bỏ thêm'} ${vnd(Math.abs(s.giveBack))}`] : []),
    ...(paidToday.length ? [`Trả nợ trong ngày: ${paidToday.map(p => vnd(p.amount)).join(', ')}`] : []),
    `Còn nợ (tất cả): ${vnd(s.debtLeft)}${Object.keys(s.creditors).length ? ` — ${Object.entries(s.creditors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([who, left]) => `${who} ${vnd(left)}`).join(', ')}` : ''}`,
  ];
  if (!sorted.length) return [`${head}\n\nKhông có phiếu Sổ tay nào trong ngày.${s.debtLeft ? `\n${footer.at(-1)}` : ''}`];

  const blocks = sorted.map((n, i) => noteBlock(n, i + 1, fundedBy).join('\n'));
  const messages = [];
  let current = `${head} (${sorted.length} phiếu)`;
  for (const block of blocks) {
    const piece = block.length > ZALO_TEXT_LIMIT - 60 ? `${block.slice(0, ZALO_TEXT_LIMIT - 80)}\n…(xem đủ trên web)` : block;
    if (`${current}\n\n${piece}`.length > ZALO_TEXT_LIMIT) { messages.push(current); current = `${head} (tiếp)`; }
    current += `\n\n${piece}`;
  }
  const tail = footer.join('\n');
  if (`${current}\n${tail}`.length > ZALO_TEXT_LIMIT) { messages.push(current); current = `${head} (tổng)`; }
  messages.push(`${current}\n${tail}`);
  return messages;
}
