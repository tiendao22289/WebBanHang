/**
 * Các mục thêm của báo cáo Zalo hằng ngày:
 *  - lossBlock:    bill huỷ, món bị bớt sau khi in bếp, giảm giá, món tặng
 *  - staffBlock:   chấm công trong ngày, trễ / sớm, ai quên ra ca, đơn chờ duyệt
 *  - compareBlock: so với hôm qua / cùng thứ tuần trước, bill, giờ đông, món bán chạy
 * Mỗi hàm trả về chuỗi (hoặc '' nếu không có gì đáng báo). lossData / staffData / staffRangeData trả về
 * cùng số liệu dạng dữ liệu cho trang /thongke (thẻ số, bảng) — chữ Zalo dựng từ chính dữ liệu đó.
 */
import { dayFlags, durationText, flagTexts, normalizeRules, sessionHours, workDayOf } from './attendanceRules.mjs';
import { DAY_PAY_FROM, EARLY_CUT_MINUTES } from './payroll.mjs';

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
export function lossData({ ledgerDay = [], printed = new Map(), movedIds = new Set(), cancelled = [], menuPrice = new Map() }) {
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
  // Món tặng (0đ) — ước giá trị theo giá menu.
  const gifts = new Map();
  for (const bill of ledgerDay) for (const i of bill.items || []) {
    if (!i.is_gift) continue;
    const g = gifts.get(i.name) || { qty: 0, value: 0 };
    const q = Number(i.quantity) || 0;
    gifts.set(i.name, { qty: g.qty + q, value: g.value + q * (menuPrice.get(String(i.name || '').trim().toLowerCase()) || 0) });
  }
  const giftItems = [...gifts.entries()].sort((a, b) => b[1].qty - a[1].qty).map(([name, g]) => ({ name, ...g }));
  const out = {
    cancelled: { count: cancelRows.length, total: cancelTotal, rows: cancelRows },
    removed: { qty: removed.reduce((a, r) => a + r.qty, 0), value: removed.reduce((a, r) => a + r.value, 0), rows: removed },
    discounts: { count: kinds.reduce((a, d) => a + d.count, 0), amount: kinds.reduce((a, d) => a + d.amount, 0), kinds },
    gifts: { qty: giftItems.reduce((a, g) => a + g.qty, 0), value: giftItems.reduce((a, g) => a + g.value, 0), items: giftItems },
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
 * reviews: chủ đã cho / không cho tính giờ ngoài ca; staffNames: { id: tên }.
 */
export function staffData({ sessions = [], pending = [], fixes = [], alerts = [], settings = null, shifts = [], hours = [], reviews = [], staffNames = {}, date = null }) {
  const rules = settings ? normalizeRules(settings, shifts, hours) : null;
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
    const flags = dayFlags(sorted, rules);
    // Về sớm từ 30 phút (từ tháng 11) bị trừ lương theo giờ.
    const cut = flags.leftEarly >= EARLY_CUT_MINUTES && !!date && date.slice(0, 7) >= DAY_PAY_FROM;
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
export function staffRangeData({ sessions = [], alerts = [], settings = null, shifts = [], hours = [], reviews = [], staffNames = {}, from, to }) {
  const rules = settings ? normalizeRules(settings, shifts, hours) : null;
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
    const f = dayFlags(sorted, rules);
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
export function compareData({ day, prev, week, ledgerDay = [] }) {
  const byHour = new Map();
  for (const b of ledgerDay) { const h = hourOf(b.paid_at); const v = byHour.get(h) || { bills: 0, amount: 0 }; byHour.set(h, { bills: v.bills + 1, amount: v.amount + (Number(b.amount) || 0) }); }
  const peak = [...byHour.entries()].sort((a, b) => b[1].amount - a[1].amount)[0];
  const sold = new Map();
  for (const b of ledgerDay) for (const i of b.items || []) {
    // Bỏ món tặng, dòng giảm giá và đồ lặt vặt dưới 5.000đ (khăn, đá...).
    if ((Number(i.unit_price) || 0) < 5000 || i.is_gift) continue;
    sold.set(i.name, (sold.get(i.name) || 0) + (Number(i.quantity) || 0));
  }
  const ranked = [...sold.entries()].sort((a, b) => b[1] - a[1]).map(([name, qty]) => ({ name, qty }));
  return {
    prev: prev ? prev.revenue : null, week: week ? week.revenue : null,
    avgBill: day.bills ? day.revenue / day.bills : 0,
    hours: [...byHour.entries()].map(([hour, v]) => ({ hour, ...v })).sort((a, b) => a.hour - b.hour),
    peak: peak ? { hour: peak[0], ...peak[1] } : null,
    top: ranked.slice(0, 8), slow: ranked.length > 8 ? ranked.slice(-3).reverse() : [],
  };
}
