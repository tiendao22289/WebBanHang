// ============================================================
//  VOUCHER — logic thuần dùng chung (trang Bàn, trang Voucher, server, test).
//  Không import supabase ở đây để test chạy thẳng bằng node --test.
//  Chốt mã + trừ tiền nằm trong SQL redeem_voucher (supabase/migrations/vouchers.sql);
//  calcVoucherDiscount dưới đây chỉ để xem trước, phải cùng công thức với SQL.
// ============================================================
import { shiftEndISO } from './menuAvailability.mjs';

const VN_OFFSET_MS = 7 * 3600000;
const DAY_MS = 86400000;

// Bỏ 0/O, 1/I/L để đọc qua điện thoại không nhầm.
export const VOUCHER_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 6;

export const VOUCHER_SOURCES = {
  gift: 'Tặng tay',
  next_visit: 'Hẹn lần sau',
  wheel: 'Vòng xoay',
};

/** Mã mới dạng BK-7K3P9X. random(): số trong [0,1). */
export function newVoucherCode(random = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += VOUCHER_ALPHABET[Math.floor(random() * VOUCHER_ALPHABET.length)];
  return `BK-${s}`;
}

/** Mã nhân viên gõ (thường, có/không "BK-", có dấu cách) → dạng lưu trong DB, sai dạng → null. */
export function normalizeVoucherCode(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length === CODE_LEN + 2 && s.startsWith('BK')) s = s.slice(2);
  if (s.length !== CODE_LEN) return null;
  // Gõ nhầm số 0 / chữ O, số 1 / chữ I: các ký tự này không có trong mã.
  if (/[01OIL]/.test(s)) return null;
  return `BK-${s}`;
}

/** Chuẩn hoá SĐT VN về 0xxxxxxxxx; sai → null. (Giống zaloRewardServer.normalizePhone.) */
export function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  if (p.startsWith('0084')) p = '0' + p.slice(4);
  return /^0\d{9}$/.test(p) ? p : null;
}

/** Hạn của mã "lần sau": từ 5h sáng hôm sau (ca bán qua nửa đêm) đến 5h sáng sau `days` ngày. */
export function nextVisitWindow(days, nowMs = Date.now()) {
  const from = new Date(shiftEndISO(nowMs)).getTime();
  const n = Math.max(1, Math.round(Number(days) || 0));
  return { validFrom: new Date(from).toISOString(), validUntil: new Date(from + n * DAY_MS).toISOString() };
}

/** Ngày "YYYY-MM-DD" (giờ VN) → mốc 05:00 sáng ngày đó. Ngày bán hàng của quán bắt đầu lúc 5h. */
export function vnDayStartISO(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 5) - VN_OFFSET_MS).toISOString();
}

/** Hạn của mã chủ quán tặng: từ ngày A đến HẾT ngày B (tức 5h sáng ngày B+1). Từ hôm nay thì dùng được ngay. */
export function giftWindow(fromDay, toDay, nowMs = Date.now()) {
  const from = vnDayStartISO(fromDay);
  const toStart = vnDayStartISO(toDay);
  if (!from || !toStart) return null;
  // Bắt đầu hôm nay (theo lịch, kể cả lúc 0h–5h sáng) hoặc trước đó → dùng được ngay.
  const today = new Date(nowMs + VN_OFFSET_MS).toISOString().slice(0, 10);
  const start = fromDay <= today ? Math.min(nowMs, new Date(from).getTime()) : new Date(from).getTime();
  const until = new Date(toStart).getTime() + DAY_MS;
  if (until <= start || until <= nowMs) return null; // hết hạn rồi thì không tạo
  return { validFrom: new Date(start).toISOString(), validUntil: new Date(until).toISOString() };
}

/** Ngày cuối dùng được (giờ VN) của mã: mốc hết hạn 5h sáng → ngày hôm trước. */
export function lastUseDay(validUntil) {
  const t = new Date(validUntil).getTime() - 5 * 3600000 - 1;
  if (!Number.isFinite(t)) return '';
  return new Date(t + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Ngày bắt đầu dùng (giờ VN, theo lịch). */
export function firstUseDay(validFrom) {
  const t = new Date(validFrom).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** "2026-11-12" → "12/11". */
export function shortDay(day) {
  const [, m, d] = String(day || '').split('-');
  return d && m ? `${d}/${m}` : '';
}

export const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;

/** "30.000đ" hoặc "10% (tối đa 50.000đ)". */
export function voucherValueText(v) {
  const value = Number(v?.discount_value ?? v?.value) || 0;
  if ((v?.discount_type ?? v?.type) === 'percent') {
    const max = Number(v?.max_discount ?? v?.max) || 0;
    return max > 0 ? `${value}% (tối đa ${money(max)})` : `${value}%`;
  }
  return money(value);
}

/** Trạng thái để hiển thị: active | not_yet | expired | used | cancelled. */
export function voucherState(v, nowMs = Date.now()) {
  if (!v) return 'cancelled';
  if (v.status === 'used' || v.status === 'cancelled') return v.status;
  if (nowMs < new Date(v.valid_from).getTime()) return 'not_yet';
  if (nowMs >= new Date(v.valid_until).getTime()) return 'expired';
  return 'active';
}

export const VOUCHER_STATE_TEXT = {
  active: 'Còn dùng được', not_yet: 'Chưa tới ngày dùng', expired: 'Hết hạn', used: 'Đã dùng', cancelled: 'Đã huỷ',
};

/**
 * Xem trước số tiền giảm — cùng công thức redeem_voucher (SQL). base = tiền món;
 * billNow = tổng bill hiện tại (đã trừ giảm giá khác): bill luôn còn ít nhất 1.000đ.
 */
export function calcVoucherDiscount(base, v, billNow = Infinity) {
  const total = Math.max(0, Number(base) || 0);
  if (total <= 0 || !v) return 0;
  const value = Number(v.discount_value) || 0;
  let r = v.discount_type === 'percent' ? Math.floor(total * value / 100 / 1000) * 1000 : value;
  const max = Number(v.max_discount) || 0;
  if (v.discount_type === 'percent' && max > 0) r = Math.min(r, max);
  return Math.max(0, Math.min(r, Math.floor(total), Math.floor(Number(billNow)) - 1000));
}

/** Lý do redeem_voucher từ chối → câu cho nhân viên. */
export function redeemFailText(r) {
  switch (r?.reason) {
    case 'not_found': return 'Không có mã này. Kiểm tra lại từng chữ giúp nhé.';
    case 'used': {
      const at = r.used_at ? new Date(new Date(r.used_at).getTime() + VN_OFFSET_MS) : null;
      const when = at ? ` lúc ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} ${String(at.getUTCDate()).padStart(2, '0')}/${String(at.getUTCMonth() + 1).padStart(2, '0')}` : '';
      return `Mã này đã dùng rồi${r.table_number ? ` ở bàn ${r.table_number}` : ''}${when}.`;
    }
    case 'cancelled': return 'Mã này đã bị chủ quán huỷ.';
    case 'not_yet': return `Mã chưa tới ngày dùng — dùng được từ ${shortDay(firstUseDay(r.valid_from))}.`;
    case 'expired': return `Mã đã hết hạn (hạn đến hết ${shortDay(lastUseDay(r.valid_until))}).`;
    case 'no_bill': return 'Bàn chưa có bill để trừ voucher.';
    case 'bill_changed': return 'Bill vừa thay đổi (thanh toán / gộp / chuyển bàn). Mở lại bàn rồi thử lại.';
    case 'bill_has_voucher': return 'Bill này đã dùng 1 voucher rồi — mỗi bill chỉ 1 voucher.';
    case 'min_bill': return `Voucher dành cho bill từ ${money(r.min_bill)} (tiền món hiện ${money(r.base)}).`;
    case 'zero': return 'Bill chưa có món, hoặc đã được giảm gần hết — không trừ thêm được.';
    default: return r?.message || 'Chưa dùng được voucher, thử lại giúp nhé.';
  }
}

// ── Cấu hình "Hẹn lần sau" (bảng settings) ─────────────────────
export const NEXT_VOUCHER_KEYS = [
  'voucher_next_enabled', 'voucher_next_min_bill', 'voucher_next_type', 'voucher_next_value',
  'voucher_next_max', 'voucher_next_use_min_bill', 'voucher_next_days', 'voucher_next_repeat',
];

export function parseNextVoucherConfig(rows) {
  const map = Object.fromEntries((rows || []).map(r => [r.key, r.value]));
  const num = (k, d) => (map[k] == null || map[k] === '' ? d : Math.max(0, Math.round(Number(map[k]) || 0)));
  return {
    enabled: map.voucher_next_enabled === 'true',
    minBill: num('voucher_next_min_bill', 300000),
    type: map.voucher_next_type === 'percent' ? 'percent' : 'amount',
    value: num('voucher_next_value', 30000),
    max: num('voucher_next_max', 0),
    useMinBill: num('voucher_next_use_min_bill', 200000),
    days: Math.max(1, num('voucher_next_days', 14)),
    repeat: map.voucher_next_repeat !== 'false',
  };
}

/** Cấu hình hợp lệ để lưu (trả lỗi tiếng Việt nếu sai). */
export function checkNextVoucherConfig(c) {
  if (!['amount', 'percent'].includes(c.type)) return 'Chọn giảm tiền hay giảm %.';
  if (c.type === 'percent' && !(c.value >= 1 && c.value <= 100)) return '% giảm phải từ 1 đến 100.';
  if (c.type === 'amount' && !(c.value >= 1000)) return 'Số tiền giảm phải từ 1.000đ.';
  if (!(c.days >= 1 && c.days <= 365)) return 'Hạn dùng từ 1 đến 365 ngày.';
  return null;
}

/**
 * Bill vừa thanh toán → tặng cho SĐT nào: SĐT hợp lệ có tiền bill lớn nhất
 * (bàn nhiều người gọi bằng điện thoại riêng thì tặng người gọi nhiều nhất).
 */
export function pickVoucherPhone(orders) {
  const byPhone = new Map();
  for (const o of orders || []) {
    const phone = normalizePhone(o.customer_phone);
    if (!phone) continue;
    const cur = byPhone.get(phone) || { phone, name: null, total: 0, at: o.created_at || '' };
    cur.total += Number(o.total_amount) || 0;
    const name = String(o.customer_name || '').trim();
    if (!cur.name && name && name !== 'Admin') cur.name = name;
    if ((o.created_at || '') < cur.at) cur.at = o.created_at;
    byPhone.set(phone, cur);
  }
  return [...byPhone.values()].sort((a, b) => b.total - a.total || String(a.at).localeCompare(String(b.at)))[0] || null;
}

// ── Lời nhắn Zalo ─────────────────────────────────────────────
// Cách dùng mã — khách tự nhập trên trang gọi món, hoặc nhờ nhân viên.
export const HOW_TO_USE = 'Lần tới ghé quán, gọi món xong bạn bấm "📋 Đã gọi" → nhập mã là bill tự giảm '
  + '(hoặc đưa mã / đọc số điện thoại cho nhân viên).';

export const GIFT_MESSAGE_TEMPLATE = '🎁 Ốc Bảo Khang tặng {ten} voucher giảm {giam}!\n'
  + 'Mã: {ma}\nDùng từ {tu} đến hết {den}{dieukien}.\n'
  + `${HOW_TO_USE} Mời bạn ghé quán! 🦪`;

export const NEXT_VISIT_MESSAGE_TEMPLATE = 'Cảm ơn {ten} đã ghé Ốc Bảo Khang hôm nay! 🥰\n'
  + '🎁 Quán tặng bạn voucher giảm {giam} cho lần ghé tới.\n'
  + 'Mã: {ma}\nDùng từ {tu} đến hết {den}{dieukien}.\n'
  + HOW_TO_USE;

/** Khách tự nhập mã ở trang gọi món: dòng voucher ghi người thêm là tên này (không có mã nhân viên). */
export const CUSTOMER_REDEEM_NAME = 'Khách tự nhập mã';

/** Lý do không dùng được mã → câu cho KHÁCH (không lộ bàn / giờ người khác đã dùng). */
export function customerRedeemText(r) {
  switch (r?.reason) {
    case 'not_found': return 'Mã chưa đúng, Quý khách kiểm tra lại giúp quán nhé.';
    case 'used': return 'Mã này đã được dùng rồi ạ.';
    case 'cancelled': return 'Mã này không còn dùng được ạ.';
    case 'not_yet': return `Mã dùng được từ ngày ${shortDay(firstUseDay(r.valid_from))} ạ — hẹn Quý khách lần ghé tới!`;
    case 'expired': return `Mã đã hết hạn (hạn đến hết ${shortDay(lastUseDay(r.valid_until))}) ạ.`;
    case 'min_bill': return `Voucher dành cho bill từ ${money(r.min_bill)} (bill hiện ${money(r.base)}). Quý khách gọi thêm chút nữa rồi nhập lại nhé 😋`;
    case 'bill_has_voucher': return 'Bill này đã dùng 1 voucher rồi ạ (mỗi bill 1 voucher).';
    case 'too_many': return 'Nhập sai nhiều lần quá, Quý khách nhờ nhân viên giúp nhé.';
    case 'no_key': return 'Điện thoại này chưa gửi món ở bàn — Quý khách nhờ nhân viên áp mã giúp nhé.';
    case 'zero': return 'Bill chưa có món (hoặc đã được giảm gần hết) nên chưa trừ thêm được ạ.';
    default: return 'Bàn chưa có bill đang mở để trừ voucher — Quý khách gọi món trước rồi nhập mã nhé.';
  }
}

/** Điền {ten} {giam} {ma} {tu} {den} {dieukien} vào lời nhắn. */
export function fillVoucherMessage(template, v) {
  const name = String(v?.customer_name || '').trim();
  const fields = {
    ten: name || 'bạn',
    giam: voucherValueText(v),
    ma: v?.code || '',
    tu: shortDay(firstUseDay(v?.valid_from)),
    den: shortDay(lastUseDay(v?.valid_until)),
    dieukien: Number(v?.min_bill) > 0 ? `, cho bill từ ${money(v.min_bill)}` : '',
  };
  return String(template || '').replace(/\{(ten|giam|ma|tu|den|dieukien)\}/g, (_, k) => fields[k]);
}
