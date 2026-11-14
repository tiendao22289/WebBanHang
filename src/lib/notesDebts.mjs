/**
 * Các khoản Sổ tay đang còn nợ — dùng chung cho trang Sổ tay (chọn khoản trả) và
 * máy chủ (kiểm tra số trả). Một khoản = một dòng hàng còn nợ; phiếu không có
 * dòng hàng (chỉ ghi số nợ) thì cả phiếu là một khoản (item_index = null).
 * item_id = mã _id của dòng: sửa phiếu (xoá / thêm dòng) đổi vị trí chứ không đổi mã.
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
    if (left > 0) lines.push({ ...base, item_index: index, item_id: item._id || null, name: item.name, creditor: String(item.creditor || '').trim(), left });
  });
  // Phiếu chỉ ghi số nợ (không có dòng hàng còn nợ) → trả theo cả phiếu.
  const noteLeft = (Number(note?.debt) || 0) - (Number(note?.paid_debt) || 0);
  if (!lines.length && noteLeft > 0) lines.push({ ...base, item_index: null, item_id: null, name: 'Nợ của phiếu', creditor: '', left: noteLeft });
  return lines;
}

/** Khoản trình duyệt chọn trả: theo mã dòng (_id); dòng cũ chưa có mã thì theo vị trí. */
export const findDebtLine = (lines, itemId, itemIndex) => lines.find(l => (itemId ? l.item_id === itemId : l.item_index === itemIndex));

/**
 * Vị trí dòng hàng đã nhận một lần trả nợ (staff_note_payments), -1 = không thấy dòng nào.
 * Lần trả mới ghi phiếu bỏ tiền (from_note_id) vào lịch sử trả của dòng → tìm theo đó, nên
 * sửa phiếu (xoá / thêm dòng phía trên) không làm lệch. Lần trả cũ chưa ghi phiếu bỏ tiền thì
 * dựa vào item_index, nhưng chỉ nhận dòng thật sự còn giữ số tiền đã trả ấy.
 */
export function paymentItemIndex(items, payment) {
  if (!Array.isArray(items) || payment?.item_index === null || payment?.item_index === undefined) return -1;
  const amount = Number(payment.amount) || 0, at = Number(payment.item_index);
  const from = payment.paid_from_note_id || null;
  const logs = item => (Array.isArray(item?.payment_logs) ? item.payment_logs.filter(l => l && typeof l === 'object') : []);
  const sum = (item, keep) => logs(item).filter(keep).reduce((a, l) => a + (Number(l.amount) || 0), 0);
  // Dòng còn giữ đủ số tiền đó; ưu tiên dòng giữ đúng số tiền, rồi dòng ở vị trí đã ghi.
  const pick = held => {
    const fits = items.map((item, i) => ({ i, net: held(item) })).filter(x => x.net >= amount);
    const best = list => list.find(x => x.i === at) || list[0];
    return (best(fits.filter(x => x.net === amount)) || best(fits))?.i ?? -1;
  };
  const tagged = pick(item => sum(item, l => 'from_note_id' in l && (l.from_note_id || null) === from));
  if (tagged >= 0) return tagged;
  // Lần trả cũ: lịch sử trả chưa có from_note_id (dòng không có lịch sử thì xem số đã trả).
  return pick(item => (logs(item).length ? sum(item, l => !('from_note_id' in l)) : Number(item?.paid_amount) || 0));
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
 * carriedOut (đã chuyển sang phiếu sau), offsetOut (tiền thừa giữ lại bù tiền người đi chợ
 * đã bỏ thêm ở phiếu khác — offset_out). balance = given + carriedIn − spent − funded
 * (âm = bỏ thêm); left = số người đi chợ còn cầm chưa trả chủ.
 * Phiếu âm: short = tiền người đi chợ bỏ thêm chưa được bù (chủ còn nợ), settled = đã bù
 * bằng tiền thừa phiếu khác (short_settled). Chủ quán chọn "trừ vào tiền thừa" (09/11/2026).
 */
export function noteMoney(note, payments = []) {
  const data = note?.note_type === 'expense' ? readContent(note.content) : null;
  const given = Number(data?.input_amount) || 0;
  const carriedIn = sumAmounts(data?.carried_in);
  const spent = Number(note?.amount) || 0;
  const funded = payments.filter(p => p.paid_from_note_id === note?.id).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const returned = sumAmounts(data?.returned_logs);
  const carriedOut = sumAmounts(data?.carried_out);
  const offsetOut = sumAmounts(data?.offset_out);
  const settled = sumAmounts(data?.short_settled);
  const balance = given + carriedIn - spent - funded;
  const hasMoney = given + carriedIn > 0;
  const left = hasMoney ? Math.max(0, balance - returned - carriedOut - offsetOut) : 0;
  const short = hasMoney ? Math.max(0, -balance - settled) : 0;
  return { given, carriedIn, spent, funded, returned, carriedOut, offsetOut, settled, balance, left, short };
}

/** Tiền người đi chợ bỏ thêm ở phiếu này chưa được bù (chủ còn nợ người đó). */
export const noteShortage = (note, payments = []) => noteMoney(note, payments).short;

/**
 * Các phiếu từ ngày `since` (giờ VN) người đi chợ bỏ thêm tiền chưa được bù, cũ nhất trước.
 * Bù bằng tiền thừa của chính người đó khi trả chủ (planOffsets).
 */
export function openShortages(notes, payments, since) {
  const from = since ? Date.parse(`${since}T00:00:00+07:00`) : 0;
  return notes.filter(n => Date.parse(n.created_at) >= from)
    .map(n => ({ note_id: n.id, created_at: n.created_at, writer: n.staff?.full_name || '', staff_id: n.staff_id, short: noteShortage(n, payments) }))
    .filter(l => l.short > 0)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/**
 * Trả chủ tiền thừa có trừ tiền bỏ thêm: sources = tiền thừa đem trả [{ id (null = phiếu đang ghi),
 * staff_id, amount }] (cũ trước), shortages = openShortages. Tiền thừa của ai chỉ bù cho phiếu
 * bỏ thêm của chính người đó, phiếu cũ nhất trước.
 * → { offsets: [{ from_note_id, to_note_id, amount }], returns: [{ id, staff_id, amount }] (số thật đưa chủ) }.
 */
export function planOffsets(sources, shortages) {
  const owed = shortages.map(s => ({ ...s, need: s.short }));
  const offsets = [], returns = [];
  for (const src of sources) {
    let amount = Math.max(0, Math.round(Number(src.amount) || 0));
    for (const s of owed) {
      if (amount <= 0) break;
      if (s.need <= 0 || s.staff_id !== src.staff_id) continue;
      const take = Math.min(amount, s.need);
      offsets.push({ from_note_id: src.id ?? null, to_note_id: s.note_id, amount: take });
      s.need -= take; amount -= take;
    }
    returns.push({ id: src.id ?? null, staff_id: src.staff_id, amount });
  }
  return { offsets, returns };
}

/**
 * "Còn phải đưa chủ" tính theo từng người: tiền thừa của ai chỉ trừ tiền bỏ thêm của chính người đó
 * (như planOffsets). leftovers = openLeftovers, shortages = openShortages.
 * → { held, short (tổng), toOwner (người đi chợ còn phải đưa chủ), owes (chủ còn nợ người đi chợ) }.
 */
export function handoverTotals(leftovers = [], shortages = []) {
  const by = new Map();
  const of = id => { if (!by.has(id)) by.set(id, { held: 0, short: 0 }); return by.get(id); };
  for (const l of leftovers) of(l.staff_id).held += Number(l.left) || 0;
  for (const s of shortages) of(s.staff_id).short += Number(s.short) || 0;
  const out = { held: 0, short: 0, toOwner: 0, owes: 0 };
  for (const p of by.values()) {
    out.held += p.held; out.short += p.short;
    out.toOwner += Math.max(0, p.held - p.short);
    out.owes += Math.max(0, p.short - p.held);
  }
  return out;
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
