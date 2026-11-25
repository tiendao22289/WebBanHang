/**
 * Gọi gia vị: nhân viên gửi đơn cho chủ gia vị (người ngoài, mở bằng link riêng), chủ gia vị soạn hàng và điền giá,
 * nhân viên bấm "Đã nhận". Tiền đơn đã nhận là chi phí gia vị của ngày nhận và ghi nợ chủ gia vị; chủ quán trả gom
 * (spice_payments). Dùng chung cho máy chủ, trang nhân viên, trang chủ gia vị và Sổ thu chi.
 *
 * Dòng hàng (spice_orders.items): { name, unit, qty, received_qty (null = nhận đủ qty), price (giá 1 đơn vị, null = chưa có),
 * old_price (giá lần trước của chính chủ gia vị đó cho món này, lúc gửi đơn) }.
 */

export const MAX_SPICE_LINES = 60;
export const MAX_SPICE_PRICE = 50_000_000;
export const MAX_SPICE_QTY = 10_000;
/** Tổng một đơn tối đa (cột total trong DB). */
export const MAX_SPICE_TOTAL = 1_000_000_000;
const TOO_BIG = 'Tổng đơn quá lớn, kiểm tra lại giá và số lượng.';

const DAY_MS = 86400000;
const ms = iso => Date.parse(iso) || 0;
/** Ngày theo giờ Việt Nam của một mốc giờ ISO. */
export const vnDateOf = iso => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 10);

/** Tên món để so khớp: bỏ khoảng trắng thừa, không phân biệt hoa thường. */
export const itemKey = name => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const cleanName = (name, max = 60) => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Số lượng: "1,5" = "1.5" = 1.5; không hợp lệ / ≤ 0 → null. */
export function parseQty(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= MAX_SPICE_QTY ? Math.round(value * 1000) / 1000 : null;
  const s = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return parseQty(Number(s));
}

/**
 * Giá 1 đơn vị: "25.000" = "25000" = "25k" = 25000; trống → null (chưa có giá); 0 được (món tặng).
 * Chữ lạ / quá lớn → undefined (không hợp lệ).
 */
export function parsePrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= MAX_SPICE_PRICE ? Math.round(value) : undefined;
  const s = String(value).trim().toLowerCase().replace(/\s/g, '');
  if (!s) return null;
  const k = /^(\d+(?:[.,]\d+)?)k$/.exec(s);
  if (k) return parsePrice(Number(k[1].replace(',', '.')) * 1000);
  if (!/^\d[\d.,]*$/.test(s)) return undefined;
  return parsePrice(Number(s.replace(/[.,]/g, '')));
}

export const lineQty = line => {
  const r = line?.received_qty;
  return r === null || r === undefined ? Number(line?.qty) || 0 : Number(r) || 0;
};
const hasPrice = line => line?.price !== null && line?.price !== undefined && line?.price !== '';
export const lineAmount = line => (hasPrice(line) ? Math.round(lineQty(line) * (Number(line.price) || 0)) : 0);
export const orderTotal = items => (items || []).reduce((s, l) => s + lineAmount(l), 0);
/** Số dòng chưa có giá (dòng nhận 0 thì không cần giá). */
export const missingPrices = items => (items || []).filter(l => !hasPrice(l) && lineQty(l) > 0).length;
/** Giá đổi so với lần trước: + tăng, − giảm, 0 / null = như cũ / không so được. */
export const priceChange = line => (hasPrice(line) && line?.old_price !== null && line?.old_price !== undefined
  ? Number(line.price) - Number(line.old_price) : null);

/**
 * Trạng thái đơn: cancelled · new (mới gửi, chủ gia vị chưa bấm Xong) · priced (đã soạn, có giá, chờ nhân viên nhận)
 * · waiting_price (đã nhận hàng nhưng còn món chưa có giá) · done (đã nhận, đủ giá — tính vào chi phí, ghi nợ).
 */
export function orderState(order) {
  if (order?.cancelled_at) return 'cancelled';
  if (order?.received_at) return missingPrices(order.items) ? 'waiting_price' : 'done';
  return order?.priced_at ? 'priced' : 'new';
}
/** Dòng được thêm sau khi gọi đơn (không phải lúc gọi): hiện "➕ ai thêm lúc nào". */
export const addedLater = (order, line) => !!line?.added_at && Math.abs(ms(line.added_at) - ms(order?.created_at)) > 1000;

export const STATE_LABELS = {
  cancelled: 'Đã huỷ', new: 'Mới gửi', priced: 'Đã soạn · chờ nhận', waiting_price: 'Đã nhận · chờ giá', done: 'Đã nhận',
};

/**
 * Chủ gia vị sửa giá được khi đơn chưa nhận; đơn đã nhận thì chỉ điền được món còn trống giá
 * (chủ quán sửa được mọi lúc qua trang Gia vị).
 */
export const supplierCanPrice = (order, index) => {
  if (!order || order.cancelled_at) return false;
  if (!order.received_at) return true;
  return !hasPrice(order.items?.[index]);
};

/**
 * Giá gần nhất mỗi món của một chủ gia vị: Map itemKey → { price, at }. Lấy từ dòng có giá của các đơn chưa huỷ,
 * đơn mới nhất trước (created_at).
 */
export function lastPrices(orders, supplierId) {
  const out = new Map();
  const list = (orders || []).filter(o => o.supplier_id === supplierId && !o.cancelled_at)
    .sort((a, b) => ms(b.created_at) - ms(a.created_at));
  for (const o of list) for (const l of o.items || []) {
    const k = itemKey(l.name);
    if (k && hasPrice(l) && !out.has(k)) out.set(k, { price: Number(l.price), at: o.created_at });
  }
  return out;
}

/** Nợ từng chủ gia vị: tiền các đơn đã nhận − đã trả. { [supplier_id]: { owed, paid, debt, waiting } } */
export function supplierBalances(orders, payments) {
  const out = {};
  const row = id => (out[id] ||= { owed: 0, paid: 0, debt: 0, waiting: 0 });
  for (const o of orders || []) {
    if (o.cancelled_at || !o.received_at) continue;
    const r = row(o.supplier_id);
    r.owed += orderTotal(o.items);
    if (missingPrices(o.items)) r.waiting += 1;
  }
  for (const p of payments || []) row(p.supplier_id).paid += Number(p.amount) || 0;
  for (const r of Object.values(out)) r.debt = r.owed - r.paid;
  return out;
}

/**
 * Tiền gia vị theo ngày nhận cho Sổ thu chi: { [ngày]: { amount, orders, waiting, items: { key: { name, amount } } } }.
 * Chỉ đơn đã nhận (chưa huỷ); món chưa có giá tính 0 và đếm vào waiting.
 */
export function spiceCostByDay(orders) {
  const out = {};
  for (const o of orders || []) {
    if (o.cancelled_at || !o.received_at) continue;
    const date = o.received_date || vnDateOf(o.received_at);
    const d = (out[date] ||= { amount: 0, orders: 0, waiting: 0, items: {} });
    d.orders += 1;
    if (missingPrices(o.items)) d.waiting += 1;
    for (const l of o.items || []) {
      const amount = lineAmount(l);
      d.amount += amount;
      const k = itemKey(l.name);
      if (!k || amount <= 0) continue;
      d.items[k] = { name: d.items[k]?.name || cleanName(l.name), amount: (d.items[k]?.amount || 0) + amount };
    }
  }
  return out;
}

const periodKey = (date, period) => (period === 'year' ? date.slice(0, 4) : period === 'month' ? date.slice(0, 7) : date);

/**
 * Thống kê từng món theo ngày / tháng / năm (đơn đã nhận, theo ngày nhận).
 * → [{ key (kỳ), total, items: [{ name, unit, qty, amount, price (giá cuối kỳ), first (giá đầu kỳ), change (giá cuối − giá
 *    lần trước của đơn đầu kỳ), suppliers }] }], kỳ mới nhất trước; món nhiều tiền trước.
 */
export function spiceStats(orders, { period = 'day', supplierNames = {} } = {}) {
  const groups = new Map();
  const list = (orders || []).filter(o => !o.cancelled_at && o.received_at)
    .sort((a, b) => ms(a.received_at) - ms(b.received_at));
  for (const o of list) {
    const date = o.received_date || vnDateOf(o.received_at);
    const key = periodKey(date, period);
    const g = groups.get(key) || { key, total: 0, items: new Map() };
    groups.set(key, g);
    for (const l of o.items || []) {
      const k = itemKey(l.name);
      if (!k) continue;
      const amount = lineAmount(l);
      g.total += amount;
      const it = g.items.get(k) || { name: cleanName(l.name), unit: l.unit || '', qty: 0, amount: 0, price: null, first: null, before: null, suppliers: new Set() };
      g.items.set(k, it);
      it.qty += lineQty(l);
      it.amount += amount;
      if (hasPrice(l)) {
        if (it.first === null) { it.first = Number(l.price); it.before = l.old_price ?? null; }
        it.price = Number(l.price);
      }
      if (supplierNames[o.supplier_id]) it.suppliers.add(supplierNames[o.supplier_id]);
    }
  }
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key)).map(g => ({
    key: g.key, total: g.total,
    items: [...g.items.values()].map(it => ({
      name: it.name, unit: it.unit, qty: Math.round(it.qty * 1000) / 1000, amount: it.amount, price: it.price, first: it.first,
      change: it.price !== null && it.before !== null && it.before !== undefined ? it.price - Number(it.before) : null,
      suppliers: [...it.suppliers],
    })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'vi')),
  }));
}

/**
 * Mục Gia vị của một ngày cho Thống kê nhanh / Sổ thu chi: từng món kèm giá tăng / giảm so với lần trước,
 * tiền đã trả trong ngày và nợ còn lại tới hết ngày đó.
 */
export function spiceDayData({ orders = [], payments = [], date, supplierNames = {} }) {
  const day = (orders || []).filter(o => !o.cancelled_at && o.received_at && (o.received_date || vnDateOf(o.received_at)) === date);
  const lines = [];
  for (const o of day) for (const l of o.items || []) {
    if (!itemKey(l.name)) continue;
    lines.push({ name: cleanName(l.name), unit: l.unit || '', qty: lineQty(l), price: hasPrice(l) ? Number(l.price) : null,
      old_price: l.old_price ?? null, change: priceChange(l), amount: lineAmount(l), supplier: supplierNames[o.supplier_id] || '' });
  }
  const until = (orders || []).filter(o => !o.cancelled_at && o.received_at && (o.received_date || vnDateOf(o.received_at)) <= date);
  const paidUntil = (payments || []).filter(p => p.paid_date <= date);
  const owed = until.reduce((s, o) => s + orderTotal(o.items), 0) - paidUntil.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const paidToday = (payments || []).filter(p => p.paid_date === date);
  return {
    total: lines.reduce((s, l) => s + l.amount, 0), orders: day.length, waiting: day.filter(o => missingPrices(o.items)).length,
    lines, up: lines.filter(l => l.change > 0).length, down: lines.filter(l => l.change < 0).length,
    paid: paidToday.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    payments: paidToday.map(p => ({ supplier: supplierNames[p.supplier_id] || '', amount: Number(p.amount) || 0, method: p.method })),
    debt: owed,
  };
}

const vnd = n => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const qtyText = q => String(Math.round((Number(q) || 0) * 1000) / 1000).replace('.', ',');

/** Dòng giá tăng / giảm cho người đọc: "▲ 5.000đ" / "▼ 2.000đ" / "". */
export const changeText = change => (change > 0 ? `▲ ${vnd(change)}` : change < 0 ? `▼ ${vnd(-change)}` : '');

/** Tin nhắn nhân viên gửi qua Zalo cho chủ gia vị (kèm link soạn hàng). */
export function shareText({ supplierName = '', items = [], note = '', link = '', by = '', title = 'Quán gọi gia vị' }) {
  const lines = [`🧂 ${title}${supplierName ? ` – gửi ${supplierName}` : ''}`];
  for (const l of items) lines.push(`• ${cleanName(l.name)}: ${qtyText(l.qty)}${l.unit ? ` ${l.unit}` : ''}`);
  if (note) lines.push(`Ghi chú: ${note}`);
  if (by) lines.push(`Người gọi: ${by}`);
  if (link) lines.push('', `Mở link đơn này để soạn hàng và điền giá: ${link}`);
  return lines.join('\n');
}

/** Ngày đầu của kỳ thống kê gần đây: ngày → 30 ngày, tháng → 12 tháng, năm → từ 2026. */
export function statsFrom(period, today) {
  if (period === 'year') return '2026-01-01';
  if (period === 'month') return `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}-01`;
  return new Date(Date.parse(`${today}T00:00:00Z`) - 30 * DAY_MS).toISOString().slice(0, 10);
}

/* ---------- Sửa đơn (dùng chung cho /api/admin/spices và /api/spice-supplier) ---------- */

const MAX_LOG = 300;
const pushLog = (order, events) => [...(Array.isArray(order?.log) ? order.log : []), ...events].slice(-MAX_LOG);
const logItems = lines => lines.map(l => ({ name: l.name, qty: l.qty, unit: l.unit }));

/**
 * Dòng hàng nhân viên gửi lên → dòng lưu: kiểm tên / số lượng, không trùng món (cả với dòng đã có), giá lấy giá lần trước
 * của chủ gia vị (last: Map từ lastPrices), ghi ai thêm lúc nào. → { lines } hoặc { error }.
 */
export function buildLines(raw, { last = new Map(), existing = [], by = '', at = '' } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length + existing.length > MAX_SPICE_LINES) return { error: `Tối đa ${MAX_SPICE_LINES} món một đơn.` };
  const seen = new Set(existing.map(l => itemKey(l.name)));
  const lines = [];
  for (const l of list) {
    const name = cleanName(l?.name);
    if (!name) continue;
    const qty = parseQty(l?.qty);
    if (qty === null) return { error: `Số lượng "${name}" không hợp lệ.` };
    if (seen.has(itemKey(name))) return { error: `"${name}" đã có trong đơn rồi.` };
    seen.add(itemKey(name));
    const old = last.get(itemKey(name))?.price ?? null;
    lines.push({ name, unit: cleanName(l?.unit, 20), qty, received_qty: null, price: old, old_price: old, added_by: by, added_at: at });
  }
  if (!lines.length) return { error: 'Chưa có món nào.' };
  return { lines };
}

/** Đơn mới: dòng + lịch sử "gọi". */
export function createOrderRow({ lines, note = '', by, byId = null, at, supplierId }) {
  return {
    supplier_id: supplierId, items: lines, total: orderTotal(lines), note: note || null,
    created_by: byId, created_by_name: by, created_at: at, updated_at: at,
    log: [{ at, by, who: 'staff', type: 'create', items: logItems(lines), ...(note ? { note } : {}) }],
  };
}

/** Nhân viên thêm món vào đơn chưa nhận. → { patch } hoặc { error }. */
export function addLines(order, raw, { last, by, at, note = '' }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (order.received_at) return { error: 'Đơn đã nhận hàng, gọi đơn mới để thêm.' };
  const built = buildLines(raw, { last, existing: order.items, by, at });
  if (built.error) return built;
  const items = [...order.items, ...built.lines];
  if (orderTotal(items) > MAX_SPICE_TOTAL) return { error: TOO_BIG };
  // Chủ gia vị đã báo soạn xong mà quán gọi thêm: đơn về lại "Mới gửi" để chủ gia vị soạn và điền giá món thêm.
  return { patch: { items, total: orderTotal(items), ...(order.priced_at ? { priced_at: null } : {}),
    log: pushLog(order, [{ at, by, who: 'staff', type: 'add', items: logItems(built.lines), ...(note ? { note } : {}) }]) }, lines: built.lines };
}

/**
 * Đổi giá: prices [{ index, price }] (trống = bỏ giá). who 'admin' sửa mọi dòng; 'supplier' theo supplierCanPrice.
 * done = chủ gia vị bấm "Đã soạn xong" (đặt priced_at lần đầu). note (chỉ khi gửi) = ghi chú của chủ gia vị.
 * → { patch (null = không đổi gì) } hoặc { error }.
 */
export function applyPrices(order, prices, { by, at, who = 'supplier', done = false, note } = {}) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (!Array.isArray(prices) || prices.length > MAX_SPICE_LINES) return { error: 'Giá gửi lên không hợp lệ.' };
  const items = order.items.map(l => ({ ...l }));
  const changes = [];
  for (const p of prices) {
    const i = Number(p?.index);
    if (!Number.isInteger(i) || i < 0 || i >= items.length) return { error: 'Dòng hàng không hợp lệ.' };
    const price = parsePrice(p?.price);
    if (price === undefined) return { error: `Giá "${items[i].name}" không hợp lệ.` };
    const before = items[i].price ?? null;
    if (before === price) continue;
    if (who !== 'admin' && !supplierCanPrice(order, i)) return { error: `"${items[i].name}": quán đã nhận hàng, muốn sửa giá thì báo chủ quán.` };
    items[i].price = price;
    changes.push({ name: items[i].name, from: before, to: price });
  }
  const events = [];
  if (changes.length) events.push({ at, by, who, type: 'price', changes });
  const patch = { items, total: orderTotal(items) };
  if (done && !order.priced_at && !order.received_at) { patch.priced_at = at; events.push({ at, by, who, type: 'done' }); }
  if (note !== undefined) {
    const clean = String(note ?? '').trim().slice(0, 300) || null;
    if (clean !== (order.supplier_note ?? null)) { patch.supplier_note = clean; events.push({ at, by, who, type: 'note', note: clean || '' }); }
  }
  if (!events.length) return { patch: null };
  if (patch.total > MAX_SPICE_TOTAL) return { error: TOO_BIG };
  patch.log = pushLog(order, events);
  return { patch };
}

/** Nhân viên bấm Đã nhận: received[i] = số nhận (trống = nhận đủ). → { patch } hoặc { error }. */
export function receiveOrder(order, received, { by, at }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (order.received_at) return { error: `Đơn đã được ${order.received_by_name || 'người khác'} bấm nhận rồi.` };
  const list = Array.isArray(received) ? received : [];
  const short = [];
  const items = order.items.map((l, i) => {
    const r = list[i];
    if (r === null || r === undefined || String(r).trim() === '') return { ...l, received_qty: null };
    const q = Number(String(r).replace(',', '.')) === 0 ? 0 : parseQty(r);
    if (q === null) return { ...l, received_qty: null };
    if (q !== Number(l.qty)) short.push({ name: l.name, qty: l.qty, got: q, unit: l.unit });
    return { ...l, received_qty: q === Number(l.qty) ? null : q };
  });
  if (orderTotal(items) > MAX_SPICE_TOTAL) return { error: TOO_BIG };
  return { patch: {
    items, total: orderTotal(items), received_at: at, received_date: vnDateOf(at), received_by_name: by,
    log: pushLog(order, [{ at, by, who: 'staff', type: 'receive', ...(short.length ? { short } : {}) }]),
  } };
}

export function cancelOrder(order, { by, at, reason = '' }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (order.received_at) return { error: 'Đơn đã nhận hàng, không huỷ được.' };
  return { patch: { cancelled_at: at, cancelled_by_name: by, log: pushLog(order, [{ at, by, who: 'staff', type: 'cancel', ...(reason ? { note: reason } : {}) }]) } };
}

/** Giờ ngắn "08:15 25/11" theo giờ Việt Nam. */
export function shortTime(iso) {
  const d = new Date(new Date(iso).getTime() + 7 * 3600000).toISOString();
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
}
const itemList = items => (items || []).map(i => `${i.name} ${qtyText(i.qty)}${i.unit ? ` ${i.unit}` : ''}`).join(', ');
const priceOf = v => (v === null || v === undefined ? 'trống' : vnd(v));

/** Một dòng lịch sử dễ đọc: { time, who, role ('staff'|'supplier'|'admin'), text }. */
export function logLine(e) {
  const who = e.by || (e.who === 'supplier' ? 'Chủ gia vị' : 'Nhân viên');
  const withNote = s => (e.note ? `${s} · ghi chú: ${e.note}` : s);
  const text = e.type === 'create' ? withNote(`gọi: ${itemList(e.items)}`)
    : e.type === 'add' ? withNote(`thêm: ${itemList(e.items)}`)
    : e.type === 'price' ? `đổi giá: ${(e.changes || []).map(c => `${c.name} ${priceOf(c.from)} → ${priceOf(c.to)}`).join(', ')}`
    : e.type === 'done' ? 'báo đã soạn xong hàng'
    : e.type === 'note' ? `ghi chú: ${e.note || '(xoá ghi chú)'}`
    : e.type === 'receive' ? (e.short?.length ? `nhận hàng khác số gọi: ${e.short.map(s => {
      const d = Math.round((Number(s.got) - Number(s.qty)) * 1000) / 1000, u = s.unit ? ` ${s.unit}` : '';
      return `${s.name} gọi ${qtyText(s.qty)} nhận ${qtyText(s.got)}${u} (${d < 0 ? 'thiếu' : 'dư'} ${qtyText(Math.abs(d))})`;
    }).join(', ')}` : 'nhận đủ hàng')
    : e.type === 'cancel' ? withNote('huỷ đơn')
    : String(e.type || '');
  return { time: e.at ? shortTime(e.at) : '', who, role: e.who || 'staff', text };
}

/** Tổng cho chủ gia vị xem: đã giao (đơn quán đã nhận), quán đã trả, quán còn thiếu, đơn đang chờ. */
export function supplierSummary(orders, payments) {
  const received = (orders || []).filter(o => !o.cancelled_at && o.received_at);
  const delivered = received.reduce((s, o) => s + orderTotal(o.items), 0);
  const paid = (payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  return {
    delivered, paid, owed: delivered - paid,
    open: (orders || []).filter(o => !o.cancelled_at && !o.received_at).length,
    waitingPrice: received.filter(o => missingPrices(o.items)).length,
  };
}

/* ---------- Danh sách món để chọn nhanh ---------- */

/** Chữ để tìm: bỏ dấu, chữ thường ("Hành tím" → "hanh tim"). */
export const plainText = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim();

/** Số lượng mỗi lần bấm món: số mặc định chủ quán đặt, không có thì 1. */
export const itemStep = item => {
  const q = Number(item?.default_qty);
  return Number.isFinite(q) && q > 0 ? q : 1;
};

/**
 * Xếp món: món hay gọi (đếm trong các đơn gần đây, ưu tiên của chủ gia vị đang chọn) lên trước, rồi theo thứ tự chủ quán
 * xếp (sort), rồi tên. Món ẩn (active = false) bỏ ra.
 */
export function rankItems(items, orders = [], supplierId = null) {
  const count = new Map();
  for (const o of orders || []) {
    if (o.cancelled_at) continue;
    const w = supplierId && o.supplier_id === supplierId ? 3 : 1;
    for (const l of o.items || []) count.set(itemKey(l.name), (count.get(itemKey(l.name)) || 0) + w);
  }
  return (items || []).filter(i => i.active !== false)
    .map(i => ({ ...i, uses: count.get(itemKey(i.name)) || 0 }))
    .sort((a, b) => b.uses - a.uses || (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name, 'vi'));
}

/**
 * Chủ quán dán nhiều món một lần, mỗi dòng (hoặc cách nhau dấu phẩy / chấm phẩy) một món:
 * "Muối 2 kg", "Tiêu 0,5kg", "Rau răm" (dấu phẩy phải có dấu cách sau, để "0,5" không bị tách) → [{ name, qty (null = không ghi), unit }]. Bỏ dòng trống, gộp tên trùng.
 */
export function parseItemLines(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\n|;|,\s+/)) {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    const m = /^(.*?\S)\s+(\d+(?:[.,]\d+)?)\s*([^\d\s].*)?$/.exec(line);
    const name = cleanName(m ? m[1] : line);
    const qty = m ? parseQty(m[2]) : null;
    const unit = cleanName(m?.[3] || '', 20);
    if (!name || seen.has(itemKey(name))) continue;
    seen.add(itemKey(name));
    out.push({ name, qty, unit });
  }
  return out.slice(0, 100);
}
