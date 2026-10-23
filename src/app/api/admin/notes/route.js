/**
 * /api/admin/notes — Sổ tay: ghi / sửa / trả nợ / xoá phiếu qua máy chủ.
 *
 * Máy chủ tự tính tiền của phiếu từ các dòng hàng (notesMath), lấy người ghi
 * từ phiên đăng nhập, giờ theo máy chủ, tự ghi lịch sử chỉnh sửa và ghi riêng
 * từng lần trả nợ (staff_note_payments). Số "đã trả nợ" của từng dòng luôn lấy
 * từ dữ liệu đang lưu, không tin số trình duyệt gửi lên. Mọi thay đổi còn được
 * trigger trong DB ghi vào staff_data_audit.
 *
 * GET  → { notes (kèm staff), payments }  (admin: tất cả; nhân viên: của mình)
 * POST {action}: create, edit, pay_item, delete (admin)
 */
import { NextResponse } from 'next/server';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';
import { noteTotals, parsePrice, parseQty } from '@/lib/notesMath.mjs';

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
function diffItems(oldItems, newItems, oldText, newText) {
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
    if (d.length) lines.push(`✏️ Sửa ${n.name}: ${d.join(', ')}`);
  });
  const newIds = new Set(newItems.map(n => n._id));
  oldItems.forEach((o, idx) => { if (!newIds.has(o._id || `#${idx}`)) lines.push(`🗑️ Xóa: ${o.name}`); });
  if ((oldText || '') !== (newText || '')) lines.push(`📝 Ghi chú thêm: "${newText || '(xóa)'}"`);
  return lines;
}

const parseContent = content => { try { const d = JSON.parse(content); return d && typeof d === 'object' ? d : null; } catch { return null; } };

/** Trả nợ cho một dòng của phiếu: cập nhật dòng, lịch sử, số đã trả, ghi sổ trả nợ. */
async function applyPayment(db, note, itemIndex, amount, { user, fromNoteId, logText }) {
  const data = parseContent(note.content);
  const ts = stamp();
  const item = data?.type === 'structured_expense' && Array.isArray(data.items) && itemIndex !== null ? data.items[itemIndex] : null;
  if (item) {
    item.paid_amount = (Number(item.paid_amount) || 0) + amount;
    if (item.paid_amount >= debtBase(item)) item.paymentStatus = 'full';
    item.payment_logs = [...(item.payment_logs || []), { amount, ts }];
  }
  if (data) data.history = [...(data.history || []), { ts, by: user.full_name || 'Không rõ', changes: logText(item || { name: '' }) }];
  const paidDebt = Math.min(Number(note.debt) || 0, (Number(note.paid_debt) || 0) + amount);
  const content = data ? JSON.stringify(data) : `${note.content || ''}\n\n[${logText({ name: '' })}]`;
  const r = await db.from('staff_notes').update({ content, paid_debt: paidDebt }).eq('id', note.id);
  if (r.error) throw r.error;
  const p = await db.from('staff_note_payments').insert({ note_id: note.id, item_index: itemIndex, amount, paid_from_note_id: fromNoteId || null, staff_id: user.id, created_by_name: user.full_name || null });
  if (p.error) console.error('[notes] payment log', p.error);
  return { ...note, content, paid_debt: paidDebt };
}

/** Các dòng còn nợ của một phiếu (theo thứ tự dòng). */
function openDebts(note) {
  const data = parseContent(note.content);
  if (data?.type !== 'structured_expense' || !Array.isArray(data.items)) return [];
  return data.items.map((item, idx) => {
    if (!String(item?.name || '').trim()) return null;
    const wasDebt = item.paymentStatus === 'debt' || Number(item.paid_amount) > 0;
    const left = wasDebt ? debtBase(item) - (Number(item.paid_amount) || 0) : 0;
    return left > 0 ? { idx, left } : null;
  }).filter(Boolean);
}

export async function GET(request) {
  try {
    const s = await getStaffSession(request);
    if (s.code !== 200) return fail(s.code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập.', s.code);
    const db = staffDatabase(s.user.id);
    let q = db.from('staff_notes').select('*, staff ( full_name, phone )').order('created_at', { ascending: false });
    if (s.user.role !== 'admin') q = q.eq('staff_id', s.user.id);
    const { data: notes, error } = await q;
    if (error) throw error;
    let payments = [];
    const p = await db.from('staff_note_payments').select('id, note_id, item_index, amount, paid_at, paid_from_note_id, created_by_name').order('paid_at');
    if (!p.error) {
      const ids = new Set((notes || []).map(n => n.id));
      payments = (p.data || []).filter(x => ids.has(x.note_id) || ids.has(x.paid_from_note_id));
    }
    return NextResponse.json({ notes: notes || [], payments }, { headers });
  } catch (error) {
    console.error('[notes] GET', error);
    return fail('Không tải được Sổ tay, thử lại.', 500);
  }
}

export async function POST(request) {
  try {
    const s = await getStaffSession(request);
    if (s.code !== 200) return fail(s.code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập.', s.code);
    const user = s.user, isAdmin = user.role === 'admin';
    const db = staffDatabase(user.id);
    const body = await request.json().catch(() => ({}));

    if (body.action === 'create') {
      const type = TYPES.includes(body.note_type) ? body.note_type : 'other';
      const items = type === 'expense' ? cleanItems(body.items) : [];
      const noteText = str(body.note, 4000);
      const payOld = money(body.pay_old_debt);
      // Nợ cũ của chính người ghi.
      const { data: mine, error: mineErr } = await db.from('staff_notes').select('*').eq('staff_id', user.id).order('created_at');
      if (mineErr) throw mineErr;
      const oldDebt = (mine || []).reduce((a, n) => a + Math.max(0, (n.debt || 0) - (n.paid_debt || 0)), 0);
      if (payOld > oldDebt) return fail('Số tiền trả nợ không được vượt quá tổng nợ cũ!');
      const notice = payOld > 0 ? `[💰 Đã trả nợ cũ: ${vnd(payOld)}. Nợ cũ còn lại: ${vnd(oldDebt - payOld)}]` : '';
      let content, amount = 0, debt = 0;
      if (items.length) {
        const t = noteTotals(items);
        amount = t.paid; debt = t.debt;
        content = JSON.stringify({ type: 'structured_expense', items, note: [noteText, notice].filter(Boolean).join('\n\n'),
          input_amount: money(body.input_amount) });
      } else {
        content = [noteText.trim(), notice].filter(Boolean).join('\n\n');
      }
      if (!content) return fail('Vui lòng nhập nội dung!');
      const { data: created, error } = await db.from('staff_notes')
        .insert({ staff_id: user.id, note_type: type, content, amount, debt, status: 'approved' }).select('*').single();
      if (error) throw error;
      // Chỉ trừ nợ cũ sau khi phiếu mới đã lưu (trước đây trừ trước, mất mạng là lệch).
      let left = payOld;
      for (const old of (mine || []).filter(n => (n.debt || 0) - (n.paid_debt || 0) > 0)) {
        if (left <= 0) break;
        let current = old;
        const lines = openDebts(current);
        let noteLeft = Math.min((old.debt || 0) - (old.paid_debt || 0), left);
        if (!lines.length) {
          // Phiếu cũ không có dòng hàng: trả cả phiếu.
          const pay = noteLeft;
          await applyPayment(db, current, null, pay, { user, fromNoteId: created.id, logText: () => `💰 Khấu trừ ${vnd(pay)} (qua báo cáo mới)` });
          left -= pay;
          continue;
        }
        for (const line of lines) {
          if (noteLeft <= 0) break;
          const pay = Math.min(line.left, noteLeft);
          current = await applyPayment(db, current, line.idx, pay, { user, fromNoteId: created.id,
            logText: item => `💰 Khấu trừ ${vnd(pay)} cho "${item.name}" (qua báo cáo mới)${item.paymentStatus === 'full' ? ' — ✅ Đã trả đủ' : ''}` });
          noteLeft -= pay; left -= pay;
        }
      }
      return NextResponse.json({ ok: true, note: created }, { headers });
    }

    if (!UUID.test(body.id || '')) return fail('Thiếu phiếu.');
    const { data: note, error: noteErr } = await db.from('staff_notes').select('*').eq('id', body.id).maybeSingle();
    if (noteErr) throw noteErr;
    if (!note) return fail('Không tìm thấy phiếu.', 404);
    const own = note.staff_id === user.id;
    if (!isAdmin && !own) return fail('Không phải phiếu của bạn.', 403);

    if (body.action === 'delete') {
      if (!isAdmin) return fail('Chỉ admin được xoá phiếu.', 403);
      const r = await db.from('staff_notes').delete().eq('id', note.id);
      if (r.error) throw r.error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'pay_item') {
      const idx = Number(body.item_index), amount = money(body.amount);
      const line = openDebts(note).find(l => l.idx === idx);
      if (!line) return fail('Dòng này không còn nợ.');
      if (!amount || amount > line.left) return fail('Số tiền không hợp lệ!');
      const updated = await applyPayment(db, note, idx, amount, { user, logText: item => `💰 Trả nợ ${vnd(amount)} cho "${item.name}"` });
      return NextResponse.json({ ok: true, note: updated }, { headers });
    }

    if (body.action === 'edit') {
      // Nhân viên chỉ sửa phiếu của mình trong ngày ghi; admin sửa được mọi phiếu (có nhật ký).
      if (!isAdmin && vnDay(note.created_at) !== vnDay(new Date().toISOString())) return fail('Chỉ sửa được phiếu trong ngày ghi.', 403);
      const type = TYPES.includes(body.note_type) ? body.note_type : note.note_type;
      const stored = parseContent(note.content);
      const storedItems = stored?.type === 'structured_expense' && Array.isArray(stored.items) ? stored.items : [];
      const items = type === 'expense' ? cleanItems(body.items, storedItems) : [];
      const noteText = str(body.note, 4000);
      const ts = stamp(), by = user.full_name || 'Không rõ';
      let content, amount = 0, debt = 0;
      if (items.length) {
        const lines = diffItems(storedItems, items, stored?.note || '', noteText);
        const t = noteTotals(items);
        amount = t.paid; debt = t.debt;
        const before = (Number(note.amount) || 0) + (Number(note.debt) || 0);
        if (Math.abs(before - (amount + debt)) >= 1) lines.push(`💲 Tổng phiếu: ${vnd(before)} → ${vnd(amount + debt)}`);
        const inputAmount = money(body.input_amount);
        content = JSON.stringify({ type: 'structured_expense', items, note: noteText, ...(inputAmount > 0 ? { input_amount: inputAmount } : {}),
          history: [...(stored?.history || []), { ts, by, changes: lines.length ? lines.join('\n') : '✏️ Cập nhật ghi chú' }] });
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
      const paidDebt = Math.min(Number(note.paid_debt) || 0, debt);
      const { data: saved, error } = await db.from('staff_notes')
        .update({ note_type: type, content, amount, debt, paid_debt: paidDebt, updated_at: new Date().toISOString() })
        .eq('id', note.id).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, note: saved }, { headers });
    }

    return fail('Thao tác không hợp lệ.');
  } catch (error) {
    console.error('[notes] POST', error);
    return fail('Không lưu được, thử lại.', 500);
  }
}
