/**
 * Giỏ của khách chưa gửi → trang Bàn biết (supabase/migrations/customer_cart_alert.sql).
 *
 * Trang gọi món QR báo giỏ lên máy chủ mỗi khi giỏ đổi (report_customer_cart). Trang Bàn hiện 🛒 trên
 * đúng bàn có giỏ; giỏ để yên CART_FORGOT_MS mà chưa gửi thì ô bàn chớp vàng "Khách quên gửi món".
 * Khách gửi đơn / xoá hết giỏ → dòng bị xoá, báo tắt. Nhân viên bấm "Tắt" (đã nhắc khách) → xoá dòng
 * của bàn, khách sửa giỏ thì báo lại. Trước đó (CART_REMIND_MS) điện thoại khách tự nhắc "chưa gửi món".
 */

export const CART_FORGOT_MS = 5 * 60 * 1000;
// Nhắc ngay trên điện thoại khách trước khi trang Bàn chớp vàng (khách tự gửi, nhân viên khỏi chạy ra).
export const CART_REMIND_MS = 3 * 60 * 1000;
const MAX_LINES = 60;
const KEY_STORAGE = 'cart_alert_key';
let memoryKey = null;

/** Giỏ + quà khách chọn → các dòng gửi máy chủ: chỉ mã món, số phần, lựa chọn (không tiền, không tên khách). */
export function cartAlertItems(cart, gifts) {
  const choiceText = opts => (Array.isArray(opts) ? opts : [])
    .map(o => o?.choice).filter(c => c != null && c !== '').join(', ').slice(0, 120);
  const line = (id, q, opts, gift) => {
    const o = choiceText(opts);
    return { id, q, ...(o ? { o } : {}), ...(gift ? { g: true } : {}) };
  };
  return [
    ...(Array.isArray(cart) ? cart : [])
      .filter(c => c?.id && Number(c.quantity) > 0)
      .map(c => line(c.id, Math.min(99, Math.round(Number(c.quantity))), c._options)),
    ...(Array.isArray(gifts) ? gifts : []).filter(g => g?.id).map(g => line(g.id, 1, g._options, true)),
  ].slice(0, MAX_LINES);
}

/** Mã bí mật riêng của máy khách (máy chủ chỉ giữ sha256 của nó). Không dùng chung mã voucher. */
export function cartAlertDeviceKey() {
  const fresh = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)),
    b => b.toString(16).padStart(2, '0')).join('');
  try {
    let key = localStorage.getItem(KEY_STORAGE);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key || '')) { key = fresh(); localStorage.setItem(KEY_STORAGE, key); }
    return key;
  } catch {
    return (memoryKey ||= fresh());
  }
}

/**
 * Báo giỏ lên máy chủ: đợi delayMs sau lần đổi cuối, mỗi lúc chỉ 1 lần gửi (lần gửi chậm không đè giỏ
 * mới hơn), giỏ giống lần đã gửi thì thôi. Lỗi mạng thì thử lại thưa dần (15 giây → tối đa 5 phút).
 * isReady(): trang đã nạp lại giỏ cũ chưa (chưa thì giỏ trống lúc mới mở không được xoá báo cũ).
 * send(tableId, items) → true khi máy chủ nhận.
 */
export function createCartReporter({ send, isReady = () => true, delayMs = 1200, timers = globalThis }) {
  let want = null, sent = null, busy = false, timer = null, failures = 0, disposed = false;
  const sig = w => JSON.stringify([w.tableId || null, w.items]);
  const schedule = ms => {
    if (disposed) return;
    timers.clearTimeout(timer);
    timer = timers.setTimeout(flush, ms);
  };
  async function flush() {
    timer = null;
    if (disposed || busy || !want) return;
    if (!isReady()) { schedule(1000); return; }
    const target = want;
    const s = sig(target);
    if (s === sent) return;
    busy = true;
    let ok = false;
    try { ok = !!(await send(target.tableId || null, target.items)); } catch { ok = false; }
    busy = false;
    if (ok) { sent = s; failures = 0; } else failures++;
    if (want && sig(want) !== sent) schedule(ok ? delayMs : Math.min(15000 * 2 ** (failures - 1), 300000));
  }
  return {
    update(tableId, items) { want = { tableId: tableId || null, items: Array.isArray(items) ? items : [] }; schedule(delayMs); },
    dispose() { disposed = true; timers.clearTimeout(timer); },
  };
}

/**
 * Nhắc khách "chưa gửi món" trên trang gọi món: giỏ có món mà để yên delayMs thì onChange(true).
 * Giỏ đổi, mở / đóng giỏ, đang gửi → ẩn và đếm lại. paused (đang xem giỏ, đang gửi, đang nhập
 * thông tin) thì không đếm. Khách bấm "Để sau" (mute) → không nhắc lại tới khi giỏ đổi.
 */
export function createCartReminder({ onChange, delayMs = CART_REMIND_MS, timers = globalThis }) {
  let timer = null, shown = false, sig = null, muted = null, disposed = false;
  const show = v => { if (shown !== v) { shown = v; onChange(v); } };
  const stop = () => { timers.clearTimeout(timer); timer = null; };
  return {
    update(nextSig, { hasItems = false, paused = false } = {}) {
      stop();
      if (nextSig !== sig) { sig = nextSig; muted = null; }
      show(false);
      if (disposed || !hasItems || paused || muted === sig) return;
      timer = timers.setTimeout(() => { timer = null; if (!disposed) show(true); }, delayMs);
    },
    mute() { muted = sig; stop(); show(false); },
    dispose() { disposed = true; stop(); },
  };
}

/**
 * Kết quả get_customer_carts → giỏ với mốc "đổi lần cuối" theo đồng hồ MÁY NÀY: máy chủ cho biết
 * giỏ đã để yên bao lâu (idle_ms), nên máy ở quán lệch giờ vẫn đếm đúng 5 phút.
 */
export function customerCartsFromServer(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({
      tableId: r?.table_id || null,
      count: Math.max(0, Math.round(Number(r?.item_count) || 0)),
      items: Array.isArray(r?.items) ? r.items : [],
      changedAt: now - Math.max(0, Number(r?.idle_ms) || 0),
    }))
    .filter(c => c.tableId && c.count > 0);
}

/**
 * Gộp theo bàn (1 bàn nhiều điện thoại): { [tableId]: { count, forgot, idleMs, forgotCount } }.
 * forgot: có giỏ để yên từ CART_FORGOT_MS trở lên; forgotCount: số món của các giỏ đó.
 */
export function customerCartsByTable(carts, now = Date.now()) {
  const out = {};
  for (const c of Array.isArray(carts) ? carts : []) {
    if (!c?.tableId || !(c.count > 0)) continue;
    const idle = Math.max(0, now - c.changedAt);
    const t = out[c.tableId] || (out[c.tableId] = { count: 0, forgot: false, idleMs: 0, forgotCount: 0 });
    t.count += c.count;
    if (idle >= CART_FORGOT_MS) { t.forgot = true; t.forgotCount += c.count; }
    t.idleMs = Math.max(t.idleMs, idle);
  }
  return out;
}

/** "7 phút" — giỏ để yên bao lâu, cho dòng chữ trên ô bàn. */
export function idleMinutesText(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  return m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}
