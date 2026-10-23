/**
 * Tin Zalo "Sổ tay của ngày" gửi kèm báo cáo Sổ thu chi: từng phiếu, từng món
 * (trả / nợ / đã trả bớt / còn nợ), dư hoặc thiếu so với tiền chủ đưa, lịch sử
 * sửa trong ngày, từng lần trả nợ, phiếu ngày khác bị sửa / xoá trong ngày, và
 * còn nợ theo chủ nợ. Mỗi tin Zalo tối đa ~2.000 ký tự → chia nhiều tin.
 */
import { lineWarnings, noteTotals, parsePrice, parseQty } from './notesMath.mjs';
import { notesSummary } from './notesSummary.mjs';

export const ZALO_TEXT_LIMIT = 1900;
const vnd = n => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const vnIso = iso => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString();
const clock = iso => vnIso(iso).slice(11, 16);
const dayMonth = iso => { const d = vnIso(iso); return `${d.slice(8, 10)}/${d.slice(5, 7)}`; };
const readContent = content => { try { const d = JSON.parse(content); return d && typeof d === 'object' ? d : null; } catch { return null; } };
const TYPE_LABEL = { stock: '📦 Báo thiếu', repair: '🔧 Sửa chữa', other: '📝 Ghi chú' };
const named = items => (items || []).filter(i => String(i?.name || '').trim());
const lineTotal = item => Math.round(parsePrice(item.price) * parseQty(item.qty));
const debtBase = item => {
  const total = lineTotal(item);
  const owed = item.paymentStatus === 'debt' || Number(item.paid_amount) > 0;
  if (!owed) return 0;
  return String(item.debtAmount || '').trim() ? Math.min(parsePrice(String(item.debtAmount).replace(/\./g, '')) || total, total) : total;
};
// Lịch sử Sổ tay ghi "HH:mm dd/mm/yyyy" → có thuộc ngày date (YYYY-MM-DD) không.
const historyOnDay = (ts, date) => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(ts || ''));
  return !!m && `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` === date;
};
const historyClock = ts => /(\d{1,2}:\d{2})/.exec(String(ts || ''))?.[1] || '';

/** Một món: "• Mực 1,5kg × 200k = 300.000đ — nợ Chị Lan 300.000đ, đã trả 100.000đ, còn 200.000đ" */
function itemLine(item) {
  const total = lineTotal(item);
  const qty = String(item.qty || '').trim();
  const head = `• ${item.name}${qty ? ` ${qty}` : ''}${item.price ? ` × ${item.price}` : ''} = ${vnd(total)}`;
  const base = debtBase(item);
  if (!base) return `${head} — trả đủ`;
  const who = String(item.creditor || '').trim();
  const paidLater = Math.min(base, Number(item.paid_amount) || 0);
  const parts = [];
  if (base < total) parts.push(`trả ngay ${vnd(total - base)}`);
  parts.push(`nợ${who ? ` ${who}` : ''} ${vnd(base)}`);
  if (paidLater >= base) parts.push('đã trả hết nợ');
  else if (paidLater > 0) parts.push(`đã trả ${vnd(paidLater)}, còn ${vnd(base - paidLater)}`);
  return `${head} — ${parts.join(', ')}`;
}

function noteBlock(note, index, ctx) {
  const data = readContent(note.content);
  const who = note.staff?.full_name || ctx.staffName(note.staff_id) || 'Không rõ';
  if (note.note_type !== 'expense' || data?.type !== 'structured_expense') {
    const text = String(data?.note ?? note.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return [`${index}. ${clock(note.created_at)} · ${who} · ${TYPE_LABEL[note.note_type] || '🛒 Chi tiền'}`, text ? `   ${text}` : null,
      (Number(note.amount) || Number(note.debt)) ? `   Tiền ${vnd((Number(note.amount) || 0) + (Number(note.debt) || 0))}` : null].filter(Boolean);
  }
  const items = named(data.items).filter(i => lineTotal(i) || String(i.price || '').trim());
  const given = Number(data.input_amount) || 0;
  const lines = [`${index}. ${clock(note.created_at)} · ${who}${given ? ` · chủ đưa ${vnd(given)}` : ''}`];
  for (const item of items) {
    lines.push(itemLine(item));
    for (const w of lineWarnings(item)) lines.push(`  ⚠ ${w}`);
  }
  const saved = (Number(note.amount) || 0) + (Number(note.debt) || 0);
  const paidNow = Number(note.amount) || 0;
  const funded = ctx.fundedBy.get(note.id) || 0;
  lines.push(`→ Tiền hàng ${vnd(saved)} · trả ngay ${vnd(paidNow)}${note.debt ? ` · nợ ${vnd(note.debt)}` : ''}${funded ? ` · trả nợ cũ ${vnd(funded)}` : ''}`);
  if (given) {
    const left = given - paidNow - funded;
    lines.push(`→ Chủ đưa ${vnd(given)} − đã chi ${vnd(paidNow + funded)} = ${left >= 0 ? `dư ${vnd(left)} (trả lại chủ)` : `thiếu ${vnd(-left)} (người đi chợ bỏ thêm)`}`);
  }
  const t = noteTotals(named(data.items));
  if (Math.abs(saved - t.total) >= 1000) lines.push(`⚠ Phiếu lệch tiền: tổng ghi ${vnd(saved)} nhưng các món cộng lại ${vnd(t.total)}`);
  const text = String(data.note || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  if (text) lines.push(`   Ghi chú: ${text.slice(0, 200)}`);
  const edits = (data.history || []).filter(h => historyOnDay(h.ts, ctx.date));
  for (const h of edits) lines.push(`   ✎ ${historyClock(h.ts)} ${h.by || ''}: ${String(h.changes || '').replace(/\n+/g, '; ')}`);
  return lines;
}

/**
 * dayNotes: phiếu ghi trong ngày; allNotes: mọi phiếu tới hết ngày (để tính nợ, tìm phiếu
 * được sửa); payments: staff_note_payments; deleted: phiếu bị xoá trong ngày (nhật ký:
 * { changed_at, old_row, staff_id }); staffNames: { id: tên }; range: { start, end } (Date).
 */
export function notesReportMessages({ date, dayNotes = [], allNotes = [], payments = [], deleted = [], staffNames = {}, range }) {
  const [y, m, d] = date.split('-');
  const weekday = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  const head = `🛒 Sổ tay · ${weekday} ${d}/${m}/${y}`;
  const inDay = iso => { const t = new Date(iso).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); };
  const fundedBy = new Map();
  for (const p of payments) if (p.paid_from_note_id) fundedBy.set(p.paid_from_note_id, (fundedBy.get(p.paid_from_note_id) || 0) + Number(p.amount || 0));
  const ctx = { date, fundedBy, staffName: id => staffNames[id] };
  const byId = new Map(allNotes.map(n => [n.id, n]));
  const sorted = [...dayNotes].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const s = notesSummary(allNotes, payments, range);

  // 1. Tổng của ngày.
  const newDebt = sorted.reduce((a, n) => a + (Number(n.debt) || 0), 0);
  const summary = [`${head} · ${sorted.length} phiếu`,
    ...(s.hasGiven ? [`Chủ đưa: ${vnd(s.given)}`] : []),
    `Tiền hàng: ${vnd(s.goods)} (trả ngay ${vnd(s.cashNow)}, nợ mới ${vnd(newDebt)})`,
    ...(s.debtPaid ? [`Trả nợ trong ngày: ${vnd(s.debtPaid)}`] : []),
    `Chi tiền mặt: ${vnd(s.cash)}`,
    ...(s.hasGiven ? [s.giveBack >= 0 ? `Dư trả lại chủ: ${vnd(s.giveBack)}` : `Thiếu (bỏ thêm): ${vnd(-s.giveBack)}`] : []),
    `Còn nợ tất cả: ${vnd(s.debtLeft)}`].join('\n');
  const blocks = [summary];

  // 2–3. Từng phiếu của ngày.
  if (!sorted.length) blocks.push('Không có phiếu Sổ tay nào ghi trong ngày.');
  sorted.forEach((n, i) => blocks.push(noteBlock(n, i + 1, ctx).join('\n')));

  // 4. Từng lần trả nợ trong ngày.
  const paidToday = payments.filter(p => inDay(p.paid_at)).sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
  if (paidToday.length) {
    blocks.push(['💰 Trả nợ trong ngày:', ...paidToday.map(p => {
      const note = byId.get(p.note_id);
      const item = p.item_index !== null && p.item_index !== undefined ? readContent(note?.content)?.items?.[p.item_index] || null : null;
      const creditor = String(item?.creditor || '').trim();
      return `• ${clock(p.paid_at)} ${vnd(p.amount)}${item ? ` cho ${item.name}` : ''}${creditor ? ` (${creditor})` : ''}${note ? ` — phiếu ${dayMonth(note.created_at)}` : ''}${p.paid_from_note_id ? ' — lấy từ tiền đi chợ' : ''}${p.created_by_name ? ` · ${p.created_by_name}` : ''}`;
    })].join('\n'));
  }

  // 5. Phiếu của ngày khác bị sửa / xoá trong ngày.
  const dayIds = new Set(sorted.map(n => n.id));
  const editedOld = allNotes.filter(n => !dayIds.has(n.id)).map(n => ({ n, edits: (readContent(n.content)?.history || []).filter(h => historyOnDay(h.ts, date) && !/^💰/.test(String(h.changes || ''))) }))
    .filter(x => x.edits.length);
  if (editedOld.length || deleted.length) {
    const lines = ['✎ Phiếu ngày khác bị sửa / xoá hôm nay:'];
    for (const { n, edits } of editedOld) {
      for (const h of edits) lines.push(`• Phiếu ${dayMonth(n.created_at)} (${n.staff?.full_name || staffNames[n.staff_id] || 'Không rõ'}) — ${historyClock(h.ts)} ${h.by || ''}: ${String(h.changes || '').replace(/\n+/g, '; ')}`);
    }
    for (const row of deleted) {
      const old = row.old_row || {};
      const total = (Number(old.amount) || 0) + (Number(old.debt) || 0);
      lines.push(`• ${clock(row.changed_at)} XOÁ phiếu ${old.created_at ? dayMonth(old.created_at) : '?'} của ${staffNames[old.staff_id] || 'Không rõ'}${total ? ` (${vnd(total)})` : ''}${row.staff_id ? ` — người xoá: ${staffNames[row.staff_id] || 'Không rõ'}` : ''}`);
    }
    blocks.push(lines.join('\n'));
  }

  // 6. Còn nợ theo chủ nợ (từng món, từ ngày nào).
  const owed = [];
  for (const n of allNotes) {
    for (const item of named(readContent(n.content)?.items)) {
      const left = debtBase(item) - Math.min(debtBase(item), Number(item.paid_amount) || 0);
      if (left > 0) owed.push({ who: String(item.creditor || '').trim() || 'Không ghi tên', what: item.name, left, at: n.created_at });
    }
  }
  if (owed.length) {
    const byWho = new Map();
    for (const o of owed) byWho.set(o.who, [...(byWho.get(o.who) || []), o]);
    blocks.push(['📋 Còn nợ:', ...[...byWho.entries()].sort((a, b) => b[1].reduce((x, o) => x + o.left, 0) - a[1].reduce((x, o) => x + o.left, 0)).map(([who, list]) =>
      `• ${who}: ${vnd(list.reduce((x, o) => x + o.left, 0))} — ${list.slice(0, 6).map(o => `${o.what} ${vnd(o.left)} (${dayMonth(o.at)})`).join(', ')}${list.length > 6 ? `, +${list.length - 6} món` : ''}`)].join('\n'));
  }

  return packMessages(head, blocks);
}

/** Ghép các khối chữ thành các tin dưới giới hạn của Zalo (khối quá dài thì cắt bớt). */
export function packMessages(head, blocks) {
  const messages = [];
  let current = '';
  for (const raw of blocks.filter(Boolean)) {
    const block = raw.length > ZALO_TEXT_LIMIT - 40 ? `${raw.slice(0, ZALO_TEXT_LIMIT - 60)}\n…(xem đủ trên web)` : raw;
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > ZALO_TEXT_LIMIT) { messages.push(current); current = `${head} (tiếp)\n\n${block}`; }
    else current = next;
  }
  if (current) messages.push(current);
  return messages;
}
