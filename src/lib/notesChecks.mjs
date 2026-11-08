/**
 * Kiểm tra phiếu đi chợ (Sổ tay) để nhân viên khó khai gian — dùng chung cho trang Sổ tay,
 * máy chủ và báo cáo của chủ (Zalo, /thongke):
 *  - Giá cao bất thường: so với giá các lần mua trước của CÙNG mặt hàng (trung vị 5 lần gần nhất
 *    trong 45 ngày, cần ít nhất 2 lần). Cao hơn từ PRICE_ALERT_PCT% thì cảnh báo. Chỉ so dòng
 *    hàng chợ có giá; không so dòng gộp Tiền rau / Tiền gia vị và dòng Khác (xăng xe, sửa chữa…).
 *  - Ảnh: phiếu có hàng chợ (hàng ốc, rau, gia vị có giá) phải kèm ảnh hàng trên cân ở quán
 *    hoặc giấy ghi của mối. Phiếu chỉ có dòng Khác / chỉ trả nợ / chỉ ghi chữ thì không cần.
 *  - Bill từng dòng: mỗi dòng hàng ốc (dòng so giá) phải có ảnh bill của mối (item.bill_photo; một
 *    tờ bill dùng chung được cho nhiều dòng) hoặc lý do mối không đưa bill (item.no_bill — chủ thấy).
 *    Ảnh hàng trên cân chống khai thừa số ký / hàng không về quán; bill chống khai giá cao.
 */
import { itemKey, parsePrice } from './notesMath.mjs';

export const PRICE_ALERT_PCT = 15;
export const MAX_NOTE_PHOTOS = 3;
export const MAX_BILL_PHOTOS = 15;
const LOOKBACK_MS = 45 * 86400000;
const RECENT = 5;
const MIN_TIMES = 2;

const vnd = n => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const named = item => !!String(item?.name || '').trim();
const priced = item => named(item) && parsePrice(item.price) > 0;

/** Dòng hàng chợ (cần ảnh): có giá, không phải dòng Khác. */
export const isMarketLine = item => priced(item) && !item.category;
export const needsTripPhoto = items => (Array.isArray(items) ? items : []).some(isMarketLine);
/** Dòng so được giá với các lần mua trước. */
export const comparableLine = item => isMarketLine(item) && !item.preset;
/** Dòng hàng ốc cần bill của mối. */
export const needsBill = comparableLine;
export const noBillReason = item => String(item?.no_bill || '').trim();
/** Dòng cần bill mà chưa có ảnh bill, cũ hay vừa chụp (billed(item)), cũng chưa ghi lý do. */
export const missingBills = (items, billed = () => false) =>
  (Array.isArray(items) ? items : []).filter(i => needsBill(i) && !i.bill_photo && !billed(i) && !noBillReason(i));
export const noBillText = item => `Không có bill: ${noBillReason(item)}`;

function noteItems(note) {
  if (note?.note_type !== 'expense') return [];
  try {
    const data = typeof note.content === 'string' ? JSON.parse(note.content) : note.content;
    return data?.type === 'structured_expense' && Array.isArray(data.items) ? data.items : [];
  } catch { return []; }
}

/** Giá các lần mua theo mặt hàng: Map(tên đã bỏ dấu → [{ price, at, noteId }] cũ → mới). */
export function purchasePrices(notes) {
  const prices = new Map();
  for (const note of notes || []) {
    const at = Date.parse(note?.created_at);
    if (!Number.isFinite(at)) continue;
    for (const item of noteItems(note)) {
      if (!comparableLine(item)) continue;
      const key = itemKey(item.name);
      prices.set(key, [...(prices.get(key) || []), { price: parsePrice(item.price), at, noteId: note.id }]);
    }
  }
  for (const list of prices.values()) list.sort((a, b) => a.at - b.at);
  return prices;
}

/** Giá thường mua trước thời điểm before (bỏ chính phiếu noteId); null nếu chưa đủ lần mua. */
export function usualPrice(prices, name, { before = Date.now(), noteId = null } = {}) {
  const list = (prices?.get(itemKey(name)) || [])
    .filter(p => p.at < before && p.at >= before - LOOKBACK_MS && p.noteId !== noteId)
    .slice(-RECENT).map(p => p.price).sort((a, b) => a - b);
  if (list.length < MIN_TIMES) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
}

/** { price, usual, pct } nếu dòng ghi giá cao hơn giá thường từ PRICE_ALERT_PCT%, không thì null. */
export function priceAlert(item, prices, opts) {
  if (!comparableLine(item)) return null;
  const usual = usualPrice(prices, item.name, opts);
  if (!usual) return null;
  const price = parsePrice(item.price);
  const pct = Math.round((price / usual - 1) * 100);
  return pct >= PRICE_ALERT_PCT ? { price, usual, pct } : null;
}

export const priceAlertText = alert => `Giá cao hơn thường ${alert.pct}% (thường ${vnd(alert.usual)})`;

/** Cảnh báo giá của một phiếu đã lưu: so với các phiếu ghi trước nó. */
export const notePriceAlert = (note, prices) => item => priceAlert(item, prices, { before: Date.parse(note?.created_at), noteId: note?.id });
