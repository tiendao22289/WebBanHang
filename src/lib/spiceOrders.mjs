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

/**
 * Đối chiếu tiền của MỘT chủ gia vị (hai bên cùng một con số):
 * - Tiền quán ghi trả (spice_payments) trừ dần vào đơn đã nhận CŨ NHẤT trước (kể cả đơn chủ gia vị đã bấm Đã TT,
 *   để quán ghi trả và chủ gia vị bấm Đã TT cho cùng đơn thì không bị trừ hai lần).
 * - Đơn chủ gia vị bấm Đã TT coi như đã trả đủ (tiền đưa tay, chuyển khoản quán chưa ghi…).
 * - Còn nợ = phần chưa trả của các đơn chưa bấm Đã TT − tiền quán trả dư (nếu có).
 * asOf ("YYYY-MM-DD"): chỉ tính đơn nhận, tiền trả, dấu Đã TT tới hết ngày đó (nợ cuối ngày).
 * → { delivered, cash (tiền quán ghi trả), owed, byOrder: Map(id → { total, covered, marked, paid, left }) }
 */
export function settleOrders(orders, payments, { asOf = null } = {}) {
  const upTo = d => !asOf || (d && d <= asOf);
  const list = (orders || []).filter(o => !o.cancelled_at && o.received_at && upTo(o.received_date || vnDateOf(o.received_at)))
    .sort((a, b) => ms(a.received_at) - ms(b.received_at) || String(a.id).localeCompare(String(b.id)));
  const cash = (payments || []).filter(p => upTo(p.paid_date)).reduce((t, p) => t + (Number(p.amount) || 0), 0);
  let pool = cash, delivered = 0, unpaid = 0;
  const byOrder = new Map();
  for (const o of list) {
    const total = orderTotal(o.items);
    delivered += total;
    const covered = Math.min(pool, Math.max(0, total));
    pool -= covered;
    const marked = !!o.supplier_paid_at && upTo(vnDateOf(o.supplier_paid_at));
    const left = marked ? 0 : total - covered;
    unpaid += left;
    byOrder.set(o.id, { total, covered, marked, paid: marked || (total > 0 && left <= 0), left });
  }
  return { delivered, cash, owed: unpaid - pool, byOrder };
}

const bySupplier = rows => {
  const m = new Map();
  for (const r of rows || []) { if (!m.has(r.supplier_id)) m.set(r.supplier_id, []); m.get(r.supplier_id).push(r); }
  return m;
};

/** Nợ từng chủ gia vị (theo settleOrders). { [supplier_id]: { owed (tiền đã giao), paid (quán ghi trả), debt (còn nợ), waiting } } */
export function supplierBalances(orders, payments) {
  const out = {};
  const os = bySupplier(orders), ps = bySupplier(payments);
  for (const id of new Set([...os.keys(), ...ps.keys()])) {
    const st = settleOrders(os.get(id) || [], ps.get(id) || []);
    out[id] = { owed: st.delivered, paid: st.cash, debt: st.owed, waiting: (os.get(id) || []).filter(o => !o.cancelled_at && o.received_at && missingPrices(o.items)).length };
  }
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
      const it = g.items.get(k) || { name: cleanName(l.name), unit: l.unit || '', qty: 0, amount: 0, price: null, first: null, before: null, suppliers: new Set(),
        supplierAdded: 0, supplierOffered: 0, supplierEdits: 0 };
      g.items.set(k, it);
      it.qty += lineQty(l);
      it.amount += amount;
      // Lưu lại: chủ gia vị tự thêm món (số đã lấy) / chủ gia vị sửa giá khác giá lần trước.
      if (l.by_supplier) { it.supplierAdded += lineQty(l); it.supplierOffered += Number(l.qty) || 0; }
      if (l.price_by === 'supplier' && l.old_price !== null && l.old_price !== undefined && hasPrice(l) && Number(l.price) !== Number(l.old_price)) it.supplierEdits += 1;
      if (hasPrice(l)) {
        // Mốc so: giá lần trước của đơn đầu kỳ; món lần đầu mới có giá thì lấy giá đầu kỳ (trong kỳ đổi giá vẫn thấy ▲▼).
        if (it.first === null) { it.first = Number(l.price); it.before = l.old_price ?? Number(l.price); }
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
      suppliers: [...it.suppliers], supplierAdded: Math.round(it.supplierAdded * 1000) / 1000, supplierOffered: Math.round(it.supplierOffered * 1000) / 1000, supplierEdits: it.supplierEdits,
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
  const os = bySupplier(orders), ps = bySupplier(payments);
  let owed = 0;
  for (const id of new Set([...os.keys(), ...ps.keys()])) owed += settleOrders(os.get(id) || [], ps.get(id) || [], { asOf: date }).owed;
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
    items[i].price_by = who;
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

/**
 * Chủ gia vị tự thêm món vào đơn chưa nhận (quán gọi thiếu): raw [{ name, unit, qty, price }]. Dòng mới đánh dấu by_supplier,
 * giá chủ gia vị ghi (trống thì lấy giá lần trước). Khi nhận, quán chọn Không lấy được. → { patch, lines } hoặc { error }.
 */
export function supplierAddLines(order, raw, { last = new Map(), by, at }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (order.received_at) return { error: 'Quán đã nhận đơn này rồi, không thêm được.' };
  const list = Array.isArray(raw) ? raw : [];
  const built = buildLines(list, { last, existing: order.items, by, at });
  if (built.error) return built;
  const priceOfRaw = new Map(list.map(r => [itemKey(cleanName(r?.name)), r?.price]));
  const lines = [];
  for (const l of built.lines) {
    const rawPrice = priceOfRaw.get(itemKey(l.name));
    const typed = rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === '' ? null : parsePrice(rawPrice);
    if (typed === undefined) return { error: `Giá "${l.name}" không hợp lệ.` };
    lines.push({ ...l, price: typed ?? l.price, ...(typed !== null ? { price_by: 'supplier' } : {}), by_supplier: true });
  }
  const items = [...order.items, ...lines];
  if (orderTotal(items) > MAX_SPICE_TOTAL) return { error: TOO_BIG };
  return { patch: { items, total: orderTotal(items),
    log: pushLog(order, [{ at, by, who: 'supplier', type: 'add', items: logItems(lines) }]) }, lines };
}

/** Chủ gia vị đánh dấu đơn đã nhận tiền / chưa (sổ riêng của chủ gia vị; nợ của quán vẫn theo các lần quán trả). */
export function setSupplierPaid(order, paid, { by, at }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (!order.received_at) return { error: 'Quán chưa nhận đơn này.' };
  if (!!order.supplier_paid_at === !!paid) return { patch: null };
  return { patch: { supplier_paid_at: paid ? at : null,
    log: pushLog(order, [{ at, by, who: 'supplier', type: paid ? 'paid' : 'unpaid' }]) } };
}

/**
 * Thống kê cho chủ gia vị: đơn quán đã nhận, lọc paid ('all' | 'paid' | 'unpaid' theo dấu chủ gia vị bấm) và ngày nhận [from, to].
 * → { count, total, paid: { count, total }, unpaid: { count, total }, orders (mới trước), items: [{ name, unit, qty, amount, orders }] }
 */
export function supplierOrderStats(orders, { paid = 'all', from = '', to = '9999', payments = [] } = {}) {
  // Đã thanh toán = chủ gia vị bấm Đã TT hoặc tiền quán ghi trả đã phủ đủ đơn (trừ đơn cũ trước).
  const settle = settleOrders(orders, payments).byOrder;
  const dated = (orders || []).filter(o => o.received_at || o.cancelled_at)
    .map(o => ({ ...o, pay: settle.get(o.id) || null, date: o.received_at ? (o.received_date || vnDateOf(o.received_at)) : vnDateOf(o.cancelled_at) }))
    .filter(o => o.date >= from && o.date <= to);
  const received = dated.filter(o => !o.cancelled_at && o.received_at);
  // Đơn quán đã huỷ (để xem lại, không tính tiền).
  const cancelledList = dated.filter(o => o.cancelled_at);
  const part = list => ({ count: list.length, total: list.reduce((s, o) => s + orderTotal(o.items), 0) });
  const paidList = received.filter(o => o.pay?.paid), unpaidList = received.filter(o => !o.pay?.paid);
  const shown = paid === 'paid' ? paidList : paid === 'unpaid' ? unpaidList : paid === 'cancelled' ? cancelledList : received;
  const items = new Map();
  for (const o of shown) for (const l of o.items || []) {
    const k = itemKey(l.name);
    const qty = lineQty(l);
    if (!k || qty <= 0) continue;
    const it = items.get(k) || { name: cleanName(l.name), unit: l.unit || '', qty: 0, amount: 0, orders: 0 };
    it.qty = Math.round((it.qty + qty) * 1000) / 1000;
    it.amount += lineAmount(l);
    it.orders += 1;
    items.set(k, it);
  }
  return {
    ...part(shown), paid: part(paidList), unpaid: part(unpaidList), cancelled: part(cancelledList),
    orders: [...shown].sort((a, b) => String(b.received_at || b.cancelled_at || b.created_at).localeCompare(String(a.received_at || a.cancelled_at || a.created_at))),
    items: [...items.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'vi')),
  };
}

/** Kết quả kiểm hàng từng dòng: đủ / thiếu / dư / sai hàng (sai loại, hư, không đúng yêu cầu). */
export const CHECKS = ['ok', 'short', 'over', 'wrong', 'skip'];
// skip = Không lấy: món chủ gia vị tự thêm mà quán không cần (không tính tiền).
export const CHECK_LABELS = { ok: 'Đủ', short: 'Thiếu', over: 'Dư', wrong: 'Sai hàng', skip: 'Không lấy' };

/**
 * Kiểm một dòng đã nhận: { check, got (số nhận), diff (nhận − gọi), note }. Dòng cũ chưa có check thì suy ra từ số nhận.
 */
export function lineCheck(line) {
  const qty = Number(line?.qty) || 0, got = lineQty(line);
  const diff = Math.round((got - qty) * 1000) / 1000;
  const check = CHECKS.includes(line?.check) ? line.check : diff < 0 ? 'short' : diff > 0 ? 'over' : 'ok';
  return { check, got, diff, note: line?.check_note || '' };
}

/**
 * Đọc kết quả kiểm hàng người nhận gửi lên. Mỗi dòng: null (đủ) · số (số nhận, kiểu cũ) · { check, qty, note }.
 * Thiếu: số nhận < số gọi · Dư: số nhận > số gọi · Sai hàng: phải ghi rõ sai thế nào, số nhận (mặc định 0 = không lấy).
 * → { items, checks (các dòng không đủ, để ghi lịch sử) } hoặc { error }.
 */
function readChecks(order, received) {
  const list = Array.isArray(received) ? received : [];
  const checks = [];
  const items = [];
  for (let i = 0; i < order.items.length; i += 1) {
    const l = order.items[i], r = list[i], ordered = Number(l.qty) || 0;
    const { check_note: _n, check: _c, ...base } = l;
    let check = 'ok', got = ordered, note = '';
    if (r && typeof r === 'object') {
      check = CHECKS.includes(r.check) ? r.check : 'ok';
      note = String(r.note ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
      const raw = String(r.qty ?? '').trim().replace(',', '.');
      const q = raw === '' ? null : Number(raw) === 0 ? 0 : parseQty(raw);
      if (check !== 'ok' && raw !== '' && q === null) return { error: `"${l.name}": số nhận không hợp lệ.` };
      if (check === 'short') {
        if (q === null || q >= ordered) return { error: `"${l.name}": thiếu thì số nhận phải ít hơn ${qtyText(ordered)}.` };
        got = q;
      } else if (check === 'over') {
        if (q === null || q <= ordered) return { error: `"${l.name}": dư thì số nhận phải nhiều hơn ${qtyText(ordered)}.` };
        got = q;
      } else if (check === 'wrong') {
        if (!note) return { error: `"${l.name}": ghi rõ sai thế nào (vd: ớt xanh thay ớt đỏ, hàng hư).` };
        got = q === null ? 0 : q;
      } else if (check === 'skip') {
        if (!l.by_supplier) return { error: `"${l.name}": quán gọi món này, không lấy thì chọn Thiếu (nhận 0).` };
        got = 0;
      }
    } else if (r !== null && r !== undefined && String(r).trim() !== '') {
      // Kiểu cũ: chỉ có số nhận.
      const q = Number(String(r).replace(',', '.')) === 0 ? 0 : parseQty(r);
      if (q !== null) { got = q; check = q < ordered ? 'short' : q > ordered ? 'over' : 'ok'; }
    }
    const row = { ...base, received_qty: got === ordered ? null : got, check };
    if (note) row.check_note = note;
    if (check !== 'ok') checks.push({ name: l.name, unit: l.unit, qty: ordered, got, check, ...(note ? { note } : {}) });
    items.push(row);
  }
  if (orderTotal(items) > MAX_SPICE_TOTAL) return { error: TOO_BIG };
  return { items, checks };
}

/**
 * Nhân viên nhận hàng, kiểm từng món (đủ / thiếu / dư / sai hàng). received xem readChecks; note = ghi chú khi nhận.
 * → { patch } hoặc { error }.
 */
export function receiveOrder(order, received, { by, at, note = '' }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (order.received_at) return { error: `Đơn đã được ${order.received_by_name || 'người khác'} bấm nhận rồi.` };
  const r = readChecks(order, received);
  if (r.error) return r;
  const clean = String(note ?? '').trim().slice(0, 300);
  return { patch: {
    items: r.items, total: orderTotal(r.items), received_at: at, received_date: vnDateOf(at), received_by_name: by,
    log: pushLog(order, [{ at, by, who: 'staff', type: 'receive', ...(r.checks.length ? { checks: r.checks } : {}), ...(clean ? { note: clean } : {}) }]),
  } };
}

/**
 * Quản lý / chủ quán kiểm lại đơn đã nhận (đối soát với chủ gia vị): sửa đủ / thiếu / dư / sai, ngày nhận giữ nguyên.
 */
export function recheckOrder(order, received, { by, at, note = '' }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  if (!order.received_at) return { error: 'Đơn chưa nhận, bấm Nhận hàng.' };
  const r = readChecks(order, received);
  if (r.error) return r;
  const clean = String(note ?? '').trim().slice(0, 300);
  return { patch: {
    items: r.items, total: orderTotal(r.items),
    log: pushLog(order, [{ at, by, who: 'staff', type: 'recheck', checks: r.checks, ...(clean ? { note: clean } : {}) }]),
  } };
}

/** Một dòng kiểm hàng dễ đọc: "Muối thiếu 0,5 kg (gọi 2, nhận 1,5)". */
export function checkText(c) {
  const u = c.unit ? ` ${c.unit}` : '';
  const d = Math.round((Number(c.got) - Number(c.qty)) * 1000) / 1000;
  const check = c.check || (d < 0 ? 'short' : d > 0 ? 'over' : 'ok');
  if (check === 'wrong') return `${c.name} sai hàng${c.note ? `: ${c.note}` : ''} (gọi ${qtyText(c.qty)}, lấy ${qtyText(c.got)}${u})`;
  if (check === 'skip') return `${c.name} không lấy (chủ gia vị tự thêm ${qtyText(c.qty)}${u})${c.note ? ` · ${c.note}` : ''}`;
  if (check === 'ok') return `${c.name} đủ`;
  return `${c.name} ${check === 'short' ? 'thiếu' : 'dư'} ${qtyText(Math.abs(d))}${u} (gọi ${qtyText(c.qty)}, nhận ${qtyText(c.got)})${c.note ? ` · ${c.note}` : ''}`;
}

/**
 * Huỷ đơn. Đơn chưa nhận: người gọi / quản lý. Đơn ĐÃ nhận (đơn thử, bấm nhận nhầm): chỉ chủ quán (owner = true) và phải ghi lý do;
 * đơn huỷ ra khỏi Sổ thu chi, công nợ, thống kê, đối soát; ngày giờ nhận vẫn giữ để xem lại, lịch sử ghi ai huỷ, lý do.
 */
export function cancelOrder(order, { by, at, reason = '', owner = false }) {
  if (order.cancelled_at) return { error: 'Đơn đã huỷ.' };
  const clean = String(reason ?? '').trim().slice(0, 200);
  if (order.received_at) {
    if (!owner) return { error: 'Đơn đã nhận hàng, chỉ chủ quán huỷ được.' };
    if (!clean) return { error: 'Ghi lý do huỷ đơn đã nhận (vd: đơn thử, bấm nhận nhầm).' };
  }
  return { patch: { cancelled_at: at, cancelled_by_name: by, log: pushLog(order, [{ at, by, who: owner ? 'admin' : 'staff', type: 'cancel',
    ...(order.received_at ? { was_received: true, total: orderTotal(order.items) } : {}), ...(clean ? { note: clean } : {}) }]) } };
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
    : e.type === 'receive' ? withNote((e.checks || e.short)?.length ? `nhận hàng: ${(e.checks || e.short).map(checkText).join('; ')}` : 'nhận đủ hàng')
    : e.type === 'recheck' ? withNote(e.checks?.length ? `kiểm lại: ${e.checks.map(checkText).join('; ')}` : 'kiểm lại: tất cả đủ')
    : e.type === 'cancel' ? withNote(e.was_received ? `huỷ đơn đã nhận (${vnd(e.total)} ra khỏi sổ và công nợ)` : 'huỷ đơn')
    : e.type === 'paid' ? 'đánh dấu đã nhận tiền đơn này'
    : e.type === 'unpaid' ? 'đánh dấu chưa nhận tiền đơn này'
    : String(e.type || '');
  return { time: e.at ? shortTime(e.at) : '', who, role: e.who || 'staff', text };
}

/** Tổng cho chủ gia vị xem: đã giao (đơn quán đã nhận), quán đã trả, quán còn thiếu, đơn đang chờ. */
export function supplierSummary(orders, payments) {
  const received = (orders || []).filter(o => !o.cancelled_at && o.received_at);
  const st = settleOrders(orders, payments);
  // paid = đã thanh toán (quán ghi trả + đơn chủ gia vị bấm Đã TT); cash = riêng tiền quán ghi trả.
  return {
    delivered: st.delivered, paid: st.delivered - st.owed, cash: st.cash, owed: st.owed,
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
 * Xếp món đúng thứ tự chủ quán xếp trong Cài đặt (sort, rồi tên); uses = số lần gọi gần đây (ưu tiên chủ gia vị đang chọn).
 * Món ẩn (active = false) bỏ ra.
 */
export function rankItems(items, orders = [], supplierId = null) {
  const count = new Map();
  for (const o of orders || []) {
    if (o.cancelled_at) continue;
    const w = supplierId && o.supplier_id === supplierId ? 3 : 1;
    for (const l of o.items || []) count.set(itemKey(l.name), (count.get(itemKey(l.name)) || 0) + w);
  }
  // Thứ tự do chủ quán xếp trong Cài đặt; số lần gọi chỉ để biết món hay gọi.
  return orderedItems((items || []).filter(i => i.active !== false))
    .map(i => ({ ...i, uses: count.get(itemKey(i.name)) || 0 }));
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

/** Danh sách món theo thứ tự chủ quán xếp (sort, rồi tên). */
export function orderedItems(items) {
  return [...(items || [])].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name).localeCompare(String(b.name), 'vi'));
}

/** Một dòng của danh sách để sửa bằng chữ: "Tiêu xay 0,5 kg". */
export function itemLineText(i) {
  const q = Number(i.default_qty) > 0 ? ` ${String(Math.round(Number(i.default_qty) * 1000) / 1000).replace('.', ',')}` : '';
  return `${i.name}${q}${i.unit ? `${q ? ' ' : ' 1 '}${i.unit}` : ''}`;
}

/**
 * Đưa món lên (dir -1) / xuống (dir 1) một bậc: đánh số lại 1..n theo thứ tự đang thấy rồi đổi chỗ.
 * → [{ id, sort }] chỉ các món đổi số (rỗng nếu đã ở đầu / cuối hoặc không thấy món).
 */
export function moveItem(items, id, dir) {
  const list = orderedItems(items);
  const i = list.findIndex(x => x.id === id), j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((x, k) => ({ id: x.id, sort: k + 1 })).filter((x, k) => Number(list[k].sort) !== x.sort);
}

/**
 * Chủ quán sửa CẢ danh sách bằng chữ (mỗi dòng "Tên số đơn-vị"): danh sách sau khi lưu đúng y như chữ —
 * thứ tự theo dòng, số / đơn vị theo dòng (không ghi = bỏ), món không còn trong chữ thì xoá.
 * → { error } | { updates: [{ id, patch }], inserts: [row], deletes: [id] }
 */
export function planItemList(existing, text) {
  const list = parseItemLines(text);
  if (!list.length) return { error: 'Danh sách trống. Mỗi dòng một món, vd: Muối 1 kg' };
  const byKey = new Map((existing || []).map(i => [itemKey(i.name), i]));
  const keep = new Set();
  const updates = [], inserts = [];
  list.forEach((it, k) => {
    const row = { name: it.name, unit: it.unit || null, default_qty: it.qty, sort: k + 1, active: true };
    const old = byKey.get(itemKey(it.name));
    if (!old) { inserts.push(row); return; }
    keep.add(old.id);
    const changed = ['name', 'unit', 'default_qty', 'sort', 'active'].some(f => (old[f] ?? null) !== row[f] && !(f === 'default_qty' && Number(old[f]) === row[f]));
    if (changed) updates.push({ id: old.id, patch: row });
  });
  const deletes = (existing || []).filter(i => !keep.has(i.id)).map(i => i.id);
  return { updates, inserts, deletes };
}

/* ---------- Đối soát từng ngày với chủ gia vị ---------- */

/**
 * Đối soát từng ngày của MỘT chủ gia vị (orders, payments chỉ của người đó, đủ từ trước tới nay để tính nợ cuối ngày):
 * [{ date, orders: [{ id, created_at, created_by_name, received_at, received_by_name, note, receive_note, supplier_note, total,
 *    lines: [{ name, unit, qty, got, check, diff, note, price, amount }] }], total, counts: { short, over, wrong }, waiting,
 *    paid, payments: [{ amount, method, note }], balance (quán còn nợ tới hết ngày) }], ngày mới nhất trước, chỉ ngày ≥ from
 * có nhận hàng hoặc có trả tiền. Đơn tính theo ngày nhận (giống Sổ thu chi).
 */
export function supplierDays(orders, payments, { from = '' } = {}) {
  const byDate = new Map();
  const day = date => {
    if (!byDate.has(date)) byDate.set(date, { date, orders: [], total: 0, counts: { short: 0, over: 0, wrong: 0, skip: 0 }, waiting: 0, paid: 0, payments: [], balance: 0 });
    return byDate.get(date);
  };
  for (const o of orders || []) {
    if (o.cancelled_at || !o.received_at) continue;
    const d = day(o.received_date || vnDateOf(o.received_at));
    const receiveNote = [...(o.log || [])].reverse().find(e => e.type === 'receive' || e.type === 'recheck')?.note || '';
    const lines = (o.items || []).map(l => {
      const c = lineCheck(l);
      if (c.check !== 'ok') d.counts[c.check] += 1;
      return { name: l.name, unit: l.unit || '', qty: Number(l.qty) || 0, got: c.got, check: c.check, diff: c.diff, note: c.note,
        price: l.price ?? null, amount: lineAmount(l), by_supplier: !!l.by_supplier };
    });
    const total = orderTotal(o.items);
    d.total += total;
    if (missingPrices(o.items)) d.waiting += 1;
    d.orders.push({ id: o.id, created_at: o.created_at, created_by_name: o.created_by_name || '', received_at: o.received_at,
      received_by_name: o.received_by_name || '', note: o.note || '', receive_note: receiveNote, supplier_note: o.supplier_note || '', total, lines });
  }
  for (const p of payments || []) {
    const d = day(p.paid_date);
    d.paid += Number(p.amount) || 0;
    d.payments.push({ amount: Number(p.amount) || 0, method: p.method, note: p.note || '' });
  }
  const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of all) {
    d.balance = settleOrders(orders, payments, { asOf: d.date }).owed;
    d.orders.sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)));
  }
  return all.filter(d => d.date >= from).reverse();
}

/** Tin đối soát một ngày để gửi Zalo cho chủ gia vị (hoặc chủ gia vị gửi lại quán). */
export function dayReportText({ supplierName = '', day, withMoney = true }) {
  const [y, m, dd] = day.date.split('-');
  const out = [`🧂 Đối soát gia vị ngày ${dd}/${m}/${y}${supplierName ? ` – ${supplierName}` : ''}`];
  day.orders.forEach((o, k) => {
    out.push('', `Đơn ${k + 1} (gọi ${shortTime(o.created_at)}${o.created_by_name ? ` – ${o.created_by_name}` : ''}; nhận ${shortTime(o.received_at)}${o.received_by_name ? ` – ${o.received_by_name}` : ''}):`);
    for (const l of o.lines) {
      const mark = l.check === 'ok' ? '✅' : l.check === 'wrong' ? '⚠️' : l.check === 'short' ? '➖' : l.check === 'skip' ? '🚫' : '➕';
      const what = l.check === 'ok' ? `${qtyText(l.got)}${l.unit ? ` ${l.unit}` : ''} đủ` : checkText(l).replace(`${l.name} `, '');
      out.push(`${mark} ${l.name}: ${what}${withMoney ? ` = ${l.price === null ? 'chưa giá' : vnd(l.amount)}` : ''}`);
    }
    if (o.receive_note) out.push(`Ghi chú nhận: ${o.receive_note}`);
    if (withMoney) out.push(`Tiền đơn: ${vnd(o.total)}`);
  });
  const { short, over, wrong, skip = 0 } = day.counts;
  if (short || over || wrong) out.push('', `Cần đối lại: ${[short && `${short} món thiếu`, over && `${over} món dư`, wrong && `${wrong} món sai`].filter(Boolean).join(', ')}`);
  if (skip) out.push(`Quán không lấy ${skip} món chủ gia vị tự thêm (không tính tiền).`);
  if (withMoney) {
    out.push('', `Tổng nhận ngày này: ${vnd(day.total)}`);
    if (day.paid) out.push(`Quán trả trong ngày: ${vnd(day.paid)}`);
    out.push(`Quán còn nợ tới hết ngày: ${vnd(day.balance)}`);
  }
  return out.join('\n');
}
