/**
 * Các mục thêm của báo cáo Zalo hằng ngày:
 *  - lossBlock:    bill huỷ, món bị bớt sau khi in bếp, giảm giá, món tặng
 *  - staffBlock:   chấm công trong ngày, trễ / sớm, ai quên ra ca, đơn chờ duyệt
 *  - compareBlock: so với hôm qua / cùng thứ tuần trước, bill, giờ đông, món bán chạy
 * Mỗi hàm trả về chuỗi (hoặc '' nếu không có gì đáng báo). lossData / staffData / staffRangeData trả về
 * cùng số liệu dạng dữ liệu cho trang /thongke (thẻ số, bảng) — chữ Zalo dựng từ chính dữ liệu đó.
 */
import { dayFlags, durationText, flagTexts, normalizeRules, sessionHours, workDayOf } from './attendanceRules.mjs';
import { DAY_PAY_FROM, earlyRuleOf, lateRuleOn } from './payroll.mjs';

const vnd =n => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const clock = iso => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(11, 16);
const hourOf = iso => new Date(new Date(iso).getTime() + 7 * 3600000).getUTCHours();
const optionsText = options => (Array.isArray(options) ? options.map(o => o?.choice).filter(Boolean).join(', ') : '');
const itemKey = (name, options, price) => `${String(name || '').trim().toLowerCase()}|${optionsText(options)}|${Number(price) || 0}`;
const label = (name, options) => `${name || 'Món'}${optionsText(options) ? ` (${optionsText(options)})` : ''}`;
const pct = (now, before) => (before > 0 ? `${now >= before ? '+' : '−'}${Math.round(Math.abs(now - before) / before * 100)}%` : '');

/**
 * ledgerDay: bill đã thu trong ngày (hoặc trong khoảng ngày) { order_id, table_number, paid_at, amount, items[] }.
 * printed: Map order_id → [ảnh chụp món lúc in: { id, quantity, unit_price, name, item_options, is_gift }].
 * movedIds: Set mã món đang nằm ở bill khác (chuyển / gộp bàn) — không tính là bớt.
 * cancelled: bill huỷ { id, table_number, cancelled_at, cancelled_by_name, total_amount }.
 * menuPrice: Map tên món (chữ thường) → giá menu, để ước giá trị món tặng.
 * Trả về từng loại thất thoát (số lần / số món, tiền, từng dòng) và tổng tiền ước tính.
 */
// Các loại khuyến mãi giảm tiền, nhận theo tên dòng giảm (discountLabel ở reviewReward.js, tên giải vòng xoay, 'Voucher BK-…').
// Dòng cuối là 'Giảm khác' (giảm tay của nhân viên…).
const PROMO_KINDS = [
  { key: 'wheel', label: 'Vòng xoay', icon: '🎡', test: n => /vòng xoay/i.test(n) },
  { key: 'google', label: 'Đánh giá Google', icon: '⭐', test: n => /google/i.test(n) },
  { key: 'tiktok', label: 'Theo dõi TikTok', icon: '🎵', test: n => /tiktok/i.test(n) },
  { key: 'zalo', label: 'Quan tâm Zalo', icon: '💬', test: n => /zalo/i.test(n) },
  { key: 'facebook', label: 'Theo dõi Facebook', icon: '👍', test: n => /facebook/i.test(n) },
  { key: 'voucher', label: 'Voucher', icon: '🎟️', test: n => /^voucher /i.test(n) },
  { key: 'other', label: 'Giảm giá khác', icon: '🏷️', test: () => true },
];

// Giá gốc 1 phần của món tặng theo thực đơn: tổng giá các lựa chọn đã chọn (vd Ốc gai "Xào tỏi" 50.000đ), không có lựa chọn
// đặt giá thì giá món. Không thấy món trong thực đơn thì giá theo tên (menuPrice), không có nữa thì 0.
function giftUnitPrice(i, menuByName, menuPrice) {
  const key = String(i.name || '').trim().toLowerCase(), item = menuByName.get(key);
  if (!item) return menuPrice.get(key) || 0;
  let sum = 0, priced = false;
  const picked = i.options ?? i.item_options;
  for (const sel of Array.isArray(picked) ? picked : []) {
    const opt = (item.options || []).find(o => o?.name === sel?.name && Array.isArray(o.choices));
    if (!opt || sel?.choice == null || sel.choice === '') continue;
    for (const part of String(sel.choice).split(', ')) {
      const at = opt.choices.indexOf(part), p = at >= 0 ? opt.prices?.[at] : null;
      if (p !== null && p !== undefined && p !== '' && Number.isFinite(Number(p))) { sum += Number(p); priced = true; }
    }
  }
  return priced ? sum : Number(item.price) || 0;
}

export function lossData({ ledgerDay = [], printed = new Map(), movedIds = new Set(), cancelled = [], menuPrice = new Map(), menuItems = [] }) {
  const menuByName = new Map(menuItems.map(m => [String(m.name || '').trim().toLowerCase(), m]));
  // Bill huỷ — kèm món đã in bếp (đã làm mà không thu tiền). Món đã sang bill khác (gộp bill / chuyển bàn)
  // vẫn được thu ở bill đó nên không tính.
  const cancelRows = cancelled.flatMap(o => {
    const snap = [...latestByItem(printed.get(o.id) || []).values()].filter(i => !movedIds.has(i.id));
    const printedValue = snap.reduce((a, i) => a + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0);
    const printedCount = snap.reduce((a, i) => a + (Number(i.quantity) || 0), 0);
    const amount = Number(o.total_amount) || 0;
    // Bill phụ còn lại sau khi gộp bill (merge_bills_atomic): 0đ, không giờ huỷ, không người huỷ — món đã sang
    // bill chính (bill chính ngoài thống kê bị dọn thì không còn món để đối chiếu). Nút huỷ luôn ghi giờ huỷ.
    if (!o.cancelled_at && !o.cancelled_by_name && !amount) return [];
    return [{ at: o.cancelled_at || null, table: o.table_number ?? null, printedCount, printedValue, amount, by: o.cancelled_by_name || null }];
  });
  const cancelTotal = cancelRows.reduce((a, r) => a + (r.printedValue || r.amount), 0);
  // Món đã in bếp nhưng bill lúc thu không còn (hoặc ít hơn).
  const removed = [];
  for (const bill of ledgerDay) {
    const snap = maxByItem(printed.get(bill.order_id) || []);
    const printedQty = new Map();
    for (const [id, i] of snap) {
      if (movedIds.has(id) || i.is_gift || Number(i.unit_price) <= 0) continue;
      const k = itemKey(i.name, i.item_options, i.unit_price);
      printedQty.set(k, { qty: (printedQty.get(k)?.qty || 0) + Number(i.quantity || 0), name: i.name, options: i.item_options, price: Number(i.unit_price) || 0 });
    }
    const finalQty = new Map();
    for (const i of bill.items || []) {
      const k = itemKey(i.name, i.options ?? i.item_options, i.unit_price);
      finalQty.set(k, (finalQty.get(k) || 0) + Number(i.quantity || 0));
    }
    for (const [k, p] of printedQty) {
      const diff = p.qty - (finalQty.get(k) || 0);
      if (diff > 0) removed.push({ table: bill.table_number ?? null, paidAt: bill.paid_at || null, name: label(p.name, p.options), qty: diff, value: diff * p.price });
    }
  }
  // Giảm giá (dòng âm trong bill) gom theo loại.
  const discounts = new Map();
  for (const bill of ledgerDay) for (const i of bill.items || []) {
    const amount = (Number(i.unit_price) || 0) * (Number(i.quantity) || 0);
    if (amount >= 0) continue;
    // 'Voucher BK-XXXXXX': mỗi mã một tên → gom chung một nhóm.
    const kind = /vòng xoay/i.test(i.name || '') ? 'Vòng xoay' : /^voucher /i.test(i.name || '') ? 'Voucher'
      : String(i.name || 'Giảm giá').split(':')[0].trim();
    const d = discounts.get(kind) || { count: 0, amount: 0 };
    discounts.set(kind, { count: d.count + 1, amount: d.amount - amount });
  }
  const kinds = [...discounts.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([kind, d]) => ({ kind, ...d }));
  // Món tặng (0đ) — giá trị theo giá gốc trên thực đơn (cả lựa chọn), vd tặng 10 phần Ốc gai 50.000đ = 500.000đ.
  const gifts = new Map();
  for (const bill of ledgerDay) for (const i of bill.items || []) {
    if (!i.is_gift) continue;
    const g = gifts.get(i.name) || { qty: 0, value: 0 };
    const q = Number(i.quantity) || 0;
    gifts.set(i.name, { qty: g.qty + q, value: g.value + q * giftUnitPrice(i, menuByName, menuPrice) });
  }
  const giftItems = [...gifts.entries()].sort((a, b) => b[1].qty - a[1].qty).map(([name, g]) => ({ name, ...g }));
  // Khuyến mãi từng loại (Thống kê nhanh): vòng xoay (giảm tiền / tặng món), đánh giá Google, TikTok, Zalo, Facebook, voucher,
  // giảm khác, và món tặng (8 tặng 1 / nhân viên tặng, tách nước và món ăn). Mỗi dòng kèm bàn, giờ thu, tiền. Món tặng vòng
  // xoay nhận ra nhờ cờ wheel_gift sổ ghi lúc thu tiền (bill thu trước khi có cờ này tính vào món tặng).
  const groupRows = new Map(PROMO_KINDS.map(k => [k.key, []])), giftRows = [];
  for (const bill of ledgerDay) for (const i of bill.items || []) {
    const qty = Number(i.quantity) || 0, price = Number(i.unit_price) || 0, base = { table: bill.table_number ?? null, at: bill.paid_at || null };
    const name = String(i.name || '');
    if (price * qty < 0) {
      const kind = PROMO_KINDS.find(k => k.test(name)) || PROMO_KINDS.at(-1);
      groupRows.get(kind.key).push({ ...base, kind: 'discount', name: name || 'Giảm giá', qty, amount: -price * qty });
    } else if (i.is_gift && qty > 0) {
      const unit = giftUnitPrice(i, menuByName, menuPrice);
      const row = { ...base, kind: 'gift', name: label(i.name, i.options ?? i.item_options), qty, unit, amount: unit * qty, drink: isDrinkItem(name) };
      (i.wheel_gift ? groupRows.get('wheel') : giftRows).push(row);
    }
  }
  const sum = rows => rows.reduce((a, r) => a + r.amount, 0);
  const qtyOf = rows => rows.reduce((a, r) => a + r.qty, 0);
  const byItem = rows => [...rows.reduce((m, r) => {
    const g = m.get(r.name) || { name: r.name, qty: 0, unit: r.unit, amount: 0 };
    return m.set(r.name, { ...g, qty: g.qty + r.qty, amount: g.amount + r.amount });
  }, new Map()).values()].sort((a, b) => b.qty - a.qty || b.amount - a.amount);
  const giftPart = rows => ({ qty: qtyOf(rows), amount: sum(rows), items: byItem(rows) });
  const promoGroups = PROMO_KINDS.map(({ key, label: name, icon }) => {
    const rows = groupRows.get(key);
    return { key, label: name, icon, count: rows.length, amount: sum(rows), giftQty: qtyOf(rows.filter(r => r.kind === 'gift')), rows };
  }).filter(g => g.count);
  const promos = {
    groups: promoGroups,
    gifts: { count: giftRows.length, qty: qtyOf(giftRows), amount: sum(giftRows), rows: giftRows,
      drinks: giftPart(giftRows.filter(r => r.drink)), foods: giftPart(giftRows.filter(r => !r.drink)) },
  };
  promos.total = sum(promoGroups) + promos.gifts.amount;
  const out = {
    cancelled: { count: cancelRows.length, total: cancelTotal, rows: cancelRows },
    removed: { qty: removed.reduce((a, r) => a + r.qty, 0), value: removed.reduce((a, r) => a + r.value, 0), rows: removed },
    discounts: { count: kinds.reduce((a, d) => a + d.count, 0), amount: kinds.reduce((a, d) => a + d.amount, 0), kinds },
    gifts: { qty: giftItems.reduce((a, g) => a + g.qty, 0), value: giftItems.reduce((a, g) => a + g.value, 0), items: giftItems },
    promos,
  };
  out.total = out.cancelled.total + out.removed.value + out.discounts.amount + out.gifts.value;
  return out;
}

export function lossBlock(input) {
  const d = lossData(input);
  const lines = [];
  if (d.cancelled.count) {
    lines.push(`Bill huỷ: ${d.cancelled.count} — ${vnd(d.cancelled.total)}`);
    for (const r of d.cancelled.rows.slice(0, 8)) {
      lines.push(`• ${r.at ? clock(r.at) : '--:--'} Bàn ${r.table ?? '?'}${r.printedCount ? ` · ${r.printedCount} món đã in bếp (${vnd(r.printedValue)})` : ` · ${vnd(r.amount)}`}${r.by ? ` · huỷ bởi ${r.by}` : ''}`);
    }
  }
  if (d.removed.rows.length) {
    lines.push(`Món bị bớt sau khi in bếp: ${d.removed.qty} món — ${vnd(d.removed.value)}`);
    for (const r of d.removed.rows.slice(0, 10)) lines.push(`• Bàn ${r.table ?? '?'} (thu ${clock(r.paidAt)}): ${r.name} ×${r.qty} (${vnd(r.value)})`);
    if (d.removed.rows.length > 10) lines.push(`• … và ${d.removed.rows.length - 10} món khác`);
  }
  if (d.discounts.kinds.length) {
    lines.push(`Giảm giá: ${d.discounts.count} lần — ${vnd(d.discounts.amount)} (${d.discounts.kinds.map(k => `${k.kind} ${k.count} lần ${vnd(k.amount)}`).join(', ')})`);
  }
  if (d.gifts.items.length) {
    lines.push(`Món tặng: ${d.gifts.qty} món${d.gifts.value > 0 ? ` ~ ${vnd(d.gifts.value)}` : ''} (${d.gifts.items.slice(0, 6).map(g => `${g.name} ×${g.qty}`).join(', ')})`);
  }
  return lines.length ? ['🔍 Kiểm soát thất thoát', ...lines].join('\n') : '🔍 Kiểm soát thất thoát: không có bill huỷ, món bị bớt, giảm giá hay món tặng.';
}

// Ảnh chụp món qua các lần in: lấy số lượng lớn nhất từng món (bớt sau khi in vẫn thấy).
function maxByItem(snapshots) {
  const map = new Map();
  for (const snap of snapshots) for (const i of snap || []) {
    if (!i?.id) continue;
    const prev = map.get(i.id);
    if (!prev || Number(i.quantity) > Number(prev.quantity)) map.set(i.id, i);
  }
  return map;
}
const latestByItem = maxByItem;

const ALERT_TEXT = { other_network: 'không dùng wifi quán', unknown_device: 'chấm bằng máy lạ', shared_device: 'dùng máy của người khác', admin_no_qr: 'admin chấm không quét mã' };

/**
 * sessions: attendance_sessions quanh ngày báo cáo { id, staff_id, date, clock_in, clock_out, auto_closed };
 * date: ngày báo cáo — chỉ giữ các lượt thuộc ca của ngày đó (lượt dọn quán sau nửa đêm tính về ca hôm trước);
 * pending: payroll_requests đang chờ { staff_id, request_type, amount, days, reason };
 * fixes: đơn xin sửa giờ đang chờ; alerts: lần quét bị cảnh báo / bị chặn;
 * settings / shifts / hours: dòng checkin_settings, staff_shifts, checkin_hours (null = tính cả ca như cũ);
 * reviews: chủ đã cho / không cho tính giờ ngoài ca; staffNames: { id: tên };
 * closedDays: ngày quán nghỉ — chủ gọi vào làm thì không tính trễ / về sớm;
 * selfFines: lỗi nhân viên tự ghi trong ngày { staff_id, reason, amount, note } (0đ = chờ chủ định tiền);
 * lateRules: luật đi trễ / về sớm (payroll_late_rules) — về sớm có bị trừ lương không theo luật của từng người.
 */
export function staffData({ sessions = [], pending = [], fixes = [], alerts = [], settings = null, shifts = [], hours = [], reviews = [], staffNames = {}, date = null, closedDays = [],
  selfFines = [], lateRules = [] }) {
  const rules = settings ? normalizeRules(settings, shifts, hours) : null;
  const closedDay = !!date && closedDays.includes(date);
  if (date) sessions = sessions.filter(s => workDayOf(s, rules) === date);
  const reviewOf = new Map(reviews.map(r => [r.attendance_id, r]));
  const nameOf = id => staffNames[id] || 'Không rõ';
  const byStaff = new Map();
  for (const s of sessions) byStaff.set(s.staff_id, [...(byStaff.get(s.staff_id) || []), s]);
  const people = [], outside = [];
  for (const [id, list] of [...byStaff.entries()].sort((a, b) => String(a[1][0].clock_in).localeCompare(String(b[1][0].clock_in)))) {
    const sorted = [...list].sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
    // Giờ tính lương: cả ca, hoặc (từ ngày tính theo ca) chỉ trong ca + giờ ngoài ca chủ đã cho.
    const counted = sorted.map(s => sessionHours(s, rules, reviewOf.get(s.id)));
    const waitMs = counted.reduce((a, h) => a + h.pendingMs, 0);
    if (waitMs) outside.push({ id, name: nameOf(id), minutes: Math.round(waitMs / 60000) });
    const flags = closedDay ? { ...dayFlags(sorted, rules), late: 0, leftEarly: 0 } : dayFlags(sorted, rules);
    // Về sớm quá số phút luật cho phép (từ tháng 11; chưa cài luật về sớm: từ 30 phút) và luật có trừ tiền: bị trừ lương.
    const er = earlyRuleOf(date ? lateRuleOn(lateRules, id, date) : null);
    const cut = er.on && flags.leftEarly > er.allowed && !!date && date.slice(0, 7) >= DAY_PAY_FROM;
    people.push({ id, name: nameOf(id), spans: sorted.map(s => ({ in: s.clock_in, out: s.clock_out || null })),
      hours: Math.round(counted.reduce((a, h) => a + h.countedMs, 0) / 360000) / 10, flags, cut,
      open: sorted.some(s => !s.clock_out), forgot: sorted.some(s => s.auto_closed), waitMinutes: Math.round(waitMs / 60000) });
  }
  // Gộp cảnh báo theo người: "không dùng wifi quán ×2; bị chặn 1 lần".
  const byPerson = new Map();
  for (const a of alerts) {
    const m = byPerson.get(a.staff_id) || new Map();
    for (const w of a.warnings || []) m.set(ALERT_TEXT[w] || w, (m.get(ALERT_TEXT[w] || w) || 0) + 1);
    if (a.action === 'blocked') m.set('bị chặn không cho chấm', (m.get('bị chặn không cho chấm') || 0) + 1);
    byPerson.set(a.staff_id, m);
  }
  return {
    people,
    alerts: [...byPerson].map(([id, m]) => ({ id, name: nameOf(id), items: [...m].map(([text, count]) => ({ text, count })) })),
    pending: pending.map(r => ({ id: r.staff_id, name: nameOf(r.staff_id), kind: r.request_type === 'advance' ? 'advance' : 'absent', amount: Number(r.amount) || 0, days: Number(r.days) || 1, reason: r.reason ? String(r.reason).slice(0, 60) : '' })),
    fixes: fixes.map(f => ({ id: f.staff_id, name: nameOf(f.staff_id), reason: f.reason ? String(f.reason).slice(0, 60) : '' })),
    outside,
    selfFines: selfFines.map(f => ({ id: f.staff_id, name: nameOf(f.staff_id), reason: String(f.reason || '').slice(0, 80), amount: Number(f.amount) || 0,
      note: f.note ? String(f.note).slice(0, 80) : '' })),
  };
}

export function staffBlock(input) {
  const d = staffData(input);
  const lines = ['👥 Nhân viên'];
  if (!d.people.length) lines.push('Không ai chấm công trong ngày.');
  for (const p of d.people) {
    const spans = p.spans.map(s => `${clock(s.in)}–${s.out ? clock(s.out) : '…'}`).join(', ');
    const flags = flagTexts(p.flags);
    if (p.cut) flags[flags.findIndex(t => t.startsWith('về sớm'))] += ' (trừ lương)';
    lines.push(`• ${p.name}: ${spans} (${p.hours.toString().replace('.', ',')} giờ)${flags.length ? ` ⚠ ${flags.join(', ')}` : ''}${p.open ? ' ⚠ chưa bấm ra ca' : ''}${p.forgot ? ' ⚠ quên ra ca, máy tự tính giờ ra' : ''}`);
  }
  if (d.alerts.length) {
    lines.push('⚠ Cảnh báo chấm công:');
    for (const a of d.alerts) lines.push(`• ${a.name}: ${a.items.map(({ text, count }) => (count > 1 ? `${text} ×${count}` : text)).join('; ')}`);
  }
  if (d.selfFines.length) {
    lines.push(`🙋 Nhân viên tự ghi lỗi (${d.selfFines.length}):`);
    for (const f of d.selfFines.slice(0, 10)) lines.push(`• ${f.name}: ${f.reason}${f.note ? ` (${f.note})` : ''} — ${f.amount > 0 ? vnd(f.amount) : 'chờ bạn định tiền'}`);
  }
  const waiting = d.pending.length + d.fixes.length + d.outside.length;
  if (waiting) {
    lines.push(`Chờ bạn duyệt (${waiting}):`);
    for (const r of d.pending.slice(0, 8)) {
      lines.push(`• ${r.name} ${r.kind === 'advance' ? `xin ứng ${vnd(r.amount)}` : `báo nghỉ ${r.days} ngày`}${r.reason ? ` — ${r.reason}` : ''}`);
    }
    for (const f of d.fixes.slice(0, 8)) lines.push(`• ${f.name} xin sửa giờ chấm công${f.reason ? ` — ${f.reason}` : ''}`);
    for (const o of d.outside) lines.push(`• ${o.name} có ${durationText(o.minutes)} ngoài ca chưa tính lương`);
  }
  return lines.join('\n');
}

/**
 * Nhân viên trong một khoảng ngày (tuần / tháng): mỗi người bao nhiêu ngày, bao nhiêu giờ, mấy lần trễ /
 * về sớm / quên ra ca / bị cảnh báo khi quét. from / to: ngày làm đầu / cuối (YYYY-MM-DD).
 */
export function staffRangeData({ sessions = [], alerts = [], settings = null, shifts = [], hours = [], reviews = [], staffNames = {}, from, to, closedDays = [] }) {
  const rules = settings ? normalizeRules(settings, shifts, hours) : null;
  const closed = new Set(closedDays);
  const reviewOf = new Map(reviews.map(r => [r.attendance_id, r]));
  const byDay = new Map();
  for (const s of sessions) {
    const day = workDayOf(s, rules);
    if (day < from || day > to) continue;
    const key = `${s.staff_id}|${day}`;
    byDay.set(key, [...(byDay.get(key) || []), s]);
  }
  const people = new Map();
  const person = id => {
    if (!people.has(id)) people.set(id, { id, name: staffNames[id] || 'Không rõ', days: 0, hours: 0, late: { count: 0, minutes: 0 }, leftEarly: { count: 0, minutes: 0 },
      early: { count: 0, minutes: 0 }, stayed: { count: 0, minutes: 0 }, forgot: 0, warnings: 0, blocked: 0, waitMinutes: 0 });
    return people.get(id);
  };
  for (const [key, list] of byDay) {
    const p = person(key.split('|')[0]);
    const sorted = [...list].sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
    const counted = sorted.map(s => sessionHours(s, rules, reviewOf.get(s.id)));
    p.days += 1;
    p.hours += counted.reduce((a, h) => a + h.countedMs, 0) / 3600000;
    p.waitMinutes += Math.round(counted.reduce((a, h) => a + h.pendingMs, 0) / 60000);
    // Ngày quán nghỉ (chủ gọi vào làm): không tính trễ / về sớm.
    const f = closed.has(key.split('|')[1]) ? { ...dayFlags(sorted, rules), late: 0, leftEarly: 0 } : dayFlags(sorted, rules);
    for (const k of ['late', 'leftEarly', 'early', 'stayed']) if (f[k]) { p[k].count += 1; p[k].minutes += f[k]; }
    if (sorted.some(s => s.auto_closed)) p.forgot += 1;
  }
  for (const a of alerts) {
    const p = person(a.staff_id);
    if (a.action === 'blocked') p.blocked += 1;
    else if (a.warnings?.length) p.warnings += 1;
  }
  const list = [...people.values()].map(p => ({ ...p, hours: Math.round(p.hours * 10) / 10 })).sort((a, b) => b.hours - a.hours);
  return { people: list, totals: { people: list.filter(p => p.days).length, hours: Math.round(list.reduce((a, p) => a + p.hours, 0) * 10) / 10,
    late: list.reduce((a, p) => a + p.late.count, 0), forgot: list.reduce((a, p) => a + p.forgot, 0), warnings: list.reduce((a, p) => a + p.warnings + p.blocked, 0) } };
}

/**
 * day / prev / week: { revenue, bills } của ngày, hôm qua, cùng thứ tuần trước (null = chưa có sổ).
 * ledgerDay: bill trong ngày (để tính giờ đông và món bán chạy).
 */
export function compareBlock({ day, prev, week, weekdayLabel, ledgerDay = [] }) {
  const lines = ['📈 So sánh'];
  const parts = [`Doanh thu ${vnd(day.revenue)}`];
  parts.push(prev ? `hôm qua ${vnd(prev.revenue)}${pct(day.revenue, prev.revenue) ? ` (${pct(day.revenue, prev.revenue)})` : ''}` : 'hôm qua chưa có số');
  parts.push(week ? `${weekdayLabel} tuần trước ${vnd(week.revenue)}${pct(day.revenue, week.revenue) ? ` (${pct(day.revenue, week.revenue)})` : ''}` : `${weekdayLabel} tuần trước chưa có số`);
  lines.push(parts.join(' · '));
  const c = compareData({ day, prev, week, ledgerDay });
  if (day.bills) lines.push(`${day.bills} bill · trung bình ${vnd(c.avgBill)}/bill`);
  if (c.peak) lines.push(`Đông nhất ${c.peak.hour}h–${(c.peak.hour + 1) % 24}h: ${c.peak.bills} bill, ${vnd(c.peak.amount)}`);
  if (c.top.length) lines.push(`Bán chạy: ${c.top.slice(0, 5).map(i => `${i.name} ${i.qty}`).join(', ')}`);
  if (c.slow.length) lines.push(`Bán ít: ${c.slow.map(i => `${i.name} ${i.qty}`).join(', ')}`);
  return lines.join('\n');
}

/** Số liệu của compareBlock dạng dữ liệu (cho biểu đồ trang /thongke). */
// Đồ uống / đồ lặt vặt (bia, nước ngọt, trà, khăn, đá…) theo tên món — Thống kê nhanh chỉ xếp hạng món ăn.
const plainText = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
const DRINK_NAME = /^(bia|nuoc|coca|pepsi|7 ?up|sting|siting|c ?2\b|0 ?do\b|o ?long|tra\b|xa xi|khan\b|da\b|ruou|soju|sua\b|red ?bull|bo huc|revive|aquafina|lavie|sprite|fanta|mirinda|number ?1|monster|cafe|ca phe|heineken|tiger|saigon|sai gon)/;
export const isDrinkItem = name => DRINK_NAME.test(plainText(name));

export function compareData({ day, prev, week, ledgerDay = [] }) {
  const byHour = new Map();
  for (const b of ledgerDay) { const h = hourOf(b.paid_at); const v = byHour.get(h) || { bills: 0, amount: 0 }; byHour.set(h, { bills: v.bills + 1, amount: v.amount + (Number(b.amount) || 0) }); }
  const peak = [...byHour.entries()].sort((a, b) => b[1].amount - a[1].amount)[0];
  const sold = new Map(), foodMap = new Map();
  for (const b of ledgerDay) for (const i of b.items || []) {
    const qty = Number(i.quantity) || 0, price = Number(i.unit_price) || 0;
    // Món ăn (bỏ bia, nước, khăn…, món tặng và dòng giảm giá / vòng xoay giá âm): mọi món, kèm tiền — Thống kê nhanh hiện vài
    // món đầu, bấm xem tất cả.
    if (!i.is_gift && !isDrinkItem(i.name) && qty > 0 && price > 0) {
      const f = foodMap.get(i.name) || { name: i.name, qty: 0, amount: 0 };
      foodMap.set(i.name, { name: i.name, qty: f.qty + qty, amount: f.amount + qty * price });
    }
    // Bỏ món tặng, dòng giảm giá và đồ lặt vặt dưới 5.000đ (khăn, đá...).
    if (price < 5000 || i.is_gift) continue;
    sold.set(i.name, (sold.get(i.name) || 0) + qty);
  }
  const ranked = [...sold.entries()].sort((a, b) => b[1] - a[1]).map(([name, qty]) => ({ name, qty }));
  const foods = [...foodMap.values()].sort((a, b) => b.qty - a.qty || b.amount - a.amount || a.name.localeCompare(b.name, 'vi'))
    .map(f => ({ ...f, amount: Math.round(f.amount) }));
  return {
    prev: prev ? prev.revenue : null, week: week ? week.revenue : null,
    avgBill: day.bills ? day.revenue / day.bills : 0,
    hours: [...byHour.entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => a.hour - b.hour),
    peak: peak ? { hour: peak[0], ...peak[1] } : null,
    top: ranked.slice(0, 8), slow: ranked.length > 8 ? ranked.slice(-3).reverse() : [],
    foods,
  };
}
