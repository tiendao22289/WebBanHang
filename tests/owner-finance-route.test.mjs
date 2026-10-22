import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as finance from '../src/lib/ownerFinance.mjs';

const source = readFileSync(new URL('../src/app/api/admin/finance/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

// Bộ dựng truy vấn giả kiểu supabase-js, đủ cho route sổ thu chi.
function fakeDb(state, { failTable } = {}) {
  return { from(table) {
    let op = 'read', values, conditions = [], orders = [], range = null, single = false, maybe = false, max = Infinity, conflict = null;
    const q = {
      select() { return q; },
      eq(k, v) { conditions.push(r => r[k] === v); return q; },
      gte(k, v) { conditions.push(r => r[k] >= v); return q; },
      lt(k, v) { conditions.push(r => r[k] < v); return q; },
      gt(k, v) { conditions.push(r => r[k] > v); return q; },
      in(k, vs) { conditions.push(r => vs.includes(r[k])); return q; },
      limit(n) { max = n; return q; },
      maybeSingle() { maybe = true; return q; },
      upsert(v, opts) { op = 'upsert'; values = v; conflict = opts?.onConflict; return q; },
      order(k) { orders.push(k); return q; },
      range(a, b) { range = [a, b]; return q; },
      insert(v) { op = 'insert'; values = v; return q; },
      delete() { op = 'delete'; return q; },
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
          if (existing) Object.assign(existing, values); else state[table].push({ ...values });
          return resolve({ data: structuredClone(existing || values), error: null });
        }
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

function load({ role = 'admin', code = 200, state, failTable }) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...finance, URL, Number, Math, String, Promise, console: { error() {} }, Date, JSON,
    getStaffSession: async () => code === 200 ? { code, user: { id: 's1', full_name: 'Chủ quán', role } } : { code },
    statusDatabase: () => fakeDb(state, { failTable }),
  });
}

// Kết quả tạo trong vm khác realm → qua JSON để so sánh như dữ liệu API thật.
const plain = res => JSON.parse(JSON.stringify(res));
const get = async (api, query) => plain(await api.GET({ url: `http://x/api/admin/finance?${query}` }));
const post = async (api, body) => plain(await api.POST({ json: async () => body }));
const empty = () => ({ finance_revenue_ledger: [], staff_notes: [], finance_entries: [], bank_accounts: [], staff: [],
  finance_day_closes: [], table_bill_history: [] });
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
    { id: 'e2', entry_date: '2026-10-23', kind: 'salary', label: 'Lan', amount: 250000, created_at: '2' },
    { id: 'e3', entry_date: '2026-10-01', kind: 'fixed', category: 'rent', label: 'Thuê nhà', amount: 3100000, created_at: '3' });
  state.bank_accounts.push({ id: 'acc-a', bank_name: 'Vietcombank', account_name: 'A', account_number: '123456789', sort_order: 0 });
  state.staff.push({ id: 's1', full_name: 'Lan' }, { id: 's2', full_name: 'Minh' });
  const res = await get(load({ state }), 'month=2026-10');
  assert.equal(res.status, 200);
  const day = res.body.days.find(d => d.date === '2026-10-23');
  assert.equal(day.bills, 1203);
  assert.equal(day.revenue, 12030000);
  assert.equal(day.transfer, 401 * 10000);
  assert.equal(day.purchases, 700000, 'only Đi chợ notes count, paid + debt');
  assert.equal(day.drinks, 300000);
  assert.equal(day.salary, 250000);
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

test('drinks, salary and fixed costs are saved with the right date, and bad input is refused', async () => {
  const state = empty();
  const api = load({ state });
  let res = await post(api, { action: 'add', kind: 'drink', entry_date: '2026-10-23', label: '', amount: 120000 });
  assert.equal(res.status, 400, 'drink needs a label (the page sends a default)');
  res = await post(api, { action: 'add', kind: 'drink', entry_date: '2026-10-23', label: 'Nước ngọt / bia', amount: 120000 });
  assert.equal(res.body.entry.entry_date, '2026-10-23');
  assert.equal(res.body.entry.created_by_name, 'Chủ quán');
  res = await post(api, { action: 'add', kind: 'salary', entry_date: '2026-10-23', label: '  Lan ', amount: '250000', note: 'ca tối' });
  assert.deepEqual([res.body.entry.label, res.body.entry.amount, res.body.entry.note], ['Lan', 250000, 'ca tối']);
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
  assert.equal(state.finance_entries.length, 3);
  res = await post(api, { action: 'delete', id: state.finance_entries[0].id });
  assert.equal(res.body.ok, true);
  assert.equal(state.finance_entries.length, 2);
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

test('bills paid after the ledger started but missing from it are reported', async () => {
  const state = empty();
  const started = new Date(Date.now() - 3 * 3600000).toISOString();
  state.finance_revenue_ledger.push({ order_id: 'in-ledger', business_date: '2026-10-23', amount: 1, payment_method: 'cash', recorded_at: started });
  state.table_bill_history.push(
    { order_id: 'in-ledger', paid_at: later(-60), expires_at: later(500), snapshot: {} },
    { order_id: 'missing', paid_at: later(-30), expires_at: later(500),
      snapshot: { table_number: 7, customer_name: 'Lan', payment_method: 'transfer',
        order_items: [{ unit_price: 50000, quantity: 2 }, { unit_price: -10000, quantity: 1 }] } },
    { order_id: 'before-ledger', paid_at: new Date(Date.parse(started) - 60000).toISOString(), expires_at: later(500), snapshot: {} },
    { order_id: 'expired', paid_at: later(-30), expires_at: later(-1), snapshot: {} });
  const res = await get(load({ state }), 'month=2026-10');
  assert.deepEqual(res.body.missingBills.map(b => [b.orderId, b.tableNumber, b.amount, b.paymentMethod]),
    [['missing', 7, 90000, 'transfer']]);

  const fresh = empty();
  fresh.table_bill_history.push({ order_id: 'x', paid_at: later(-5), expires_at: later(500), snapshot: {} });
  assert.deepEqual((await get(load({ state: fresh }), 'month=2026-10')).body.missingBills, [],
    'nothing is missing before the ledger has started');
  const noHistory = await get(load({ state, failTable: 'table_bill_history' }), 'month=2026-10');
  assert.equal(noHistory.status, 200);
  assert.deepEqual(noHistory.body.missingBills, []);
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
