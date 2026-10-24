/**
 * Các mục thêm của báo cáo Zalo hằng ngày:
 *  - lossBlock:    bill huỷ, món bị bớt sau khi in bếp, giảm giá, món tặng
 *  - staffBlock:   chấm công trong ngày, trễ / sớm, ai quên ra ca, đơn chờ duyệt
 *  - compareBlock: so với hôm qua / cùng thứ tuần trước, bill, giờ đông, món bán chạy
 * Mỗi hàm trả về chuỗi (hoặc '' nếu không có gì đáng báo).
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
 * ledgerDay: bill đã thu trong ngày { order_id, table_number, paid_at, amount, items[] }.
 * printed: Map order_id → [ảnh chụp món lúc in: { id, quantity, unit_price, name, item_options, is_gift }].
 * movedIds: Set mã món đang nằm ở bill khác (chuyển / gộp bàn) — không tính là bớt.
 * cancelled: bill huỷ trong ngày { id, table_number, cancelled_at, cancelled_by_name, total_amount }.
 * menuPrice: Map tên món (chữ thường) → giá menu, để ước giá trị món tặng.
 */
export function lossBlock({ ledgerDay = [], printed = new Map(), movedIds = new Set(), cancelled = [], menuPrice = new Map() }) {
  const lines = [];
  // Bill huỷ — kèm món đã in bếp (đã làm mà không thu tiền).
  if (cancelled.length) {
    const rows = cancelled.map(o => {
      const snap = latestByItem(printed.get(o.id) || []);
      const printedValue = [...snap.values()].reduce((a, i) => a + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0);
      return { o, printedCount: [...snap.values()].reduce((a, i) => a + (Number(i.quantity) || 0), 0), printedValue };
    });
    const total = rows.reduce((a, r) => a + (r.printedValue || Number(r.o.total_amount) || 0), 0);
    lines.push(`Bill huỷ: ${rows.length} — ${vnd(total)}`);
    for (const { o, printedCount, printedValue } of rows.slice(0, 8)) {
      lines.push(`• ${o.cancelled_at ? clock(o.cancelled_at) : '--:--'} Bàn ${o.table_number ?? '?'}${printedCount ? ` · ${printedCount} món đã in bếp (${vnd(printedValue)})` : ` · ${vnd(o.total_amount)}`}${o.cancelled_by_name ? ` · huỷ bởi ${o.cancelled_by_name}` : ''}`);
    }
  }
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
      if (diff > 0) removed.push({ bill, name: label(p.name, p.options), qty: diff, value: diff * p.price });
    }
  }
  if (removed.length) {
    lines.push(`Món bị bớt sau khi in bếp: ${removed.reduce((a, r) => a + r.qty, 0)} món — ${vnd(removed.reduce((a, r) => a + r.value, 0))}`);
    for (const r of removed.slice(0, 10)) lines.push(`• Bàn ${r.bill.table_number ?? '?'} (thu ${clock(r.bill.paid_at)}): ${r.name} ×${r.qty} (${vnd(r.value)})`);
    if (removed.length > 10) lines.push(`• … và ${removed.length - 10} món khác`);
  }
  // Giảm giá (dòng âm trong bill) gom theo loại.
  const discounts = new Map();
  for (const bill of ledgerDay) for (const i of bill.items || []) {
    const amount = (Number(i.unit_price) || 0) * (Number(i.quantity) || 0);
    if (amount >= 0) continue;
    const kind = /vòng xoay/i.test(i.name || '') ? 'Vòng xoay' : String(i.name || 'Giảm giá').split(':')[0].trim();
    const d = discounts.get(kind) || { count: 0, amount: 0 };
    discounts.set(kind, { count: d.count + 1, amount: d.amount - amount });
  }
  if (discounts.size) {
    const all = [...discounts.values()];
    lines.push(`Giảm giá: ${all.reduce((a, d) => a + d.count, 0)} lần — ${vnd(all.reduce((a, d) => a + d.amount, 0))} (${[...discounts.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([k, d]) => `${k} ${d.count} lần ${vnd(d.amount)}`).join(', ')})`);
  }
  // Món tặng (0đ) — ước giá trị theo giá menu.
  const gifts = new Map();
  for (const bill of ledgerDay) for (const i of bill.items || []) {
    if (!i.is_gift) continue;
    const g = gifts.get(i.name) || { qty: 0, value: 0 };
    const q = Number(i.quantity) || 0;
    gifts.set(i.name, { qty: g.qty + q, value: g.value + q * (menuPrice.get(String(i.name || '').trim().toLowerCase()) || 0) });
  }
  if (gifts.size) {
    const all = [...gifts.values()];
    const value = all.reduce((a, g) => a + g.value, 0);
    lines.push(`Món tặng: ${all.reduce((a, g) => a + g.qty, 0)} món${value > 0 ? ` ~ ${vnd(value)}` : ''} (${[...gifts.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 6).map(([n, g]) => `${n} ×${g.qty}`).join(', ')})`);
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
export function staffBlock({ sessions = [], pending = [], fixes = [], alerts = [], settings = null, shifts = [], hours = [], reviews = [], staffNames = {}, date = null }) {
  const rules = settings ? normalizeRules(settings, shifts, hours) : null;
  if (date) sessions = sessions.filter(s => workDayOf(s, rules) === date);
  const reviewOf = new Map(reviews.map(r => [r.attendance_id, r]));
  const lines = ['👥 Nhân viên'];
  const byStaff = new Map(), outside = [];
  for (const s of sessions) byStaff.set(s.staff_id, [...(byStaff.get(s.staff_id) || []), s]);
  if (!byStaff.size) lines.push('Không ai chấm công trong ngày.');
  for (const [id, list] of [...byStaff.entries()].sort((a, b) => String(a[1][0].clock_in).localeCompare(String(b[1][0].clock_in)))) {
    const sorted = [...list].sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));
    // Giờ tính lương: cả ca, hoặc (từ ngày tính theo ca) chỉ trong ca + giờ ngoài ca chủ đã cho.
    const counted = sorted.map(s => sessionHours(s, rules, reviewOf.get(s.id)));
    const hours = counted.reduce((a, h) => a + h.countedMs, 0) / 3600000;
    const waitMs = counted.reduce((a, h) => a + h.pendingMs, 0);
    if (waitMs) outside.push({ id, minutes: Math.round(waitMs / 60000) });
    const open = sorted.some(s => !s.clock_out);
    const spans = sorted.map(s => `${clock(s.clock_in)}–${s.clock_out ? clock(s.clock_out) : '…'}`).join(', ');
    const forgot = sorted.some(s => s.auto_closed);
    const dayFlag = dayFlags(sorted, rules);
    const flags = flagTexts(dayFlag);
    // Về sớm từ 30 phút (từ tháng 11) bị trừ lương theo giờ.
    if (dayFlag.leftEarly >= EARLY_CUT_MINUTES && date && date.slice(0, 7) >= DAY_PAY_FROM) flags[flags.findIndex(t => t.startsWith('về sớm'))] += ' (trừ lương)';
    lines.push(`• ${staffNames[id] || 'Không rõ'}: ${spans} (${(Math.round(hours * 10) / 10).toString().replace('.', ',')} giờ)${flags.length ? ` ⚠ ${flags.join(', ')}` : ''}${open ? ' ⚠ chưa bấm ra ca' : ''}${forgot ? ' ⚠ quên ra ca, máy tự tính giờ ra' : ''}`);
  }
  // Gộp cảnh báo theo người: "Phát: không dùng wifi quán ×2; bị chặn 1 lần".
  const byPerson = new Map();
  for (const a of alerts) {
    const m = byPerson.get(a.staff_id) || new Map();
    for (const w of a.warnings || []) m.set(ALERT_TEXT[w] || w, (m.get(ALERT_TEXT[w] || w) || 0) + 1);
    if (a.action === 'blocked') m.set('bị chặn không cho chấm', (m.get('bị chặn không cho chấm') || 0) + 1);
    byPerson.set(a.staff_id, m);
  }
  if (byPerson.size) {
    lines.push('⚠ Cảnh báo chấm công:');
    for (const [id, m] of byPerson) lines.push(`• ${staffNames[id] || 'Không rõ'}: ${[...m].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join('; ')}`);
  }
  const waiting = pending.length + fixes.length + outside.length;
  if (waiting) {
    lines.push(`Chờ bạn duyệt (${waiting}):`);
    for (const r of pending.slice(0, 8)) {
      lines.push(`• ${staffNames[r.staff_id] || 'Không rõ'} ${r.request_type === 'advance' ? `xin ứng ${vnd(r.amount)}` : `báo nghỉ ${r.days || 1} ngày`}${r.reason ? ` — ${String(r.reason).slice(0, 60)}` : ''}`);
    }
    for (const f of fixes.slice(0, 8)) lines.push(`• ${staffNames[f.staff_id] || 'Không rõ'} xin sửa giờ chấm công${f.reason ? ` — ${String(f.reason).slice(0, 60)}` : ''}`);
    for (const o of outside) lines.push(`• ${staffNames[o.id] || 'Không rõ'} có ${durationText(o.minutes)} ngoài ca chưa tính lương`);
  }
  return lines.join('\n');
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
