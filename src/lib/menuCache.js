/**
 * menuCache.js — Cache menu_items + categories cho phía ADMIN.
 *
 * Mục đích: tránh gọi lại menu_items/categories mỗi lần fetchTables()/poll.
 * Cache CHỈ dùng ở admin (admin/menu ghi, admin/tables đọc). Customer page
 * giữ nguyên (luôn fetch fresh từ server) để không bị hiển thị menu stale.
 *
 * Invalidation: chỉ do admin/menu — mỗi lần fetchData() chạy (mount + sau
 * khi bấm "Đồng bộ" trong syncDraftChanges) sẽ writeMenuCache() → cache tươi.
 * Không có TTL, không auto-refresh.
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

export function writeMenuCache(items, categories) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      items: items || [],
      categories: categories || [],
      savedAt: Date.now(),
    }));
  } catch (e) {
    console.error('[menuCache] write error:', e);
  }
}

export function clearMenuCache() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(CACHE_KEY);
}

/**
 * Fetch fresh từ server + ghi cache. Dùng khi admin/menu load hoặc bấm "Đồng bộ".
 * @returns {Promise<{ items: any[], categories: any[] }>}
 */
export async function fetchMenuFromServer() {
  const [{ data: items, error: e1 }, { data: cats, error: e2 }] = await Promise.all([
    supabase.from('menu_items').select('*, category:categories(name)').order('sort_order').order('created_at'),
    supabase.from('categories').select('*').order('sort_order'),
  ]);
  if (e1) throw new Error('menu_items: ' + e1.message);
  if (e2) throw new Error('categories: ' + e2.message);
  const safeItems = items || [];
  const safeCats = cats || [];
  writeMenuCache(safeItems, safeCats);
  return { items: safeItems, categories: safeCats };
}

/**
 * Đọc cache. Nếu miss thì fetch server + cache.
 * Consumer (admin/tables) dùng hàm này thay cho query menu_items/categories.
 * @returns {Promise<{ items: any[], categories: any[], savedAt?: number }>}
 */
export async function getMenuCached() {
  const cached = readMenuCache();
  if (cached) return cached;
  return fetchMenuFromServer();
}
