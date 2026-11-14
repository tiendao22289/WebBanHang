import { isChoiceOff, isDishOff } from './menuAvailability.mjs';

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

// ── Giỏ của KHÁCH ở trang gọi món (order/page.jsx) ─────────────────────────────
// Máy chủ (submit_customer_order_menu_check.sql) đối chiếu từng dòng với thực đơn theo đúng các quy tắc
// dưới đây; đổi ở đây thì phải đổi ở SQL.

const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const hasPrice = p => p !== null && p !== undefined && p !== '' && Number.isFinite(Number(p));

/** Các lựa chọn đang bán của 1 nhóm lựa chọn (bỏ lựa chọn trống / đang tắt), giữ thứ tự thực đơn. */
export function openChoices(opt, now = Date.now()) {
  return (Array.isArray(opt?.choices) ? opt.choices : []).filter((c, i) => c && !isChoiceOff(opt.hiddenChoices?.[i], now));
}

// ── Bảng chọn lựa chọn của món (món thường và món quà "8 tặng 1" dùng chung) ──

/** Nhóm chọn nhiều (khẩu vị / thêm / topping) — giữ MẢNG lựa chọn; nhóm khác (LOẠI…) chọn 1. */
export function isMultiOption(opt) {
  const name = String(opt?.name || '').toLowerCase();
  return name.includes('khẩu vị') || name.includes('thêm') || name.includes('topping');
}

/**
 * Lựa chọn lúc mở bảng: nhóm chọn 1 → lựa chọn đang bán đầu tiên ('' nếu tắt hết), nhóm chọn nhiều → [].
 * Trước đây bảng chọn QUÀ đặt sẵn KHẨU VỊ bằng chữ ("Bình Thường") thay vì mảng: khách bấm thêm
 * khẩu vị thì chữ bị tách thành từng ký tự ("B, ì, n, h, …, Làm Cay") và máy chủ báo quà "đã hết".
 */
export function initialOptionSelection(options, now = Date.now()) {
  const selected = {};
  for (const opt of Array.isArray(options) ? options : []) {
    if (!opt?.name || !Array.isArray(opt.choices) || opt.choices.length === 0) continue;
    selected[opt.name] = isMultiOption(opt) ? [] : (openChoices(opt, now)[0] ?? '');
  }
  return selected;
}

/** Các lựa chọn đang tick của 1 nhóm chọn nhiều (giá trị cũ dạng chữ coi như 1 lựa chọn). */
export function multiChoices(value) {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value ? [value] : [];
}

/** Bấm 1 ô của nhóm chọn nhiều: tick / bỏ tick lựa chọn đó → mảng mới. */
export function toggleMultiChoice(value, choice) {
  const list = multiChoices(value);
  return list.includes(choice) ? list.filter(c => c !== choice) : [...list, choice];
}

/** Lựa chọn trong bảng → item_options gửi máy chủ: [{ name, choice }], nhóm chọn nhiều ghép ", ". */
export function selectionToItemOptions(selected) {
  return Object.keys(selected || {}).map(name => {
    const value = selected[name];
    const choice = Array.isArray(value) ? value.join(', ') : value;
    return choice ? { name, choice } : null;
  }).filter(Boolean);
}

/**
 * Giá 1 phần của món với các lựa chọn đã chọn ([{ name, choice }], nhiều lựa chọn 1 nhóm ghép ", ").
 * Có lựa chọn đặt giá → tổng giá các lựa chọn đó, không thì giá món (như computeModalPrice).
 * → { price, off } — off: lựa chọn đang tắt / không còn trong thực đơn (null = còn bán).
 */
export function menuLinePrice(item, itemOptions, now = Date.now()) {
  let sum = 0, priced = false;
  for (const sel of Array.isArray(itemOptions) ? itemOptions : []) {
    const choice = sel?.choice;
    if (choice == null || choice === '') continue;
    const opt = (item?.options || []).find(o => o?.name === sel.name && Array.isArray(o.choices));
    if (!opt) return { price: null, off: String(choice) };
    // Tách chuỗi ghép theo tên lựa chọn có thật (dài trước), để tên có dấu phẩy vẫn khớp.
    const known = opt.choices.filter(c => typeof c === 'string' && c).sort((a, b) => b.length - a.length);
    let rest = String(choice);
    while (rest) {
      const part = known.find(c => rest === c || rest.startsWith(`${c}, `));
      if (part === undefined) return { price: null, off: rest.split(', ')[0] };
      const i = opt.choices.indexOf(part);
      if (isChoiceOff(opt.hiddenChoices?.[i], now)) return { price: null, off: part };
      if (hasPrice(opt.prices?.[i])) { sum += Number(opt.prices[i]); priced = true; }
      rest = rest === part ? '' : rest.slice(part.length + 2);
    }
  }
  return { price: priced ? sum : Number(item?.price || 0), off: null };
}

/**
 * Giỏ lưu trên máy (dạng nén của saveSession) → giỏ theo thực đơn đang bán: bỏ món / lựa chọn đã tắt,
 * giá lấy lại từ thực đơn. menuItems: món vừa tải (kể cả món đang ẩn tạm, để biết tên món bị bỏ).
 * → { cart, dropped: [tên], repriced: [tên] }
 */
export function refreshSavedCart(saved, menuItems, now = Date.now()) {
  const cart = [], dropped = [], repriced = [];
  for (const c of Array.isArray(saved) ? saved : []) {
    const item = (menuItems || []).find(m => m.id === c.id || m.id === c.i);
    const options = c._options || c.po;
    const line = item && !isDishOff(item, now) ? menuLinePrice(item, options, now) : null;
    if (!line || line.off) { dropped.push(item?.name || 'Một món'); continue; }
    const oldPrice = c.price !== undefined ? c.price : c.p;
    if (oldPrice !== undefined && Number(oldPrice) !== line.price) repriced.push(item.name);
    cart.push({
      ...item,
      quantity: c.quantity || c.q || 1,
      _optionKey: c._optionKey || c.pk,
      _options: options,
      _note: c._note || c.pn,
      price: line.price,
    });
  }
  return { cart, dropped, repriced };
}

/** Giỏ + quà chọn → các dòng gửi submit_customer_order_atomic (thứ tự: giỏ rồi quà, như máy chủ đánh số). */
export function customerOrderLines(cart, gifts, notes = {}) {
  return [
    ...(cart || []).map(item => ({
      menu_item_id: item.id,
      quantity: item.quantity,
      unit_price: item.price,
      item_options: item._options || [],
      note: item._note || notes[item.id] || null,
      is_gift: false,
    })),
    ...(gifts || []).map(g => ({
      menu_item_id: g.id,
      quantity: 1,
      unit_price: 0,
      item_options: g._options || [],
      note: g._note || null,
      is_gift: true,
    })),
  ];
}

/**
 * Máy chủ từ chối đơn ({ rejected, lines: [{ index, problem: off|price|gift, name, price, choice }] }):
 * bỏ món / lựa chọn đã tắt và quà không đủ suất, cập nhật giá mới → { cart, gifts, message } cho khách
 * xem lại giỏ rồi gửi lại.
 */
export function applyOrderRefusal(cart, gifts, lines) {
  const byIndex = new Map((lines || []).map(l => [Number(l.index), l]));
  const off = [], repriced = [], giftOff = [];
  const label = (l, fallback) => `${l.name || fallback || 'Món'}${l.choice ? ` · ${l.choice}` : ''}`;
  const nextCart = [];
  (cart || []).forEach((c, i) => {
    const l = byIndex.get(i);
    if (l?.problem === 'off' || l?.problem === 'gift') { off.push(label(l, c.name)); return; }
    if (l?.problem === 'price' && Number.isFinite(Number(l.price))) {
      repriced.push(`${l.name || c.name} ${money(l.price)}`);
      nextCart.push({ ...c, price: Number(l.price) });
      return;
    }
    nextCart.push(c);
  });
  const nextGifts = (gifts || []).filter((g, i) => {
    const l = byIndex.get((cart || []).length + i);
    if (!l) return true;
    (l.problem === 'off' ? off : giftOff).push(label(l, g.name));
    return false;
  });
  const list = names => [...new Set(names)].join(', ');
  const parts = [];
  if (off.length) parts.push(`Món đã hết / tạm ngưng nên quán đã bỏ khỏi giỏ: ${list(off)}.`);
  if (giftOff.length) parts.push(`Quà tặng chưa đủ điều kiện nên quán đã bỏ khỏi giỏ: ${list(giftOff)}.`);
  if (repriced.length) parts.push(`Giá đã cập nhật theo thực đơn mới: ${list(repriced)}.`);
  if (!parts.length) parts.push('Thực đơn vừa thay đổi.');
  parts.push('Quý khách xem lại giỏ hàng rồi bấm Gửi đơn nhé.');
  return { cart: nextCart, gifts: nextGifts, message: parts.join('\n') };
}

/**
 * Đơn trước (mất phản hồi) hoá ra ĐÃ vào quán: bớt khỏi giỏ đúng phần đã gửi (cùng món, lựa chọn,
 * ghi chú), giữ phần khách thêm sau đó. sent: các dòng của lần gửi trước (customerOrderLines).
 * → { cart, gifts }
 */
export function cartAfterSentOrder(cart, gifts, sent, notes = {}) {
  const key = l => JSON.stringify([l.menu_item_id, l.item_options || [], l.note || null, !!l.is_gift]);
  const left = new Map();
  for (const s of sent || []) left.set(key(s), (left.get(key(s)) || 0) + (Number(s.quantity) || 0));
  const take = (line, qty) => {
    const k = key(line);
    const n = Math.min(left.get(k) || 0, qty);
    left.set(k, (left.get(k) || 0) - n);
    return n;
  };
  const lines = customerOrderLines(cart, gifts, notes);
  const nextCart = (cart || []).map((c, i) => {
    const sentQty = take(lines[i], c.quantity);
    return sentQty >= c.quantity ? null : { ...c, quantity: c.quantity - sentQty };
  }).filter(Boolean);
  const nextGifts = (gifts || []).filter((g, i) => !take(lines[(cart || []).length + i], 1));
  return { cart: nextCart, gifts: nextGifts };
}
