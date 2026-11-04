/**
 * menuCache.js — Cache menu_items + categories cho phía ADMIN.
 *
 * Mục đích: tránh gọi lại menu_items/categories mỗi lần fetchTables()/poll.
 * Cache CHỈ dùng ở admin (admin/menu ghi, admin/tables đọc). Customer page
 * giữ nguyên (luôn fetch fresh từ server) để không bị hiển thị menu stale.
 *
 * Làm mới:
 *  - admin/menu: mỗi lần fetchData() chạy (mount + sau "Đồng bộ") ghi lại cache.
 *  - Mọi trang đọc qua getMenuCached(): cache cũ hơn MENU_CACHE_MAX_AGE_MS (3 phút) thì
 *    đọc lại server. Máy nhân viên (không mở được /admin/menu) vẫn thấy giá mới, món tắt /
 *    món mới — poll bàn vẫn đọc cache, nhiều nhất 1 lần đọc menu mỗi 3 phút.
 *  - watchMenuCache(): quay lại tab / có mạng lại mà cache cũ hơn 1 phút thì đọc lại.
 *  Nhiều chỗ cùng cần đọc lại một lúc thì chỉ gửi 1 request; đọc lỗi thì dùng tạm cache cũ.
 *
 * Storage: localStorage key `adminMenuCache:v1`
 * Shape: { items: menu_items[], categories: categories[], savedAt: number }
 *   - items: kết quả raw của `select('*, category:categories(name)').order('sort_order').order('created_at')`
 *     (KHÔNG lọc is_available — consumer tự lọc client-side)
 *   - categories: kết quả raw của `select('*').order('sort_order')`
 *     (KHÔNG có placeholder "Chưa phân loại" — consumer tự thêm)
 */

import { supabase } from '@/lib/supabase';

const CACHE_KEY = 'adminMenuCache:v1';
export const MENU_CACHE_MAX_AGE_MS = 3 * 60 * 1000;
export const MENU_FOCUS_MAX_AGE_MS = 60 * 1000;

export function readMenuCache() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.items) || !Array.isArray(data?.categories)) return null;
    return data; // { items, categories, savedAt }
  } catch {
    return null;
  }
}

/** Cache còn dùng được: có giờ lưu, chưa quá maxAgeMs (giờ lưu ở tương lai — đồng hồ máy bị chỉnh — coi như cũ). */
export function isMenuCacheFresh(cache, now = Date.now(), maxAgeMs = MENU_CACHE_MAX_AGE_MS) {
  const savedAt = Number(cache?.savedAt);
  return savedAt > 0 && savedAt <= now && now - savedAt < maxAgeMs;
}

export function writeMenuCache(items, categories) {
  const savedAt = Date.now();
  if (typeof window === 'undefined') return savedAt;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      items: items || [],
      categories: categories || [],
      savedAt,
    }));
  } catch (e) {
    console.error('[menuCache] write error:', e);
  }
  return savedAt;
}

export function clearMenuCache() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(CACHE_KEY);
}

let inflight = null;

/**
 * Fetch fresh từ server + ghi cache. Dùng khi admin/menu load hoặc bấm "Đồng bộ", và khi cache đã cũ.
 * @returns {Promise<{ items: any[], categories: any[], savedAt: number }>}
 */
export async function fetchMenuFromServer() {
  if (inflight) return inflight; // fetchTables + fetchOrdersOnly cùng lúc → 1 request
  inflight = (async () => {
    const [{ data: items, error: e1 }, { data: cats, error: e2 }] = await Promise.all([
      supabase.from('menu_items').select('*, category:categories(name)').order('sort_order').order('created_at'),
      supabase.from('categories').select('*').order('sort_order'),
    ]);
    if (e1) throw new Error('menu_items: ' + e1.message);
    if (e2) throw new Error('categories: ' + e2.message);
    const safeItems = items || [];
    const safeCats = cats || [];
    const savedAt = writeMenuCache(safeItems, safeCats);
    return { items: safeItems, categories: safeCats, savedAt };
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Đọc cache; thiếu hoặc cũ hơn maxAgeMs thì fetch server + cache (lỗi mạng → dùng tạm cache cũ).
 * Consumer (admin/tables) dùng hàm này thay cho query menu_items/categories.
 * @returns {Promise<{ items: any[], categories: any[], savedAt?: number }>}
 */
export async function getMenuCached({ maxAgeMs = MENU_CACHE_MAX_AGE_MS } = {}) {
  const cached = readMenuCache();
  if (cached && isMenuCacheFresh(cached, Date.now(), maxAgeMs)) return cached;
  try {
    return await fetchMenuFromServer();
  } catch (err) {
    if (cached) {
      console.error('[menuCache] refresh error, dùng menu đã lưu:', err.message);
      return cached;
    }
    throw err;
  }
}

/**
 * Quay lại tab / có mạng lại: menu cũ hơn maxAgeMs (1 phút) thì đọc lại server, rồi gọi onMenu(menu).
 * Trả hàm huỷ (dùng làm cleanup của useEffect).
 */
export function watchMenuCache(onMenu, { maxAgeMs = MENU_FOCUS_MAX_AGE_MS } = {}) {
  if (typeof window === 'undefined') return () => {};
  const refresh = () => {
    if (document.visibilityState !== 'visible') return;
    getMenuCached({ maxAgeMs }).then(onMenu).catch(err => console.error('[menuCache] refresh error:', err.message));
  };
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  return () => {
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('online', refresh);
  };
}
