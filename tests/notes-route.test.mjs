import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as math from '../src/lib/notesMath.mjs';
import { noteLeftover, noteMoney, openDebtLines } from '../src/lib/notesDebts.mjs';
import * as categoriesLib from '../src/lib/noteCategories.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const source = readFileSync(new URL('../src/app/api/admin/notes/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Thy', role: 'staff' };

function load(state, user = ADMIN) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...math, ...categoriesLib, openDebtLines, noteLeftover, noteMoney, crypto: globalThis.crypto, Object, URL, Number, Math, String, JSON, Date, Map, Set, Array, Promise, console: { error() {} },
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

test('a new report pays exactly the old debts the owner picked, after the report is saved', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state, STAFF);
  // Phiếu cũ: nợ chị Hoa (cũ hơn) và nợ chị Lan.
  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Mực', qty: '2', price: '100k', paymentStatus: 'debt', creditor: 'Chị Hoa' }] });
  await post(api, { action: 'create', note_type: 'expense', items: items() });
  const [hoa, lan] = state.staff_notes;
  assert.equal((await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Bia', price: '340k' }],
    pay_debts: [{ note_id: lan.id, item_index: 1, amount: 300000 }] })).status, 400, 'cannot pay more than what is owed on that line');
  assert.equal(state.staff_notes.length, 2, 'nothing saved when a payment is invalid');
  const r = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Bia', price: '340k' }], input_amount: 800000,
    pay_debts: [{ note_id: lan.id, item_index: 1, amount: 200000 }] });
  assert.equal(r.status, 200);
  assert.equal(state.staff_notes.find(n => n.id === hoa.id).paid_debt || 0, 0, 'the older debt to Hoa is untouched');
  const paidLan = state.staff_notes.find(n => n.id === lan.id);
  assert.equal(paidLan.paid_debt, 200000);
  assert.equal(JSON.parse(paidLan.content).items[1].paid_amount, 200000);
  assert.deepEqual(plain(state.staff_note_payments.map(p => [p.note_id, p.item_index, p.amount, p.paid_from_note_id])), [[lan.id, 1, 200000, r.body.note.id]]);
  assert.match(JSON.parse(state.staff_notes.at(-1).content).note, /Trả nợ cũ 200\.000 đ: Chị Lan — Sò điệp 200\.000 đ/);
});

test("staff cannot pay debts on other people's notes; notes with only a debt amount can be paid as a whole", async () => {
  const state = { staff_notes: [
    { id: '00000000-0000-4000-8000-0000000000c1', staff_id: ADMIN.id, note_type: 'other', content: 'nợ tiền đá', amount: 0, debt: 150000, paid_debt: 0, created_at: new Date(Date.now() - 86400000).toISOString() },
  ], staff_note_payments: [] };
  const staff = load(state, STAFF);
  assert.equal((await post(staff, { action: 'create', note_type: 'other', note: 'x', pay_debts: [{ note_id: state.staff_notes[0].id, item_index: null, amount: 50000 }] })).status, 403);
  const admin = load(state);
  assert.equal((await post(admin, { action: 'pay_item', id: state.staff_notes[0].id, item_index: null, amount: 50000 })).status, 200);
  assert.equal(state.staff_notes[0].paid_debt, 50000);
  assert.equal((await post(admin, { action: 'pay_item', id: state.staff_notes[0].id, item_index: null, amount: 200000 })).status, 400);
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

test('leftover money from an earlier trip can pay old debts, and can be marked as handed back', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Mực', qty: '2', price: '100k', paymentStatus: 'debt', creditor: 'Chị Hoa' }] });
  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Ốc', qty: '2', price: '220k' }], input_amount: 1000000 });
  const [debtNote, trip] = state.staff_notes; // trip còn thừa 560.000
  assert.equal((await post(api, { action: 'create', note_type: 'other', note: 'trả nợ',
    pay_debts: [{ note_id: debtNote.id, item_index: 0, amount: 200000, from_note_id: debtNote.id }] })).status, 400, 'a note without leftover cannot fund payments');
  assert.equal((await post(api, { action: 'return_leftover', id: trip.id, amount: 600000 })).status, 400, 'cannot hand back more than is left');
  const r = await post(api, { action: 'create', note_type: 'other', note: 'trả nợ chị Hoa',
    pay_debts: [{ note_id: debtNote.id, item_index: 0, amount: 150000, from_note_id: trip.id }, { note_id: debtNote.id, item_index: 0, amount: 50000 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(plain(state.staff_note_payments.map(p => [p.amount, p.paid_from_note_id])), [[150000, trip.id], [50000, r.body.note.id]]);
  assert.match(JSON.parse(state.staff_notes.find(n => n.id === debtNote.id).content).history.at(-2).changes, /lấy tiền thừa phiếu/);
  assert.equal(noteLeftover(state.staff_notes.find(n => n.id === trip.id), state.staff_note_payments), 410000);
  assert.equal((await post(api, { action: 'return_leftover', id: trip.id, amount: 410000 })).status, 200);
  const handed = state.staff_notes.find(n => n.id === trip.id);
  assert.equal(noteLeftover(handed, state.staff_note_payments), 0);
  assert.match(JSON.parse(handed.content).history.at(-1).changes, /Đã trả lại chủ 410\.000/);
});

test('old leftover can be carried into a new trip note, and survives later edits', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Ốc', qty: '1', price: '435k' }], input_amount: 500000 });
  const [trip] = state.staff_notes; // dư 65.000
  assert.equal((await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Rau', qty: '1', price: '50k' }],
    carry_leftovers: [{ note_id: trip.id, amount: 70000 }] })).status, 400, 'cannot carry more than is left');
  const r = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Rau', qty: '1', price: '50k' }], input_amount: 100000,
    carry_leftovers: [{ note_id: trip.id, amount: 65000 }] });
  assert.equal(r.status, 200);
  const next = state.staff_notes.find(n => n.id === r.body.note.id);
  assert.deepEqual(plain(JSON.parse(next.content).carried_in.map(c => [c.from_note_id, c.amount])), [[trip.id, 65000]]);
  const old = state.staff_notes.find(n => n.id === trip.id);
  assert.equal(noteLeftover(old, state.staff_note_payments), 0);
  assert.match(JSON.parse(old.content).history.at(-1).changes, /Chuyển 65\.000/);
  assert.equal(noteLeftover(next, state.staff_note_payments), 115000);
  // Sửa phiếu không làm mất sổ tiền dư.
  assert.equal((await post(api, { action: 'edit', id: trip.id, note_type: 'expense', items: [{ name: 'Ốc', qty: '1', price: '435k' }], note: 'sửa', input_amount: 500000 })).status, 200);
  assert.equal(noteLeftover(state.staff_notes.find(n => n.id === trip.id), state.staff_note_payments), 0);
  assert.equal((await post(api, { action: 'edit', id: next.id, note_type: 'expense', items: [{ name: 'Rau', qty: '1', price: '50k' }], note: 'sửa', input_amount: 100000 })).status, 200);
  assert.equal(noteLeftover(state.staff_notes.find(n => n.id === next.id), state.staff_note_payments), 115000);
});

test('two taps at the same time pay a debt or move leftover only once', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Cua', qty: '1', price: '100k', paymentStatus: 'debt', creditor: 'Ba' }], input_amount: 300000 });
  const [debtNote] = state.staff_notes; // dư 300k (nợ không trừ tiền giao)
  const paid = await Promise.all([1, 2].map(() => post(api, { action: 'pay_item', id: debtNote.id, item_index: 0, amount: 100000 })));
  assert.deepEqual(paid.map(r => r.status).sort(), [200, 409]);
  assert.equal(state.staff_note_payments.reduce((a, p) => a + p.amount, 0), 100000);
  const moved = await Promise.all([1, 2].map(() => post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Rau', qty: '1', price: '1k' }],
    carry_leftovers: [{ note_id: debtNote.id, amount: 300000 }] })));
  assert.deepEqual(moved.map(r => r.status).sort(), [200, 409]);
  assert.equal(state.staff_notes.filter(n => /carried_in/.test(n.content)).length, 1, 'only one note received the leftover');
});

test('deleting a note gives back leftover it received and reopens debts it paid', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Mực', qty: '1', price: '200k', paymentStatus: 'debt', creditor: 'Hoa' }], input_amount: 500000 });
  const [trip] = state.staff_notes; // dư 500k, nợ Mực 200k
  const r = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Rau', qty: '1', price: '10k' }], input_amount: 100000,
    carry_leftovers: [{ note_id: trip.id, amount: 300000 }], pay_debts: [{ note_id: trip.id, item_index: 0, amount: 200000, from_note_id: trip.id }] });
  assert.equal(r.status, 200);
  const next = r.body.note;
  assert.equal(noteLeftover(state.staff_notes.find(n => n.id === trip.id), state.staff_note_payments), 0);
  assert.equal((await post(api, { action: 'delete', id: next.id })).status, 200);
  const back = state.staff_notes.find(n => n.id === trip.id);
  assert.equal(noteLeftover(back, state.staff_note_payments), 300000, 'carried leftover is back on the old note');
  assert.match(JSON.parse(back.content).history.at(-1).changes, /Nhận lại 300\.000/);
  // Nợ trả bằng tiền thừa phiếu cũ vẫn còn (phiếu xoá không phải phiếu bỏ tiền).
  assert.equal(openDebtLines(back).length, 0);
  // Xoá phiếu đã bỏ tiền trả nợ → nợ mở lại, sổ trả nợ bỏ dòng đó.
  const funder = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Ốc', qty: '1', price: '20k', paymentStatus: 'debt', creditor: 'Ba' }] });
  const payer = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Rau', qty: '1', price: '1k' }], input_amount: 50000,
    pay_debts: [{ note_id: funder.body.note.id, item_index: 0, amount: 20000 }] });
  assert.equal(openDebtLines(state.staff_notes.find(n => n.id === funder.body.note.id)).length, 0);
  assert.equal((await post(api, { action: 'delete', id: payer.body.note.id })).status, 200);
  const reopened = state.staff_notes.find(n => n.id === funder.body.note.id);
  assert.deepEqual(plain(openDebtLines(reopened).map(l => l.left)), [20000]);
  assert.equal(state.staff_note_payments.some(p => p.paid_from_note_id === payer.body.note.id), false);
});

test('a note cannot be edited below the leftover it already handed back or moved on', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  const item = [{ name: 'Ốc', qty: '1', price: '400k' }];
  await post(api, { action: 'create', note_type: 'expense', items: item, input_amount: 1000000 });
  const [trip] = state.staff_notes; // dư 600k
  assert.equal((await post(api, { action: 'return_leftover', id: trip.id, amount: 500000 })).status, 200);
  const items = JSON.parse(state.staff_notes[0].content).items;
  const low = await post(api, { action: 'edit', id: trip.id, note_type: 'expense', items, note: '', input_amount: 800000 });
  assert.equal(low.status, 400);
  assert.match(low.body.error, /500\.000/);
  assert.equal((await post(api, { action: 'edit', id: trip.id, note_type: 'expense', items, note: '', input_amount: 950000 })).status, 200);
});

test('the owner makes the "Khác" kinds; staff put lines like petrol or repairs in them and the line keeps its kind', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const staff = load(state, STAFF);
  const admin = load(state, ADMIN);
  assert.equal((await post(staff, { action: 'set_categories', categories: [{ name: 'Xăng xe' }] })).status, 403, 'only the owner edits kinds');
  const set = await post(admin, { action: 'set_categories', categories: [{ name: ' Xăng  xe ' }, { name: 'xăng xe' }, { name: 'Khác' }, { name: '' }, { name: 'Sửa chữa' }] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.categories.map(c => c.name), ['Xăng xe', 'Sửa chữa'], 'no blanks, no duplicates, "Khác" is built in');
  const [petrol, repair] = set.body.categories;
  const renamed = await post(admin, { action: 'set_categories', categories: [{ id: petrol.id, name: 'Xăng / đi lại' }, repair] });
  assert.equal(renamed.body.categories[0].id, petrol.id, 'renaming keeps the id, so old lines keep their kind');
  assert.equal(state.finance_settings.length, 1);

  const r = await post(staff, { action: 'create', note_type: 'expense', items: [
    { name: 'Ốc hương', qty: '2', price: '200k' },
    { name: 'Đổ xăng', price: '50k', category: petrol.id },
    { name: 'Thay vòi nước', price: '120k', category: 'bad id!' },
  ] });
  assert.equal(r.status, 200);
  const saved = JSON.parse(state.staff_notes[0].content).items;
  assert.deepEqual(saved.map(i => i.category ?? ''), ['', petrol.id, ''], 'a broken kind falls back to Hàng ốc');
  assert.equal(state.staff_notes[0].amount, 570000, 'Khác lines still count in the note total');

  const edited = saved.map((i, idx) => (idx === 2 ? { ...i, category: repair.id } : i));
  assert.equal((await post(staff, { action: 'edit', id: state.staff_notes[0].id, note_type: 'expense', items: edited, note: '' })).status, 200);
  const after = JSON.parse(state.staff_notes[0].content);
  assert.equal(after.items[2].category, repair.id);
  assert.match(after.history.at(-1).changes, /Thay vòi nước: loại Hàng ốc → Khác · Sửa chữa/);

  const list = plain(await staff.GET({}));
  assert.deepEqual(list.body.categories.map(c => c.name), ['Xăng / đi lại', 'Sửa chữa'], 'staff get the kinds to pick from');
});
