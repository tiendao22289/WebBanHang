/**
 * Cách tính tiền một phiếu Sổ tay "Đi chợ / Chi tiền" — dùng chung cho trang
 * Sổ tay (hiện số khi gõ), máy chủ (tự tính lại khi lưu) và Sổ thu chi.
 *
 * Giá:  "250k" = 250.000 · "250.000" = 250.000 · "250000" = 250.000
 *       "1.200k" = 1.200.000 · "1,5k" = 1.500 · "1tr2" = 1.200.000 · "85k/kg" = 85.000
 *       "250" (không chữ k) = 250đ — ô giá tự thêm "k" cho số nhỏ khi bấm ra ngoài.
 * Số lượng: chỉ lấy số đầu tiên, dấu phẩy hay chấm đều là thập phân:
 *       "2,5kg" = 2,5 · "0,5" = 0,5 · "1/2" = 0,5 · "1 thùng 24 lon" = 1 (kèm cảnh báo)
 *       Bỏ trống = 1.
 */

// Số có dấu chấm/phẩy ngăn nghìn: 250.000 · 1,200,000
const GROUPED = /^\d{1,3}(?:[.,]\d{3})+$/;
const NUMBER = /\d+(?:[.,]\d+)*/g;

function plainNumber(token) {
  if (GROUPED.test(token)) return Number(token.replace(/[.,]/g, ''));
  return Number(token.replace(',', '.').replace(/[.,](?=.*[.,])/g, '')) || 0;
}

/** Giá một đơn vị (đồng). */
export function parsePrice(value) {
  const s = String(value ?? '').toLowerCase().replace(/\s+/g, '');
  if (!s) return 0;
  const million = /(\d+(?:[.,]\d+)?)(?:tr|triệu|trieu)(\d*)/.exec(s);
  if (million) {
    const whole = Number(million[1].replace(',', '.')) || 0;
    const fraction = million[2] ? Number(`0.${million[2]}`) : 0;
    return Math.round((whole + fraction) * 1_000_000);
  }
  const token = s.match(NUMBER)?.[0];
  if (!token) return 0;
  const n = /k|nghìn|ngàn/.test(s)
    ? (GROUPED.test(token) && token.includes('.') ? Number(token.replace(/\./g, '')) : Number(token.replace(',', '.')))
    : plainNumber(token);
  if (!Number.isFinite(n)) return 0;
  if (!/k|nghìn|ngàn/.test(s)) return Math.round(n);
  // "250000k" (gõ đủ số rồi ô tự thêm k) → không ai mua một dòng hàng 250 triệu.
  return n >= 100_000 ? Math.round(n) : Math.round(n * 1000);
}

/** Số lượng: số đầu tiên trong ô (bỏ trống = 1). */
export function parseQty(value) {
  const s = String(value ?? '').toLowerCase().trim();
  const fraction = /^(\d+)\s*\/\s*(\d+)/.exec(s);
  if (fraction && Number(fraction[2]) > 0) return Number(fraction[1]) / Number(fraction[2]);
  const token = s.match(/\d+(?:[.,]\d+)?/)?.[0];
  if (!token) return 1;
  const n = Number(token.replace(',', '.'));
  return n > 0 ? n : 1;
}

/** Những điểm đáng ngờ của một dòng hàng (hiện cảnh báo, không tự sửa). */
export function lineWarnings(item) {
  const warnings = [];
  const qty = String(item?.qty ?? '');
  if ((qty.match(/\d+(?:[.,]\d+)?/g) || []).length > 1) warnings.push(`Số lượng "${qty}" có nhiều số — chỉ tính ${parseQty(qty).toLocaleString('vi-VN')}`);
  const priceText = String(item?.price ?? '').toLowerCase();
  const price = parsePrice(priceText);
  if (price > 0 && price < 1000) warnings.push(`Giá "${item.price}" chỉ ${price}đ — thiếu chữ "k"?`);
  if (/k/.test(priceText) && (priceText.match(/\d+/g) || []).join('').length >= 6 && price < 100_000_000) {
    warnings.push(`Giá "${item.price}" được hiểu là ${price.toLocaleString('vi-VN')}đ`);
  }
  return warnings;
}

const debtBaseOf = (item, total) => {
  if (item.paymentStatus !== 'debt' && !(Number(item.paid_amount) > 0)) return 0;
  const asked = String(item.debtAmount ?? '').trim() ? parsePrice(String(item.debtAmount).replace(/\./g, '')) : total;
  return Math.min(asked || total, total);
};

/**
 * Tổng một phiếu từ các dòng hàng: total = tiền hàng, paid = trả ngay lúc mua,
 * debt = mua nợ (lúc mua). Trả nợ về sau không đổi paid/debt của phiếu.
 * Dòng đã trả nợ xong (paymentStatus 'full' + paid_amount) vẫn tính là nợ lúc mua.
 */
export function noteTotals(items = []) {
  let total = 0, paid = 0, debt = 0, debtPaid = 0;
  const lines = [];
  for (const item of items || []) {
    if (!String(item?.name || '').trim()) continue;
    const line = Math.round(parsePrice(item.price) * parseQty(item.qty));
    if (line <= 0) { lines.push({ total: 0, debt: 0, warnings: lineWarnings(item) }); continue; }
    const lineDebt = debtBaseOf(item, line);
    total += line;
    debt += lineDebt;
    paid += line - lineDebt;
    debtPaid += Math.min(lineDebt, Number(item.paid_amount) || 0);
    lines.push({ total: line, debt: lineDebt, paidLater: Math.min(lineDebt, Number(item.paid_amount) || 0), warnings: lineWarnings(item) });
  }
  return { total, paid, debt, debtPaid, debtLeft: debt - debtPaid, lines, warnings: lines.flatMap(l => l.warnings) };
}

/** Ô giá khi bấm ra ngoài: số nhỏ không có chữ k thì thêm "k" (250 → 250k), số lớn giữ nguyên. */
export function normalizePriceInput(value) {
  const v = String(value ?? '').trim();
  return /^\d+$/.test(v) && Number(v) < 10_000 ? `${v}k` : v;
}
