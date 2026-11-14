/**
 * Kiểm tra Sổ tay (chỉ đọc) cho workflow "Notes Audit" chạy trên máy quán: tự tính lại từng phiếu và so với
 * số đã lưu — tiền hàng / trả ngay / nợ, nợ đã trả (paid_debt, từng dòng) với sổ trả nợ, tiền thừa chuyển
 * phiếu / trả chủ / bù tiền bỏ thêm khớp hai đầu, lần trả nợ trỏ tới phiếu đã xoá; ô thống kê từng tháng của
 * trang Sổ tay so với cộng thẳng và với Sổ thu chi.
 * Kho mã công khai: KHÔNG in tên, SĐT, nội dung phiếu — chỉ mã phiếu 8 ký tự, giờ VN, số tiền, NV-xxxx.
 */
import { lineWarnings, noteTotals, parsePrice, parseQty } from './notesMath.mjs';
import { handoverTotals, lineDebtBase, noteMoney, openLeftovers, openShortages, paymentItemIndex } from './notesDebts.mjs';
import { notesSummary } from './notesSummary.mjs';

const TOLERANCE = 1000; // lệch dưới 1.000đ coi như khớp (làm tròn)
const MAX_ROWS = 40;
const short = id => String(id || '').slice(0, 8);
const tag = id => (id ? `NV-${String(id).replace(/-/g, '').slice(0, 4)}` : 'NV-?');
const vnTime = iso => { const d = new Date(Date.parse(iso) + 7 * 3600000).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}`; };
const readContent = content => { try { const d = JSON.parse(content); return d && typeof d === 'object' ? d : null; } catch { return null; } };
const sumOf = list => (Array.isArray(list) ? list : []).reduce((a, r) => a + (Number(r?.amount) || 0), 0);
const off = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) >= TOLERANCE;

/** Khoảng một tháng theo giờ VN: '2026-11' → { start, end }. */
export const vnMonthRange = month => {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: new Date(`${month}-01T00:00:00+07:00`), end: new Date(`${next}-01T00:00:00+07:00`) };
};

/**
 * notes: mọi phiếu staff_notes (id, staff_id, note_type, content, amount, debt, paid_debt, created_at);
 * payments: mọi dòng staff_note_payments (id, note_id, item_index, amount, paid_at, paid_from_note_id);
 * months: ['2026-10', '2026-11'] để so ô thống kê.
 */
export function notesAudit({ notes = [], payments = [], months = [] }) {
  const byId = new Map(notes.map(n => [n.id, n]));
  const out = {
    counts: { notes: notes.length, expense: 0, withItems: 0, payments: payments.length },
    totalsMismatch: [], paidDebtMismatch: [], linePaidMismatch: [], overPaidLines: [], unmatchedPayments: [],
    orphanPayments: [], leftoverOverUsed: [], shortOverSettled: [], fundedWithoutMoney: [],
    carryMismatch: [], offsetMismatch: [], costedOtherTypes: [], suspiciousLines: [], months: [],
  };
  const push = (key, row) => { if (out[key].length < MAX_ROWS) out[key].push(row); else out[`${key}More`] = (out[`${key}More`] || 0) + 1; };
  const paysOf = new Map();
  for (const p of payments) {
    if (!byId.has(p.note_id) || (p.paid_from_note_id && !byId.has(p.paid_from_note_id))) {
      push('orphanPayments', { payment: short(p.id), note: short(p.note_id), from: p.paid_from_note_id ? short(p.paid_from_note_id) : null, at: vnTime(p.paid_at), amount: Number(p.amount) || 0,
        why: !byId.has(p.note_id) ? 'phiếu nợ đã xoá' : 'phiếu bỏ tiền đã xoá' });
    }
    paysOf.set(p.note_id, [...(paysOf.get(p.note_id) || []), p]);
  }

  // Chuyển tiền dư / bù tiền bỏ thêm: cộng theo cặp (phiếu đi → phiếu đến) ở cả hai đầu.
  const carryOut = new Map(), carryIn = new Map(), offsetOut = new Map(), settledIn = new Map();
  const add = (map, from, to, amount) => { const k = `${from}>${to}`; map.set(k, (map.get(k) || 0) + (Number(amount) || 0)); };

  for (const n of notes) {
    const data = readContent(n.content);
    const base = { note: short(n.id), at: vnTime(n.created_at), staff: tag(n.staff_id) };
    if (n.note_type !== 'expense') {
      if ((Number(n.amount) || 0) + (Number(n.debt) || 0) > 0) push('costedOtherTypes', { ...base, type: n.note_type, amount: Number(n.amount) || 0, debt: Number(n.debt) || 0 });
      continue;
    }
    out.counts.expense += 1;
    const items = data?.type === 'structured_expense' && Array.isArray(data.items) ? data.items : [];
    const notePays = paysOf.get(n.id) || [];
    if (items.some(i => String(i?.name || '').trim())) {
      out.counts.withItems += 1;
      // 1. Tiền phiếu đã lưu so với các dòng hàng tính lại.
      const t = noteTotals(items);
      if (off(t.paid, n.amount) || off(t.debt, n.debt)) {
        push('totalsMismatch', { ...base, savedPaid: Number(n.amount) || 0, linesPaid: t.paid, savedDebt: Number(n.debt) || 0, linesDebt: t.debt });
      }
      // 2. Nợ đã trả từng dòng so với sổ trả nợ; dòng trả quá số nợ.
      const linePays = new Map();
      for (const p of notePays) {
        if (p.item_index === null || p.item_index === undefined) continue;
        const idx = paymentItemIndex(items, p);
        if (idx < 0) { push('unmatchedPayments', { ...base, payment: short(p.id), at: vnTime(p.paid_at), amount: Number(p.amount) || 0 }); continue; }
        linePays.set(idx, (linePays.get(idx) || 0) + (Number(p.amount) || 0));
      }
      // Dòng gõ giá / số lượng nghi sai (giá dưới 1.000đ, "k" với số quá dài, số lượng nhiều số): tiền dòng có thể sai.
      const odd = items.map((item, idx) => ({ idx, item })).filter(({ item }) => String(item?.name || '').trim() && lineWarnings(item).length);
      if (odd.length) push('suspiciousLines', { ...base, lines: odd.map(({ idx }) => idx + 1),
        amounts: odd.map(({ item }) => Math.round(parsePrice(item.price) * parseQty(item.qty))) });
      items.forEach((item, idx) => {
        if (!String(item?.name || '').trim()) return;
        const paid = Number(item.paid_amount) || 0;
        const logged = linePays.get(idx) || 0;
        const owed = lineDebtBase(item);
        if (paid > owed + TOLERANCE) push('overPaidLines', { ...base, line: idx + 1, owed, paid });
        // Lần trả trước khi có sổ trả nợ không có dòng trong staff_note_payments: chỉ báo khi sổ ghi nhiều hơn dòng.
        if (logged > paid + TOLERANCE) push('linePaidMismatch', { ...base, line: idx + 1, linePaid: paid, logged });
      });
    }
    // 3. paid_debt của phiếu so với tổng các lần trả nợ đã ghi.
    const logged = notePays.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    if (logged > (Number(n.paid_debt) || 0) + TOLERANCE) push('paidDebtMismatch', { ...base, paidDebt: Number(n.paid_debt) || 0, logged });
    if ((Number(n.paid_debt) || 0) > (Number(n.debt) || 0) + TOLERANCE) push('paidDebtMismatch', { ...base, paidDebt: Number(n.paid_debt) || 0, debt: Number(n.debt) || 0, why: 'trả nợ nhiều hơn số nợ' });

    // 4. Tiền thừa: trả chủ + chuyển đi + giữ lại bù không vượt số thừa; bù không vượt số bỏ thêm.
    const m = noteMoney(n, payments);
    const hasMoney = m.given + m.carriedIn > 0;
    const usedOfLeft = m.returned + m.carriedOut + m.offsetOut;
    if (hasMoney && usedOfLeft > Math.max(0, m.balance) + TOLERANCE) {
      push('leftoverOverUsed', { ...base, given: m.given, carriedIn: m.carriedIn, spent: m.spent, funded: m.funded, balance: m.balance, returned: m.returned, carriedOut: m.carriedOut, offsetOut: m.offsetOut });
    }
    if (m.settled > Math.max(0, -m.balance) + TOLERANCE) push('shortOverSettled', { ...base, balance: m.balance, settled: m.settled });
    if (!hasMoney && m.funded > 0) push('fundedWithoutMoney', { ...base, funded: m.funded });

    for (const c of data?.carried_out || []) add(carryOut, n.id, c?.to_note_id, c?.amount);
    for (const c of data?.carried_in || []) add(carryIn, c?.from_note_id, n.id, c?.amount);
    for (const o of data?.offset_out || []) add(offsetOut, n.id, o?.to_note_id, o?.amount);
    for (const s of data?.short_settled || []) add(settledIn, s?.from_note_id, n.id, s?.amount);
  }
  const pairs = (a, b, key, names) => {
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      const [from, to] = k.split('>');
      if (off(a.get(k), b.get(k))) push(key, { from: short(from), to: short(to), [names[0]]: a.get(k) || 0, [names[1]]: b.get(k) || 0 });
    }
  };
  pairs(carryOut, carryIn, 'carryMismatch', ['ghiChuyenDi', 'ghiNhanVao']);
  pairs(offsetOut, settledIn, 'offsetMismatch', ['ghiGiuLaiBu', 'ghiDaBu']);

  // 5. Ô thống kê từng tháng (trang Sổ tay) so với cộng thẳng từ phiếu và với cách Sổ thu chi tính.
  for (const month of months) {
    const range = vnMonthRange(month);
    const s = notesSummary(notes, payments, range);
    const inMonth = notes.filter(n => { const t = Date.parse(n.created_at); return t >= range.start.getTime() && t < range.end.getTime(); });
    const expense = inMonth.filter(n => n.note_type === 'expense');
    const goodsDirect = expense.reduce((a, n) => a + Math.max(0, Number(n.amount) || 0) + Math.max(0, Number(n.debt) || 0), 0);
    const givenDirect = expense.reduce((a, n) => a + (Number(readContent(n.content)?.input_amount) || 0), 0);
    const paidInMonth = payments.filter(p => { const t = Date.parse(p.paid_at); return t >= range.start.getTime() && t < range.end.getTime(); })
      .reduce((a, p) => a + (Number(p.amount) || 0), 0);
    // Tiền của các phiếu trong tháng so với tiền chủ đưa: phiếu dư (đã trả chủ / chuyển / giữ lại bù / còn cầm),
    // phiếu thiếu (người đi chợ bỏ thêm, đã bù / chưa bù), phiếu không ghi tiền chủ đưa.
    const cash = { duPhieu: 0, du: 0, daTraChu: 0, chuyenPhieuSau: 0, giuLaiBu: 0, conCam: 0, thieuPhieu: 0, thieu: 0, daBu: 0, chuaBu: 0, khongGhiTienGiao: 0 };
    for (const n of expense) {
      const m = noteMoney(n, payments);
      if (m.given + m.carriedIn <= 0) { cash.khongGhiTienGiao += 1; continue; }
      if (m.balance >= 0) {
        cash.duPhieu += 1; cash.du += m.balance; cash.daTraChu += m.returned; cash.chuyenPhieuSau += m.carriedOut; cash.giuLaiBu += m.offsetOut; cash.conCam += m.left;
      } else {
        cash.thieuPhieu += 1; cash.thieu += -m.balance; cash.daBu += m.settled; cash.chuaBu += m.short;
      }
    }
    // Từng ngày cộng lại phải bằng cả tháng (các ô cộng dồn được).
    const dayKeys = ['given', 'goods', 'cashNow', 'debtPaid', 'giveBack'];
    const daysSum = Object.fromEntries(dayKeys.map(k => [k, 0]));
    for (let t = range.start.getTime(); t < range.end.getTime(); t += 86400000) {
      const d = notesSummary(notes, payments, { start: new Date(t), end: new Date(t + 86400000) });
      for (const k of dayKeys) daysSum[k] += d[k];
    }
    out.months.push({
      month, notes: inMonth.length,
      tiles: { chuDua: s.given, tienHang: s.goods, chiTienMat: s.cash, traNo: s.debtPaid, conNo: s.debtLeft, traLaiChu: s.giveBack },
      direct: { chuDua: givenDirect, tienHangSoThuChi: goodsDirect, traNoTrongThang: paidInMonth },
      lech: { tienHang: s.goods - goodsDirect, chuDua: s.given - givenDirect },
      lechCongTungNgay: Object.fromEntries(dayKeys.map(k => [k, daysSum[k] - s[k]])),
      tienPhieu: cash,
    });
  }
  // Ô "Còn phải đưa chủ" tới giờ (như trang Sổ tay: tiền thừa từ 01/10, tiền bỏ thêm từ 01/11, tính theo từng người).
  const h = handoverTotals(openLeftovers(notes, payments, '2026-10-01'), openShortages(notes, payments, '2026-11-01'));
  out.now = { tienThuaDangCam: h.held, tienBoThemChuaBu: h.short, conPhaiDuaChu: h.toOwner, chuConNoNguoiDiCho: h.owes };
  const dayDrift = out.months.filter(m => Object.values(m.lechCongTungNgay).some(v => Math.abs(v) >= TOLERANCE)).map(m => `lechCongTungNgay ${m.month}`);
  const tileDrift = out.months.filter(m => Math.abs(m.lech.tienHang) >= TOLERANCE || Math.abs(m.lech.chuDua) >= TOLERANCE).map(m => `lech o thang ${m.month}`);
  const problems = ['totalsMismatch', 'paidDebtMismatch', 'linePaidMismatch', 'overPaidLines', 'unmatchedPayments', 'orphanPayments',
    'leftoverOverUsed', 'shortOverSettled', 'fundedWithoutMoney', 'carryMismatch', 'offsetMismatch', 'costedOtherTypes']
    .filter(k => out[k].length).map(k => `${k}: ${out[k].length + (out[`${k}More`] || 0)}`);
  out.summary = [...problems, ...tileDrift, ...dayDrift].length ? [...problems, ...tileDrift, ...dayDrift] : ['Không thấy lệch'];
  // Dòng gõ nghi sai không phải lệch sổ, chỉ cần người ghi xem lại.
  if (out.suspiciousLines.length) out.summary.push(`xem lại giá gõ: ${out.suspiciousLines.length + (out.suspiciousLinesMore || 0)} phiếu`);
  return out;
}
