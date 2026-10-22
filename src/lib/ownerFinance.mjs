// Tính sổ thu chi của chủ quán (tab /admin/finance). Hàm thuần, không gọi DB,
// để route server và test dùng chung.

// Sổ bắt đầu tính từ ngày này; dữ liệu trước đó không đưa vào.
export const FINANCE_START_DATE = '2026-10-23';

export const FIXED_CATEGORIES = [
  { key: 'rent', label: 'Thuê nhà' },
  { key: 'electricity', label: 'Tiền điện' },
  { key: 'water', label: 'Tiền nước' },
  { key: 'internet', label: 'Internet' },
  { key: 'other', label: 'Chi cố định khác' },
];

const DAY_MS = 86400000;

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

/** Tiền hàng của 1 phiếu Sổ tay "Đi chợ / Chi tiêu": đã trả + còn nợ. */
export function noteCost(note) {
  if (note?.note_type !== 'expense') return 0;
  return Math.max(0, Number(note.amount) || 0) + Math.max(0, Number(note.debt) || 0);
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
 * revenue: dòng finance_revenue_ledger; notes: staff_notes; entries: finance_entries.
 * Chỉ tính các ngày từ FINANCE_START_DATE đến hết hôm nay (giờ VN).
 */
export function summarizeMonth({ month, revenue = [], notes = [], entries = [], today, startDate = FINANCE_START_DATE }) {
  const { start, next, daysInMonth } = monthBounds(month);
  const lastOfMonth = new Date(Date.parse(`${next}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const from = start > startDate ? start : startDate;
  const to = lastOfMonth < today ? lastOfMonth : today;
  const dates = from <= to ? datesBetween(from, to) : [];

  const fixedEntries = entries.filter(e => e.kind === 'fixed' && e.entry_date >= start && e.entry_date < next);
  const fixedMonthTotal = fixedEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const fixedPerDay = fixedMonthTotal / daysInMonth;

  const days = dates.map(date => ({
    date, revenue: 0, bills: 0, cash: 0, transfer: 0, byAccount: {},
    purchases: 0, purchaseNotes: 0, drinks: 0, salary: 0, fixedShare: fixedPerDay, profit: 0,
  }));
  const byDate = new Map(days.map(d => [d.date, d]));

  for (const row of revenue) {
    const day = byDate.get(row.business_date);
    if (!day) continue;
    const amount = Number(row.amount) || 0;
    day.revenue += amount;
    day.bills += 1;
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
  }
  for (const entry of entries) {
    const day = byDate.get(entry.entry_date);
    if (!day) continue;
    if (entry.kind === 'drink') day.drinks += Number(entry.amount) || 0;
    if (entry.kind === 'salary') day.salary += Number(entry.amount) || 0;
  }

  const totals = { revenue: 0, bills: 0, cash: 0, transfer: 0, byAccount: {}, purchases: 0, drinks: 0, salary: 0, fixedShare: 0, profit: 0 };
  for (const day of days) {
    day.profit = day.revenue - day.purchases - day.drinks - day.salary - day.fixedShare;
    for (const key of ['revenue', 'bills', 'cash', 'transfer', 'purchases', 'drinks', 'salary', 'fixedShare', 'profit']) totals[key] += day[key];
    for (const [acc, amount] of Object.entries(day.byAccount)) totals.byAccount[acc] = (totals.byAccount[acc] || 0) + amount;
  }
  return { month, from, to, daysInMonth, fixedMonthTotal, fixedEntries, days, totals };
}
