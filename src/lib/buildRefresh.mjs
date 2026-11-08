/**
 * Tab admin mở cả ngày (máy PC ở quầy để /admin/tables từ sáng tới tối) tự lấy bản mới sau khi
 * "Đưa lên" — không ai phải bấm F5. Trang hỏi /api/version vài phút một lần và mỗi khi quay lại tab;
 * mã bản trên máy chủ khác mã bản trang đang chạy thì CHỜ lúc an toàn rồi tự tải lại. Không hỏi
 * "có chắc không" (chủ quán không muốn), không có thanh báo thường trực — chỉ một dòng
 * "Có bản mới — đang tải lại" vài giây ngay trước khi tải.
 *
 * Lúc an toàn = trang không giữ lại (giỏ nháp có món, đang thanh toán / đóng bàn — useReloadHold),
 * không có khung / Swal đang mở, không ô nhập nào đang được bấm vào hay còn chữ chưa gửi, và người
 * dùng đã để yên MIN_IDLE_MS (tab đang ẩn thì khỏi chờ để yên). Chưa an toàn thì xem lại sau.
 * Phần đọc trang (khung, ô nhập) ở src/lib/useBuildRefresh.js; ở đây là phần quyết định, thử bằng node --test.
 */

export const CHECK_EVERY_MS = 3 * 60 * 1000;        // hỏi máy chủ mã bản
export const FETCH_GAP_MS = 30 * 1000;              // quay lại tab / bấm vào cửa sổ: hỏi lại nhưng không dày hơn
export const RECHECK_SAFE_MS = 10 * 1000;           // có bản mới mà chưa an toàn: xem lại sau chừng này
export const MIN_IDLE_MS = 45 * 1000;               // màn hình đang mở: không ai chạm/gõ/rê chuột ít nhất chừng này
export const NOTICE_MS = 3000;                      // "Có bản mới — đang tải lại" hiện chừng này rồi mới tải
export const RETRY_SAME_BUILD_MS = 30 * 60 * 1000;  // đã tải lại vì bản này mà trang vẫn cũ → 30 phút sau mới thử lại

const okId = v => typeof v === 'string' && v.trim() !== '';

/** Máy chủ đang chạy bản khác bản của trang? Không biết mã (lỗi mạng, đang khởi động lại) = không. */
export function isNewBuild(current, latest) {
  return okId(current) && okId(latest) && current.trim() !== latest.trim();
}

/**
 * Có bản mới thì tải lại ngay, chờ, hay thôi.
 * state: { current, latest, hidden, modalOpen, editing, unsentText, holds: [nhãn], idleMs, lastAttempt: { build, at }, now }
 * → { action: 'none' | 'wait' | 'reload', reason }
 */
export function reloadDecision(state = {}) {
  const {
    current, latest, hidden = false, modalOpen = false, editing = false, unsentText = false,
    holds = [], idleMs = Infinity, lastAttempt = null, now = Date.now(),
  } = state;
  if (!isNewBuild(current, latest)) return { action: 'none', reason: okId(latest) ? 'same-build' : 'unknown' };
  // Vừa tải lại vì đúng bản này mà trang vẫn chạy bản cũ (bộ nhớ đệm, máy chủ đang đổi) → không tải liên tục.
  if (lastAttempt && lastAttempt.build === latest && now - Number(lastAttempt.at) < RETRY_SAME_BUILD_MS) {
    return { action: 'none', reason: 'already-tried' };
  }
  if (Array.isArray(holds) && holds.length) return { action: 'wait', reason: `hold:${holds[0]}` };
  if (modalOpen) return { action: 'wait', reason: 'modal' };
  if (editing) return { action: 'wait', reason: 'editing' };
  if (unsentText) return { action: 'wait', reason: 'unsent-text' };
  if (!hidden && !(idleMs >= MIN_IDLE_MS)) return { action: 'wait', reason: 'recent-activity' };
  return { action: 'reload', reason: hidden ? 'hidden' : 'idle' };
}

/** Bản ghi lần tải lại trước (sessionStorage) → { build, at } hoặc null. */
export function parseAttempt(raw) {
  try {
    const v = JSON.parse(raw || 'null');
    return v && okId(v.build) && Number.isFinite(Number(v.at)) ? { build: v.build, at: Number(v.at) } : null;
  } catch { return null; }
}

// ── Trang giữ lại không cho tải (giỏ nháp có món, đang thanh toán…) ──────────────────────────────
const holds = new Map();
/** Bật/tắt một lý do giữ. key riêng cho từng chỗ gọi (useReloadHold dùng useId). */
export function setReloadHold(key, label, on) {
  if (on) holds.set(key, label || 'busy');
  else holds.delete(key);
}
export function reloadHoldLabels() { return [...holds.values()]; }

// ── Đọc ô nhập (nhận object giống phần tử DOM để thử được bằng node) ──────────────────────────────
const TEXT_TYPES = new Set(['', 'text', 'search', 'tel', 'number', 'email', 'url', 'password',
  'date', 'time', 'datetime-local', 'month', 'week']);

/** Ô gõ chữ được (input chữ/số, textarea, vùng sửa được). Nút, ô tích, danh sách chọn: không. */
export function isTextEntry(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return TEXT_TYPES.has(String(el.type ?? '').toLowerCase());
}

/** Ô tìm kiếm / ô trang tự đánh dấu data-reload-safe: mất chữ trong đó không sao (không phải dữ liệu chưa gửi). */
export function isReloadSafeField(el) {
  if (!el) return false;
  if (String(el.type ?? '').toLowerCase() === 'search') return true;
  return typeof el.getAttribute === 'function' && el.getAttribute('data-reload-safe') != null;
}

/** Đang gõ: con trỏ đang nằm trong một ô nhập (trừ ô tìm kiếm). */
export function isEditing(activeEl) {
  return isTextEntry(activeEl) && !isReloadSafeField(activeEl);
}

const fieldText = el => String((el.isContentEditable ? el.textContent : el.value) ?? '');

/**
 * Còn chữ chưa gửi: trong các ô NGƯỜI DÙNG ĐÃ GÕ (touched), ô nào còn trên trang và còn chữ.
 * Ô trang tự điền sẵn (ngày hôm nay, giá cũ…) mà không ai gõ thì không tính. Ô đã rời trang thì bỏ khỏi touched.
 */
export function hasUnsentText(touched) {
  let found = false;
  for (const el of touched) {
    if (!el || el.isConnected === false) { touched.delete?.(el); continue; }
    if (!found && isTextEntry(el) && !isReloadSafeField(el) && fieldText(el).trim() !== '') found = true;
  }
  return found;
}

/** Khung phủ gần hết màn hình (lớp mờ sau khung, trang chọn món toàn màn hình…) — sidebar, thông báo nhỏ thì không. */
export function coversScreen(rect, viewWidth, viewHeight) {
  if (!rect || !(viewWidth > 0) || !(viewHeight > 0)) return false;
  return rect.width >= viewWidth * 0.6 && rect.height >= viewHeight * 0.6;
}

/** Một phần tử là lớp khung đang mở: cố định (fixed), đang hiện, phủ gần hết màn hình. */
export function isOverlay(style, rect, viewWidth, viewHeight) {
  if (!style || style.position !== 'fixed' || style.display === 'none' || style.visibility === 'hidden') return false;
  return coversScreen(rect, viewWidth, viewHeight);
}
