// ============================================================
//  VOUCHER — phần chạy ở SERVER (cần SERVICE_ROLE_KEY). Không import vào
//  component chạy trên máy khách.
//
//  Hàm gửi Zalo (sendOaText) được truyền vào thay vì import, để file này chạy
//  thẳng trong node --test với DB giả.
// ============================================================
import { createHash } from 'node:crypto';
import {
  NEXT_VOUCHER_KEYS, VOUCHER_SWITCH_KEY, isVoucherSwitchOn, parseNextVoucherConfig, nextVisitWindow, newVoucherCode,
  pickVoucherPhone, normalizePhone, fillVoucherMessage, GIFT_MESSAGE_TEMPLATE,
  NEXT_VISIT_MESSAGE_TEMPLATE, voucherValueText, shortDay, firstUseDay, lastUseDay, money, HOW_TO_USE,
  calcVoucherDiscount,
} from './voucher.mjs';

export async function loadNextVoucherConfig(db) {
  const { data, error } = await db.from('voucher_settings').select('key, value').in('key', [VOUCHER_SWITCH_KEY, ...NEXT_VOUCHER_KEYS]);
  if (error) throw error;
  return parseNextVoucherConfig(data);
}

/** Công tắc chung đang bật? Chưa cài bảng / lỗi đọc → coi như tắt. */
export async function loadVoucherSwitch(db) {
  const { data, error } = await db.from('voucher_settings').select('key, value').eq('key', VOUCHER_SWITCH_KEY);
  return !error && isVoucherSwitchOn(data);
}

/** Chèn 1 mã mới; trùng mã (rất hiếm) thì đổi mã. Trùng issue_key = gọi lại → trả mã đã có. */
export async function insertVoucher(db, row, random = Math.random) {
  for (let i = 0; i < 5; i++) {
    const { data, error } = await db.from('vouchers').insert({ ...row, code: newVoucherCode(random) }).select().maybeSingle();
    if (!error && data) return data;
    if (error?.code !== '23505') throw error || new Error('Không tạo được mã voucher.');
    // Trùng "1 mã lần sau / SĐT / ngày" (2 bàn cùng SĐT thanh toán cùng lúc) — không phải trùng mã.
    if (/vouchers_next_visit_once/.test(error.message || '')) throw error;
    if (row.issue_key) {
      const { data: existing, error: readError } = await db.from('vouchers')
        .select('*').eq('issue_key', row.issue_key).maybeSingle();
      if (readError) throw readError;
      if (existing) return existing;
    }
  }
  throw new Error('Không tạo được mã voucher, thử lại giúp nhé.');
}

/**
 * Thanh toán xong → tặng mã "hẹn lần sau" cho SĐT của bill.
 * Mỗi SĐT chỉ giữ 1 mã "lần sau" còn hạn; gọi lại cho cùng lần thanh toán trả đúng mã cũ.
 * Trả { voucher, created } hoặc { skipped: lý do }.
 */
export async function issueNextVisitVoucher(db, { orderIds, nowMs = Date.now(), random = Math.random }) {
  const cfg = await loadNextVoucherConfig(db);
  if (!cfg.on || !cfg.enabled) return { skipped: 'off' };
  const ids = [...new Set((orderIds || []).filter(Boolean))].sort();
  if (!ids.length) return { skipped: 'no_bill' };

  const issueKey = `pay:${ids[0]}`;
  const { data: again, error: againError } = await db.from('vouchers').select('*').eq('issue_key', issueKey).maybeSingle();
  if (againError) throw againError;
  if (again) return { voucher: again, created: false };

  const { data: orders, error } = await db.from('orders')
    .select('id, customer_phone, customer_name, total_amount, status, created_at').in('id', ids);
  if (error) throw error;
  const paid = (orders || []).filter(o => o.status === 'paid');
  if (!paid.length) return { skipped: 'not_paid' };
  const who = pickVoucherPhone(paid);
  if (!who) return { skipped: 'no_phone' };
  const total = paid.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);
  if (cfg.minBill > 0 && total < cfg.minBill) return { skipped: 'small_bill' };

  if (!cfg.repeat) {
    // Xét chính các dòng trong bill (gộp bill chuyển dòng voucher sang bill chính).
    const { data: lines, error: linesError } = await db.from('order_items').select('item_name')
      .in('order_id', ids).lt('unit_price', 0);
    if (linesError) throw linesError;
    if ((lines || []).some(l => String(l.item_name || '').startsWith('Voucher BK-'))) return { skipped: 'used_voucher' };
  }

  const { data: current, error: currentError } = await db.from('vouchers').select('*')
    .eq('customer_phone', who.phone).eq('source', 'next_visit').eq('status', 'active')
    .gt('valid_until', new Date(nowMs).toISOString()).limit(1);
  if (currentError) throw currentError;
  if (current?.length) return { skipped: 'has_active', voucher: current[0] };

  const win = nextVisitWindow(cfg.days, nowMs);
  try {
    const voucher = await insertVoucher(db, {
      source: 'next_visit', batch_name: 'Hẹn lần sau',
      discount_type: cfg.type, discount_value: cfg.value, max_discount: cfg.type === 'percent' ? cfg.max : 0,
      min_bill: cfg.useMinBill, valid_from: win.validFrom, valid_until: win.validUntil,
      customer_phone: who.phone, customer_name: who.name, issue_key: issueKey, issued_order_ids: ids,
    }, random);
    return { voucher, created: true };
  } catch (error) {
    if (/vouchers_next_visit_once/.test(error?.message || '')) return { skipped: 'has_active' };
    throw error;
  }
}

/** Trúng ô "Voucher lần sau" của vòng xoay → tạo mã (1 lượt quay = 1 mã). */
export async function issueWheelVoucher(db, spin, { nowMs = Date.now(), random = Math.random } = {}) {
  const cfg = await loadNextVoucherConfig(db);
  const value = Math.round(Number(spin.prize_value) || 0);
  if (!(value > 0)) throw new Error('Phần quà voucher chưa có số tiền.');
  const win = nextVisitWindow(cfg.days, nowMs);
  return insertVoucher(db, {
    source: 'wheel', batch_name: 'Vòng xoay may mắn',
    discount_type: 'amount', discount_value: value, max_discount: 0,
    min_bill: cfg.useMinBill, valid_from: win.validFrom, valid_until: win.validUntil,
    customer_phone: normalizePhone(spin.customer_phone), customer_name: spin.customer_name || null,
    issue_key: `spin:${spin.id}`, issued_spin_id: spin.id,
    issued_order_ids: spin.applied_order_id ? [spin.applied_order_id] : [],
  }, random);
}

/** Lời chúc mừng trúng voucher vòng xoay (gửi Zalo + hiện cho khách). */
export function wheelVoucherMessage(v) {
  return `🎉 Chúc mừng Quý khách trúng voucher giảm ${voucherValueText(v)} cho lần ghé tới!\n`
    + `Mã: ${v.code}\nDùng từ ${shortDay(firstUseDay(v.valid_from))} đến hết ${shortDay(lastUseDay(v.valid_until))}`
    + `${Number(v.min_bill) > 0 ? `, cho bill từ ${money(v.min_bill)}` : ''}.\n`
    + `${HOW_TO_USE}\nCảm ơn Quý khách đã ủng hộ Ốc Bảo Khang ạ!`;
}

/** Lời nhắn Zalo của 1 mã. */
export function voucherMessage(v) {
  if (v.message) return v.message;
  if (v.source === 'wheel') return wheelVoucherMessage(v);
  return fillVoucherMessage(v.source === 'next_visit' ? NEXT_VISIT_MESSAGE_TEMPLATE : GIFT_MESSAGE_TEMPLATE, v);
}

/** Tài khoản Zalo của SĐT (đã nối qua vòng xoay / ưu đãi Zalo / nhắn SĐT cho OA). */
export async function zaloUserOfPhone(db, phone) {
  if (!phone) return null;
  const { data: customer, error } = await db.from('customers').select('zalo_user_id').eq('phone', phone).maybeSingle();
  if (error) throw error;
  if (customer?.zalo_user_id) return customer.zalo_user_id;
  const { data: followers, error: followerError } = await db.from('zalo_followers')
    .select('zalo_user_id, unfollowed_at').eq('phone', phone).limit(5);
  if (followerError) throw followerError;
  // Nhiều tài khoản Zalo cùng nhắn SĐT này (có người nhắn SĐT của khách khác) → không biết ai thật, không gửi.
  const uids = [...new Set((followers || []).filter(f => !f.unfollowed_at).map(f => f.zalo_user_id))];
  return uids.length === 1 ? uids[0] : null;
}

/** Câu dễ hiểu cho lỗi Zalo trả về khi nhắn. */
export function zaloSendErrorText(detail) {
  const msg = String(detail?.message || detail || '').slice(0, 200);
  if (/interact|tương tác|48|7 days|7 ngày/i.test(msg)) return 'Zalo không cho nhắn: khách lâu rồi chưa nhắn cho quán. Chép tin để gửi tay.';
  if (/follow|quan tâm/i.test(msg)) return 'Khách chưa quan tâm Zalo của quán.';
  if (/quota|limit|hạn mức/i.test(msg)) return 'Zalo báo hết hạn mức tin nhắn hôm nay.';
  return msg ? `Zalo từ chối: ${msg}` : 'Chưa gửi được qua Zalo.';
}

/**
 * Nhắn mã qua Zalo. Không `force` thì chỉ gửi 1 lần (cờ sent_at, chiếm trước rồi
 * mới gửi; gửi hỏng thì nhả cờ để lần sau còn thử). send = sendOaText(db, uid, text, log).
 */
export async function sendVoucherZalo(db, voucher, { send, zaloUserId = null, force = false, log = () => {} }) {
  const uid = zaloUserId || await zaloUserOfPhone(db, voucher.customer_phone);
  if (!uid) {
    // Ghi lý do dưới mã (trang Voucher) và để "gửi tất cả" lần sau bỏ qua. Khách nối Zalo sau này
    // (nhắn SĐT cho OA) thì sendPendingVouchers vẫn gửi: nó xét sent_at, không xét lỗi.
    const message = 'Khách chưa nối Zalo với quán — chép tin để gửi tay.';
    await db.from('vouchers').update({ send_error: message }).eq('id', voucher.id).is('sent_at', null);
    return { ok: false, reason: 'no_zalo', message };
  }
  const stamp = new Date().toISOString();
  let claim = db.from('vouchers').update({ sent_at: stamp, send_error: null }).eq('id', voucher.id);
  if (!force) claim = claim.is('sent_at', null);
  const { data: claimed, error } = await claim.select('id').maybeSingle();
  if (error) throw error;
  if (!claimed) return { ok: true, already: true };

  let result;
  try {
    result = await send(db, uid, voucherMessage(voucher), log);
  } catch (err) {
    result = { ok: false, detail: { message: err.message } };
  }
  if (result?.ok) return { ok: true };
  const message = zaloSendErrorText(result?.detail);
  await db.from('vouchers').update({ sent_at: null, send_error: message }).eq('id', voucher.id);
  return { ok: false, reason: 'zalo', message };
}

/**
 * Khách vừa nhắn SĐT cho OA (khung nhắn tin đang mở) → gửi mọi mã còn hạn của SĐT
 * mà chưa nhắn được (lần sau / tặng tay / vòng xoay). Cùng cờ sent_at nên không gửi 2 lần.
 */
export async function sendPendingVouchers(db, phone, zaloUserId, { send, nowMs = Date.now(), log = () => {} }) {
  if (!phone || !zaloUserId) return 0;
  // Voucher đang tắt: không nhắn mã (khách chưa dùng được). Bật lại thì lần nhắn SĐT sau sẽ gửi.
  if (!(await loadVoucherSwitch(db))) return 0;
  // SĐT đã nối với một tài khoản Zalo KHÁC (hồ sơ khách, hoặc người khác đã nhắn SĐT này cho OA)
  // → có thể là người lạ nhắn SĐT của khách: không gửi mã. (Webhook đã ghi SĐT vào dòng của
  // chính người nhắn trước khi gọi hàm này, nên phải loại dòng đó ra.)
  const { data: customer, error: customerError } = await db.from('customers').select('zalo_user_id').eq('phone', phone).maybeSingle();
  if (customerError) throw customerError;
  if (customer?.zalo_user_id && customer.zalo_user_id !== zaloUserId) return 0;
  const { data: others, error: othersError } = await db.from('zalo_followers').select('zalo_user_id, unfollowed_at')
    .eq('phone', phone).neq('zalo_user_id', zaloUserId).limit(5);
  if (othersError) throw othersError;
  if ((others || []).some(f => !f.unfollowed_at)) return 0;
  const { data, error } = await db.from('vouchers').select('*')
    .eq('customer_phone', phone).eq('status', 'active').is('sent_at', null)
    .gt('valid_until', new Date(nowMs).toISOString());
  if (error) throw error;
  let sent = 0;
  for (const v of data || []) {
    const r = await sendVoucherZalo(db, v, { send, zaloUserId, log });
    if (r.ok && !r.already) sent++;
  }
  return sent;
}

/** Mã còn dùng được của các SĐT trên bill (trang Bàn hiện "Có voucher"). */
export async function activeVouchersForPhones(db, phones, nowMs = Date.now()) {
  const list = [...new Set((phones || []).map(normalizePhone).filter(Boolean))].slice(0, 30);
  if (!list.length) return [];
  const now = new Date(nowMs).toISOString();
  const { data, error } = await db.from('vouchers')
    .select('id, code, source, discount_type, discount_value, max_discount, min_bill, valid_from, valid_until, customer_phone, customer_name, status')
    .in('customer_phone', list).eq('status', 'active').lte('valid_from', now).gt('valid_until', now)
    .order('valid_until', { ascending: true });
  if (error) throw error;
  if (!data?.length) return [];
  const { data: customers } = await db.from('customers')
    .select('phone, name, visit_count, last_visit_at').in('phone', list);
  const byPhone = Object.fromEntries((customers || []).map(c => [c.phone, c]));
  return data.map(v => ({ ...v, customer: byPhone[v.customer_phone] || null }));
}

/**
 * Trước khi đóng bàn: dòng voucher còn đúng với bill hiện tại không (khách áp mã rồi nhờ bỏ bớt món):
 * tiền món còn đủ mức tối thiểu, và số đã giảm không vượt mức được giảm bây giờ (voucher % tính
 * lại theo tiền món còn lại, bill luôn còn ít nhất 1.000đ). Trả câu báo cho nhân viên, hoặc null nếu ổn.
 */
export async function voucherPayProblem(db, orderIds) {
  const ids = (orderIds || []).filter(Boolean);
  if (!ids.length) return null;
  const { data: items, error } = await db.from('order_items').select('id, item_name, unit_price, quantity, is_gift, menu_item_id').in('order_id', ids);
  if (error) throw error;
  const lines = (items || []).filter(i => i.menu_item_id == null && Number(i.unit_price) < 0 && String(i.item_name || '').startsWith('Voucher BK-'));
  if (!lines.length) return null;
  const { data: vouchers, error: vError } = await db.from('vouchers')
    .select('code, discount_type, discount_value, max_discount, min_bill, used_item_id').in('used_item_id', lines.map(l => l.id));
  if (vError) throw vError;
  const amount = i => Number(i.unit_price) * Number(i.quantity);
  const base = (items || []).filter(i => Number(i.unit_price) > 0 && !i.is_gift).reduce((sum, i) => sum + amount(i), 0);
  const bill = (items || []).reduce((sum, i) => sum + amount(i), 0);
  const fix = 'Xoá dòng voucher (mã được trả lại cho khách) rồi áp lại mã, hoặc gọi thêm món.';
  for (const v of vouchers || []) {
    if (Number(v.min_bill) > 0 && base < Number(v.min_bill)) {
      return `Voucher ${v.code} dành cho bill từ ${money(v.min_bill)}, tiền món giờ còn ${money(base)}. ${fix}`;
    }
    const line = lines.find(l => l.id === v.used_item_id);
    const taken = -amount(line);
    const allowed = calcVoucherDiscount(base, v, bill + taken);
    if (taken > allowed) {
      return `Voucher ${v.code} đang giảm ${money(taken)}, nhưng bill giờ chỉ được giảm ${money(allowed)} (đã bớt món). ${fix}`;
    }
  }
  return null;
}

/** Băm chìa khoá máy khách (lưu băm, không lưu chìa khoá). */
export const hashVoucherKey = key => createHash('sha256').update(String(key)).digest('hex');
