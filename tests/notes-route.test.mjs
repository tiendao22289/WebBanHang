import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as math from '../src/lib/notesMath.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const source = readFileSync(new URL('../src/app/api/admin/notes/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Thy', role: 'staff' };

function load(state, user = ADMIN) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...math, URL, Number, Math, String, JSON, Date, Map, Set, Array, Promise, console: { error() {} },
    getStaffSession: async () => ({ code: 200, user }), staffDatabase: () => fakeDb(state),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));
const post = async (api, body) => plain(await api.POST({ json: async () => body }));
const items = () => [
  { name: 'Ốc hương', qty: '2 ký', price: '220k', paymentStatus: 'full' },
  { name: 'Sò điệp', qty: '3 ký', price: '90k', paymentStatus: 'debt', creditor: 'Chị Lan' },
  { name: 'Mực', qty: '1,5kg', price: '200k', paymentStatus: 'full' },
  { name: 'Tiền rau', qty: '', price: '60k', paymentStatus: 'full' },
];

test('the server works out the money of a note itself and records who wrote it', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state, STAFF);
  const r = await post(api, { action: 'create', note_type: 'expense', items: items(), note: 'chợ sáng', input_amount: '1.000.000', staff_id: ADMIN.id, amount: 99 });
  assert.equal(r.status, 200);
  const note = state.staff_notes[0];
  assert.deepEqual([note.amount, note.debt, note.staff_id], [800000, 270000, STAFF.id], '"1,5kg" is 1.5 kg; the body cannot pick the writer or the total');
  assert.equal(JSON.parse(note.content).input_amount, 1000000);
});

test('paying old debt from a new report is saved after the report and logged per payment', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state, STAFF);
  await post(api, { action: 'create', note_type: 'expense', items: items() });
  assert.equal((await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Bia', price: '340k' }], pay_old_debt: 500000 })).status, 400, 'cannot pay more than owed');
  const r = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Bia', price: '340k' }], input_amount: 800000, pay_old_debt: 200000 });
  assert.equal(r.status, 200);
  const old = state.staff_notes[0];
  assert.equal(old.paid_debt, 200000);
  assert.equal(JSON.parse(old.content).items[1].paid_amount, 200000);
  assert.deepEqual(plain(state.staff_note_payments.map(p => [p.note_id, p.amount, p.paid_from_note_id])), [[old.id, 200000, r.body.note.id]]);
  assert.match(JSON.parse(state.staff_notes[1].content).note, /Đã trả nợ cũ: 200\.000/);
});

test('editing recalculates the total, keeps what was already paid and writes the change history', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: items() });
  const note = state.staff_notes[0];
  await post(api, { action: 'pay_item', id: note.id, item_index: 1, amount: 100000 });
  assert.equal((await post(api, { action: 'pay_item', id: note.id, item_index: 1, amount: 999000 })).status, 400);
  const stored = JSON.parse(note.content).items;
  // Như trang Sổ tay: dòng chưa có mã thì "#vị trí"; trình duyệt cố gửi "đã trả 270k".
  const edited = stored.map((it, i) => ({ ...it, _id: it._id || `#${i}`, ...(i === 0 ? { qty: '2,5kg' } : {}), ...(i === 1 ? { paid_amount: 270000, paymentStatus: 'debt' } : {}) }));
  const r = await post(api, { action: 'edit', id: note.id, note_type: 'expense', items: edited, note: '' });
  assert.equal(r.status, 200);
  const saved = state.staff_notes[0];
  assert.deepEqual([saved.amount, saved.debt, saved.paid_debt], [910000, 270000, 100000]);
  assert.equal(JSON.parse(saved.content).items[1].paid_amount, 100000, 'paid amount comes from the stored note, not the browser');
  const changes = JSON.parse(saved.content).history.at(-1).changes;
  assert.match(changes, /Sửa Ốc hương: SL 2 ký → 2,5kg/);
  assert.match(changes, /Tổng phiếu: 1\.070\.000 đ → 1\.180\.000 đ/);
  assert.doesNotMatch(changes, /Xóa|Thêm mới/, 'unchanged rows are matched, not re-added');

  // Đổi một dòng từ Đủ sang Nợ không còn bị tính hai lần.
  const toDebt = JSON.parse(saved.content).items.map((it, i) => (i === 3 ? { ...it, paymentStatus: 'debt' } : it));
  await post(api, { action: 'edit', id: note.id, note_type: 'expense', items: toDebt, note: '' });
  assert.equal(state.staff_notes[0].amount + state.staff_notes[0].debt, 1180000);
});

test('staff only touch their own notes on the day; only admins delete', async () => {
  const state = { staff_notes: [
    { id: '00000000-0000-4000-8000-000000000001', staff_id: ADMIN.id, note_type: 'other', content: 'x', amount: 0, debt: 0, created_at: new Date().toISOString() },
    { id: '00000000-0000-4000-8000-000000000002', staff_id: STAFF.id, note_type: 'other', content: 'cũ', amount: 0, debt: 0, created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
  ], staff_note_payments: [] };
  const staff = load(state, STAFF);
  assert.equal((await post(staff, { action: 'edit', id: state.staff_notes[0].id, note_type: 'other', note: 'sửa' })).status, 403);
  assert.equal((await post(staff, { action: 'edit', id: state.staff_notes[1].id, note_type: 'other', note: 'sửa' })).status, 403, 'old notes are locked for staff');
  assert.equal((await post(staff, { action: 'delete', id: state.staff_notes[1].id })).status, 403);
  const list = plain(await staff.GET({}));
  assert.deepEqual(list.body.notes.map(n => n.staff_id), [STAFF.id], 'staff only see their own notes');
  assert.equal((await post(load(state), { action: 'delete', id: state.staff_notes[1].id })).status, 200);
  assert.equal(state.staff_notes.length, 1);
});
