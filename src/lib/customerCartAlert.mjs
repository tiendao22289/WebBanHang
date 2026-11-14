/**
 * Giỏ của khách chưa gửi → trang Bàn biết (supabase/migrations/customer_cart_alert.sql).
 *
 * Trang gọi món QR báo giỏ lên máy chủ mỗi khi giỏ đổi (report_customer_cart). Trang Bàn hiện
 * "🛒 10 món · 4 phút" trên đúng bàn có giỏ (số phút = từ lúc khách bỏ món đầu tiên vào giỏ). Đủ
 * CART_FORGOT_MS mà chưa gửi thì cả ô bàn chớp vàng + kêu chuông (createCartBell) để nhân viên ra giúp.
 * Khách gửi đơn / xoá hết giỏ → dòng bị xoá, báo tắt. Nhân viên bấm "Tắt" (đã nhắc khách) → xoá dòng
 * của bàn, khách sửa giỏ thì báo lại. Trước đó (CART_REMIND_MS) điện thoại khách tự nhắc "chưa gửi món".
 * Nhân viên bấm vào 🛒 xem được giỏ khách, bấm Gửi hộ / Sửa rồi gửi → máy chủ nhận giỏ
 * (take_customer_cart), điện thoại khách bớt đúng các món đó khỏi giỏ (cartAfterTaken) để khỏi gửi trùng.
 */
import { menuLinePrice } from './draftCart.mjs';
import { isDishOff } from './menuAvailability.mjs';

// Chủ quán (2026-11-08): khách chọn món quá 5 phút mà chưa gửi → bàn chớp vàng, kêu chuông. Đếm từ lúc
// khách bỏ món đầu tiên vào giỏ — đúng số phút hiện trên ô bàn — chứ không phải từ lần sửa giỏ cuối.
export const CART_FORGOT_MS = 5 * 60 * 1000;
// Nhắc ngay trên điện thoại khách trước khi trang Bàn chớp vàng (khách tự gửi, nhân viên khỏi chạy ra).
export const CART_REMIND_MS = 3 * 60 * 1000;
const MAX_LINES = 60;
const KEY_STORAGE = 'cart_alert_key';
let memoryKey = null;

// Cắt theo KÝ TỰ như left() của Postgres (emoji 1 ký tự), để dòng máy chủ giữ y hệt dòng máy khách gửi
// (máy khách dựa vào đó để bớt đúng món nhân viên đã nhận — cartAfterTaken).
const cut = (s, n) => Array.from(String(s)).slice(0, n).join('');

/** 1 dòng giỏ / quà → dòng gửi máy chủ (cùng luật lọc / cắt với report_customer_cart). */
function alertLine(id, q, opts, note, gift) {
  const list = Array.isArray(opts) ? opts : [];
  const o = cut(list.map(x => x?.choice).filter(c => c != null && c !== '').join(', '), 120);
  const p = list
    .filter(x => typeof x?.name === 'string' && x.name !== '' && x.choice != null && String(x.choice) !== '')
    .slice(0, 8)
    .map(x => ({ n: cut(x.name, 60), c: cut(x.choice, 200) }));
  const t = typeof note === 'string' ? cut(note.trim(), 120) : '';
  return { id, q, ...(o ? { o } : {}), ...(p.length ? { p } : {}), ...(t ? { t } : {}), ...(gift ? { g: true } : {}) };
}

/**
 * Giỏ + quà khách chọn → các dòng gửi máy chủ: mã món, số phần, lựa chọn (o: chữ để đọc, p: từng nhóm
 * để nhân viên gửi hộ đúng món), ghi chú cho bếp (t), quà (g). Không tiền, không tên / SĐT khách.
 * notes: ghi chú món không có lựa chọn ({ [mã món]: chữ }, như customerOrderLines).
 */
export function cartAlertItems(cart, gifts, notes = {}) {
  return [
    ...(Array.isArray(cart) ? cart : [])
      .filter(c => c?.id && Number(c.quantity) > 0)
      .map(c => alertLine(c.id, Math.min(99, Math.round(Number(c.quantity))), c._options, c._note || notes?.[c.id], false)),
    ...(Array.isArray(gifts) ? gifts : []).filter(g => g?.id).map(g => alertLine(g.id, 1, g._options, g._note, true)),
  ].slice(0, MAX_LINES);
}

// So theo giá trị, không theo thứ tự khoá: máy chủ (jsonb) trả { c, n } chứ không phải { n, c } như máy gửi.
const takenKey = l => JSON.stringify([l.id, (Array.isArray(l.p) ? l.p : []).map(x => [x?.n ?? '', x?.c ?? '']), l.t || '', !!l.g]);

/**
 * Nhân viên đã nhận giỏ của máy này (Gửi hộ / Sửa rồi gửi): bớt khỏi giỏ đúng các dòng đã nhận (cùng
 * món, lựa chọn, ghi chú; quà riêng), giữ phần khách thêm sau đó. taken: các dòng máy chủ giữ (cartAlertItems).
 * → { cart, gifts, count: số phần đã bớt }
 */
export function cartAfterTaken(cart, gifts, notes, taken) {
  const left = new Map();
  for (const t of Array.isArray(taken) ? taken : []) {
    if (t?.id) left.set(takenKey(t), (left.get(takenKey(t)) || 0) + (Number(t.q) || 0));
  }
  let count = 0;
  const take = (line, qty) => {
    const k = takenKey(line);
    const n = Math.min(left.get(k) || 0, qty);
    if (n > 0) { left.set(k, left.get(k) - n); count += n; }
    return n;
  };
  const nextCart = (Array.isArray(cart) ? cart : []).map(c => {
    if (!c?.id || !(Number(c.quantity) > 0)) return c;
    const qty = Math.round(Number(c.quantity));
    const n = take(alertLine(c.id, qty, c._options, c._note || notes?.[c.id], false), qty);
    return n >= qty ? null : n > 0 ? { ...c, quantity: qty - n } : c;
  }).filter(Boolean);
  const nextGifts = (Array.isArray(gifts) ? gifts : []).filter(g => !(g?.id && take(alertLine(g.id, 1, g._options, g._note, true), 1)));
  return { cart: nextCart, gifts: nextGifts, count };
}

/** Lựa chọn của 1 dòng giỏ khách → [{ name, choice }] như item_options của bill. */
export function cartLineOptions(line) {
  return (Array.isArray(line?.p) ? line.p : []).map(x => ({ name: x.n, choice: x.c }));
}

/**
 * Giỏ khách → món cho nhân viên gửi hộ, theo thực đơn đang bán: giá tính lại như máy chủ tính đơn khách
 * (menuLinePrice). Món / lựa chọn đã tắt, hoặc máy khách bản cũ không gửi đủ lựa chọn → skipped (không gửi).
 * → { lines: [{ menuItem, options, qty, note, price }], gifts: [{ menuItem, options, note }], skipped: [chữ] }
 */
export function cartItemsToDraft(items, menuItems, now = Date.now()) {
  const lines = [], gifts = [], skipped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const menuItem = (Array.isArray(menuItems) ? menuItems : []).find(m => m.id === it?.id);
    const options = cartLineOptions(it);
    const choiceText = it?.o || options.map(o => o.choice).join(', ');
    const label = `${menuItem?.name || 'Món không còn trên thực đơn'}${choiceText ? ` · ${choiceText}` : ''}`;
    if (!menuItem || isDishOff(menuItem, now)) { skipped.push(label); continue; }
    const needsChoice = (menuItem.options || []).some(o => Array.isArray(o?.choices) && o.choices.length > 0);
    if (!options.length && it.o && needsChoice) { skipped.push(label); continue; }
    const priced = menuLinePrice(menuItem, options, now);
    if (priced.off) { skipped.push(label); continue; }
    if (it.g) gifts.push({ menuItem, options, note: it.t || '' });
    else lines.push({ menuItem, options, qty: Number(it.q) || 1, note: it.t || '', price: priced.price });
  }
  return { lines, gifts, skipped };
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
 * update(..., { now: true }): gửi liền, không đợi delayMs (đơn vừa vào quán → tắt báo "quên gửi" trên trang
 * Bàn ngay lúc đó; khách hay khoá máy / sang Zalo liền sau khi gửi, đợi 1,2 giây thì có khi không kịp báo).
 * Đang có lần gửi khác chạy dở thì gửi ngay khi lần đó xong.
 */
export function createCartReporter({ send, isReady = () => true, delayMs = 1200, timers = globalThis }) {
  let want = null, sent = null, busy = false, timer = null, failures = 0, disposed = false, urgent = null;
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
    if (ok) { sent = s; failures = 0; if (urgent === s) urgent = null; } else failures++;
    if (want && sig(want) !== sent) {
      schedule(!ok ? Math.min(15000 * 2 ** (failures - 1), 300000) : sig(want) === urgent ? 0 : delayMs);
    }
  }
  return {
    update(tableId, items, { now = false } = {}) {
      want = { tableId: tableId || null, items: Array.isArray(items) ? items : [] };
      const s = sig(want);
      if (now) urgent = s;
      // Cùng giỏ với lần "gửi liền" (trang báo lại sau khi xoá giỏ) → không lùi về đợi delayMs.
      if (urgent === s) {
        if (disposed) return;
        timers.clearTimeout(timer);
        timer = null;
        flush();
        return;
      }
      urgent = null;
      schedule(delayMs);
    },
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
        // Bản giỏ đang xem: nhân viên Gửi hộ thì máy chủ chỉ nhận đúng bản này (khách sửa sau đó → từ chối).
        cartId: typeof r?.cart_id === 'string' ? r.cart_id : null,
        updatedAt: r?.updated_at || null,
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

/**
 * "7p" / "1g 5p": bản ngắn cho ô bàn màn hình PC (ô chỉ rộng ~66px), cùng kiểu "31p" của giờ ngồi trên
 * ô bàn. Chủ quán (2026-11-09): PC phải đọc được giỏ khách như trên điện thoại.
 */
export function cartMinutesShort(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return '<1p';
  return m < 60 ? `${m}p` : `${Math.floor(m / 60)}g ${m % 60}p`;
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
