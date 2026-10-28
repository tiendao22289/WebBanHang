import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as finance from '../src/lib/ownerFinance.mjs';
import * as zaloLink from '../src/lib/financeZaloLink.mjs';
import { notesDayData, notesRangeData, notesReportMessages, packMessages } from '../src/lib/notesReport.mjs';
import { compareBlock, compareData, lossBlock, lossData, staffBlock, staffData, staffRangeData } from '../src/lib/dailyInsights.mjs';
import * as dayCheckLib from '../src/lib/dayCheck.mjs';
import * as noteCategoriesLib from '../src/lib/noteCategories.mjs';
import { dayAudit } from '../src/lib/dayAudit.mjs';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { payrollCost } from '../src/lib/payroll.mjs';
import { normalizeRules } from '../src/lib/attendanceRules.mjs';

const source = readFileSync(new URL('../src/app/api/admin/finance/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

// Bộ dựng truy vấn giả kiểu supabase-js, đủ cho route sổ thu chi.
function fakeDb(state, { failTable } = {}) {
  return { from(table) {
    let op = 'read', values, conditions = [], orders = [], range = null, single = false, maybe = false, max = Infinity, conflict = null, ignore = false;
    const q = {
      select() { return q; },
      eq(k, v) { conditions.push(r => r[k] === v); return q; },
      gte(k, v) { conditions.push(r => r[k] >= v); return q; },
      lt(k, v) { conditions.push(r => r[k] < v); return q; },
      lte(k, v) { conditions.push(r => r[k] <= v); return q; },
      gt(k, v) { conditions.push(r => r[k] > v); return q; },
      in(k, vs) { conditions.push(r => vs.includes(r[k])); return q; },
      like(k, pattern) { const needle = pattern.replace(/%/g, ''); conditions.push(r => String(r[k] ?? '').includes(needle)); return q; },
      limit(n) { max = n; return q; },
      is(k, v) { conditions.push(r => (r[k] ?? null) === v); return q; },
      not(k, op, v) { if (op === 'is' && v === null) conditions.push(r => r[k] !== null && r[k] !== undefined); return q; },
      ilike(k, pattern) { const needle = pattern.replace(/%/g, '').toLowerCase(); conditions.push(r => String(r[k] ?? '').toLowerCase().includes(needle)); return q; },
      maybeSingle() { maybe = true; return q; },
      upsert(v, opts) { op = 'upsert'; values = v; conflict = opts?.onConflict; ignore = !!opts?.ignoreDuplicates; return q; },
      order(k) { orders.push(k); return q; },
      range(a, b) { range = [a, b]; return q; },
      insert(v) { op = 'insert'; values = v; return q; },
      delete() { op = 'delete'; return q; },
      update(v) { op = 'update'; values = v; return q; },
      single() { single = true; return q; },
      then(onFulfilled, onRejected) { return new Promise(run).then(onFulfilled, onRejected); },
    };
    function run(resolve) {
        if (failTable === table) return resolve({ data: null, error: { code: '42P01', message: 'missing' } });
        let rows = (state[table] || []).filter(r => conditions.every(c => c(r)));
        state[table] ||= [];
        if (op === 'insert') {
          const inserted = (Array.isArray(values) ? values : [values]).map(v => {
            const row = { id: `00000000-0000-0000-0000-${String(state[table].length + 1).padStart(12, '0')}`, ...v };
            state[table].push(row);
            return row;
          });
          return resolve({ data: single ? inserted[0] : inserted, error: null });
        }
        if (op === 'upsert') {
          const existing = state[table].find(r => r[conflict] === values[conflict]);
          if (existing && !ignore) Object.assign(existing, values); else if (!existing) state[table].push({ ...values });
          return resolve({ data: structuredClone(existing || values), error: null });
        }
        if (op === 'update') { rows.forEach(r => Object.assign(r, values)); return resolve({ data: structuredClone(rows), error: null }); }
        if (op === 'delete') {
          const ids = new Set(rows.map(r => r.id));
          state[table] = state[table].filter(r => !ids.has(r.id));
          return resolve({ data: null, error: null });
        }
        for (const k of [...orders].reverse()) rows = [...rows].sort((a, b) => String(a[k]).localeCompare(String(b[k])));
        if (range) rows = rows.slice(range[0], range[1] + 1);
        rows = rows.slice(0, max);
        resolve({ data: structuredClone(maybe ? rows[0] ?? null : rows), error: null });
    }
    return q;
  } };
}

function load({ role = 'admin', code = 200, state, failTable, sent = [], zaloFails = false, env = {} }) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...finance, ...zaloLink, ...dayCheckLib, ...noteCategoriesLib, dayAudit, notesReportMessages, notesDayData, notesRangeData, packMessages, compareBlock, compareData, lossBlock, lossData, staffBlock, staffData, staffRangeData, AUTO_CLOSE_BY: 'Máy tự đóng (quên ra ca)', createHmac, randomInt, randomUUID, timingSafeEqual, Buffer, process: { env },
    sendOaText: async (_db, id, text) => { sent.push({ id, text }); return zaloFails ? { ok: false, detail: { error: -230 } } : { ok: true }; },
    URL, Number, Math, String, Promise, console: { error() {} }, Date, JSON,
    getStaffSession: async () => code === 200 ? { code, user: { id: 's1', full_name: 'Chủ quán', role } } : { code },
    statusDatabase: () => fakeDb(state, { failTable }),
    signReceiptImages: async (_db, paths) => Object.fromEntries(paths.filter(Boolean).map(p => [p, `signed:${p}`])),
    // Dữ liệu trang Lương (chấm công) của tháng; mặc định chưa ai đi làm.
    loadPayrollMonth: async () => ({ staff: [], configs: [], sessions: [], requests: [], violations: [], bonuses: [], rules: null, reviews: [], closes: [], ...state.payroll }),
    payrollCost,
  });
}

// Kết quả tạo trong vm khác realm → qua JSON để so sánh như dữ liệu API thật.
const plain = res => JSON.parse(JSON.stringify(res));
const get = async (api, query) => plain(await api.GET({ url: `http://x/api/admin/finance?${query}` }));
const post = async (api, body) => plain(await api.POST({ json: async () => body }));
const empty = () => ({ finance_revenue_ledger: [], staff_notes: [], finance_entries: [], bank_accounts: [], staff: [],
  finance_day_closes: [], table_bill_history: [], finance_categories: [] });
const ACC_A = '00000000-0000-0000-0000-0000000000aa';
const later = minutes => new Date(Date.now() + minutes * 60000).toISOString();

test('only a logged-in admin can read or change the finance book', async () => {
  for (const [opts, status] of [[{ code: 401 }, 401], [{ role: 'staff' }, 403], [{ code: 503 }, 503]]) {
    const api = load({ ...opts, state: empty() });
    assert.equal((await get(api, 'month=2026-10')).status, status);
    assert.equal((await post(api, { action: 'add', kind: 'drink', entry_date: '2026-10-23', label: 'x', amount: 1 })).status, status);
  }
});

test('month view adds up more than 1000 bills, purchases, entries and account names', async () => {
  const state = empty();
  for (let i = 0; i < 1203; i++) {
    state.finance_revenue_ledger.push({ order_id: `o${String(i).padStart(5, '0')}`, business_date: '2026-10-23',
      amount: 10000, payment_method: i % 3 ? 'cash' : 'transfer', account_id: i % 3 ? null : 'acc-a' });
  }
  state.staff_notes.push(
    { id: 'n1', created_at: '2026-10-23T02:00:00.000Z', note_type: 'expense', amount: 500000, debt: 200000, content: 'chợ', staff: { full_name: 'Lan' } },
    { id: 'n2', created_at: '2026-10-23T03:00:00.000Z', note_type: 'stock', amount: 999, debt: 0, content: 'thiếu', staff: null });
  state.finance_entries.push(
    { id: 'e1', entry_date: '2026-10-23', kind: 'drink', label: 'Bia', amount: 300000, created_at: '1' },
    { id: 'e2', entry_date: '2026-10-23', kind: 'salary', label: 'Lan', amount: 999999, created_at: '2' },
    { id: 'e3', entry_date: '2026-10-01', kind: 'fixed', category: 'rent', label: 'Thuê nhà', amount: 3100000, created_at: '3' });
  state.bank_accounts.push({ id: 'acc-a', bank_name: 'Vietcombank', account_name: 'A', account_number: '123456789', sort_order: 0 });
  state.staff.push({ id: 's1', full_name: 'Lan' }, { id: 's2', full_name: 'Minh' });
  // Lan đi làm ngày 23 (8 tiếng): lương 6.500.000 ÷ 26 = 250.000đ; lương nhập tay 999.999đ không tính.
  state.payroll = { staff: [{ id: 's1' }], configs: [{ staff_id: 's1', base_salary: 6500000 }],
    rules: normalizeRules({ hours_from: '2026-10-25' }, [], [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]),
    sessions: [{ id: 'w1', staff_id: 's1', date: '2026-10-23', clock_in: '2026-10-23T07:00:00Z', clock_out: '2026-10-23T15:00:00Z' }],
    violations: [{ staff_id: 's1', amount: 30000 }] };
  const res = await get(load({ state }), 'month=2026-10');
  assert.equal(res.status, 200);
  const day = res.body.days.find(d => d.date === '2026-10-23');
  assert.equal(day.bills, 1203);
  assert.equal(day.revenue, 12030000);
  assert.equal(day.transfer, 401 * 10000);
  assert.equal(day.purchases, 700000, 'only Đi chợ notes count, paid + debt');
  assert.equal(day.drinks, 300000);
  assert.equal(day.salary, 250000, 'from attendance, not the typed 999.999đ');
  assert.deepEqual([res.body.totals.salary, res.body.totals.salaryExtra], [220000, -30000], 'a fine lowers the month wage cost');
  assert.equal(day.fixedShare, 100000);
  assert.equal(res.body.fixedEntries.length, 1);
  assert.deepEqual(res.body.entries.map(e => e.id), ['e1', 'e2'], 'fixed costs are listed separately');
  assert.deepEqual(res.body.accounts, [{ id: 'acc-a', name: 'Vietcombank · A', last4: '6789' }]);
  assert.deepEqual(res.body.staff, ['Lan', 'Minh']);
  assert.equal(res.body.startDate, '2026-10-23');
});

test('day view lists bills, purchase notes with items, and that day entries', async () => {
  const state = empty();
  state.finance_revenue_ledger.push(
    { order_id: 'o1', business_date: '2026-10-23', paid_at: '2026-10-23T12:00:00Z', amount: 200000, items: [{ name: 'Ốc hương', quantity: 2, unit_price: 100000 }] },
    { order_id: 'o2', business_date: '2026-10-24', paid_at: '2026-10-24T12:00:00Z', amount: 1 });
  const structured = JSON.stringify({ type: 'structured_expense', note: 'đi chợ sáng',
    items: [{ name: 'Ốc len', qty: '3kg', price: '300.000', paymentStatus: 'debt', creditor: 'Cô Ba' }, { name: '' }] });
  state.staff_notes.push(
    // 23:59 ngày 23 giờ VN vẫn thuộc ngày 23
    { id: 'n1', created_at: '2026-10-23T16:59:00.000Z', note_type: 'expense', amount: 0, debt: 300000, paid_debt: 100000, content: structured, staff: { full_name: 'Lan' } },
    { id: 'n2', created_at: '2026-10-23T17:00:00.000Z', note_type: 'expense', amount: 5, debt: 0, content: 'hôm sau', staff: null });
  state.finance_entries.push({ id: 'e1', entry_date: '2026-10-23', kind: 'drink', label: 'Coca', amount: 100000, created_at: '1' });
  const res = await get(load({ state }), 'date=2026-10-23');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bills.map(b => b.order_id), ['o1']);
  assert.equal(res.body.notes.length, 1);
  assert.equal(res.body.notes[0].cost, 300000);
  assert.equal(res.body.notes[0].debtLeft, 200000, 'debt already paid back is not shown as still owed');
  assert.equal(res.body.notes[0].text, 'đi chợ sáng');
  assert.deepEqual(res.body.notes[0].items, [{ name: 'Ốc len', qty: '3kg', price: '300.000', paymentStatus: 'debt', creditor: 'Cô Ba' }]);
  assert.deepEqual(res.body.entries.map(e => e.id), ['e1']);
  assert.equal((await get(load({ state }), 'date=23-10-2026')).status, 400);
  assert.equal((await get(load({ state }), 'month=2026-13')).status, 400);
});

test('drinks and fixed costs are saved with the right date; salary is no longer typed in; bad input is refused', async () => {
  const state = empty();
  const api = load({ state });
  let res = await post(api, { action: 'add', kind: 'drink', entry_date: '2026-10-23', label: '', amount: 120000 });
  assert.equal(res.status, 400, 'drink needs a label (the page sends a default)');
  res = await post(api, { action: 'add', kind: 'drink', entry_date: '2026-10-23', label: 'Nước ngọt / bia', amount: 120000 });
  assert.equal(res.body.entry.entry_date, '2026-10-23');
  assert.equal(res.body.entry.created_by_name, 'Chủ quán');
  res = await post(api, { action: 'add', kind: 'salary', entry_date: '2026-10-23', label: '  Lan ', amount: '250000', note: 'ca tối' });
  assert.deepEqual([res.status, res.body.error], [400, 'Lương tự tính theo chấm công ở trang Lương, không nhập ở Sổ thu chi nữa.']);
  res = await post(api, { action: 'add', kind: 'fixed', month: '2026-10', category: 'electricity', amount: 1500000, entry_date: 'ignored' });
  assert.deepEqual([res.body.entry.entry_date, res.body.entry.category, res.body.entry.label], ['2026-10-01', 'electricity', 'Tiền điện']);
  for (const bad of [
    { kind: 'salary', entry_date: '2026-10-23', label: '', amount: 1 },
    { kind: 'drink', entry_date: '2026-10-23', label: 'x', amount: 0 },
    { kind: 'drink', entry_date: '2026-10-23', label: 'x', amount: -5 },
    { kind: 'drink', entry_date: 'hôm nay', label: 'x', amount: 5 },
    { kind: 'fixed', month: '2026-10', category: 'casino', amount: 5 },
    { kind: 'fixed', month: 'tháng 10', category: 'rent', amount: 5 },
    { kind: 'bonus', entry_date: '2026-10-23', label: 'x', amount: 5 },
  ]) assert.equal((await post(api, { action: 'add', ...bad })).status, 400, JSON.stringify(bad));
  assert.equal(state.finance_entries.length, 2, 'drink + fixed, no salary');
  res = await post(api, { action: 'delete', id: state.finance_entries[0].id });
  assert.equal(res.body.ok, true);
  assert.equal(state.finance_entries.length, 1);
  assert.equal((await post(api, { action: 'delete', id: 'x' })).status, 400);
  assert.equal((await post(api, { action: 'hack' })).status, 400);
});

test('a database without the finance tables says setup is missing instead of failing', async () => {
  const res = await get(load({ state: empty(), failTable: 'finance_revenue_ledger' }), 'month=2026-10');
  assert.equal(res.status, 503);
  assert.equal(res.body.setupMissing, true);
});

test('a day close is saved, updated in place, validated and shown with its differences', async () => {
  const state = empty();
  state.finance_revenue_ledger.push(
    { order_id: 'o1', business_date: '2026-10-23', paid_at: '2026-10-23T05:00:00Z', amount: 500000, payment_method: 'cash' },
    { order_id: 'o2', business_date: '2026-10-23', paid_at: '2026-10-23T06:00:00Z', amount: 300000, payment_method: 'transfer', account_id: ACC_A });
  state.bank_accounts.push({ id: ACC_A, bank_name: 'MB', account_name: 'A', account_number: '1', sort_order: 0 });
  const api = load({ state });
  let res = await post(api, { action: 'close', date: '2026-10-23', cash_counted: 480000, bank_counted: { [ACC_A]: 300000 }, note: 'thiếu 20k' });
  assert.equal(res.status, 200);
  res = await post(api, { action: 'close', date: '2026-10-23', cash_counted: '500000', bank_counted: { [ACC_A]: '' } });
  assert.equal(state.finance_day_closes.length, 1, 'closing again updates the same day');
  const saved = plain(state.finance_day_closes[0]);
  assert.deepEqual([saved.cash_counted, saved.bank_counted, saved.closed_by_name], [500000, {}, 'Chủ quán']);
  const day = await get(api, 'date=2026-10-23');
  assert.deepEqual([day.body.dayCash, day.body.dayByAccount[ACC_A], day.body.closeDiff.cashDiff], [500000, 300000, 0]);
  const month = await get(api, 'month=2026-10');
  assert.equal(month.body.days.find(d => d.date === '2026-10-23').close.cashDiff, 0);
  for (const bad of [
    { date: '2026-10-22', cash_counted: 1 },
    { date: '2099-01-01', cash_counted: 1 },
    { date: '2026-10-23', cash_counted: -5 },
    { date: '2026-10-23', cash_counted: 'abc' },
    { date: '2026-10-23', bank_counted: { 'not-an-account': 5 } },
    { date: '2026-10-23', cash_counted: '', bank_counted: {} },
  ]) assert.equal((await post(api, { action: 'close', ...bad })).status, 400, JSON.stringify(bad));
});

test('fixed costs are copied from the previous month once and never over an existing month', async () => {
  const state = empty();
  state.finance_entries.push(
    { id: 'f1', entry_date: '2026-10-01', kind: 'fixed', category: 'rent', label: 'Thuê nhà', amount: 6000000, created_at: '1' },
    { id: 'f2', entry_date: '2026-10-01', kind: 'fixed', category: 'electricity', label: 'Tiền điện', amount: 1500000, created_at: '2' },
    { id: 'd1', entry_date: '2026-10-23', kind: 'drink', label: 'Bia', amount: 1, created_at: '3' });
  const api = load({ state });
  const res = await post(api, { action: 'copy_fixed', month: '2026-11' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries.map(e => [e.entry_date, e.label, e.amount]),
    [['2026-11-01', 'Thuê nhà', 6000000], ['2026-11-01', 'Tiền điện', 1500000]]);
  assert.equal((await post(api, { action: 'copy_fixed', month: '2026-11' })).status, 409);
  assert.equal((await post(api, { action: 'copy_fixed', month: '2027-01' })).status, 400, 'December has nothing to copy');
  assert.equal((await post(api, { action: 'copy_fixed', month: 'nov' })).status, 400);
});

test('bills missing from the ledger are filled in from table history, except reopened ones', async () => {
  const state = empty();
  const started = new Date(Date.now() - 3 * 3600000).toISOString();
  const paidAt = later(-30);
  state.finance_revenue_ledger.push({ order_id: 'in-ledger', business_date: '2026-10-23', amount: 1, payment_method: 'cash', recorded_at: started });
  state.orders = [{ id: 'reopened', status: 'pending' }, { id: 'missing-cash', status: 'paid' }];
  state.payment_transactions = [{ order_ids: 'x,missing', account_id: 'acc-b', status: 'completed' }];
  state.table_bill_history.push(
    { order_id: 'in-ledger', paid_at: later(-60), expires_at: later(500), snapshot: {} },
    // Bill chuyển khoản đã bị dọn khỏi orders (định mức) → vẫn phải vào sổ.
    { order_id: 'missing', paid_at: paidAt, expires_at: later(500),
      snapshot: { table_number: 7, customer_name: 'Lan', payment_method: 'transfer', paid_by_name: 'Thu ngân Hoa', created_by_name: null,
        order_items: [{ unit_price: 50000, quantity: 2, menu_item: { name: 'Ốc' }, added_by_name: 'Hùng' }, { unit_price: -10000, quantity: 1, item_name: 'Giảm' }] } },
    { order_id: 'missing-cash', paid_at: paidAt, expires_at: later(500),
      snapshot: { table_number: 8, payment_method: 'cash', order_items: [{ unit_price: 20000, quantity: 1 }] } },
    // Thu xong rồi mở lại → không còn là doanh thu.
    { order_id: 'reopened', paid_at: paidAt, expires_at: later(500), snapshot: { payment_method: 'cash', order_items: [{ unit_price: 1, quantity: 1 }] } },
    // Trước ngày sổ bắt đầu (23/10) thì không thuộc sổ.
    { order_id: 'before-start', paid_at: '2026-10-22T16:59:00.000Z', expires_at: later(500), snapshot: { payment_method: 'cash', order_items: [{ unit_price: 5, quantity: 1 }] } },
    { order_id: 'expired', paid_at: later(-30), expires_at: later(-1), snapshot: {} });
  const res = await get(load({ state }), 'month=2026-10');
  assert.deepEqual(res.body.recoveredBills.map(b => [b.orderId, b.amount]), [['missing', 90000], ['missing-cash', 20000]]);
  assert.deepEqual(res.body.missingBills, []);
  const row = plain(state.finance_revenue_ledger.find(r => r.order_id === 'missing'));
  assert.deepEqual([row.amount, row.payment_method, row.account_id, row.table_number, row.business_date, row.items.map(i => i.name)],
    [90000, 'transfer', 'acc-b', '7', finance.vnDate(paidAt), ['Ốc', 'Giảm']]);
  assert.deepEqual([row.paid_by_name, row.items.map(i => i.added_by)], ['Thu ngân Hoa', ['Hùng', null]], 'names come back from table history too');
  assert.equal(state.finance_revenue_ledger.some(r => r.order_id === 'reopened'), false);
  const today = res.body.days.find(d => d.date === finance.vnDate(paidAt));
  if (today) assert.ok(today.revenue >= 110000, 'recovered bills are already in the totals');

  const again = await get(load({ state }), 'month=2026-10');
  assert.deepEqual(again.body.recoveredBills, [], 'nothing left to recover the second time');

  // Sổ còn trống (vừa cài) vẫn bổ sung bill thu trong ngày từ lịch sử bàn.
  const fresh = empty();
  fresh.table_bill_history.push({ order_id: 'x', paid_at: later(-5), expires_at: later(500),
    snapshot: { payment_method: 'cash', order_items: [{ unit_price: 30000, quantity: 1 }] } });
  assert.deepEqual((await get(load({ state: fresh }), 'month=2026-10')).body.recoveredBills.map(b => b.orderId), ['x']);
  const noHistory = await get(load({ state, failTable: 'table_bill_history' }), 'month=2026-10');
  assert.equal(noHistory.status, 200);
  assert.deepEqual(noHistory.body.recoveredBills, []);
});

test('purchase notes with prices that look like a missing "k" are flagged', async () => {
  const state = empty();
  state.staff_notes.push({ id: 'n1', created_at: '2026-10-23T02:00:00.000Z', note_type: 'expense', amount: 250, debt: 0, staff: null,
    content: JSON.stringify({ type: 'structured_expense', items: [{ name: 'Ốc len', price: '250' }, { name: 'Hàu', price: '300k' }] }) });
  const day = await get(load({ state }), 'date=2026-10-23');
  assert.deepEqual(day.body.notes[0].suspicious, ['Ốc len: 250']);
  const month = await get(load({ state }), 'month=2026-10');
  assert.equal(month.body.days.find(d => d.date === '2026-10-23').suspiciousNotes, 1);
});

const TAB_GAS = '00000000-0000-0000-0000-0000000000a1';
const TAB_ADS = '00000000-0000-0000-0000-0000000000a2';
const SAL_BONUS = '00000000-0000-0000-0000-0000000000b1';
const FIX_TRASH = '00000000-0000-0000-0000-0000000000c1';
const ownCategories = () => [
  { id: TAB_GAS, scope: 'tab', name: 'Gas', schedule: 'daily', archived: false, created_at: '1' },
  { id: TAB_ADS, scope: 'tab', name: 'Quảng cáo', schedule: 'monthly', archived: false, created_at: '2' },
  { id: SAL_BONUS, scope: 'salary', name: 'Thưởng', schedule: 'daily', archived: false, created_at: '3' },
  { id: FIX_TRASH, scope: 'fixed', name: 'Tiền rác', schedule: 'daily', archived: false, created_at: '4' },
];

test('own tabs, salary types and fixed items are created once, validated and can be hidden', async () => {
  const state = empty();
  state.finance_categories = [];
  const api = load({ state });
  let res = await post(api, { action: 'add_category', scope: 'tab', name: '  Gas   bình ', schedule: 'daily' });
  assert.deepEqual([res.status, res.body.category.name, res.body.category.schedule], [200, 'Gas bình', 'daily']);
  res = await post(api, { action: 'add_category', scope: 'tab', name: 'Quảng cáo', schedule: 'monthly' });
  assert.equal(res.body.category.schedule, 'monthly');
  assert.equal((await post(api, { action: 'add_category', scope: 'tab', name: 'gas BÌNH' })).status, 409, 'same name, any case');
  assert.equal((await post(api, { action: 'add_category', scope: 'tab', name: 'Lương' })).status, 409, 'clashes with a built-in tab');
  assert.equal((await post(api, { action: 'add_category', scope: 'fixed', name: 'Tiền điện' })).status, 409, 'clashes with a built-in fixed item');
  assert.equal((await post(api, { action: 'add_category', scope: 'salary', name: 'Thưởng' })).status, 200);
  assert.equal((await post(api, { action: 'add_category', scope: 'salary', name: 'Thưởng tết', schedule: 'monthly' })).body.category.schedule, 'daily', 'only tabs can be monthly');
  for (const bad of [{ scope: 'tab', name: '   ' }, { scope: 'boss', name: 'x' }]) {
    assert.equal((await post(api, { action: 'add_category', ...bad })).status, 400, JSON.stringify(bad));
  }
  const gas = state.finance_categories[0];
  assert.equal((await post(api, { action: 'archive_category', id: gas.id })).status, 200);
  assert.equal(state.finance_categories[0].archived, true);
  assert.equal((await post(api, { action: 'add_category', scope: 'tab', name: 'Gas bình' })).status, 200, 'a hidden name can be reused');
  assert.equal((await post(api, { action: 'archive_category', id: 'x' })).status, 400);
  const month = await get(api, 'month=2026-10');
  assert.equal(month.body.categories.length, 5, 'hidden items are still returned so old entries keep their names');
});

test('entries go into own tabs, salary types and fixed items with the right date', async () => {
  const state = empty();
  state.finance_categories = ownCategories();
  state.finance_categories.push({ id: '00000000-0000-0000-0000-0000000000d1', scope: 'tab', name: 'Cũ', schedule: 'daily', archived: true, created_at: '5' });
  const api = load({ state });
  let res = await post(api, { action: 'add', kind: 'custom', category: TAB_GAS, entry_date: '2026-10-23', amount: 450000, label: '' });
  assert.deepEqual([res.body.entry.entry_date, res.body.entry.label, res.body.entry.category], ['2026-10-23', 'Gas', TAB_GAS]);
  res = await post(api, { action: 'add', kind: 'custom', category: TAB_ADS, month: '2026-10', entry_date: '2026-10-23', amount: 3100000, label: 'Facebook' });
  assert.deepEqual([res.body.entry.entry_date, res.body.entry.label], ['2026-10-01', 'Facebook'], 'monthly tab is booked on the 1st');
  assert.equal((await post(api, { action: 'add', kind: 'salary', category: SAL_BONUS, entry_date: '2026-10-23', amount: 200000, label: 'Lan' })).status, 400, 'salary comes from attendance now');
  res = await post(api, { action: 'add', kind: 'fixed', category: FIX_TRASH, month: '2026-10', amount: 310000 });
  assert.deepEqual([res.body.entry.entry_date, res.body.entry.label, res.body.entry.category], ['2026-10-01', 'Tiền rác', FIX_TRASH]);
  for (const bad of [
    { kind: 'custom', category: '00000000-0000-0000-0000-0000000000d1', entry_date: '2026-10-23', amount: 1 },
    { kind: 'custom', category: SAL_BONUS, entry_date: '2026-10-23', amount: 1 },
    { kind: 'custom', entry_date: '2026-10-23', amount: 1 },
    { kind: 'salary', category: TAB_GAS, entry_date: '2026-10-23', amount: 1, label: 'Lan' },
    { kind: 'fixed', category: TAB_GAS, month: '2026-10', amount: 1 },
    { kind: 'custom', category: TAB_ADS, entry_date: '2026-10-23', amount: 1 },
  ]) assert.equal((await post(api, { action: 'add', ...bad })).status, 400, JSON.stringify(bad));

  const month = await get(api, 'month=2026-10');
  const day = month.body.days.find(d => d.date === '2026-10-23');
  assert.equal(day.custom[TAB_GAS], 450000);
  assert.equal(day.custom[TAB_ADS], 100000, '3.100.000 / 31 days');
  assert.equal(day.salary, 0, 'nobody clocked in');
  assert.equal(day.fixedShare, 10000);
  assert.equal(day.profit, -(450000 + 100000 + 10000));
  assert.equal(month.body.customMonthTotals[TAB_ADS], 3100000);
  assert.deepEqual(month.body.customMonthlyEntries.map(e => e.label), ['Facebook']);
});

test('paper bills show in the month totals and in the day detail with their photos', async () => {
  const state = empty();
  state.finance_manual_receipts = [
    { id: 'p1', business_date: '2026-10-23', received_at: '2026-10-23T05:00:00Z', amount: 350000, payment_method: 'cash', image_path: 'bill.jpg', table_label: 'Bàn 5', created_by_name: 'Lan' },
    { id: 'p2', business_date: '2026-10-23', received_at: '2026-10-23T06:00:00Z', amount: 420000, payment_method: 'transfer', account_id: ACC_A, image_path: 'bill2.jpg', transfer_image_path: 'ck.jpg' }];
  state.finance_revenue_ledger.push({ order_id: 'o1', business_date: '2026-10-23', paid_at: '2026-10-23T04:00:00Z', amount: 100000, payment_method: 'transfer', account_id: ACC_A, transfer_image_path: 'ck-o1.jpg' });
  const month = await get(load({ state }), 'month=2026-10');
  const day = month.body.days.find(d => d.date === '2026-10-23');
  assert.deepEqual([day.revenue, day.bills, day.paperBills, day.cash, day.transfer], [870000, 1, 2, 350000, 520000]);
  const detail = await get(load({ state }), 'date=2026-10-23');
  assert.deepEqual(detail.body.paperBills.map(b => [b.amount, b.imageUrl, b.transferImageUrl]),
    [[350000, 'signed:bill.jpg', null], [420000, 'signed:bill2.jpg', 'signed:ck.jpg']]);
  assert.equal(detail.body.bills[0].transfer_image_url, 'signed:ck-o1.jpg');
  assert.equal('transfer_image_path' in detail.body.bills[0], false, 'storage paths are not sent to the page');
  assert.deepEqual([detail.body.dayCash, detail.body.dayByAccount[ACC_A]], [350000, 520000], 'day close counts paper bills too');
});

test('bills can be looked up later by table, amount, type and photo to check transfer screenshots', async () => {
  const state = empty();
  state.finance_revenue_ledger.push(
    { order_id: 'b1', business_date: '2026-10-23', paid_at: '2026-10-23T05:00:00Z', table_number: '43', amount: 39000, payment_method: 'transfer', account_id: ACC_A, transfer_image_path: 'ck1.jpg', items: [{ name: 'Ốc', quantity: 1, unit_price: 39000 }] },
    { order_id: 'b2', business_date: '2026-10-23', paid_at: '2026-10-23T06:00:00Z', table_number: '43', amount: 120000, payment_method: 'cash' },
    { order_id: 'b3', business_date: '2026-10-22', paid_at: '2026-10-22T06:00:00Z', table_number: '5', amount: 39000, payment_method: 'transfer', transfer_image_path: null },
    { order_id: 'old', business_date: '2026-07-01', paid_at: '2026-07-01T06:00:00Z', table_number: '43', amount: 39000, payment_method: 'transfer', transfer_image_path: null });
  state.finance_manual_receipts = [
    { id: 'p1', business_date: '2026-10-23', received_at: '2026-10-23T07:00:00Z', table_label: 'Bàn 43', amount: 250000, payment_method: 'transfer', account_id: ACC_A, image_path: 'bill.jpg', transfer_image_path: 'ck2.jpg', created_by_name: 'Lan' }];
  const api = load({ state });
  const find = async q => (await get(api, `search=1&${q}`)).body;

  let r = await find('from=2026-10-20&to=2026-10-23&table=43');
  assert.deepEqual(r.results.map(x => x.id), ['p1', 'b2', 'b1'], 'newest first, paper bills matched by their table note');
  const b1 = r.results.find(x => x.id === 'b1');
  assert.deepEqual([b1.transferImageUrl, b1.items.length, b1.accountId], ['signed:ck1.jpg', 1, ACC_A]);
  const p1 = r.results.find(x => x.id === 'p1');
  assert.deepEqual([p1.billImageUrl, p1.transferImageUrl, p1.by], ['signed:bill.jpg', 'signed:ck2.jpg', 'Lan']);

  assert.deepEqual(plain(r.tables), [{ name: '5', count: 1 }, { name: '43', count: 3 }], 'tables with bills in the range, ignoring the table filter, for quick picking');
  r = await find('from=2026-10-20&to=2026-10-23&table=Bàn 43&type=transfer&image=1');
  assert.deepEqual(r.results.map(x => x.id), ['p1', 'b1'], '"Bàn 43" works like "43"; only transfers with a photo');
  r = await find('from=2026-10-20&to=2026-10-23&amount=39.000');
  assert.deepEqual(r.results.map(x => x.id), ['b1', 'b3']);
  r = await find('from=2026-10-20&to=2026-10-23&type=paper');
  assert.deepEqual(r.results.map(x => x.id), ['p1']);
  r = await find('from=2026-07-01&to=2026-07-01&table=43');
  assert.equal(r.results[0].imageExpired, true, 'a photo older than 3 months shows as removed');

  assert.equal((await get(api, 'search=1&from=2026-10-23&to=2026-10-01')).status, 400);
  assert.equal((await get(api, 'search=1&from=2026-01-01&to=2026-10-23')).status, 400, 'at most 3 months per search');
  assert.equal((await get(load({ state, role: 'staff' }), 'search=1')).status, 403, 'owner only');
});

test('Tra cứu finds bills by staff name: who took the money, who ordered or approved dishes, who typed a paper bill', async () => {
  const state = empty();
  state.staff = [{ id: 's1', full_name: 'Đức Hùng' }, { id: 's2', full_name: 'Lan' }, { id: 's3', full_name: 'Mai' }];
  state.finance_revenue_ledger.push(
    { order_id: 'b1', business_date: '2026-10-27', paid_at: '2026-10-27T10:46:45.494296+00:00', table_number: '4', amount: 395000, payment_method: 'transfer', paid_by_name: 'Lan',
      customer_name: 'Khách ẩn danh', items: [{ name: 'Ốc', quantity: 1, unit_price: 395000, added_by: null }] },
    { order_id: 'b2', business_date: '2026-10-27', paid_at: '2026-10-27T10:46:45.494296+00:00', table_number: '4', amount: 17000, payment_method: 'transfer', paid_by_name: 'Lan',
      customer_name: 'Admin', created_by_name: 'Đức Hùng', items: [{ name: 'Bia', quantity: 1, unit_price: 17000, added_by: 'Đức Hùng' }] },
    { order_id: 'b3', business_date: '2026-10-26', paid_at: '2026-10-26T12:00:00+00:00', table_number: '6', amount: 50000, payment_method: 'cash', photo_by: 'Đức Hùng', items: [{ name: 'Ốc', quantity: 1, unit_price: 50000 }] },
    { order_id: 'b4', business_date: '2026-10-26', paid_at: '2026-10-26T13:00:00+00:00', table_number: '7', amount: 60000, payment_method: 'cash', items: [{ name: 'Ốc', quantity: 1, unit_price: 60000 }] });
  state.finance_manual_receipts = [
    { id: 'p1', business_date: '2026-10-27', received_at: '2026-10-27T11:00:00Z', table_label: 'Bàn 9', amount: 250000, payment_method: 'cash', created_by_name: 'Mai' },
    { id: 'p2', business_date: '2026-10-27', received_at: '2026-10-27T12:00:00Z', table_label: null, amount: 80000, payment_method: 'transfer', created_by_name: 'Trang Mã QR · Đức Hùng' }];
  const api = load({ state });
  const find = async q => (await get(api, `search=1&from=2026-10-20&to=2026-10-27&${q}`)).body;

  let r = await find('staff=hung');
  assert.deepEqual(r.results.map(x => x.id), ['p2', 'b2', 'b1', 'b3'],
    'typed without accents; dishes, the QR page, an old bill closed with a photo, and the rest of the table checkout (b1) so its row has the full total');
  assert.deepEqual(plain(r.results.find(x => x.id === 'b2').staff), { paidBy: 'Lan', dishes: ['Đức Hùng'], dishesKnown: true });
  r = await find('staff=Lan');
  assert.deepEqual(r.results.map(x => x.id).sort(), ['b1', 'b2'], 'both bills of the table she closed');
  r = await find('staff=Mai&type=paper');
  assert.deepEqual(r.results.map(x => x.id), ['p1']);
  r = await find('staff=lan&table=4&type=transfer');
  assert.equal(r.results.length, 2, 'works together with the other filters');
  assert.deepEqual(plain((await find('staff=Linh')).results), []);
  r = await find('');
  assert.equal(r.results.length, 6, 'no name: every bill as before');
  assert.deepEqual(plain(r.staffNames), ['Đức Hùng', 'Lan', 'Mai'], 'names to pick from, in Vietnamese order');
  assert.deepEqual(plain(r.results.find(x => x.id === 'b4').staff), { paidBy: null, dishes: [], dishesKnown: false }, 'an old bill: unknown, not guessed');
});

test('Tra cứu shows whole table checkouts: the table total finds them, filters never leave half a table, one tick checks every bill', async () => {
  const state = empty();
  const id = n => `00000000-0000-0000-0000-00000000000${n}`;
  const BAN4 = '2026-10-27T10:46:45.494296+00:00', BAN6 = '2026-10-27T10:48:30.842531+00:00';
  const bill = (n, at, table, amount, more = {}) => ({ order_id: id(n), business_date: '2026-10-27', paid_at: at, table_number: table, amount,
    payment_method: 'transfer', account_id: ACC_A, transfer_image_path: `ck-${table}.jpg`, items: [], ...more });
  state.finance_revenue_ledger.push(
    bill(1, BAN4, '4', 395000), bill(2, BAN4, '4', 17000, { verified_at: '2026-10-27T12:00:00Z' }),
    bill(3, BAN6, '6', 42000), bill(4, BAN6, '6', 130000), bill(5, BAN6, '6', 383000),
    // Bàn 4 lượt khách sau: cùng bàn, khác lần đóng bàn.
    bill(6, '2026-10-27T13:00:00.000001+00:00', '4', 412000),
    // Cùng giờ nhưng thẻ khác → không phải cùng lần chuyển khoản.
    bill(7, BAN4, '4', 5000, { account_id: '00000000-0000-0000-0000-0000000000bb' }));
  const api = load({ state });
  const find = async q => (await get(api, `search=1&from=2026-10-27&to=2026-10-27&${q}`)).body;
  const ids = r => r.results.map(x => x.id).sort();

  // Khách chuyển khoản tổng bàn: 412.000đ ra lần đóng bàn 17:46 (395.000 + 17.000) và bill 412.000đ của lượt sau.
  let r = await find('amount=412.000');
  assert.deepEqual(ids(r), [id(1), id(2), id(6)]);
  assert.equal(new Set(r.results.filter(x => x.at === BAN4).map(x => x.group)).size, 1, 'both bills of the 17:46 checkout carry one group key');
  r = await find('amount=555000');
  assert.deepEqual(ids(r), [id(3), id(4), id(5)], 'Bàn 6 found by its total');
  r = await find('amount=130000');
  assert.deepEqual(ids(r), [id(3), id(4), id(5)], 'one bill amount still works and brings its whole checkout');
  assert.deepEqual(ids(await find('amount=999000')), []);
  // Bill 2 đã đối chiếu, bill 1 chưa: lọc "chưa đối chiếu" vẫn ra cả lần đóng bàn để thấy tổng đúng.
  r = await find('check=unchecked&table=4');
  assert.deepEqual(ids(r), [id(1), id(2), id(6), id(7)]);
  assert.equal(r.results.find(x => x.id === id(7)).group === r.results.find(x => x.id === id(1)).group, false, 'another card is another checkout');

  const tick = await post(api, { action: 'verify', kind: 'bill', ids: [id(3), id(4), id(5)] });
  assert.equal(tick.status, 200);
  assert.deepEqual(state.finance_revenue_ledger.filter(b => b.verified_at).map(b => b.order_id).sort(), [id(2), id(3), id(4), id(5)]);
  await post(api, { action: 'verify', kind: 'bill', ids: [id(3), id(4), id(5)], verified: false });
  assert.deepEqual(state.finance_revenue_ledger.filter(b => b.verified_at).map(b => b.order_id), [id(2)]);
  for (const bad of [[], ['x'], Array(51).fill(id(1))]) {
    assert.equal((await post(api, { action: 'verify', kind: 'bill', ids: bad })).status, 400, JSON.stringify(bad).slice(0, 40));
  }
});

test('transfer bills can be filtered by card, missing photo and checked state, and ticked off after checking the bank', async () => {
  const today = finance.vnDate(Date.now());
  const ACC_B = '00000000-0000-0000-0000-0000000000bb';
  const P1 = '00000000-0000-0000-0000-000000000001';
  const state = empty();
  state.finance_revenue_ledger.push(
    { order_id: '00000000-0000-0000-0000-000000000b01', business_date: today, paid_at: later(-30), table_number: '3', amount: 50000, payment_method: 'transfer', account_id: ACC_A, transfer_image_path: 'ck.jpg' },
    { order_id: '00000000-0000-0000-0000-000000000b02', business_date: today, paid_at: later(-20), table_number: '4', amount: 70000, payment_method: 'transfer', account_id: ACC_B, transfer_image_path: null },
    { order_id: '00000000-0000-0000-0000-000000000b03', business_date: today, paid_at: later(-10), table_number: '5', amount: 90000, payment_method: 'cash' });
  state.finance_manual_receipts = [
    { id: P1, business_date: today, received_at: later(-5), table_label: '6', amount: 30000, payment_method: 'transfer', account_id: ACC_B, image_path: 'b.jpg', transfer_image_path: null }];
  const api = load({ state });
  const ids = async q => (await get(api, `search=1&from=${today}&to=${today}&${q}`)).body.results.map(r => r.id);

  let r = (await get(api, `search=1&from=${today}&to=${today}`)).body;
  assert.deepEqual(plain(r.alerts), { missingPhoto: 2, unchecked: 3 }, 'cash bills never count');
  assert.deepEqual(await ids('image=missing'), [P1, '00000000-0000-0000-0000-000000000b02']);
  assert.deepEqual(await ids(`account=${ACC_B}`), [P1, '00000000-0000-0000-0000-000000000b02']);
  assert.deepEqual(await ids(`account=${ACC_A}&type=cash`), [], 'a card filter means transfer bills only');

  const ok = await post(api, { action: 'verify', kind: 'bill', id: '00000000-0000-0000-0000-000000000b01' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verifiedBy, 'Chủ quán');
  assert.equal((await post(api, { action: 'verify', kind: 'paper', id: P1 })).status, 200);
  assert.equal((await post(api, { action: 'verify', kind: 'bill', id: '00000000-0000-0000-0000-000000000b03' })).status, 404, 'cash bills cannot be ticked');
  assert.deepEqual(await ids('check=unchecked'), ['00000000-0000-0000-0000-000000000b02']);
  assert.deepEqual(await ids('check=checked'), [P1, '00000000-0000-0000-0000-000000000b01']);
  const checked = (await get(api, `search=1&from=${today}&to=${today}&check=checked`)).body.results[0];
  assert.ok(checked.verifiedAt && checked.verifiedBy === 'Chủ quán');

  await post(api, { action: 'verify', kind: 'paper', id: P1, verified: false });
  assert.deepEqual(await ids('check=unchecked'), [P1, '00000000-0000-0000-0000-000000000b02'], 'a tick can be undone');
  const month = await get(api, `month=${today.slice(0, 7)}`);
  assert.deepEqual(plain(month.body.transferAlerts), { missingPhoto: 2, unchecked: 2 }, 'the overview shows the same counts');
  assert.equal((await post(load({ state, role: 'staff' }), { action: 'verify', kind: 'bill', id: '00000000-0000-0000-0000-000000000b02' })).status, 403);
});

test('the owner links Zalo with a short code and gets one daily report a day', async () => {
  const today = finance.vnDate(Date.now());
  const state = empty();
  state.finance_settings = [];
  state.finance_revenue_ledger.push({ order_id: 'x1', business_date: today, paid_at: later(-10), table_number: '3', amount: 150000, payment_method: 'transfer', account_id: ACC_A, transfer_image_path: null });
  state.bank_accounts.push({ id: ACC_A, bank_name: 'Agribank', account_name: 'Chủ quán', account_number: '123456789' });
  const sent = [];
  const api = load({ state, sent, env: { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) } });
  const replies = [];
  const send = async (_db, uid, text) => replies.push({ uid, text });
  const db = fakeDb(state);

  assert.equal((await post(api, { action: 'zalo_test' })).body.error, 'Chưa liên kết Zalo nhận báo cáo.');
  const { zaloReport } = (await post(api, { action: 'zalo_link_code' })).body;
  assert.match(zaloReport.linkCode, /^\d{6}$/);
  const wrong = zaloReport.linkCode === '000000' ? '111111' : '000000';
  const msg = text => ({ event_name: 'user_send_text', sender: { id: 'owner-zalo' }, message: { text } });
  assert.equal(await zaloLink.linkFinanceReport(db, msg('hello 0912345678'), send), false, 'normal messages go to the wheel flow');
  assert.equal(await zaloLink.linkFinanceReport(db, msg(`BC ${wrong}`), send), true);
  assert.equal(replies.at(-1).text, 'Mã liên kết không đúng.');
  assert.equal(await zaloLink.linkFinanceReport(db, msg(`bc ${zaloReport.linkCode}`), send), true);
  assert.match(replies.at(-1).text, /Đã liên kết/);
  assert.deepEqual(plain(state.finance_settings[0].value.ownerIds), ['owner-zalo']);
  const broken = async () => { throw new Error('Chưa uỷ quyền Zalo OA'); };
  assert.equal(await zaloLink.linkFinanceReport(db, msg('BC 123456'), broken), true, 'a failed reply still keeps the code message out of the wheel flow');
  assert.equal((await get(api, `month=${today.slice(0, 7)}`)).body.zaloReport.linked, 1);

  const test1 = await post(api, { action: 'zalo_test' });
  assert.equal(test1.status, 200);
  assert.equal(sent.length, 3, 'summary + details + Sổ tay of the day');
  assert.match(sent[0].text, /Doanh thu: 150\.000đ \(1 bill\)/);
  assert.match(sent[0].text, /CK Agribank · Chủ quán: 150\.000đ/);
  assert.match(sent[0].text, /1 bill CK chưa có ảnh/);
  assert.match(sent[1]?.text || '', /🔍 Kiểm soát thất thoát[\s\S]*👥 Nhân viên[\s\S]*📈 So sánh/, 'loss, staff and comparison follow the summary');
  assert.match(sent[2]?.text || '', /🛒 Sổ tay/, 'then the Sổ tay of the day');

  const key = createHmac('sha256', 'k'.repeat(40)).update('finance-daily-report').digest('hex');
  const cronApi = load({ state, sent, code: 401, env: { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) } });
  const cron = async k => plain(await cronApi.POST({ json: async () => ({ action: 'daily_report', date: today }), headers: new Map([['x-finance-report-key', k]]) }));
  assert.equal((await cron('0'.repeat(64))).status, 401, 'a wrong key still needs an owner login');
  assert.equal((await cron(key)).body.ok, true);
  assert.equal((await cron(key)).body.skipped, true, 'the morning report goes out once a day');
  assert.equal(sent.length, 6, 'three messages, twice');

  const failing = load({ state, sent, zaloFails: true });
  const res = await post(failing, { action: 'zalo_test' });
  assert.equal(res.status, 400);
  assert.match(res.body.zaloReport.lastError, /-230/, 'the page shows why Zalo refused');
  assert.equal((await post(api, { action: 'zalo_unlink' })).body.zaloReport.linked, 0);
});

test('sales per dish and Sổ tay purchases per item are grouped so each group shows sold, bought and profit', async () => {
  const today = finance.vnDate(Date.now());
  const state = empty();
  state.finance_settings = [];
  state.finance_revenue_ledger.push(
    { order_id: 'i1', business_date: today, paid_at: later(-30), amount: 370000, payment_method: 'cash', items: [
      { name: 'Ốc hương xào bơ', quantity: 2, unit_price: 120000 }, { name: 'Ốc Hương nướng', quantity: 1, unit_price: 130000 }] },
    { order_id: 'i2', business_date: today, paid_at: later(-20), amount: 70000, payment_method: 'cash', items: [
      { name: 'Bia Tiger', quantity: 5, unit_price: 20000 }, { name: 'Giảm 8%', quantity: 1, unit_price: -30000 }] });
  state.staff_notes.push({ id: 'n1', created_at: new Date(`${today}T12:00:00+07:00`).toISOString(), note_type: 'expense', amount: 450000, debt: 0, content: JSON.stringify({ type: 'structured_expense',
    items: [{ name: 'oc huong', qty: '2kg', price: '200k' }, { name: 'Tiền rau', qty: '', price: '50k' }] }) });
  state.finance_entries.push({ id: 'd1', kind: 'drink', entry_date: today, amount: 150000, label: 'Bia Tiger thùng' });
  const api = load({ state });
  const items = async () => (await get(api, `items=1&from=${today}&to=${today}`)).body;

  let r = await items();
  assert.deepEqual(r.sold.map(s => [s.name, s.qty, s.revenue]), [['Ốc hương xào bơ', 2, 240000], ['Ốc Hương nướng', 1, 130000], ['Bia Tiger', 5, 100000], ['Giảm giá / khuyến mãi', 0, -30000]]);
  assert.deepEqual(r.bought.map(b => [b.name, b.qty, b.cost]), [['oc huong', '2kg', 400000], ['Bia Tiger thùng', '', 150000], ['Tiền rau', '', 50000]]);
  assert.deepEqual(plain(r.suggestions), ['oc huong', 'Bia Tiger thùng'], 'purchases whose name matches a dish are offered as groups');
  assert.equal(r.totals.revenue, 440000, 'matches what the bills took');
  assert.equal(r.totals.cost, 600000, 'Sổ tay + drinks');

  assert.equal((await post(api, { action: 'save_item_group', name: 'Ốc hương' })).status, 200);
  const beer = (await post(api, { action: 'save_item_group', name: 'Bia', keywords: 'bia tiger, tiger' })).body.group;
  assert.equal((await post(api, { action: 'save_item_group', name: 'ốc HƯƠNG' })).status, 409);
  r = await items();
  assert.deepEqual(r.groups.map(g => [g.name, g.revenue, g.cost, g.profit]), [['Ốc hương', 370000, 400000, -30000], ['Bia', 100000, 150000, -50000]]);
  assert.equal(r.totals.ungroupedRevenue, -30000);
  assert.equal(r.totals.ungroupedCost, 50000);

  await post(api, { action: 'save_item_group', id: beer.id, name: 'Bia Tiger', keywords: ['tiger'] });
  await post(api, { action: 'delete_item_group', id: (await items()).groups[0].id });
  assert.deepEqual((await items()).groups.map(g => [g.name, plain(g.keywords)]), [['Bia Tiger', ['tiger']]]);
  assert.equal((await get(load({ state, role: 'staff' }), `items=1`)).status, 403);
});

test('the owner picks the send time; the half-hourly job only sends once that time has come', async () => {
  const state = empty();
  state.finance_settings = [{ key: 'zalo_report', value: { ownerIds: ['owner-zalo'] } }];
  const sent = [];
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) };
  const admin = load({ state, sent, env });
  assert.equal((await post(admin, { action: 'zalo_set_time', time: '08:15' })).status, 400, 'half-hour steps only');
  const vnNow = new Date(Date.now() + 7 * 3600000);
  const slot = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${m % 60 < 30 ? '00' : '30'}`;
  const nowMin = vnNow.getUTCHours() * 60 + vnNow.getUTCMinutes();
  const later = slot(nowMin + 120);
  if (later > slot(nowMin)) { // không chạy phần này sát nửa đêm
    const set = await post(admin, { action: 'zalo_set_time', time: later });
    assert.equal(set.body.zaloReport.sendAt, later);
    const key = createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update('finance-daily-report').digest('hex');
    const cron = load({ state, sent, code: 401, env });
    const run = async () => plain(await cron.POST({ json: async () => ({ action: 'daily_report' }), headers: new Map([['x-finance-report-key', key]]) }));
    assert.match((await run()).body.skipped, /chưa tới giờ gửi/);
    assert.equal(sent.length, 0);
    await post(admin, { action: 'zalo_set_time', time: slot(nowMin) });
    const r = await run();
    assert.ok(r.body.ok && !r.body.skipped || /trước khi sổ bắt đầu|Không có số liệu/.test(r.body.error || ''), JSON.stringify(r.body));
  }
});

test('report sections can be switched off one by one', async () => {
  const today = finance.vnDate(Date.now());
  const state = empty();
  state.finance_settings = [{ key: 'zalo_report', value: { ownerIds: ['owner-zalo'] } }];
  state.finance_revenue_ledger.push({ order_id: 'z1', business_date: today, paid_at: later(-5), table_number: '3', amount: 50000, payment_method: 'cash', items: [{ name: 'Tôm', quantity: 1, unit_price: 50000 }] });
  const sent = [];
  const api = load({ state, sent });
  const off = await post(api, { action: 'zalo_set_sections', sections: { loss: false, staff: false, compare: true, notes: false } });
  assert.deepEqual(plain(off.body.zaloReport.sections), { loss: false, staff: false, compare: true, notes: false });
  await post(api, { action: 'zalo_test' });
  assert.equal(sent.length, 2, 'summary + comparison only');
  assert.match(sent[1].text, /📈 So sánh/);
  assert.doesNotMatch(sent[1].text, /Kiểm soát thất thoát|Nhân viên|Sổ tay/);
});

test('the owner can switch the Zalo report off without unlinking, and still read it on /thongke', async () => {
  const today = finance.vnDate(Date.now());
  const state = empty();
  state.finance_settings = [{ key: 'zalo_report', value: { ownerIds: ['owner-zalo'] } }];
  state.finance_revenue_ledger.push({ order_id: 'r1', business_date: today, paid_at: later(-5), table_number: '4', amount: 80000, payment_method: 'cash', items: [{ name: 'Sò', quantity: 1, unit_price: 80000 }] });
  const sent = [];
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) };
  const api = load({ state, sent, env });
  assert.equal((await get(api, `month=${today.slice(0, 7)}`)).body.zaloReport.enabled, true, 'on by default');
  assert.equal((await post(api, { action: 'zalo_set_enabled', enabled: 'no' })).status, 400);
  const off = await post(api, { action: 'zalo_set_enabled', enabled: false });
  assert.equal(off.body.zaloReport.enabled, false);
  assert.equal(off.body.zaloReport.linked, 1, 'linked Zalo is kept');

  const key = createHmac('sha256', 'k'.repeat(40)).update('finance-daily-report').digest('hex');
  const cron = load({ state, sent, code: 401, env });
  const run = async () => plain(await cron.POST({ json: async () => ({ action: 'daily_report', date: today }), headers: new Map([['x-finance-report-key', key]]) }));
  assert.equal((await run()).body.skipped, 'đã tắt gửi Zalo');
  assert.equal(sent.length, 0, 'nothing goes to Zalo while switched off');

  const page = await get(api, `report=${today}`);
  assert.equal(page.status, 200);
  const { summary, compare, trend, sections } = page.body;
  assert.equal(summary.revenue, 80000, 'the page shows the same numbers as Zalo');
  assert.equal(summary.bills, 1);
  assert.equal(summary.cash, 80000);
  assert.ok(!summary.warnings.some(w => /kiểm tra|chốt sổ/.test(w)), 'today is still open: no reminder, the machine checks it at 5am tomorrow');
  assert.deepEqual(plain(compare.top), [{ name: 'Sò', qty: 1 }]);
  assert.equal(trend.length, 7);
  assert.equal(trend.at(-1).revenue, 80000, 'last bar is the day being read');
  assert.deepEqual(sections.map(s => s.key), ['loss', 'staff', 'notes'], 'with every detail section');
  assert.equal((await get(api, 'report=2099-01-01')).status, 400, 'no future days');
  assert.equal((await get(load({ role: 'staff', state }), `report=${today}`)).status, 403, 'admins only');

  await post(api, { action: 'zalo_set_enabled', enabled: true });
  assert.equal((await run()).body.ok, true);
  assert.match(sent[0].text, /Xem trên web: https:\/\/ocbaokhang\.online\/thongke\?date=/, 'the Zalo summary links to the page');
});

test('/thongke reads a week or a month: each day, totals, sales, losses, staff and Sổ tay, and the day as data', async () => {
  const today = finance.vnDate(Date.now());
  const state = empty();
  state.finance_revenue_ledger.push({ order_id: 'r1', business_date: today, paid_at: later(-5), table_number: '4', amount: 80000, payment_method: 'cash',
    items: [{ name: 'Sò', quantity: 1, unit_price: 80000 }, { name: 'Nước suối', quantity: 1, unit_price: 0, is_gift: true }] });
  const api = load({ state });
  const week = (await get(api, `period=week&date=${today}`)).body;
  assert.equal(week.days.length, 7, 'Monday to Sunday');
  assert.equal(week.totals.revenue, 80000);
  assert.deepEqual(plain(week.sales.top), [{ name: 'Sò', qty: 1 }]);
  assert.equal(week.loss.gifts.qty, 1);
  assert.ok(week.staff && week.notes, 'staff and Sổ tay of the week');
  const month = (await get(api, `period=month&date=${today}`)).body;
  assert.equal(month.from, `${today.slice(0, 7)}-01`);
  assert.equal(month.weekdays.length, 7);
  assert.equal((await get(api, 'period=year')).status, 400);
  assert.equal((await get(api, 'period=week&date=2099-01-01')).status, 400, 'no future days');
  const day = (await get(api, `report=${today}`)).body;
  assert.equal(day.loss.gifts.qty, 1, 'losses of the day as data');
  assert.ok(day.staff.people && day.notes.summary, 'staff and Sổ tay of the day as data');
  assert.ok(day.summary.costs.every(c => c.label !== 'Nước ngọt / bia'));
});

test('the owner never has to close the day: the machine checks it, saves the result and stops asking', async () => {
  const today = finance.vnDate(Date.now());
  // Giờ trong ngày VN đang xem (không lấy 'mấy phút trước': chạy lúc vừa qua nửa đêm sẽ rơi sang hôm qua).
  const at = m => new Date(Date.parse(finance.vnDayStartIso(today)) + m * 60000).toISOString();
  const state = empty();
  state.finance_revenue_ledger.push(
    { order_id: '00000000-0000-0000-0000-0000000000c1', business_date: today, paid_at: at(1), table_number: '2', amount: 200000, payment_method: 'transfer', transfer_image_path: null, items: [] },
    { order_id: '00000000-0000-0000-0000-0000000000c2', business_date: today, paid_at: at(2), table_number: '3', amount: 150000, payment_method: 'cash', photo_skip_reason: 'Máy hỏng camera', items: [] });
  // Bàn đã thu nhưng sổ chưa có (trigger lỗi, lịch sử bàn đã hết hạn).
  state.orders = [{ id: '00000000-0000-0000-0000-0000000000c3', status: 'paid', paid_at: at(3), total_amount: 90000, payment_method: 'cash', table_id: 't5' }];
  state.tables = [{ id: 't5', table_number: 5 }];
  const api = load({ state });
  const before = (await get(api, `month=${today.slice(0, 7)}`)).body.days.find(d => d.date === today);
  assert.equal(before.check, null);

  const res = await post(api, { action: 'check_day', date: today });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.check.issues.map(i => i.key), ['unrecorded', 'ck_no_photo', 'no_photo']);
  assert.equal(res.body.check.issues[0].rows[0].table, 5);
  assert.equal(state.finance_day_checks.length, 1, 'result saved');

  const day = (await get(api, `date=${today}`)).body;
  assert.equal(day.check.problems, 3, 'the Hôm nay tab shows the result');
  const month = (await get(api, `month=${today.slice(0, 7)}`)).body.days.find(d => d.date === today);
  assert.deepEqual([month.check.ok, month.check.problems], [false, 3]);
  const report = (await get(api, `report=${today}`)).body;
  assert.ok(!report.summary.warnings.some(w => /Chưa kiểm tra/.test(w)), 'no reminder to close the day');
  assert.equal(report.summary.check.problems, 3);
  assert.equal((await post(api, { action: 'check_day', date: '2099-01-01' })).status, 400);
  assert.equal((await post(load({ role: 'staff', state }), { action: 'check_day', date: today })).status, 403);
});

test('Sổ tay "Khác" kinds (petrol, repairs) show as their own costs on /thongke, the week view and the month book', async () => {
  const state = empty();
  state.finance_settings = [{ key: 'note_categories', value: { categories: [{ id: 'xang', name: 'Xăng xe' }] } }];
  const content = JSON.stringify({ type: 'structured_expense', items: [{ name: 'Ốc hương', qty: '1', price: '300k' }, { name: 'Đổ xăng', price: '50k', category: 'xang' }] });
  state.staff_notes.push({ id: 'k1', created_at: '2026-10-23T03:00:00.000Z', note_type: 'expense', amount: 350000, debt: 0, content, staff: { full_name: 'Lan' } });
  const api = load({ state });
  const report = (await get(api, 'report=2026-10-23')).body;
  assert.deepEqual(plain(report.summary.costs.slice(0, 2)), [{ label: 'Đi chợ', amount: 300000 }, { label: 'Xăng xe (Sổ tay)', amount: 50000 }]);
  assert.equal(report.summary.cost, 350000, 'same total as before');
  const week = (await get(api, 'period=week&date=2026-10-23')).body;
  assert.ok(week.totals.costs.some(c => c.label === 'Xăng xe (Sổ tay)' && c.amount === 50000));
  const month = (await get(api, 'month=2026-10')).body;
  assert.deepEqual(plain(month.noteCategories), [{ id: 'xang', name: 'Xăng xe' }]);
  assert.deepEqual(plain(month.totals.notesOther), { xang: 50000 });
});

test('the day audit run by the shop machine reads one day and writes nothing; it needs its own key and shows no names', async () => {
  const today = finance.vnDate(Date.now());
  const day = finance.vnDate(Date.now() - 86400000);
  const at = m => new Date(Date.parse(finance.vnDayStartIso(day)) + m * 60000).toISOString();
  const state = empty();
  state.finance_revenue_ledger.push(
    { order_id: '00000000-0000-0000-0000-0000000000d1', business_date: day, paid_at: at(600), table_number: '2', amount: 200000, payment_method: 'transfer', transfer_image_path: null, customer_name: 'Chị Hoa', items: [] },
    { order_id: '00000000-0000-0000-0000-0000000000d2', business_date: day, paid_at: at(610), table_number: '3', amount: 150000, payment_method: 'cash', items: [] });
  state.tables = [{ id: 't5', table_number: 5 }, { id: 't7', table_number: 7 }, { id: 't8', table_number: 8 }];
  state.orders = [
    // Đã thu mà sổ chưa có / bill còn mở / bill gọi nhân viên (bỏ qua) / bill huỷ.
    { id: '00000000-0000-0000-0000-0000000000d3', status: 'paid', paid_at: at(620), created_at: at(500), total_amount: 90000, payment_method: 'cash', table_id: 't5', customer_phone: '0900' },
    { id: '00000000-0000-0000-0000-0000000000d4', status: 'pending', created_at: at(700), total_amount: 120000, table_id: 't7' },
    { id: '00000000-0000-0000-0000-0000000000d5', status: 'pending', created_at: at(710), total_amount: 0, table_id: 't7', customer_phone: 'BAO_BEP' },
    { id: '00000000-0000-0000-0000-0000000000d6', status: 'cancelled', created_at: at(650), cancelled_at: at(655), cancelled_by_name: 'Lan', total_amount: 80000, table_id: 't8' },
  ];
  state.attendance_sessions = [{ id: 'att1', staff_id: 'aaaa1111-0000-4000-8000-000000000001', date: day, clock_in: at(540), clock_out: null }];
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) };
  const key = purpose => createHmac('sha256', 'k'.repeat(40)).update(purpose).digest('hex');
  const call = (api, body, k) => api.POST({ json: async () => body, headers: new Map([['x-finance-report-key', k]]) }).then(plain);
  const cron = load({ state, code: 401, env });

  assert.equal((await call(cron, { action: 'day_audit' }, key('finance-daily-report'))).status, 401, 'the daily report key cannot read the audit');
  const res = await call(cron, { action: 'day_audit' }, key('finance-day-audit'));
  assert.equal(res.status, 200);
  const { audit } = res.body;
  assert.equal(audit.date, day, 'yesterday by default');
  assert.deepEqual([audit.money.bills, audit.money.amount], [2, 350000]);
  assert.deepEqual(audit.bills.unrecorded.map(b => b.table), [5]);
  assert.deepEqual(audit.bills.leftOpen.map(b => [b.table, b.amount]), [[7, 120000]], 'the staff-call bill is not a bill');
  assert.deepEqual(audit.photos.transferNoPhoto.map(b => b.table), ['2']);
  assert.deepEqual(audit.loss.cancelled.map(b => [b.table, b.amount]), [[8, 80000]]);
  assert.deepEqual(audit.staff.people.map(p => [p.staff, p.open]), [['NV-aaaa', true]]);
  const text = JSON.stringify(res.body);
  for (const name of ['Chị Hoa', 'Lan']) assert.ok(!text.includes(name), `no "${name}" in a public log`);

  assert.equal(state.finance_revenue_ledger.length, 2, 'read-only: the missing bill is reported, not added');
  assert.equal((state.finance_day_checks || []).length, 0, 'read-only: no day check saved');
  assert.equal((await call(cron, { action: 'day_audit', date: '2099-01-01' }, key('finance-day-audit'))).status, 400);
  assert.equal((await call(cron, { action: 'day_audit', date: today }, key('finance-day-audit'))).status, 200, 'today so far is allowed');
});
