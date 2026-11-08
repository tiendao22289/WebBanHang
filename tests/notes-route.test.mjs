import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as math from '../src/lib/notesMath.mjs';
import * as debts from '../src/lib/notesDebts.mjs';
import { noteLeftover, noteMoney, openDebtLines } from '../src/lib/notesDebts.mjs';
import * as categoriesLib from '../src/lib/noteCategories.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';
import { seesAllNotes } from '../src/lib/staffRoles.mjs';
import * as checks from '../src/lib/notesChecks.mjs';
import { receiptImageProblem } from '../src/lib/receiptImages.mjs';

const source = readFileSync(new URL('../src/app/api/admin/notes/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Thy', role: 'staff' };

// Kho ảnh giả: state.stored = ảnh đang có, state.removed = ảnh đã xoá.
function load(state, user = ADMIN) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...math, ...categoriesLib, ...debts, ...checks, seesAllNotes, receiptImageProblem, crypto: globalThis.crypto, Object, URL, Number, Math, String, JSON, Date, Map, Set, Array, Promise, console: { error() {} },
    getStaffSession: async () => ({ code: 200, user }), staffDatabase: () => fakeDb(state), statusDatabase: () => ({}),
    uploadReceiptImage: async (db, file, kind) => {
      if (state.storageDown) throw new Error('storage down');
      const path = `2026-11/${kind}-${crypto.randomUUID()}.jpg`;
      state.stored = [...(state.stored || []), path];
      return path;
    },
    removeReceiptImages: async (db, paths) => { state.removed = [...(state.removed || []), ...paths.filter(Boolean)]; },
    signReceiptImages: async (db, paths) => Object.fromEntries(paths.map(p => [p, `/img?p=${p}`])),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));
const PHOTO = { size: 1000, type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(8) };
// Phiếu mới gửi như trang Sổ tay: dòng nào cũng có _id, 1 ảnh hàng trên cân, 1 tờ bill cho mọi dòng hàng ốc.
// Thao tác khác gửi JSON. photos = [] / bills = [] để gửi thiếu; bills: [{ file, ids: [_id dòng] }].
const withIds = body => (Array.isArray(body.items) ? { ...body, items: body.items.map((i, k) => ({ _id: `row-${k}-${Math.random().toString(36).slice(2, 8)}`, ...i })) } : body);
// Tờ bill phủ mọi dòng có giá (trừ Tiền rau / gia vị) — dòng Khác kèm bill cũng được.
const allBills = body => { const ids = (body.items || []).filter(i => String(i.name || '').trim() && math.parsePrice(i.price) > 0 && !i.preset).map(i => i._id); return ids.length ? [{ file: PHOTO, ids }] : []; };
const request = (body, photos, bills) => (photos.length || bills.length
  ? { headers: { get: () => 'multipart/form-data; boundary=x' },
    formData: async () => ({
      get: k => (k === 'payload' ? JSON.stringify(body) : k === 'bill_items' ? JSON.stringify(bills.map(b => b.ids)) : null),
      getAll: k => (k === 'photo' ? photos : k === 'bill' ? bills.map(b => b.file) : []) }) }
  : { headers: { get: () => 'application/json' }, json: async () => body });
const post = async (api, raw, photos, bills) => {
  const create = raw.action === 'create';
  const body = create ? withIds(raw) : raw;
  return plain(await api.POST(request(body, photos ?? (create ? [PHOTO] : []), bills ?? (create ? allBills(body) : []))));
};
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

test('managers see and edit all notes, but cannot delete notes or change kinds', async () => {
  const MANAGER = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Thùy', role: 'manager' };
  const state = { staff_notes: [
    { id: '00000000-0000-4000-8000-000000000001', staff_id: ADMIN.id, note_type: 'other', content: 'x', amount: 0, debt: 0, created_at: new Date().toISOString() },
    { id: '00000000-0000-4000-8000-000000000002', staff_id: STAFF.id, note_type: 'other', content: 'cũ', amount: 0, debt: 0, created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
  ], staff_note_payments: [] };
  const manager = load(state, MANAGER);
  const list = plain(await manager.GET({}));
  assert.equal(list.body.notes.length, 2, 'managers see the whole shop');
  assert.equal((await post(manager, { action: 'edit', id: state.staff_notes[1].id, note_type: 'other', note: 'sửa' })).status, 200);
  assert.equal(state.staff_notes[1].content, 'sửa');
  assert.equal((await post(manager, { action: 'delete', id: state.staff_notes[1].id })).status, 403);
  assert.equal((await post(manager, { action: 'set_categories', categories: [{ name: 'Xăng' }] })).status, 403);
  assert.equal((await post(manager, { action: 'create', note_type: 'other', note: 'mua đá' })).status, 200);
  assert.equal(state.staff_notes.at(-1).staff_id, MANAGER.id);
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
  const rows = id => math.editRows(JSON.parse(state.staff_notes.find(n => n.id === id).content).items);
  assert.equal((await post(api, { action: 'edit', id: trip.id, note_type: 'expense', items: rows(trip.id), note: 'sửa', input_amount: 500000 })).status, 200);
  assert.equal(noteLeftover(state.staff_notes.find(n => n.id === trip.id), state.staff_note_payments), 0);
  assert.equal((await post(api, { action: 'edit', id: next.id, note_type: 'expense', items: rows(next.id), note: 'sửa', input_amount: 100000 })).status, 200);
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

test('deleting the note that paid a debt reopens that same line, even after an earlier line was removed from the debt note', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  const A = (await post(api, { action: 'create', note_type: 'expense', items: [
    { name: 'Đá', price: '10k', paymentStatus: 'full' },
    { name: 'Ốc', price: '200k', paymentStatus: 'debt', creditor: 'Hoa' },
    { name: 'Rau', price: '50k', paymentStatus: 'full' }] })).body.note.id;
  const B = (await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Bia', price: '100k' }], input_amount: 400000,
    pay_debts: [{ note_id: A, item_index: 1, amount: 200000 }] })).body.note.id;
  const noteA = () => state.staff_notes.find(n => n.id === A);
  assert.equal(openDebtLines(noteA()).length, 0, 'Ốc is paid');
  // Bỏ dòng "Đá": Ốc lên vị trí 0, Rau (trả tiền mặt) xuống vị trí 1 — đúng vị trí sổ trả nợ đã ghi.
  assert.equal((await post(api, { action: 'edit', id: A, note_type: 'expense', items: JSON.parse(noteA().content).items.slice(1), note: '' })).status, 200);
  assert.deepEqual(plain(state.staff_note_payments.map(p => p.item_index)), [1]);
  assert.equal((await post(api, { action: 'delete', id: B })).status, 200);
  const items = JSON.parse(noteA().content).items;
  assert.deepEqual(plain(items.map(i => [i.name, i.paymentStatus, i.paid_amount || 0])), [['Ốc', 'debt', 0], ['Rau', 'full', 0]], 'the cash line stays paid');
  assert.deepEqual(plain(openDebtLines(noteA()).map(l => [l.name, l.left])), [['Ốc', 200000]], 'the real debt is back');
  assert.equal(noteA().paid_debt, 0);
  assert.match(JSON.parse(noteA().content).history.at(-1).changes, /Huỷ trả nợ 200\.000 đ cho "Ốc"/);
});

test('payments recorded before lines kept their payer still undo the right line, and never turn a cash line into a debt', async () => {
  const A = '00000000-0000-4000-8000-0000000000a2';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const at = new Date().toISOString();
  // Dữ liệu cũ: dòng chưa có _id, lịch sử trả không ghi phiếu bỏ tiền; phiếu đã bị sửa bỏ dòng đầu (sổ trả nợ vẫn ghi vị trí 1).
  const content = JSON.stringify({ type: 'structured_expense', items: [
    { name: 'Ốc', price: '200k', paymentStatus: 'full', creditor: 'Hoa', paid_amount: 200000, payment_logs: [{ amount: 200000, ts: '10:00 01/11/2026' }] },
    { name: 'Rau', price: '50k', paymentStatus: 'full' }] });
  const state = { staff_notes: [
    { id: A, staff_id: ADMIN.id, note_type: 'expense', content, amount: 50000, debt: 200000, paid_debt: 200000, created_at: at, updated_at: at },
    { id: B, staff_id: ADMIN.id, note_type: 'expense', content: JSON.stringify({ type: 'structured_expense', items: [{ name: 'Bia', price: '100k' }] }), amount: 100000, debt: 0, created_at: at, updated_at: at },
  ], staff_note_payments: [{ id: '10000000-0000-4000-8000-000000000001', note_id: A, item_index: 1, amount: 200000, paid_from_note_id: B, paid_at: at }] };
  assert.equal((await post(load(state), { action: 'delete', id: B })).status, 200);
  const items = JSON.parse(state.staff_notes[0].content).items;
  assert.deepEqual(plain(items.map(i => [i.name, i.paymentStatus, i.paid_amount || 0])), [['Ốc', 'debt', 0], ['Rau', 'full', 0]]);
});

test('a debt is paid on the line the owner picked, found by its id when the debt note was edited meanwhile', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: [
    { name: 'Đá', price: '10k', paymentStatus: 'debt', creditor: 'Ba' },
    { name: 'Ốc', price: '200k', paymentStatus: 'debt', creditor: 'Hoa' },
    { name: 'Sò', price: '80k', paymentStatus: 'debt', creditor: 'Lan' }] });
  const note = state.staff_notes[0];
  // Màn hình chọn trả nợ mở trước khi phiếu bị sửa (bỏ dòng "Đá").
  const [, oc, so] = openDebtLines(note);
  assert.ok(oc.item_id && so.item_id, 'open debts carry the line id');
  await post(api, { action: 'edit', id: note.id, note_type: 'expense', items: JSON.parse(note.content).items.slice(1), note: '' });
  const r = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Bia', price: '10k' }],
    pay_debts: [{ note_id: note.id, item_id: oc.item_id, item_index: oc.item_index, amount: 200000 }] });
  assert.equal(r.status, 200);
  assert.equal((await post(api, { action: 'pay_item', id: note.id, item_id: so.item_id, item_index: so.item_index, amount: 30000 })).status, 200);
  const items = JSON.parse(state.staff_notes[0].content).items;
  assert.deepEqual(plain(items.map(i => [i.name, i.paid_amount || 0])), [['Ốc', 200000], ['Sò', 30000]], 'not the line now standing at the old position');
  assert.deepEqual(plain(state.staff_note_payments.map(p => p.item_index)), [0, 1], 'the payment book keeps the position at payment time');
  assert.equal((await post(api, { action: 'pay_item', id: note.id, item_id: oc.item_id, amount: 1000 })).status, 400, 'a line already paid off cannot be paid again');
});

test('an edit made on an out-of-date screen is refused instead of overwriting a newer edit', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Ốc hương', price: '200k', qty: '2' }] });
  const id = state.staff_notes[0].id;
  // Hai máy cùng mở ô sửa một bản phiếu.
  const view = { items: JSON.parse(state.staff_notes[0].content).items, updated_at: state.staff_notes[0].updated_at };
  const first = await post(api, { action: 'edit', id, note_type: 'expense', items: [...view.items, { _id: 'muc', name: 'Mực', price: '300k' }], note: '', updated_at: view.updated_at },
    [], [{ file: PHOTO, ids: ['muc'] }]);
  assert.equal(first.status, 200);
  const stale = await post(api, { action: 'edit', id, note_type: 'expense', items: view.items.map(i => ({ ...i, qty: '3' })), note: '', updated_at: view.updated_at });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /Tải lại trang/);
  assert.deepEqual(plain(JSON.parse(state.staff_notes[0].content).items.map(i => i.name)), ['Ốc hương', 'Mực'], 'the newer edit is kept');
  assert.equal(state.staff_notes[0].amount, 700000);
  // Mở lại bản mới thì sửa được.
  const fresh = JSON.parse(state.staff_notes[0].content).items.map(i => (i.name === 'Ốc hương' ? { ...i, qty: '3' } : i));
  assert.equal((await post(api, { action: 'edit', id, note_type: 'expense', items: fresh, note: '', updated_at: first.body.note.updated_at })).status, 200);
  assert.equal(state.staff_notes[0].amount, 900000);
});

test('changing the quantity of a debt line keeps the whole line as debt (the edit box leaves "Số tiền nợ" empty)', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', input_amount: 500000, items: [{ name: 'Sò điệp', price: '90k', qty: '3 ký', paymentStatus: 'debt', creditor: 'Chị Lan' }] });
  const note = state.staff_notes[0];
  // Như trang Sổ tay mở ô sửa (editRows), sửa 3 → 4 ký rồi lưu.
  const rows = math.editRows(JSON.parse(note.content).items);
  assert.equal(rows[0].debtAmount, '', 'no hidden debt amount is filled in');
  const r = await post(api, { action: 'edit', id: note.id, note_type: 'expense', items: rows.map(i => ({ ...i, qty: '4 ký' })), note: '', input_amount: 500000, updated_at: note.updated_at });
  assert.equal(r.status, 200);
  const saved = state.staff_notes[0];
  assert.deepEqual([saved.amount, saved.debt], [0, 360000], 'nothing moves to "paid now"');
  assert.deepEqual(plain(openDebtLines(saved).map(l => l.left)), [360000]);
  assert.equal(noteLeftover(saved, state.staff_note_payments), 500000, 'the cash handed out is all still left');
  assert.deepEqual(plain(math.editRows([{ name: 'Cũ', price: '10k' }, { _id: 'x', name: 'Mới' }]).map(i => i._id)), ['#0', 'x'], 'old lines get "#position"');
});

test('a market trip needs a photo; only "Khác" lines, debt payments or plain text do not', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state, STAFF);
  const noPhoto = await post(api, { action: 'create', note_type: 'expense', items: items() }, []);
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.body.error, /Chụp ảnh hàng trên cân/);
  assert.equal(state.staff_notes.length, 0, 'nothing saved without the photo');
  const rauOnly = await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Tiền rau', price: '60k', preset: true }] }, []);
  assert.equal(rauOnly.status, 400, 'buying vegetables is a market trip too');

  assert.equal((await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Xăng xe', price: '50k', category: 'xang' }] }, [])).status, 200, 'petrol only: no photo');
  assert.equal((await post(api, { action: 'create', note_type: 'expense', items: [], note: 'Gas sắp hết' }, [])).status, 200, 'plain text: no photo');

  const ok = await post(api, { action: 'create', note_type: 'expense', items: items(), photos: ['2026-01/note-fake.jpg'] }, [PHOTO, PHOTO]);
  assert.equal(ok.status, 200);
  const photos = JSON.parse(state.staff_notes.at(-1).content).photos;
  assert.deepEqual(plain(photos), plain(state.stored.filter(p => p.includes('/note-'))), 'the two uploaded photos are kept; a path sent by the browser is ignored');
  const list = plain(await load(state).GET({}));
  assert.equal(list.body.photo_links[photos[0]], `/img?p=${photos[0]}`, 'GET returns a link to see each photo');
});

test('photo limits: at most 3, images only; a failed save removes the uploaded photos', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state, STAFF);
  assert.match((await post(api, { action: 'create', note_type: 'expense', items: items() }, [PHOTO, PHOTO, PHOTO, PHOTO])).body.error, /Tối đa 3 ảnh/);
  assert.match((await post(api, { action: 'create', note_type: 'expense', items: items() }, [{ ...PHOTO, type: 'application/pdf' }])).body.error, /JPG, PNG/);
  state.storageDown = true;
  assert.equal((await post(api, { action: 'create', note_type: 'expense', items: items() })).status, 500);
  assert.equal(state.staff_notes.length, 0);
  state.storageDown = false;
  // Ghi phiếu thất bại (trả nợ vượt số còn nợ được kiểm tra trước) → không có ảnh nào được lưu.
  assert.equal((await post(api, { action: 'create', note_type: 'expense', items: items(), pay_debts: [{ note_id: '00000000-0000-4000-8000-000000000999', amount: 1000 }] })).status, 400);
  assert.equal((state.stored || []).length, 0, 'photos are only stored after every check passed');
});

test('editing keeps the photos; adding market lines to a note without any needs a photo; delete removes them', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: items() });
  const note = state.staff_notes[0];
  const before = JSON.parse(note.content).photos;
  const rows = math.editRows(JSON.parse(note.content).items).map(i => (i.name === 'Mực' ? { ...i, qty: '2kg' } : i));
  assert.equal((await post(api, { action: 'edit', id: note.id, note_type: 'expense', items: rows, note: '', updated_at: note.updated_at })).status, 200);
  assert.deepEqual(plain(JSON.parse(state.staff_notes[0].content).photos), plain(before), 'editing a price or quantity keeps the photo');

  await post(api, { action: 'create', note_type: 'expense', items: [{ name: 'Xăng xe', price: '50k', category: 'xang' }] }, []);
  const petrol = state.staff_notes[1];
  const addOc = [...math.editRows(JSON.parse(petrol.content).items), { _id: 'oc', name: 'Ốc hương', price: '220k', qty: '2' }];
  const blocked = await post(api, { action: 'edit', id: petrol.id, note_type: 'expense', items: addOc, note: '', updated_at: petrol.updated_at });
  assert.equal(blocked.status, 400, 'cannot slip market goods into a petrol note without a photo');
  const withPhoto = await post(api, { action: 'edit', id: petrol.id, note_type: 'expense', items: addOc, note: '', updated_at: petrol.updated_at }, [PHOTO], [{ file: PHOTO, ids: ['oc'] }]);
  assert.equal(withPhoto.status, 200);
  const saved = JSON.parse(state.staff_notes[1].content);
  assert.equal(saved.photos.length, 1);
  assert.match(saved.history.at(-1).changes, /📷 Thêm 1 ảnh/);

  const billOf = [...new Set(JSON.parse(state.staff_notes[0].content).items.map(i => i.bill_photo).filter(Boolean))];
  assert.equal(billOf.length, 1, 'one bill covers all the ốc lines of the trip');
  assert.equal((await post(api, { action: 'delete', id: note.id })).status, 200);
  assert.deepEqual(plain(state.removed), plain([...before, ...billOf]), 'deleting a note deletes its photo and its bills');
});

test('every ốc line needs a seller bill or a reason; one bill can cover several lines', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state, STAFF);
  const lines = () => [
    { _id: 'oc', name: 'Ốc hương', qty: '2 ký', price: '220k' },
    { _id: 'so', name: 'Sò điệp', qty: '3 ký', price: '90k' },
    { _id: 'muc', name: 'Mực', qty: '1', price: '200k' },
    { _id: 'rau', name: 'Tiền rau', preset: true, price: '60k' },
  ];
  const missing = await post(api, { action: 'create', note_type: 'expense', items: lines() }, [PHOTO], [{ file: PHOTO, ids: ['oc', 'so'] }]);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Còn 1 món chưa có bill: Mực/);
  assert.equal(state.staff_notes.length, 0);
  assert.match((await post(api, { action: 'create', note_type: 'expense', items: lines() }, [PHOTO], [{ file: PHOTO, ids: ['khac'] }])).body.error, /không khớp/);

  const items = lines().map(i => (i._id === 'muc' ? { ...i, no_bill: '  Mối quen, không viết bill  ' } : i));
  items[0].bill_photo = '2026-01/notebill-trick.jpg';
  const ok = await post(api, { action: 'create', note_type: 'expense', items }, [PHOTO], [{ file: PHOTO, ids: ['oc', 'so', 'rau'] }]);
  assert.equal(ok.status, 200);
  const saved = JSON.parse(state.staff_notes[0].content).items;
  const bill = state.stored.find(p => p.includes('/notebill-'));
  assert.deepEqual(saved.map(i => i.bill_photo || null), [bill, bill, null, bill], 'one bill for ốc, sò and rau; a path sent by the browser is ignored');
  assert.equal(saved[2].no_bill, 'Mối quen, không viết bill');
});

test('editing: old lines keep their bill, a new ốc line needs one, a removed line takes its own bill with it', async () => {
  const state = { staff_notes: [], staff_note_payments: [] };
  const api = load(state);
  await post(api, { action: 'create', note_type: 'expense', items: [{ _id: 'oc', name: 'Ốc hương', price: '220k', qty: '2' }, { _id: 'so', name: 'Sò điệp', price: '90k', qty: '3' }] },
    [PHOTO], [{ file: PHOTO, ids: ['oc'] }, { file: PHOTO, ids: ['so'] }]);
  const note = state.staff_notes[0];
  const [ocBill, soBill] = JSON.parse(note.content).items.map(i => i.bill_photo);
  const rows = math.editRows(JSON.parse(note.content).items);
  const add = [...rows.map(i => ({ ...i, bill_photo: undefined })), { _id: 'muc', name: 'Mực', price: '200k', qty: '1' }];
  assert.match((await post(api, { action: 'edit', id: note.id, note_type: 'expense', items: add, note: '', updated_at: note.updated_at })).body.error, /chưa có bill: Mực/);
  const r = await post(api, { action: 'edit', id: note.id, note_type: 'expense', items: add.filter(i => i._id !== 'so'), note: '', updated_at: note.updated_at }, [], [{ file: PHOTO, ids: ['muc'] }]);
  assert.equal(r.status, 200);
  const after = JSON.parse(state.staff_notes[0].content);
  assert.deepEqual(after.items.map(i => [i._id, !!i.bill_photo]), [['oc', true], ['muc', true]]);
  assert.equal(after.items[0].bill_photo, ocBill, 'the old bill stays even when the browser does not send it');
  assert.match(after.history.at(-1).changes, /🧾 Thêm bill: Mực/);
  assert.deepEqual(plain(state.removed), [soBill], 'the bill of the removed Sò điệp line is deleted');
});
