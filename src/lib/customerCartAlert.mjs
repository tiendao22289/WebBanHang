/**
 * Giỏ của khách chưa gửi → trang Bàn biết (supabase/migrations/customer_cart_alert.sql).
 *
 * Trang gọi món QR báo giỏ lên máy chủ mỗi khi giỏ đổi (report_customer_cart). Trang Bàn hiện
 * "🛒 10 món · 4 phút" trên đúng bàn có giỏ (số phút = từ lúc khách bỏ món đầu tiên vào giỏ). Đủ
 * CART_FORGOT_MS mà chưa gửi thì cả ô bàn chớp vàng + kêu chuông (createCartBell) để nhân viên ra giúp.
 * Khách gửi đơn / xoá hết giỏ → dòng bị xoá, báo tắt. Nhân viên bấm "Tắt" (đã nhắc khách) → xoá dòng
 * của bàn, khách sửa giỏ thì báo lại. Trước đó (CART_REMIND_MS) điện thoại khách tự nhắc "chưa gửi món".
 */

// Chủ quán (2026-11-08): khách chọn món quá 5 phút mà chưa gửi → bàn chớp vàng, kêu chuông. Đếm từ lúc
// khách bỏ món đầu tiên vào giỏ — đúng số phút hiện trên ô bàn — chứ không phải từ lần sửa giỏ cuối.
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
 * Kết quả get_customer_carts → giỏ với các mốc theo đồng hồ MÁY NÀY: máy chủ cho biết khách đã chọn
 * bao lâu (age_ms, từ món đầu tiên) và để yên bao lâu (idle_ms), nên máy ở quán lệch giờ (đã gặp lệch
 * 9 phút) vẫn đếm đúng 5 phút.
 */
export function customerCartsFromServer(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => {
      const idle = Math.max(0, Number(r?.idle_ms) || 0);
      // age_ms luôn ≥ idle_ms; thiếu (máy chủ cũ) thì lấy idle_ms cho khỏi báo sai sớm.
      const age = Math.max(idle, Number(r?.age_ms) || 0);
      return {
        tableId: r?.table_id || null,
        count: Math.max(0, Math.round(Number(r?.item_count) || 0)),
        items: Array.isArray(r?.items) ? r.items : [],
        changedAt: now - idle,
        startedAt: now - age,
      };
    })
    .filter(c => c.tableId && c.count > 0);
}

/**
 * Gộp theo bàn (1 bàn nhiều điện thoại): { [tableId]: { count, ageMs, forgot, forgotCount, idleMs } }.
 * ageMs: khách chọn lâu nhất bao lâu (số phút hiện trên ô bàn); forgot: có giỏ chọn từ CART_FORGOT_MS
 * trở lên mà chưa gửi (ô bàn chớp vàng + chuông); forgotCount: số món của các giỏ đó.
 */
export function customerCartsByTable(carts, now = Date.now()) {
  const out = {};
  for (const c of Array.isArray(carts) ? carts : []) {
    if (!c?.tableId || !(c.count > 0)) continue;
    const idle = Math.max(0, now - c.changedAt);
    const age = Math.max(idle, now - (Number.isFinite(c.startedAt) ? c.startedAt : c.changedAt));
    const t = out[c.tableId] || (out[c.tableId] = { count: 0, ageMs: 0, forgot: false, forgotCount: 0, idleMs: 0 });
    t.count += c.count;
    if (age >= CART_FORGOT_MS) { t.forgot = true; t.forgotCount += c.count; }
    t.ageMs = Math.max(t.ageMs, age);
    t.idleMs = Math.max(t.idleMs, idle);
  }
  return out;
}

/**
 * "4 phút" — khách đã chọn món bao lâu, cho dòng chữ trên ô bàn ("<1 phút" khi vừa chọn). Dấu cách
 * không ngắt dòng (ô bàn 375px hẹp: không để "4" một dòng, "phút" một dòng).
 */
export function cartMinutesText(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return '<1 phút';
  return m < 60 ? `${m} phút` : `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}

// ── Chuông trang Bàn khi bàn bắt đầu chớp vàng ─────────────────────────────────
// Kêu ngay lúc bàn đủ 5 phút, nhắc lại mỗi 2 phút, tối đa 5 lần (~8 phút) rồi chỉ còn chớp — có chừng
// mực, không kêu suốt 2 tiếng nếu khách bỏ đi. Nhiều bàn tới lượt cùng lúc chỉ kêu 1 lần, 2 lần kêu cách
// nhau ít nhất 30 giây.
export const CART_BELL_REPEAT_MS = 2 * 60 * 1000;
export const CART_BELL_MAX_RINGS = 5;
export const CART_BELL_GAP_MS = 30 * 1000;

/**
 * Lịch chuông theo bàn. check(forgotIds, now, { canRing }) → { ring: các bàn kêu lần này, blocked }.
 * canRing = false (trình duyệt chưa cho phát tiếng vì chưa ai chạm trang) → không tính là đã kêu,
 * blocked = true khi có bàn tới lượt kêu; chạm trang xong thì lần check sau kêu ngay.
 * quiet(tableId): nhân viên đã mở bàn xem → bàn đó thôi kêu (vẫn chớp) tới khi hết báo (khách gửi món,
 * giỏ trống, bấm Tắt); lần sau bàn đó báo lại thì kêu lại.
 */
export function createCartBell({ repeatMs = CART_BELL_REPEAT_MS, maxRings = CART_BELL_MAX_RINGS, gapMs = CART_BELL_GAP_MS } = {}) {
  let tables = new Map(); // tableId → { rings, lastAt, quiet }
  let lastRingAt = -Infinity;
  return {
    check(forgotIds, now = Date.now(), { canRing = true } = {}) {
      const next = new Map();
      for (const id of Array.isArray(forgotIds) ? forgotIds : []) {
        if (id && !next.has(id)) next.set(id, tables.get(id) || { rings: 0, lastAt: -Infinity, quiet: false });
      }
      tables = next; // bàn hết báo thì quên luôn → lần báo sau là lượt mới
      const due = [...tables].filter(([, t]) => !t.quiet && t.rings < maxRings && now - t.lastAt >= repeatMs).map(([id]) => id);
      if (!due.length) return { ring: [], blocked: false };
      if (!canRing) return { ring: [], blocked: true };
      if (now - lastRingAt < gapMs) return { ring: [], blocked: false };
      for (const id of due) { const t = tables.get(id); tables.set(id, { ...t, rings: t.rings + 1, lastAt: now }); }
      lastRingAt = now;
      return { ring: due, blocked: false };
    },
    quiet(tableId) {
      const t = tables.get(tableId);
      if (t) tables.set(tableId, { ...t, quiet: true });
    },
  };
}
