/**
 * Tắt / bật món nhanh ở trang Bàn (/admin/tables) — dùng ĐÚNG các cờ mà trang Thực đơn đang dùng,
 * không thêm cờ mới:
 *   món:       is_available=false (tắt luôn) · is_available=true + hidden_until=<giờ> (tắt đến giờ đó)
 *   lựa chọn:  options[i].hiddenChoices[j] = true (tắt luôn) · <giờ ISO> (tắt đến giờ đó) · false (đang bán)
 * Web khách (order/page.jsx) ẩn món và lựa chọn theo đúng hai quy tắc isDishOff / isChoiceOff dưới đây.
 *
 * Máy chủ luôn đọc lại món ngay trước khi ghi và chỉ đổi cờ ẩn của lựa chọn được chọn (tìm theo tên,
 * không tin vị trí trình duyệt gửi) — tên, giá, danh mục in, SL/1 KM… của lựa chọn giữ nguyên.
 */

// Quán bán qua nửa đêm: "hết hôm nay" = 5 giờ sáng hôm sau (giống giờ máy tự kiểm sổ, dayCheck.mjs).
export const SHIFT_END_HOUR = 5;
export const MAX_CHANGES = 300;
const VN_OFFSET_MS = 7 * 3600000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
// Bộ lọc "options chưa đổi" nằm trên URL; món quá nhiều lựa chọn thì bỏ bộ lọc cho khỏi quá dài.
const MAX_GUARD_URL_CHARS = 6000;

/** Món đang ẩn với khách — giống order/page.jsx: is_available=false hoặc hidden_until chưa qua. */
export function isDishOff(item, now = Date.now()) {
  return !item?.is_available || (!!item.hidden_until && !(new Date(item.hidden_until).getTime() < now));
}

/** Lựa chọn đang ẩn — giống order/page.jsx: true, hoặc giờ ISO chưa qua. */
export function isChoiceOff(flag, now = Date.now()) {
  return flag === true || (typeof flag === 'string' && new Date(flag).getTime() > now);
}

/** Giờ "hết hôm nay": 5h sáng kế tiếp theo giờ Việt Nam. */
export function shiftEndISO(nowMs = Date.now()) {
  const vn = new Date(nowMs + VN_OFFSET_MS);
  let end = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), SHIFT_END_HOUR) - VN_OFFSET_MS;
  if (end <= nowMs) end += 86400000;
  return new Date(end).toISOString();
}

/** Cờ ẩn → "tắt luôn" (true) / "tắt đến 5:00 30/10" (giờ VN chưa qua); còn lại ''. */
export function offLabel(until, now = Date.now()) {
  if (until === true) return 'tắt luôn';
  if (typeof until !== 'string') return '';
  const t = new Date(until).getTime();
  if (!(t > now)) return '';
  const vn = new Date(t + VN_OFFSET_MS);
  const pad = n => String(n).padStart(2, '0');
  return `tắt đến ${vn.getUTCHours()}:${pad(vn.getUTCMinutes())} ${pad(vn.getUTCDate())}/${pad(vn.getUTCMonth() + 1)}`;
}

/** Nhãn tắt của một món: tắt luôn khi is_available=false, không thì giờ hidden_until. */
export function dishOffLabel(item, now = Date.now()) {
  if (!isDishOff(item, now)) return '';
  return !item.is_available ? 'tắt luôn' : (offLabel(item.hidden_until, now) || 'tắt luôn');
}

/** Các lựa chọn của món (bỏ dòng __promo_divisor), kèm vị trí trong options và trạng thái tắt. */
export function dishChoices(item, now = Date.now()) {
  const out = [];
  (Array.isArray(item?.options) ? item.options : []).forEach((opt, optIndex) => {
    if (!opt?.name || !Array.isArray(opt.choices)) return;
    opt.choices.forEach((choice, index) => {
      if (!String(choice || '').trim()) return;
      const flag = opt.hiddenChoices?.[index];
      out.push({ option: opt.name, optIndex, choice, index, off: isChoiceOff(flag, now), label: offLabel(flag, now) });
    });
  });
  return out;
}

const str = (v, max) => String(v ?? '').slice(0, max);

/**
 * Dữ liệu trình duyệt gửi → danh sách thay đổi theo từng món.
 * body: { mode: 'today'|'off', dishes: [{ id, off }], choices: [{ id, option, optIndex, choice, index, off }] }
 */
export function cleanAvailabilityChanges(body) {
  const mode = body?.mode === 'off' ? 'off' : 'today';
  const byId = new Map();
  const get = id => byId.get(id) || byId.set(id, { id, dish: undefined, choices: [] }).get(id);
  const list = v => (Array.isArray(v) ? v : []).slice(0, MAX_CHANGES);
  for (const d of list(body?.dishes)) {
    if (UUID.test(String(d?.id))) get(d.id).dish = !!d.off;
  }
  for (const c of list(body?.choices)) {
    if (!UUID.test(String(c?.id)) || !str(c.option, 100) || !str(c.choice, 100)) continue;
    get(c.id).choices.push({
      option: str(c.option, 100), choice: str(c.choice, 100), off: !!c.off,
      optIndex: Number.isInteger(c.optIndex) ? c.optIndex : -1, index: Number.isInteger(c.index) ? c.index : -1,
    });
  }
  return { mode, items: [...byId.values()] };
}

/**
 * Món (đọc mới từ DB) + thay đổi → { update, skipped }. update chỉ có is_available/hidden_until khi đổi
 * món, và options khi đổi lựa chọn — options là bản sao chỉ khác ở cờ hiddenChoices được chọn.
 * until: giờ ISO (tắt hết hôm nay) hoặc null (tắt luôn).
 */
export function patchMenuItem(row, change, until) {
  const update = {}, skipped = [];
  if (change.dish !== undefined) {
    if (!change.dish) Object.assign(update, { is_available: true, hidden_until: null });
    else if (until) Object.assign(update, { is_available: true, hidden_until: until });
    else Object.assign(update, { is_available: false, hidden_until: null });
  }
  if (change.choices?.length) {
    const options = Array.isArray(row?.options) ? structuredClone(row.options) : [];
    let touched = false;
    for (const c of change.choices) {
      const has = o => o?.name === c.option && Array.isArray(o.choices) && o.choices.includes(c.choice);
      const opt = has(options[c.optIndex]) ? options[c.optIndex] : options.find(has);
      if (!opt) { skipped.push(c); continue; }
      const index = opt.choices[c.index] === c.choice ? c.index : opt.choices.indexOf(c.choice);
      const hidden = Array.isArray(opt.hiddenChoices) ? opt.hiddenChoices : [];
      while (hidden.length < opt.choices.length) hidden.push(false);
      hidden[index] = c.off ? (until || true) : false;
      opt.hiddenChoices = hidden;
      touched = true;
    }
    if (touched) update.options = options;
  }
  return { update, skipped };
}

async function writeRow(db, id, update, guard) {
  let q = db.from('menu_items').update(update).eq('id', id);
  if (guard) q = q.eq('options', guard);
  return q.select('id');
}

/**
 * Ghi tất cả thay đổi. Mỗi món: đọc lại → sửa cờ → ghi, và khi đổi lựa chọn thì chỉ ghi nếu options
 * vẫn y như lúc đọc (có người vừa sửa món thì đọc lại và làm lại, tối đa 3 lần).
 * → { until, saved: [{id,name}], skipped: [{id,name,option,choice}], missing: [id], failed: [{id,name}] }
 */
export async function saveAvailability(db, { mode, items }, nowMs = Date.now()) {
  const until = mode === 'today' ? shiftEndISO(nowMs) : null;
  const saved = [], skipped = [], missing = [], failed = [];
  for (const change of items) {
    let name = '', done = false;
    try {
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        const { data: row, error } = await db.from('menu_items')
          .select('id, name, is_available, hidden_until, options').eq('id', change.id).maybeSingle();
        if (error) throw error;
        if (!row) { missing.push(change.id); done = true; break; }
        name = row.name || '';
        const { update, skipped: notFound } = patchMenuItem(row, change, until);
        if (attempt === 0) skipped.push(...notFound.map(c => ({ id: change.id, name, option: c.option, choice: c.choice })));
        if (!Object.keys(update).length) { done = true; break; }
        let guard = null;
        if (update.options) {
          const json = JSON.stringify(row.options);
          if (encodeURIComponent(json).length <= MAX_GUARD_URL_CHARS) guard = json;
        }
        let { data: written, error: writeError } = await writeRow(db, change.id, update, guard);
        // DB không chạy được bộ lọc (kiểu cột lạ, URL dài…): ghi thẳng, vẫn là bản vừa đọc lại.
        if (writeError && guard) ({ data: written, error: writeError } = await writeRow(db, change.id, update, null));
        if (writeError) throw writeError;
        if (written?.length) { saved.push({ id: change.id, name }); done = true; }
      }
    } catch (err) {
      console.error('[menuAvailability] save error:', change.id, err?.message || err);
    }
    if (!done) failed.push({ id: change.id, name });
  }
  return { until, saved, skipped, missing, failed };
}
