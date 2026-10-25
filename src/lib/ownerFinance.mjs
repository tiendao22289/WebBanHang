// Tính sổ thu chi của chủ quán (tab /admin/finance). Hàm thuần, không gọi DB,
// để route server và test dùng chung.

// Sổ bắt đầu tính từ ngày này; dữ liệu trước đó không đưa vào.
import { lineWarnings, noteTotals, parsePrice as linePrice, parseQty } from './notesMath.mjs';

export const FINANCE_START_DATE = '2026-10-23';

export const FIXED_CATEGORIES = [
  { key: 'rent', label: 'Thuê nhà' },
  { key: 'electricity', label: 'Tiền điện' },
  { key: 'water', label: 'Tiền nước' },
  { key: 'internet', label: 'Internet' },
  { key: 'other', label: 'Chi cố định khác' },
];

const DAY_MS = 86400000;

// Ảnh bill giấy / ảnh chuyển khoản giữ 3 tháng rồi tự xoá (số tiền vẫn giữ).
export const RECEIPT_IMAGE_DAYS = 90;
export const RECEIPT_BUCKET = 'finance-receipts';
export const RECEIPT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Ngày theo giờ Việt Nam (YYYY-MM-DD) của một thời điểm. */
export function vnDate(value) {
  return new Date(new Date(value).getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

export function isMonthKey(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '');
}

/** Ngày đầu tháng, ngày đầu tháng sau và số ngày của tháng (YYYY-MM). */
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m, 1));
  return {
    start: start.toISOString().slice(0, 10),
    next: next.toISOString().slice(0, 10),
    daysInMonth: Math.round((next - start) / DAY_MS),
  };
}

/** Mốc UTC của 00:00 giờ VN ngày `date` — để lọc cột timestamptz. */
export function vnDayStartIso(date) {
  return new Date(`${date}T00:00:00.000+07:00`).toISOString();
}

/** Các dòng hàng của phiếu Sổ tay dạng bảng (structured_expense), hoặc []. */
export function noteItems(note) {
  try {
    if (!note?.content?.includes('structured_expense')) return [];
    return JSON.parse(note.content).items || [];
  } catch { return []; }
}

/** Tiền hàng của 1 phiếu Sổ tay "Đi chợ / Chi tiêu": đã trả + còn nợ. */
export function noteCost(note) {
  if (note?.note_type !== 'expense') return 0;
  return Math.max(0, Number(note.amount) || 0) + Math.max(0, Number(note.debt) || 0);
}

/**
 * Đọc giá một dòng hàng Sổ tay giống trang Sổ tay: "250k" = 250.000, còn
 * "250" là 250đ.
 */
export function parseNotePrice(value) {
  const s = String(value ?? '').toLowerCase().trim();
  const num = parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
  return s.includes('k') ? num * 1000 : num;
}

// Hàng chợ không có món nào dưới 1.000đ → nhiều khả năng gõ thiếu chữ "k".
export const SUSPICIOUS_PRICE_BELOW = 1000;

/** Các dòng hàng có giá đáng ngờ (có giá nhưng dưới 1.000đ). */
export function suspiciousNoteItems(items) {
  return (items || []).filter(i => {
    const price = parseNotePrice(i.price);
    return i.name && price > 0 && price < SUSPICIOUS_PRICE_BELOW;
  });
}

/**
 * So chốt sổ ngày với sổ: tiền mặt đếm được − tiền mặt sổ ghi, và từng tài
 * khoản ngân hàng. Dương = thừa, âm = thiếu. null nếu chưa nhập ô đó.
 */
export function closeDifferences(day, close) {
  if (!close) return null;
  const cashCounted = close.cash_counted === null || close.cash_counted === undefined ? null : Number(close.cash_counted);
  const banks = {};
  for (const [acc, amount] of Object.entries(close.bank_counted || {})) {
    if (amount === null || amount === '' || amount === undefined) continue;
    banks[acc] = Number(amount) - (day.byAccount[acc] || 0);
  }
  return {
    cashCounted,
    cashDiff: cashCounted === null ? null : cashCounted - day.cash,
    bankDiffs: banks,
    closedBy: close.closed_by_name || null,
    closedAt: close.closed_at || null,
    note: close.note || null,
  };
}

function datesBetween(from, toInclusive) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${toInclusive}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Gom số liệu 1 tháng thành từng ngày + tổng tháng.
 * revenue: dòng finance_revenue_ledger; notes: staff_notes; entries: finance_entries;
 * categories: finance_categories (để biết tab tự tạo nhập theo ngày hay theo tháng);
 * paperBills: finance_manual_receipts (bill giấy nhập tay, cộng vào doanh thu).
 * wages: payrollCost() — lương mỗi ngày theo chấm công (byDay) + thưởng − phạt cả tháng (monthExtra).
 *   Khoản lương nhập tay cũ (finance_entries kind 'salary') không tính nữa.
 * Chỉ tính các ngày từ FINANCE_START_DATE đến hết hôm nay (giờ VN).
 */
export function summarizeMonth({ month, revenue = [], paperBills = [], notes = [], entries = [], closes = [], categories = [], wages = null, today, startDate = FINANCE_START_DATE }) {
  const { start, next, daysInMonth } = monthBounds(month);
  const lastOfMonth = new Date(Date.parse(`${next}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const from = start > startDate ? start : startDate;
  const to = lastOfMonth < today ? lastOfMonth : today;
  const dates = from <= to ? datesBetween(from, to) : [];

  const fixedEntries = entries.filter(e => e.kind === 'fixed' && e.entry_date >= start && e.entry_date < next);
  const fixedMonthTotal = fixedEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const fixedPerDay = fixedMonthTotal / daysInMonth;

  // Tab tự tạo: theo tháng thì chia đều như chi cố định, theo ngày thì tính đúng ngày.
  const monthlyTabs = new Set(categories.filter(c => c.scope === 'tab' && c.schedule === 'monthly').map(c => c.id));
  const customMonthTotals = {};
  for (const e of entries) {
    if (e.kind !== 'custom' || !monthlyTabs.has(e.category) || e.entry_date < start || e.entry_date >= next) continue;
    customMonthTotals[e.category] = (customMonthTotals[e.category] || 0) + (Number(e.amount) || 0);
  }
  const customDailyShare = Object.fromEntries(Object.entries(customMonthTotals).map(([id, total]) => [id, total / daysInMonth]));

  const days = dates.map(date => ({
    date, revenue: 0, bills: 0, paperBills: 0, paperRevenue: 0, cash: 0, transfer: 0, byAccount: {},
    purchases: 0, purchaseNotes: 0, suspiciousNotes: 0, mismatchNotes: 0, drinks: 0, salary: Number(wages?.byDay?.[date]) || 0, fixedShare: fixedPerDay,
    custom: { ...customDailyShare }, customTotal: 0, profit: 0, close: null,
  }));
  const byDate = new Map(days.map(d => [d.date, d]));

  // Bill trên hệ thống và bill giấy cùng cộng vào doanh thu, tiền mặt / từng thẻ.
  const receipts = [...revenue.map(r => ({ ...r, paper: false })), ...paperBills.map(r => ({ ...r, paper: true }))];
  for (const row of receipts) {
    const day = byDate.get(row.business_date);
    if (!day) continue;
    const amount = Number(row.amount) || 0;
    day.revenue += amount;
    if (row.paper) { day.paperBills += 1; day.paperRevenue += amount; } else day.bills += 1;
    if (row.payment_method === 'transfer') {
      day.transfer += amount;
      const key = row.account_id || 'unknown';
      day.byAccount[key] = (day.byAccount[key] || 0) + amount;
    } else {
      day.cash += amount;
    }
  }
  for (const note of notes) {
    const day = byDate.get(vnDate(note.created_at));
    const cost = noteCost(note);
    if (!day || cost <= 0) continue;
    day.purchases += cost;
    day.purchaseNotes += 1;
    if (suspiciousNoteItems(noteItems(note)).length || noteLineWarnings(note).length) day.suspiciousNotes += 1;
    if (noteMismatch(note)) day.mismatchNotes += 1;
  }
  for (const entry of entries) {
    const day = byDate.get(entry.entry_date);
    if (!day) continue;
    if (entry.kind === 'drink') day.drinks += Number(entry.amount) || 0;
    if (entry.kind === 'custom' && !monthlyTabs.has(entry.category)) {
      day.custom[entry.category] = (day.custom[entry.category] || 0) + (Number(entry.amount) || 0);
    }
  }

  const closeByDate = new Map(closes.map(c => [c.business_date, c]));
  for (const day of days) day.close = closeDifferences(day, closeByDate.get(day.date));

  const totals = { revenue: 0, bills: 0, paperBills: 0, paperRevenue: 0, cash: 0, transfer: 0, byAccount: {}, purchases: 0, drinks: 0, salary: 0, fixedShare: 0,
    custom: {}, customTotal: 0, profit: 0 };
  for (const day of days) {
    day.customTotal = Object.values(day.custom).reduce((sum, v) => sum + v, 0);
    day.profit = day.revenue - day.purchases - day.drinks - day.salary - day.fixedShare - day.customTotal;
    for (const key of ['revenue', 'bills', 'paperBills', 'paperRevenue', 'cash', 'transfer', 'purchases', 'drinks', 'salary', 'fixedShare', 'customTotal', 'profit', 'suspiciousNotes', 'mismatchNotes']) totals[key] = (totals[key] || 0) + day[key];
    for (const [acc, amount] of Object.entries(day.byAccount)) totals.byAccount[acc] = (totals.byAccount[acc] || 0) + amount;
    for (const [id, amount] of Object.entries(day.custom)) totals.custom[id] = (totals.custom[id] || 0) + amount;
  }
  // Thưởng − phạt lương tính theo tháng (trang Lương), không chia vào ngày nào.
  totals.salaryExtra = Number(wages?.monthExtra) || 0;
  totals.salary += totals.salaryExtra;
  totals.profit -= totals.salaryExtra;
  return { month, from, to, daysInMonth, fixedMonthTotal, fixedEntries, customMonthTotals, days, totals, wagesReady: !!wages };
}

const vnd = n => `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
const signed = n => `${n < 0 ? '-' : '+'}${vnd(Math.abs(n))}`;

/**
 * Tin Zalo báo cáo một ngày cho chủ quán. `day` là một phần tử của
 * summarizeMonth().days, `monthTotals` là totals của tháng (tới ngày đó),
 * `alerts` = { missingPhoto, unchecked } của bill chuyển khoản trong tháng.
 */
export function dailyReportText({ day, monthTotals, accounts = [], alerts = {}, title = 'Báo cáo', forZalo = true }) {
  const [y, m, d] = day.date.split('-');
  const weekday = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${day.date}T00:00:00Z`).getUTCDay()];
  const accountName = id => accounts.find(a => a.id === id)?.name || 'Không rõ thẻ';
  const cost = day.purchases + day.drinks + day.salary + day.fixedShare + day.customTotal;
  const lines = [`📒 ${title} Sổ thu chi · ${weekday} ${d}/${m}/${y}`, ''];
  lines.push(`Doanh thu: ${vnd(day.revenue)} (${day.bills} bill${day.paperBills ? ` + ${day.paperBills} bill giấy` : ''})`);
  lines.push(`• Tiền mặt: ${vnd(day.cash)}`);
  for (const [id, amount] of Object.entries(day.byAccount || {})) lines.push(`• CK ${accountName(id)}: ${vnd(amount)}`);
  const parts = [['đi chợ', day.purchases], ['nước', day.drinks], ['lương', day.salary], ['cố định', day.fixedShare], ['khác', day.customTotal]]
    .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${vnd(v)}`);
  lines.push(`Chi: ${vnd(cost)}${parts.length ? ` (${parts.join(', ')})` : ''}`);
  lines.push(`${day.profit < 0 ? 'Lỗ' : 'Lãi'} ngày: ${signed(day.profit)}`);
  if (monthTotals) lines.push(`Tháng ${m} tới nay: thu ${vnd(monthTotals.revenue)} · ${monthTotals.profit < 0 ? 'lỗ' : 'lãi'} ${vnd(Math.abs(monthTotals.profit))}`);

  const warnings = dailyWarnings({ day, accounts, alerts });
  lines.push('');
  if (warnings.length) lines.push(...warnings.map(w => `⚠ ${w}`));
  else lines.push('✓ Không có gì bất thường');
  // Zalo chỉ cho OA nhắn lại người vừa nhắn mình → nhắc chủ quán trả lời. Trang /thongke thì không cần.
  if (forZalo) lines.push('', 'Nhắn "ok" để Zalo cho phép gửi tiếp báo cáo các ngày sau.');
  return lines.join('\n');
}

/** Cảnh báo của một ngày (chưa chốt sổ, lệch két, bill CK thiếu ảnh...) — dùng cho Zalo và /thongke. */
export function dailyWarnings({ day, accounts = [], alerts = {} }) {
  const accountName = id => accounts.find(a => a.id === id)?.name || 'Không rõ thẻ';
  const warnings = [];
  if (!day.close) warnings.push('Chưa chốt sổ ngày này');
  else {
    if (day.close.cashDiff) warnings.push(`Tiền mặt ${day.close.cashDiff < 0 ? 'thiếu' : 'dư'} ${vnd(Math.abs(day.close.cashDiff))}`);
    for (const [id, diff] of Object.entries(day.close.bankDiffs || {})) {
      if (diff) warnings.push(`${accountName(id)} ${diff < 0 ? 'thiếu' : 'dư'} ${vnd(Math.abs(diff))}`);
    }
  }
  if (alerts.missingPhoto) warnings.push(`${alerts.missingPhoto} bill CK chưa có ảnh (tháng này)`);
  if (alerts.unchecked) warnings.push(`${alerts.unchecked} bill CK chưa đối chiếu (tháng này)`);
  if (day.mismatchNotes) warnings.push(`${day.mismatchNotes} phiếu Sổ tay lệch tiền (tổng phiếu khác các dòng hàng)`);
  if (day.suspiciousNotes) warnings.push(`${day.suspiciousNotes} phiếu Sổ tay giá / số lượng đáng ngờ`);
  return warnings;
}

/** Tên món / hàng để so khớp: bỏ dấu, chữ thường ("Ốc Hương" = "oc huong"). */
export function itemKey(name) {
  return String(name || '').replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

const qtyNumber = qty => parseFloat(String(qty ?? '').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;

/** Tiền một dòng hàng Sổ tay — giống trang Sổ tay: giá × số lượng (không ghi số lượng = 1). */
export function noteLineCost(item) {
  return Math.round(linePrice(item?.price) * parseQty(item?.qty));
}

/**
 * Phiếu có dòng hàng mà tổng tiền đã lưu (đã trả + nợ) khác tổng các dòng tính lại
 * — thường do lỗi cũ của Sổ tay ("2,5kg" bị hiểu thành 25kg). 0 = khớp (lệch < 1.000đ).
 */
export function noteMismatch(note) {
  const items = noteItems(note).filter(i => String(i?.name || '').trim());
  if (!items.length || note?.note_type !== 'expense') return 0;
  const diff = noteCost(note) - noteTotals(items).total;
  return Math.abs(diff) >= 1000 ? diff : 0;
}

/** Dòng hàng đáng ngờ: giá thiếu "k", số lượng có nhiều số... */
export const noteLineWarnings = note => noteItems(note).filter(i => String(i?.name || '').trim()).flatMap(i => lineWarnings(i).map(w => `${i.name}: ${w}`));

const groupWords = g => (g.keywords?.length ? g.keywords : [g.name]).map(itemKey).filter(Boolean);

/**
 * Bán ra theo món (món trong bill của sổ) và nhập vào theo hàng (dòng hàng
 * Sổ tay + nước ngọt nhập tay), rồi gom theo nhóm chủ quán đặt: món / hàng
 * nào có chứa từ khoá của nhóm thì vào nhóm đó (nhóm đứng trước được ưu tiên).
 */
export function summarizeItems({ bills = [], notes = [], drinks = [], paperRevenue = 0, groups = [] }) {
  const sold = new Map();
  for (const bill of bills) {
    for (const item of bill.items || []) {
      const qty = Number(item.quantity) || 0;
      const amount = (Number(item.unit_price) || 0) * qty;
      const discount = amount < 0;
      const name = discount ? 'Giảm giá / khuyến mãi' : String(item.name || 'Món không tên').trim();
      const key = discount ? '__discount' : itemKey(name);
      const row = sold.get(key) || { key, name, qty: 0, giftQty: 0, revenue: 0, discount };
      if (!discount) { if (item.is_gift) row.giftQty += qty; else row.qty += qty; }
      row.revenue += amount;
      sold.set(key, row);
    }
  }

  const bought = new Map();
  const addBought = (name, cost, qty) => {
    const key = itemKey(name);
    const row = bought.get(key) || { key, name: String(name).trim(), times: 0, cost: 0, qtyTotal: 0, units: new Set() };
    row.times += 1;
    row.cost += cost;
    const n = qtyNumber(qty);
    if (n) { row.qtyTotal += n; row.units.add(String(qty).replace(/[0-9.,\s]/g, '').toLowerCase()); }
    bought.set(key, row);
  };
  // unitemized: phiếu không ghi dòng hàng; mismatch: tổng phiếu đã lưu − tổng các dòng (phiếu lệch tiền).
  let notesTotal = 0, itemizedTotal = 0, unitemized = 0, mismatch = 0, mismatchNotes = 0;
  for (const note of notes) {
    const total = noteCost(note);
    if (!total) continue;
    notesTotal += total;
    let lines = 0;
    for (const item of noteItems(note)) {
      const cost = noteLineCost(item);
      if (!item.name || !cost) continue;
      lines += cost;
      addBought(item.name, cost, item.qty);
    }
    itemizedTotal += lines;
    if (!lines) unitemized += total;
    else if (Math.abs(total - lines) >= 1000) { mismatch += total - lines; mismatchNotes += 1; }
  }
  const drinksTotal = drinks.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  for (const e of drinks) if (Number(e.amount) > 0) addBought(e.label || 'Nước ngọt / bia', Number(e.amount), '');

  const pick = key => groups.find(g => groupWords(g).some(w => key.includes(w))) || null;
  const soldRows = [...sold.values()].map(r => ({ ...r, group: r.discount ? null : pick(r.key)?.id || null }))
    .sort((a, b) => b.revenue - a.revenue);
  const boughtRows = [...bought.values()].map(({ units, qtyTotal, ...r }) => ({
    ...r, qty: qtyTotal && units.size === 1 ? `${Math.round(qtyTotal * 100) / 100}${[...units][0]}` : '',
    group: pick(r.key)?.id || null,
  })).sort((a, b) => b.cost - a.cost);

  const groupRows = groups.map(g => {
    const dishes = soldRows.filter(r => r.group === g.id);
    const goods = boughtRows.filter(r => r.group === g.id);
    const revenue = dishes.reduce((s, r) => s + r.revenue, 0);
    const cost = goods.reduce((s, r) => s + r.cost, 0);
    return { id: g.id, name: g.name, keywords: g.keywords || [], revenue, qty: dishes.reduce((s, r) => s + r.qty, 0), cost,
      profit: revenue - cost, costRatio: revenue > 0 ? cost / revenue : null, dishes: dishes.map(r => r.key), goods: goods.map(r => r.key) };
  });

  // Gợi ý nhóm: hàng nhập chưa vào nhóm mà tên có trong tên món bán ra.
  const suggestions = boughtRows.filter(r => !r.group && r.key.length >= 3 && soldRows.some(s => !s.discount && s.key.length >= 3 && (s.key.includes(r.key) || r.key.includes(s.key))))
    .slice(0, 8).map(r => r.name);

  const revenue = soldRows.reduce((s, r) => s + r.revenue, 0);
  return {
    sold: soldRows, bought: boughtRows, groups: groupRows, suggestions,
    totals: {
      revenue, paperRevenue, cost: notesTotal + drinksTotal,
      notesTotal, drinksTotal, unitemized, mismatch, mismatchNotes,
      ungroupedRevenue: soldRows.filter(r => !r.group).reduce((s, r) => s + r.revenue, 0),
      ungroupedCost: boughtRows.filter(r => !r.group).reduce((s, r) => s + r.cost, 0) + unitemized + mismatch,
    },
  };
}
