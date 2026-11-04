/**
 * Sổ tay: loại "Khác" của dòng hàng (xăng xe, sửa chữa, đồ dùng, in ấn…). Phiếu đi chợ có 2 tab:
 * "Hàng ốc" (dòng không có loại — như trước giờ) và "Khác" (dòng có `category` = id loại).
 * Chủ quán tự tạo / đổi tên / xoá loại; danh sách lưu ở finance_settings['note_categories']
 * = { categories: [{ id, name }] }. Loại "Khác" chung (OTHER_ID) luôn có, cho dòng chưa rõ loại
 * và dòng của loại đã bị xoá.
 */
export const OTHER_ID = 'other';
export const OTHER_NAME = 'Khác';
export const MAX_CATEGORIES = 30;
const ID = /^[a-z0-9_-]{1,40}$/i;
const key = s => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Loại của một dòng hàng: '' = hàng ốc, còn lại là id loại Khác. */
export const lineCategory = item => {
  const c = String(item?.category ?? '');
  return ID.test(c) ? c : '';
};

/**
 * Danh sách loại chủ gửi lên → [{ id, name }]: bỏ tên trống / trùng, tên ≤ 40 chữ, tối đa 30 loại,
 * giữ id cũ (để dòng hàng đã ghi vẫn đúng loại), loại mới thì đặt id bằng makeId().
 */
export function cleanCategories(list, makeId) {
  const out = [];
  const names = new Set([key(OTHER_NAME)]);
  const ids = new Set([OTHER_ID]);
  for (const c of Array.isArray(list) ? list : []) {
    const name = String(c?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name || names.has(key(name))) continue;
    let id = ID.test(String(c?.id ?? '')) && !ids.has(c.id) ? c.id : '';
    while (!id || ids.has(id)) id = makeId();
    names.add(key(name)); ids.add(id);
    out.push({ id, name });
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

/** Tên loại (loại đã xoá hoặc chưa chọn → "Khác"). */
export const categoryName = (id, categories = []) => categories.find(c => c.id === id)?.name || OTHER_NAME;

/** Các loại để chọn khi ghi phiếu: loại chủ tạo, cuối cùng là "Khác". */
export const categoryOptions = (categories = []) => [...categories, { id: OTHER_ID, name: OTHER_NAME }];

/**
 * Tiền các dòng loại Khác của một phiếu: { [id loại]: tiền }. lineCost: tiền một dòng (giá × số lượng).
 * total (tổng phiếu đã lưu) chặn trên — phiếu lệch tiền không làm phần hàng ốc âm.
 */
export function noteOtherCosts(items, total, lineCost) {
  const out = {};
  let left = Math.max(0, Number(total) || 0);
  for (const item of items || []) {
    const id = lineCategory(item);
    if (!id || !String(item?.name || '').trim()) continue;
    const cost = Math.min(left, Math.max(0, lineCost(item) || 0));
    if (!cost) continue;
    out[id] = (out[id] || 0) + cost;
    left -= cost;
  }
  return out;
}

// Tên khoản để cộng chung: "Tiền  điện" = "tiền điện" (không phân biệt hoa thường, khoảng trắng, dấu chấm cuối).
const itemKey = s => key(s).replace(/[.,;:!]+$/, '').trim();
const itemLabel = s => { const t = String(s || '').replace(/\s+/g, ' ').trim().replace(/[.,;:!]+$/, ''); return t.charAt(0).toUpperCase() + t.slice(1); };

/**
 * Như noteOtherCosts nhưng giữ từng khoản theo tên dòng hàng (tiền nhà, tiền điện…): { [id loại]: { [tên]: { name, amount } } }.
 * Cùng cách chặn tiền theo tổng phiếu nên cộng các khoản của một loại đúng bằng tiền loại đó.
 */
export function noteOtherItems(items, total, lineCost) {
  const out = {};
  let left = Math.max(0, Number(total) || 0);
  for (const item of items || []) {
    const id = lineCategory(item), name = String(item?.name || '').trim();
    if (!id || !name) continue;
    const cost = Math.min(left, Math.max(0, lineCost(item) || 0));
    if (!cost) continue;
    addNamedCost((out[id] ||= {}), name, cost);
    left -= cost;
  }
  return out;
}

/** Cộng tiền vào khoản theo tên: map { [tên đã gộp]: { name, amount } } (tên hiện là cách viết gặp đầu tiên). */
export function addNamedCost(map, name, amount) {
  const k = itemKey(name), v = Number(amount) || 0;
  if (!k || !(v > 0)) return map;
  map[k] = { name: map[k]?.name || itemLabel(name), amount: (map[k]?.amount || 0) + v };
  return map;
}

/** Các khoản { [tên]: { name, amount } } → [{ name, amount }] nhiều tiền trước (làm tròn đồng). */
export const namedCostList = map => Object.values(map || {}).map(x => ({ name: x.name, amount: Math.round(Number(x.amount) || 0) })).filter(x => x.amount > 0)
  .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'vi'));

/** Cộng dồn { id loại: { tên: { name, amount } } } của b vào a. */
export function addItemCosts(a, b) {
  for (const [id, byName] of Object.entries(b || {})) {
    const into = (a[id] ||= {});
    for (const [k, x] of Object.entries(byName || {})) into[k] = { name: into[k]?.name || x.name, amount: (into[k]?.amount || 0) + (Number(x.amount) || 0) };
  }
  return a;
}

/**
 * Gộp tiền theo loại của id lạ / đã xoá vào "Khác"; trả [{ id, name, amount, items? }] theo thứ tự danh sách loại.
 * itemsById (noteOtherItems / addItemCosts): có thì mỗi loại kèm items [{ name, amount }] — từng khoản, nhiều tiền trước.
 */
export function otherCostRows(byId = {}, categories = [], itemsById = null) {
  const known = new Set(categories.map(c => c.id));
  const sums = {}, items = {};
  for (const [id, v] of Object.entries(byId || {})) {
    const k = known.has(id) ? id : OTHER_ID;
    sums[k] = (sums[k] || 0) + (Number(v) || 0);
  }
  for (const [id, byName] of Object.entries(itemsById || {})) addItemCosts(items, { [known.has(id) ? id : OTHER_ID]: byName });
  return categoryOptions(categories).filter(c => sums[c.id] > 0)
    .map(c => ({ id: c.id, name: c.name, amount: sums[c.id], ...(itemsById ? { items: namedCostList(items[c.id]) } : {}) }));
}

/** Cộng dồn { id: tiền } của b vào a. */
export function addCosts(a, b) {
  for (const [id, v] of Object.entries(b || {})) a[id] = (a[id] || 0) + (Number(v) || 0);
  return a;
}
