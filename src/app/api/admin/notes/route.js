/**
 * /api/admin/notes — Sổ tay: ghi / sửa / trả nợ / xoá phiếu qua máy chủ.
 *
 * Máy chủ tự tính tiền của phiếu từ các dòng hàng (notesMath), lấy người ghi
 * từ phiên đăng nhập, giờ theo máy chủ, tự ghi lịch sử chỉnh sửa và ghi riêng
 * từng lần trả nợ (staff_note_payments). Số "đã trả nợ" của từng dòng luôn lấy
 * từ dữ liệu đang lưu, không tin số trình duyệt gửi lên. Mọi thay đổi còn được
 * trigger trong DB ghi vào staff_data_audit. Mỗi thao tác ghi một lần qua hàm
 * staff_notes_commit (cả giao dịch, kiểm tra phiếu chưa bị đổi từ lúc đọc).
 *
 * GET  → { notes (kèm staff), payments, categories }  (admin, quản lý: tất cả; nhân viên: của mình)
 *       categories: các loại "Khác" chủ quán tạo (dòng hàng tab Khác có category = id loại)
 * POST {action}: create (kèm pay_debts: [{ note_id, item_id, item_index|null, amount }] — trả đúng các khoản
 *       nợ cũ đã chọn (tìm dòng theo item_id = _id của dòng, dòng cũ chưa có mã thì theo item_index);
 *       from_note_id = lấy từ tiền thừa của phiếu trước, bỏ trống = tiền phiếu mới;
 *       carry_leftovers [{ note_id, amount }] = cộng tiền dư phiếu cũ vào phiếu mới),
 *       edit (kèm updated_at của phiếu lúc mở ô sửa: phiếu đã đổi từ đó thì không ghi đè),
 *       pay_item (item_id / item_index; item_index null = cả phiếu), return_leftover (đã trả tiền thừa cho chủ),
 *       delete (admin; hoàn lại nợ đã trả / tiền dư đã chuyển bằng phiếu đó),
 *       set_categories (admin; { categories: [{ id?, name }] } — tạo / đổi tên / xoá loại Khác)
 *
 * Ảnh phiếu đi chợ: create / edit gửi dạng multipart (payload = JSON như trên, photo = ảnh hàng trên cân, không bắt buộc
 * — chủ quán bỏ bắt chụp ngày 08/11/2026, chỉ trang cũ chưa tải lại còn gửi). Ảnh nằm trong bucket ảnh bill (kind 'note'),
 * đường dẫn lưu ở content.photos; GET trả kèm photo_links { đường dẫn: link xem 1 giờ }.
 * Bill của mối ở từng dòng hàng (item.bill_photo, kind 'notebill'): chụp trực tiếp hoặc chọn ảnh có sẵn trong máy
 * (item.bill_from = 'gallery', chủ thấy "ảnh có sẵn"). item.bill_hash = mã ảnh: ảnh bill đã dùng ở phiếu khác
 * trong 90 ngày thì không nhận.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, staffDatabase, statusDatabase } from '@/lib/statusAuth';
import { noteTotals, parsePrice, parseQty } from '@/lib/notesMath.mjs';
import { MAX_BILL_PHOTOS, MAX_NOTE_PHOTOS, missingBills, needsBill } from '@/lib/notesChecks.mjs';
import { receiptImageProblem, removeReceiptImages, signReceiptImages, uploadReceiptImage } from '@/lib/receiptImages.mjs';
import { findDebtLine, noteLeftover, noteMoney, openDebtLines, paymentItemIndex } from '@/lib/notesDebts.mjs';
import { categoryName, cleanCategories, lineCategory } from '@/lib/noteCategories.mjs';
import { seesAllNotes } from '@/lib/staffRoles.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const TYPES = ['expense', 'stock', 'repair', 'other'];
const MAX_ITEMS = 100;
const MAX_MONEY = 1_000_000_000;
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });
const vnDay = iso => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 10);
const stamp = () => new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
const vnd = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')} đ`;
const str = (v, max) => String(v ?? '').slice(0, max);
const money = v => { const n = Math.round(Number(String(v ?? '').replace(/\./g, ''))); return Number.isFinite(n) && n >= 0 && n <= MAX_MONEY ? n : 0; };

/** Dòng hàng từ trình duyệt → chỉ giữ các ô nhập; tiền đã trả nợ lấy từ dòng đang lưu. */
function cleanItems(items, stored = []) {
  if (!Array.isArray(items)) return [];
  // Dòng cũ chưa có _id: trang Sổ tay đặt "#vị trí" khi mở sửa.
  const byId = new Map(stored.map((i, idx) => [i._id || `#${idx}`, i]));
  return items.slice(0, MAX_ITEMS).filter(i => String(i?.name || '').trim()).map((i, idx) => {
    const old = (i._id && byId.get(i._id)) || null;
    const row = {
      name: str(i.name, 80).trim(), price: str(i.price, 30), qty: str(i.qty, 30),
      paymentStatus: i.paymentStatus === 'debt' ? 'debt' : 'full',
      creditor: str(i.creditor, 60), debtAmount: str(i.debtAmount, 30),
      _id: str(i._id || `item-${Date.now()}-${idx}`, 60),
    };
    if (i.preset) row.preset = true;
    // Dòng tab "Khác" (xăng xe, sửa chữa…): id loại; dòng hàng ốc không có trường này.
    const category = lineCategory(i);
    if (category) row.category = category;
    // Bill của dòng chỉ lấy từ dòng đang lưu (ảnh mới gắn sau khi lưu ảnh) — trình duyệt không tự đặt đường dẫn ảnh,
    // mã ảnh (bill_hash) hay nguồn ảnh (bill_from).
    if (typeof old?.bill_photo === 'string') {
      row.bill_photo = old.bill_photo;
      if (typeof old.bill_hash === 'string') row.bill_hash = old.bill_hash;
      if (old.bill_from === 'gallery') row.bill_from = 'gallery';
    }
    const noBill = str(i.no_bill, 120).trim();
    if (noBill) row.no_bill = noBill;
    if (old?.paid_amount) {
      row.paid_amount = Number(old.paid_amount) || 0;
      row.payment_logs = old.payment_logs || [];
      // Dòng đã trả nợ xong thì giữ là "đủ"; nợ lúc mua vẫn tính theo debtAmount / tổng dòng.
      if (old.paymentStatus === 'full' && row.paymentStatus === 'debt' && row.paid_amount >= debtBase(row)) row.paymentStatus = 'full';
    }
    return row;
  });
}

const lineTotal = i => Math.round(parsePrice(i.price) * parseQty(i.qty));
function debtBase(i) {
  const t = lineTotal(i);
  return String(i.debtAmount || '').trim() ? Math.min(parsePrice(String(i.debtAmount).replace(/\./g, '')) || t, t) : t;
}

/** Lịch sử thay đổi giữa dòng đang lưu và dòng mới (giống trang Sổ tay cũ). */
function diffItems(oldItems, newItems, oldText, newText, categories = []) {
  const kind = i => (lineCategory(i) ? `Khác · ${categoryName(lineCategory(i), categories)}` : 'Hàng ốc');
  const lines = [];
  const oldById = new Map(oldItems.map((o, idx) => [o._id || `#${idx}`, o]));
  newItems.forEach((n, idx) => {
    const o = oldById.get(n._id);
    if (!o) {
      const t = lineTotal(n);
      lines.push(`➕ Thêm mới: ${n.name}${n.price ? ' ' + n.price : ''}${n.qty ? ' × ' + n.qty : ''}${t > 0 ? ' = ' + vnd(t) : ''}${n.paymentStatus === 'debt' ? ' (Nợ)' : ''}`);
      return;
    }
    const d = [];
    if (o.name !== n.name) d.push(`tên "${o.name}" → "${n.name}"`);
    if ((o.price || '') !== n.price) d.push(`giá ${o.price || '—'} → ${n.price || '—'}`);
    if ((o.qty || '') !== n.qty) d.push(`SL ${o.qty || '—'} → ${n.qty || '—'}`);
    if ((o.paymentStatus || 'full') !== n.paymentStatus) d.push(`trạng thái ${o.paymentStatus === 'debt' ? 'Nợ' : 'Đủ'} → ${n.paymentStatus === 'debt' ? 'Nợ' : 'Đủ'}`);
    if (n.paymentStatus === 'debt' && (o.debtAmount || '') !== n.debtAmount) d.push(`số nợ ${o.debtAmount || '(toàn bộ)'} → ${n.debtAmount || '—'}`);
    if ((o.creditor || '') !== n.creditor && (o.creditor || n.creditor)) d.push(`nợ của: ${n.creditor || '—'}`);
    if (lineCategory(o) !== lineCategory(n)) d.push(`loại ${kind(o)} → ${kind(n)}`);
    if ((o.no_bill || '') !== (n.no_bill || '')) d.push(n.no_bill ? `không có bill: ${n.no_bill}` : 'bỏ ghi "không có bill"');
    if (d.length) lines.push(`✏️ Sửa ${n.name}: ${d.join(', ')}`);
  });
  const newIds = new Set(newItems.map(n => n._id));
  oldItems.forEach((o, idx) => { if (!newIds.has(o._id || `#${idx}`)) lines.push(`🗑️ Xóa: ${o.name}`); });
  if ((oldText || '') !== (newText || '')) lines.push(`📝 Ghi chú thêm: "${newText || '(xóa)'}"`);
  return lines;
}

// Loại "Khác" của Sổ tay: finance_settings['note_categories'] (chưa có → chưa tạo loại nào).
async function readCategories(db) {
  const { data, error } = await db.from('finance_settings').select('value').eq('key', 'note_categories').maybeSingle();
  if (error) { console.error('[notes] categories', error); return []; }
  return Array.isArray(data?.value?.categories) ? data.value.categories : [];
}

const parseContent = content => { try { const d = JSON.parse(content); return d && typeof d === 'object' ? d : null; } catch { return null; } };
const paths = list => (Array.isArray(list) ? list : []).filter(x => typeof x === 'string');
/** Ảnh hàng trên cân của phiếu (content.photos). */
const scalePhotos = note => paths(parseContent(note?.content)?.photos);
/** Mọi ảnh của phiếu: hàng trên cân + bill từng dòng (một bill có thể dùng cho nhiều dòng). */
function notePhotos(note) {
  const data = parseContent(note?.content);
  return [...new Set([...paths(data?.photos), ...paths((Array.isArray(data?.items) ? data.items : []).map(i => i?.bill_photo))])];
}

/**
 * Thân request: JSON, hoặc multipart khi ghi phiếu kèm ảnh: payload = JSON, photo = ảnh hàng trên cân,
 * bill = ảnh bill, bill_items = JSON [[_id dòng hàng của bill 1], [… bill 2], …],
 * bill_from = JSON ['camera' | 'gallery', …] (bill chụp trực tiếp hay chọn ảnh có sẵn trong máy).
 */
async function readBody(request) {
  if (!/multipart\/form-data/i.test(request.headers?.get?.('content-type') || '')) return { body: await request.json().catch(() => ({})), photos: [], bills: [], billItems: [], billFrom: [] };
  const form = await request.formData().catch(() => null);
  const json = (key, fallback) => { try { return JSON.parse(form?.get(key) || 'null') ?? fallback; } catch { return fallback; } };
  const files = key => (form ? form.getAll(key).filter(f => f && typeof f !== 'string') : []);
  const billItems = json('bill_items', []), billFrom = json('bill_from', []);
  return { body: json('payload', {}), photos: files('photo'), bills: files('bill'), billItems: Array.isArray(billItems) ? billItems : [], billFrom: Array.isArray(billFrom) ? billFrom : [] };
}

/**
 * Ảnh bill gửi lên → [{ file, ids, from }] (mỗi bill phủ ít nhất 1 dòng của phiếu chưa có bill), hoặc { error }.
 * Dòng đã có bill (lưu từ trước) giữ bill cũ.
 */
function billPlan(items, bills, billItems, billFrom = []) {
  if (bills.length > MAX_BILL_PHOTOS) return { error: `Tối đa ${MAX_BILL_PHOTOS} ảnh bill một phiếu.` };
  const open = new Set(items.filter(i => !i.bill_photo).map(i => i._id));
  const plan = [];
  for (const [k, file] of bills.entries()) {
    const problem = receiptImageProblem(file);
    if (problem) return { error: problem };
    const ids = (Array.isArray(billItems[k]) ? billItems[k] : []).filter(id => typeof id === 'string' && open.has(id));
    if (!ids.length) return { error: 'Ảnh bill không khớp dòng hàng nào của phiếu, tải lại trang rồi thử lại.' };
    ids.forEach(id => open.delete(id));
    plan.push({ file, ids, from: billFrom[k] === 'gallery' ? 'gallery' : 'camera' });
  }
  return { plan };
}

/** Mã của tấm ảnh (SHA-256): chọn lại đúng tấm ảnh cũ trong máy thì ra cùng mã. */
async function imageHash(file) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

const BILL_REUSE_DAYS = 90; // ảnh phiếu cũng chỉ giữ 90 ngày
/**
 * Ảnh bill đã dùng ở phiếu khác trong 90 ngày (chọn lại ảnh bill cũ trong máy để khai lần đi chợ mới)
 * → { note: phiếu đó, names: các món của bill }, không trùng → null. Cùng phiếu (sửa phiếu, thêm dòng
 * cùng tờ bill) thì được. Ghi mã ảnh vào từng bill (entry.hash) để lưu vào dòng hàng.
 */
async function reusedBill(db, items, plan, noteId) {
  for (const entry of plan) entry.hash = await imageHash(entry.file);
  const since = new Date(Date.now() - BILL_REUSE_DAYS * 86400000).toISOString();
  for (const hash of new Set(plan.map(p => p.hash))) {
    let query = db.from('staff_notes').select('id, created_at').gte('created_at', since).like('content', `%${hash}%`);
    if (noteId) query = query.neq('id', noteId);
    const { data, error } = await query.limit(1);
    if (error) throw error;
    if (data?.[0]) {
      const ids = plan.filter(p => p.hash === hash).flatMap(p => p.ids);
      return { note: data[0], names: items.filter(i => ids.includes(i._id)).map(i => i.name) };
    }
  }
  return null;
}

/** Lưu ảnh bill rồi gắn đường dẫn (và mã ảnh, nguồn ảnh) vào các dòng; lỗi giữa chừng thì xoá ảnh đã lưu (uploaded nhận mọi đường dẫn). */
async function uploadBills(storage, items, plan, uploaded) {
  for (const { file, ids, from, hash } of plan) {
    const path = await uploadReceiptImage(storage, file, 'notebill');
    uploaded.push(path);
    for (const item of items) {
      if (!ids.includes(item._id)) continue;
      item.bill_photo = path;
      if (hash) item.bill_hash = hash;
      if (from === 'gallery') item.bill_from = 'gallery';
    }
  }
}

const missingText = list => `Còn ${list.length} món chưa có bill: ${list.map(i => i.name).join(', ')}. Bấm 🧾 ở từng dòng để chụp bill của mối (hoặc ghi lý do mối không đưa bill).`;
const reusedText = (reused, dm) => `Ảnh bill của ${reused.names.join(', ')} đã dùng ở phiếu ngày ${dm(reused.note.created_at)}. Chọn đúng bill của lần đi chợ này (hoặc bấm "Không có bill?" ghi lý do).`;

/**
 * Một thao tác = một lần ghi (hàm staff_notes_commit trong DB). Các phiếu bị đổi được
 * sửa trên bản sao ở đây, rồi ghi cùng lúc; phiếu nào đã bị đổi từ lúc đọc (updated_at
 * khác) thì cả thao tác không được ghi → bấm 2 lần cùng lúc không trả / chuyển tiền 2 lần.
 */
function changeSet() {
  const work = new Map();
  const set = {
    payments: [], deletePayments: [], insert: null, remove: null,
    /** Bản sao đang sửa của phiếu (lần đầu lấy từ dữ liệu đã đọc). */
    note(row) {
      if (!work.has(row.id)) work.set(row.id, { expect: row.updated_at ?? null, row: { ...row } });
      return work.get(row.id).row;
    },
    async commit(db) {
      const p = {
        updates: [...work.values()].filter(w => w.row.id !== set.remove?.id).map(({ expect, row }) => ({
          id: row.id, expect, content: row.content, note_type: row.note_type, amount: row.amount, debt: row.debt, paid_debt: row.paid_debt })),
        payments: set.payments, delete_payments: set.deletePayments,
        ...(set.insert ? { insert: set.insert } : {}),
        ...(set.remove ? { delete: { id: set.remove.id, expect: set.remove.updated_at ?? null } } : {}),
      };
      const { data, error } = await db.rpc('staff_notes_commit', { p });
      if (error && /note_changed/.test(error.message || '')) throw Object.assign(new Error('changed'), { changed: true });
      if (error) throw error;
      return data;
    },
  };
  return set;
}

/**
 * Ghi trả nợ vào bản sao phiếu (dòng hàng, lịch sử, số đã trả) và thêm vào sổ trả nợ.
 * Lịch sử trả của dòng ghi phiếu bỏ tiền (from_note_id): xoá phiếu đó thì tìm lại đúng dòng
 * này dù phiếu đã bị sửa (sổ trả nợ chỉ lưu vị trí dòng lúc trả).
 */
function payInto(changes, note, itemIndex, amount, { user, fromNoteId, logText }) {
  const row = changes.note(note);
  const data = parseContent(row.content);
  const ts = stamp();
  const items = data?.type === 'structured_expense' && Array.isArray(data.items) ? data.items : [];
  // Dòng cũ chưa có mã: đặt "#vị trí" như trang Sổ tay khi mở sửa, để từ nay tìm dòng theo mã.
  items.forEach((it, i) => { if (it && typeof it === 'object' && !it._id) it._id = `#${i}`; });
  const item = itemIndex !== null ? items[itemIndex] || null : null;
  if (item) {
    item.paid_amount = (Number(item.paid_amount) || 0) + amount;
    if (item.paid_amount >= debtBase(item)) item.paymentStatus = 'full';
    item.payment_logs = [...(item.payment_logs || []), { amount, ts, from_note_id: fromNoteId || null }];
  }
  if (data) data.history = [...(data.history || []), { ts, by: user.full_name || 'Không rõ', changes: logText(item || { name: '' }) }];
  row.paid_debt = Math.min(Number(row.debt) || 0, (Number(row.paid_debt) || 0) + amount);
  row.content = data ? JSON.stringify(data) : `${row.content || ''}\n\n[${logText({ name: '' })}]`;
  changes.payments.push({ note_id: note.id, item_index: itemIndex, amount, paid_from_note_id: fromNoteId || null, staff_id: user.id, created_by_name: user.full_name || null });
}

/**
 * Huỷ một lần trả nợ (khi xoá phiếu đã dùng để trả): mở lại nợ của đúng dòng đã nhận tiền
 * (paymentItemIndex — không theo vị trí, vì phiếu có thể đã bị sửa xoá / thêm dòng).
 */
function unpayInto(changes, note, payment, { user, why }) {
  const row = changes.note(note);
  const data = parseContent(row.content);
  const ts = stamp(), amount = Number(payment.amount) || 0;
  const items = data?.type === 'structured_expense' && Array.isArray(data.items) ? data.items : [];
  const item = items[paymentItemIndex(items, payment)] || null;
  if (item) {
    const from = payment.paid_from_note_id || null;
    // Ghi lần huỷ cùng kiểu lần trả (lần trả cũ không có from_note_id) để các lần huỷ sau tìm đúng dòng còn lại.
    const tagged = (item.payment_logs || []).some(l => l && typeof l === 'object' && 'from_note_id' in l && (l.from_note_id || null) === from && Number(l.amount) > 0);
    item.paid_amount = Math.max(0, (Number(item.paid_amount) || 0) - amount);
    if (item.paid_amount < debtBase(item)) item.paymentStatus = 'debt';
    item.payment_logs = [...(item.payment_logs || []), { amount: -amount, ts, note: why, ...(tagged ? { from_note_id: from } : {}) }];
  }
  const text = `↩ Huỷ trả nợ ${vnd(amount)}${item?.name ? ` cho "${item.name}"` : ''} (${why})`;
  if (data) data.history = [...(data.history || []), { ts, by: user.full_name || 'Không rõ', changes: text }];
  row.paid_debt = Math.max(0, (Number(row.paid_debt) || 0) - amount);
  row.content = data ? JSON.stringify(data) : `${row.content || ''}\n\n[${text}]`;
}

/** Thêm một dòng lịch sử vào bản sao phiếu. */
function logInto(changes, note, user, text, edit = d => d) {
  const row = changes.note(note);
  const data = parseContent(row.content);
  if (!data) return;
  edit(data);
  data.history = [...(data.history || []), { ts: stamp(), by: user.full_name || 'Không rõ', changes: text }];
  row.content = JSON.stringify(data);
}

/** Phiếu sau khi ghi (trang Sổ tay hiện lại ngay). */
const fresh = async (db, id) => (await db.from('staff_notes').select('*').eq('id', id).single()).data;

export async function GET(request) {
  try {
    const s = await getStaffSession(request);
    if (s.code !== 200) return fail(s.code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập.', s.code);
    const db = staffDatabase(s.user.id);
    let q = db.from('staff_notes').select('*, staff ( full_name, phone )').order('created_at', { ascending: false });
    if (!seesAllNotes(s.user.role)) q = q.eq('staff_id', s.user.id);
    const { data: notes, error } = await q;
    if (error) throw error;
    let payments = [];
    const p = await db.from('staff_note_payments').select('id, note_id, item_index, amount, paid_at, paid_from_note_id, created_by_name').order('paid_at');
    if (!p.error) {
      const ids = new Set((notes || []).map(n => n.id));
      payments = (p.data || []).filter(x => ids.has(x.note_id) || ids.has(x.paid_from_note_id));
    }
    // Link xem ảnh phiếu (1 giờ); kho ảnh lỗi thì vẫn trả phiếu, chỉ thiếu ảnh.
    const paths = (notes || []).flatMap(notePhotos);
    const photoLinks = paths.length ? await signReceiptImages(statusDatabase(), paths).catch(() => ({})) : {};
    return NextResponse.json({ notes: notes || [], payments, categories: await readCategories(db), photo_links: photoLinks }, { headers });
  } catch (error) {
    console.error('[notes] GET', error);
    return fail('Không tải được Sổ tay, thử lại.', 500);
  }
}

export async function POST(request) {
  try {
    const s = await getStaffSession(request);
    if (s.code !== 200) return fail(s.code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập.', s.code);
    // Quản lý làm được như chủ quán trên phiếu (ghi, sửa, trả nợ phiếu của ai cũng được), trừ xoá phiếu và sửa loại.
    const user = s.user, isAdmin = user.role === 'admin', canManage = seesAllNotes(user.role);
    const db = staffDatabase(user.id);
    const { body, photos, bills, billItems, billFrom } = await readBody(request);
    const changes = changeSet();
    const dm = iso => vnDay(iso).split('-').reverse().slice(0, 2).join('/');

    if (body.action === 'create') {
      const type = TYPES.includes(body.note_type) ? body.note_type : 'other';
      const items = type === 'expense' ? cleanItems(body.items) : [];
      const noteText = str(body.note, 4000);
      // Ảnh hàng trên cân: không bắt buộc nữa (trang cũ chưa tải lại vẫn gửi được).
      if (photos.length > MAX_NOTE_PHOTOS) return fail(`Tối đa ${MAX_NOTE_PHOTOS} ảnh một phiếu.`);
      for (const photo of photos) { const problem = receiptImageProblem(photo); if (problem) return fail(problem); }
      // Mỗi dòng hàng ốc: ảnh bill của mối hoặc lý do không có bill (chống khai giá cao).
      const bill = billPlan(items, bills, billItems, billFrom);
      if (bill.error) return fail(bill.error);
      const covered = new Set(bill.plan.flatMap(p => p.ids));
      const noBill = missingBills(items, i => covered.has(i._id));
      if (noBill.length) return fail(missingText(noBill));
      // Các khoản nợ cũ người ghi chọn trả bằng tiền của phiếu này — kiểm tra hết trước khi lưu.
      const requested = Array.isArray(body.pay_debts) ? body.pay_debts.slice(0, 60) : [];
      const carryReq = type === 'expense' && items.length && Array.isArray(body.carry_leftovers) ? body.carry_leftovers.slice(0, 30) : [];
      const targetIds = [...new Set([...requested.flatMap(r => [r?.note_id, r?.from_note_id]), ...carryReq.map(c => c?.note_id)].filter(id => UUID.test(id || '')))];
      const { data: targets, error: targetErr } = targetIds.length ? await db.from('staff_notes').select('*').in('id', targetIds) : { data: [], error: null };
      if (targetErr) throw targetErr;
      const byId = new Map((targets || []).map(n => [n.id, n]));
      const plan = [], used = new Map();
      for (const r of requested) {
        const target = byId.get(r?.note_id);
        const pay = money(r?.amount);
        if (!target || !pay) return fail('Khoản nợ cần trả không hợp lệ.');
        if (!canManage && target.staff_id !== user.id) return fail('Không trả được nợ trên phiếu của người khác.', 403);
        const idx = r.item_index === null || r.item_index === undefined ? null : Number(r.item_index);
        // Tìm dòng theo mã: phiếu nợ có thể vừa bị sửa (xoá / thêm dòng) nên vị trí trình duyệt thấy đã khác.
        const line = findDebtLine(openDebtLines(target), typeof r.item_id === 'string' ? r.item_id : null, idx);
        const key = `${target.id}:${line ? line.item_index : idx}`;
        const already = used.get(key) || 0;
        if (!line || pay + already > line.left) return fail(`Số trả vượt số còn nợ${line ? ` (${line.name}: còn ${vnd(line.left - already)})` : ' — khoản này đã trả hết'}.`);
        used.set(key, already + pay);
        const from = UUID.test(r.from_note_id || '') ? r.from_note_id : null;
        plan.push({ target, idx: line.item_index, pay, line, from });
      }
      const carry = [];
      for (const c of carryReq) {
        const amount = money(c?.amount);
        if (!byId.has(c?.note_id) || !amount) return fail('Tiền dư phiếu cũ không hợp lệ.');
        carry.push({ id: c.note_id, amount });
      }
      // Tiền thừa phiếu trước: phiếu nguồn phải còn đủ tiền thừa chưa trả chủ.
      const sourceIds = [...new Set([...plan.map(x => x.from), ...carry.map(c => c.id)].filter(Boolean))];
      if (sourceIds.length) {
        const { data: sourcePays, error: sourceErr } = await db.from('staff_note_payments').select('paid_from_note_id, amount').in('paid_from_note_id', sourceIds);
        if (sourceErr) throw sourceErr;
        for (const id of sourceIds) {
          const source = byId.get(id);
          if (!source) return fail('Phiếu lấy tiền thừa không hợp lệ.');
          if (!canManage && source.staff_id !== user.id) return fail('Không dùng được tiền thừa trên phiếu của người khác.', 403);
          const want = plan.filter(x => x.from === id).reduce((a, x) => a + x.pay, 0) + carry.filter(c => c.id === id).reduce((a, c) => a + c.amount, 0);
          const left = noteLeftover(source, sourcePays || []);
          if (want > left) return fail(`Tiền thừa phiếu ${dm(source.created_at)} chỉ còn ${vnd(left)}.`);
          // Phiếu nguồn cũng được khoá khi ghi: hai lần lấy cùng lúc thì lần sau bị từ chối.
          changes.note(source);
        }
      }
      // Ảnh bill cũ (đã dùng ở phiếu khác) chọn lại từ máy thì không nhận.
      const reused = await reusedBill(db, items, bill.plan, null);
      if (reused) return fail(reusedText(reused, dm));
      const newId = crypto.randomUUID();
      const today = dm(new Date().toISOString());
      const payTotal = plan.reduce((a, x) => a + x.pay, 0);
      const sourceText = x => (x.from ? `, lấy tiền thừa phiếu ${dm(byId.get(x.from).created_at)}` : '');
      const notice = payTotal > 0 ? `[💰 Trả nợ cũ ${vnd(payTotal)}: ${plan.map(x => `${x.line.creditor || 'không ghi tên'} — ${x.line.name} ${vnd(x.pay)} (phiếu ${dm(x.target.created_at)}${sourceText(x)})`).join('; ')}]` : '';
      let content, amount = 0, debt = 0;
      const storage = statusDatabase();
      const photoPaths = [], uploaded = [];
      if (items.length) {
        const t = noteTotals(items);
        amount = t.paid; debt = t.debt;
        // Ảnh lưu trước, phiếu sau: ghi phiếu lỗi thì xoá ảnh vừa lưu (bên dưới).
        try {
          for (const photo of photos) photoPaths.push(await uploadReceiptImage(storage, photo, 'note'));
          await uploadBills(storage, items, bill.plan, uploaded);
        } catch (error) {
          await removeReceiptImages(storage, [...photoPaths, ...uploaded]);
          throw error;
        }
        content = JSON.stringify({ type: 'structured_expense', items, note: [noteText, notice].filter(Boolean).join('\n\n'),
          input_amount: money(body.input_amount),
          ...(photoPaths.length ? { photos: photoPaths } : {}),
          ...(carry.length ? { carried_in: carry.map(c => ({ from_note_id: c.id, from_at: byId.get(c.id).created_at, amount: c.amount })) } : {}) });
      } else {
        content = [noteText.trim(), notice].filter(Boolean).join('\n\n');
      }
      if (!content) return fail('Vui lòng nhập nội dung!');
      // Phiếu cũ ghi lại số tiền dư đã chuyển sang phiếu mới.
      for (const c of carry) {
        logInto(changes, byId.get(c.id), user, `➡ Chuyển ${vnd(c.amount)} tiền dư sang phiếu ${today}`,
          data => { data.carried_out = [...(data.carried_out || []), { amount: c.amount, ts: stamp(), by: user.full_name || 'Không rõ', to_note_id: newId }]; });
      }
      for (const x of plan) {
        payInto(changes, x.target, x.idx, x.pay, { user, fromNoteId: x.from || newId,
          logText: item => `💰 Khấu trừ ${vnd(x.pay)}${item?.name ? ` cho "${item.name}"` : ''} (${x.from ? `lấy tiền thừa phiếu ${dm(byId.get(x.from).created_at)}` : 'lấy từ phiếu đi chợ mới'})${item?.paymentStatus === 'full' ? ' — ✅ Đã trả đủ' : ''}` });
      }
      changes.insert = { id: newId, staff_id: user.id, note_type: type, content, amount, debt, status: 'approved' };
      let created;
      try {
        created = await changes.commit(db);
      } catch (error) {
        await removeReceiptImages(storage, [...photoPaths, ...uploaded]);
        throw error;
      }
      return NextResponse.json({ ok: true, note: created }, { headers });
    }

    if (body.action === 'set_categories') {
      if (!isAdmin) return fail('Chỉ chủ quán được sửa loại.', 403);
      const categories = cleanCategories(body.categories, () => `c${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`);
      const { error } = await db.from('finance_settings').upsert({ key: 'note_categories', value: { categories }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
      return NextResponse.json({ ok: true, categories }, { headers });
    }

    if (!UUID.test(body.id || '')) return fail('Thiếu phiếu.');
    const { data: note, error: noteErr } = await db.from('staff_notes').select('*').eq('id', body.id).maybeSingle();
    if (noteErr) throw noteErr;
    if (!note) return fail('Không tìm thấy phiếu.', 404);
    const own = note.staff_id === user.id;
    if (!canManage && !own) return fail('Không phải phiếu của bạn.', 403);

    if (body.action === 'delete') {
      if (!isAdmin) return fail('Chỉ admin được xoá phiếu.', 403);
      // Hoàn lại mọi liên kết tiền của phiếu: nợ đã trả bằng tiền phiếu này mở lại,
      // tiền dư đã nhận / đã chuyển trả về phiếu kia, sổ trả nợ của phiếu này bỏ đi.
      const data = parseContent(note.content) || {};
      const { data: pays, error: paysErr } = await db.from('staff_note_payments').select('*').or(`paid_from_note_id.eq.${note.id},note_id.eq.${note.id}`);
      if (paysErr) throw paysErr;
      const funded = (pays || []).filter(p => p.paid_from_note_id === note.id && p.note_id !== note.id);
      const linkIds = [...new Set([...funded.map(p => p.note_id), ...(data.carried_in || []).map(c => c.from_note_id), ...(data.carried_out || []).map(c => c.to_note_id)].filter(id => UUID.test(id || '')))];
      const { data: linked, error: linkErr } = linkIds.length ? await db.from('staff_notes').select('*').in('id', linkIds) : { data: [], error: null };
      if (linkErr) throw linkErr;
      const byId = new Map((linked || []).map(n => [n.id, n]));
      const why = `xoá phiếu ${dm(note.created_at)}`;
      for (const p of funded) if (byId.has(p.note_id)) unpayInto(changes, byId.get(p.note_id), p, { user, why });
      for (const c of data.carried_in || []) {
        const source = byId.get(c.from_note_id);
        if (source) logInto(changes, source, user, `↩ Nhận lại ${vnd(c.amount)} tiền dư (${why})`,
          d => { d.carried_out = (d.carried_out || []).filter(o => o.to_note_id !== note.id); });
      }
      for (const c of data.carried_out || []) {
        const receiver = byId.get(c.to_note_id);
        if (receiver) logInto(changes, receiver, user, `↩ Bỏ ${vnd(c.amount)} tiền dư cũ (${why})`,
          d => { d.carried_in = (d.carried_in || []).filter(i => i.from_note_id !== note.id); });
      }
      changes.deletePayments = (pays || []).map(p => p.id);
      changes.remove = note;
      await changes.commit(db);
      await removeReceiptImages(statusDatabase(), notePhotos(note));
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'return_leftover') {
      // Người đi chợ đã đưa lại tiền thừa cho chủ → bớt khỏi "tiền thừa chưa trả chủ".
      const amount = money(body.amount);
      const { data: pays, error: paysErr } = await db.from('staff_note_payments').select('paid_from_note_id, amount').eq('paid_from_note_id', note.id);
      if (paysErr) throw paysErr;
      const left = noteLeftover(note, pays || []);
      if (!amount || amount > left) return fail(`Phiếu này còn ${vnd(left)} tiền thừa.`);
      logInto(changes, note, user, `↩ Đã trả lại chủ ${vnd(amount)} tiền thừa`,
        data => { data.returned_logs = [...(data.returned_logs || []), { amount, ts: stamp(), by: user.full_name || 'Không rõ' }]; });
      await changes.commit(db);
      return NextResponse.json({ ok: true, note: await fresh(db, note.id) }, { headers });
    }

    if (body.action === 'pay_item') {
      const idx = body.item_index === null || body.item_index === undefined ? null : Number(body.item_index), amount = money(body.amount);
      const line = findDebtLine(openDebtLines(note), typeof body.item_id === 'string' ? body.item_id : null, idx);
      if (!line) return fail('Dòng này không còn nợ.');
      if (!amount || amount > line.left) return fail('Số tiền không hợp lệ!');
      payInto(changes, note, line.item_index, amount, { user, logText: item => `💰 Trả nợ ${vnd(amount)}${item?.name ? ` cho "${item.name}"` : ''}` });
      await changes.commit(db);
      return NextResponse.json({ ok: true, note: await fresh(db, note.id) }, { headers });
    }

    if (body.action === 'edit') {
      // Nhân viên chỉ sửa phiếu của mình trong ngày ghi; admin, quản lý sửa được mọi phiếu (có nhật ký).
      if (!canManage && vnDay(note.created_at) !== vnDay(new Date().toISOString())) return fail('Chỉ sửa được phiếu trong ngày ghi.', 403);
      // Trang gửi updated_at của phiếu lúc mở ô sửa: phiếu đã đổi từ đó (máy khác sửa, trả nợ…) thì
      // không ghi đè bản mới hơn bằng màn hình cũ. Đổi sau lúc đọc này thì staff_notes_commit chặn.
      const expect = body.updated_at ?? null, current = note.updated_at ?? null;
      if ('updated_at' in body && expect !== current && Date.parse(expect) !== Date.parse(current)) {
        return fail('Phiếu này vừa được sửa / trả nợ ở máy khác. Tải lại trang để xem bản mới rồi sửa lại.', 409);
      }
      const type = TYPES.includes(body.note_type) ? body.note_type : note.note_type;
      const stored = parseContent(note.content);
      const storedItems = stored?.type === 'structured_expense' && Array.isArray(stored.items) ? stored.items : [];
      const items = type === 'expense' ? cleanItems(body.items, storedItems) : [];
      const noteText = str(body.note, 4000);
      const ts = stamp(), by = user.full_name || 'Không rõ';
      // Ảnh hàng trên cân thêm lúc sửa (không bắt buộc; cả phiếu tối đa MAX_NOTE_PHOTOS).
      const storedPhotos = scalePhotos(note);
      if (storedPhotos.length + photos.length > MAX_NOTE_PHOTOS) return fail(`Tối đa ${MAX_NOTE_PHOTOS} ảnh một phiếu.`);
      for (const photo of photos) { const problem = receiptImageProblem(photo); if (problem) return fail(problem); }
      // Bill: chỉ bắt với dòng hàng ốc mới thêm (hoặc vừa đổi thành hàng ốc); dòng cũ giữ bill / lý do cũ,
      // phiếu ghi trước khi bắt bill sửa giá / số lượng thì không bắt chụp lại.
      const bill = billPlan(items, bills, billItems, billFrom);
      if (bill.error) return fail(bill.error);
      const covered = new Set(bill.plan.flatMap(p => p.ids));
      const storedById = new Map(storedItems.map((o, idx) => [o._id || `#${idx}`, o]));
      const noBill = missingBills(items, i => covered.has(i._id)).filter(i => !needsBill(storedById.get(i._id)));
      if (noBill.length) return fail(missingText(noBill));
      const reused = await reusedBill(db, items, bill.plan, note.id);
      if (reused) return fail(reusedText(reused, dm));
      const storage = statusDatabase();
      const addedPhotos = [];
      let content, amount = 0, debt = 0;
      if (items.length) {
        const lines = diffItems(storedItems, items, stored?.note || '', noteText, await readCategories(db));
        const t = noteTotals(items);
        amount = t.paid; debt = t.debt;
        const before = (Number(note.amount) || 0) + (Number(note.debt) || 0);
        if (Math.abs(before - (amount + debt)) >= 1) lines.push(`💲 Tổng phiếu: ${vnd(before)} → ${vnd(amount + debt)}`);
        if (photos.length) lines.push(`📷 Thêm ${photos.length} ảnh`);
        if (bill.plan.length) {
          const fromPhone = new Set(bill.plan.filter(p => p.from === 'gallery').flatMap(p => p.ids));
          lines.push(`🧾 Thêm bill: ${items.filter(i => covered.has(i._id)).map(i => `${i.name}${fromPhone.has(i._id) ? ' (ảnh có sẵn)' : ''}`).join(', ')}`);
        }
        const inputAmount = money(body.input_amount);
        // Giữ sổ tiền dư (đã trả chủ, chuyển đi / nhận vào) và ảnh hàng khi sửa phiếu.
        const moneyLogs = Object.fromEntries(['returned_logs', 'carried_in', 'carried_out', 'photos'].filter(k => Array.isArray(stored?.[k])).map(k => [k, stored[k]]));
        const doc = { type: 'structured_expense', items, note: noteText, ...(inputAmount > 0 ? { input_amount: inputAmount } : {}), ...moneyLogs,
          history: [...(stored?.history || []), { ts, by, changes: lines.length ? lines.join('\n') : '✏️ Cập nhật ghi chú' }] };
        content = JSON.stringify(doc);
        // Tiền dư đã trả chủ / chuyển sang phiếu khác phải vẫn còn sau khi sửa.
        const { data: pays, error: paysErr } = await db.from('staff_note_payments').select('paid_from_note_id, amount').eq('paid_from_note_id', note.id);
        if (paysErr) throw paysErr;
        const after = noteMoney({ ...note, note_type: type, content, amount }, pays || []);
        const claimed = after.returned + after.carriedOut;
        if (claimed > 0 && after.balance < claimed) {
          return fail(`Phiếu này đã trả chủ / chuyển sang phiếu sau ${vnd(claimed)} tiền dư. Sau khi sửa, tiền giao trừ tiền đã chi phải còn ít nhất số này (hiện chỉ còn ${vnd(Math.max(0, after.balance))}).`);
        }
        if (photos.length || bill.plan.length) {
          const addedScale = [];
          try {
            for (const photo of photos) {
              const path = await uploadReceiptImage(storage, photo, 'note');
              addedPhotos.push(path);
              addedScale.push(path);
            }
            await uploadBills(storage, items, bill.plan, addedPhotos);
          } catch (error) {
            await removeReceiptImages(storage, addedPhotos);
            throw error;
          }
          content = JSON.stringify({ ...doc, ...(addedScale.length ? { photos: [...storedPhotos, ...addedScale] } : {}) });
        }
      } else if (stored) {
        content = JSON.stringify({ ...stored, history: [...(stored.history || []), { ts, by, changes: '✏️ Sửa nội dung' }], note: noteText });
        amount = Number(note.amount) || 0;
        debt = money(body.debt) || Number(note.debt) || 0;
      } else {
        content = noteText.trim();
        amount = Number(note.amount) || 0;
        debt = money(body.debt) || Number(note.debt) || 0;
      }
      if (!content) return fail('Vui lòng nhập nội dung!');
      const row = changes.note(note);
      Object.assign(row, { note_type: type, content, amount, debt, paid_debt: Math.min(Number(note.paid_debt) || 0, debt) });
      try {
        await changes.commit(db);
      } catch (error) {
        await removeReceiptImages(storage, addedPhotos);
        throw error;
      }
      // Bill của dòng vừa xoá (không dòng nào còn dùng) thì xoá ảnh.
      const kept = new Set(notePhotos({ content }));
      await removeReceiptImages(storage, notePhotos(note).filter(p => !kept.has(p)));
      return NextResponse.json({ ok: true, note: await fresh(db, note.id) }, { headers });
    }

    return fail('Thao tác không hợp lệ.');
  } catch (error) {
    if (error?.changed) return fail('Phiếu vừa được cập nhật (có thể do bấm 2 lần hoặc máy khác). Tải lại rồi thử lại.', 409);
    console.error('[notes] POST', error);
    return fail('Không lưu được, thử lại.', 500);
  }
}
