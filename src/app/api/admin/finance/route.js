/**
 * /api/admin/finance — Sổ thu chi của chủ quán (chỉ admin).
 *
 * GET ?month=YYYY-MM  → doanh thu thật từng ngày (finance_revenue_ledger),
 *                       tiền đi chợ trong Sổ tay, nước ngọt, lương, chi cố định.
 * GET ?date=YYYY-MM-DD → chi tiết 1 ngày: từng bill + từng phiếu Sổ tay.
 * POST {action:'add'|'delete'} → thêm/xoá khoản tự nhập (nước ngọt, lương, cố định).
 *
 * Chạy bằng service role vì 2 bảng sổ thu chi đã chặn anon. Không liên quan
 * tới /admin/stats.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, statusDatabase } from '@/lib/statusAuth';
import { FINANCE_START_DATE, FIXED_CATEGORIES, isMonthKey, monthBounds, noteCost, summarizeMonth, vnDate, vnDayStartIso } from '@/lib/ownerFinance.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const missingTable = error => ['PGRST205', '42P01'].includes(error?.code);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['drink', 'salary', 'fixed'];

async function requireOwner(request) {
  const session = await getStaffSession(request);
  if (session.code !== 200) return { code: session.code };
  return session.user.role === 'admin' ? session : { code: 403 };
}

function deny(code) {
  const error = code === 503 ? 'Không kiểm tra được quyền admin.' : 'Chỉ admin được xem sổ thu chi.';
  return NextResponse.json({ error }, { status: code, headers });
}

// PostgREST trả tối đa 1000 dòng mỗi lần → đọc theo trang cho đủ cả tháng.
async function readAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

function parseNoteItems(note) {
  try {
    if (!note.content?.includes('structured_expense')) return null;
    const data = JSON.parse(note.content);
    // Bỏ các dòng mẫu chưa điền giá ("Tiền rau", "Tiền gia vị"...).
    return (data.items || []).filter(i => i.name && String(i.price || '').trim()).map(i => ({
      name: i.name, qty: i.qty || '', price: i.price || '', paymentStatus: i.paymentStatus || 'full', creditor: i.creditor || '',
    }));
  } catch { return null; }
}

function noteView(note) {
  const items = parseNoteItems(note);
  let text = note.content || '';
  if (items) { try { text = JSON.parse(note.content).note || ''; } catch { text = ''; } }
  return { id: note.id, createdAt: note.created_at, staffName: note.staff?.full_name || '', cost: noteCost(note),
    paid: Number(note.amount) || 0, debt: Number(note.debt) || 0,
    debtLeft: Math.max(0, (Number(note.debt) || 0) - (Number(note.paid_debt) || 0)), items, text: text.slice(0, 500) };
}

const notesBetween = (db, fromIso, toIso) => readAll(() => db.from('staff_notes')
  .select('id, created_at, note_type, amount, debt, paid_debt, content, staff ( full_name )')
  .eq('note_type', 'expense').gte('created_at', fromIso).lt('created_at', toIso)
  .order('created_at', { ascending: true }));

export async function GET(request) {
  try {
    const session = await requireOwner(request);
    if (session.code !== 200) return deny(session.code);
    const params = new URL(request.url).searchParams;
    const db = statusDatabase();
    const today = vnDate(Date.now());

    const date = params.get('date');
    if (date) {
      if (!DATE.test(date)) return NextResponse.json({ error: 'Ngày không hợp lệ.' }, { status: 400, headers });
      const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const [bills, notes, entries] = await Promise.all([
        readAll(() => db.from('finance_revenue_ledger')
          .select('order_id, paid_at, table_number, customer_name, payment_method, account_id, amount, items')
          .eq('business_date', date).order('paid_at', { ascending: true })),
        notesBetween(db, vnDayStartIso(date), vnDayStartIso(nextDay)),
        db.from('finance_entries').select('*').eq('entry_date', date).order('created_at').then(r => { if (r.error) throw r.error; return r.data || []; }),
      ]);
      return NextResponse.json({ date, bills, notes: notes.map(noteView).filter(n => n.cost > 0), entries }, { headers });
    }

    const month = params.get('month') || today.slice(0, 7);
    if (!isMonthKey(month)) return NextResponse.json({ error: 'Tháng không hợp lệ.' }, { status: 400, headers });
    const { start, next } = monthBounds(month);
    let revenue;
    try {
      revenue = await readAll(() => db.from('finance_revenue_ledger')
        .select('order_id, business_date, amount, payment_method, account_id')
        .gte('business_date', start).lt('business_date', next).order('order_id'));
    } catch (error) {
      if (missingTable(error)) return NextResponse.json({ error: 'Chưa cài bảng sổ thu chi trên cơ sở dữ liệu (owner_finance.sql).', setupMissing: true }, { status: 503, headers });
      throw error;
    }
    const [notes, entriesResult, accountsResult, staffResult] = await Promise.all([
      notesBetween(db, vnDayStartIso(start), vnDayStartIso(next)),
      db.from('finance_entries').select('*').gte('entry_date', start).lt('entry_date', next).order('entry_date').order('created_at'),
      db.from('bank_accounts').select('id, account_name, bank_name, account_number').order('sort_order'),
      db.from('staff').select('id, full_name').order('full_name'),
    ]);
    for (const result of [entriesResult, accountsResult, staffResult]) if (result.error) throw result.error;
    const entries = entriesResult.data || [];
    const summary = summarizeMonth({ month, revenue, notes, entries, today });
    return NextResponse.json({
      ...summary, today, startDate: FINANCE_START_DATE, fixedCategories: FIXED_CATEGORIES,
      entries: entries.filter(e => e.kind !== 'fixed'),
      accounts: (accountsResult.data || []).map(a => ({ id: a.id, name: [a.bank_name, a.account_name].filter(Boolean).join(' · ') || 'Tài khoản', last4: String(a.account_number || '').slice(-4) })),
      staff: (staffResult.data || []).map(s => s.full_name).filter(Boolean),
    }, { headers });
  } catch (error) {
    console.error('[admin/finance] GET', error);
    return NextResponse.json({ error: 'Không đọc được sổ thu chi.' }, { status: 500, headers });
  }
}

export async function POST(request) {
  try {
    const session = await requireOwner(request);
    if (session.code !== 200) return deny(session.code);
    const body = await request.json().catch(() => ({}));
    const db = statusDatabase();

    if (body.action === 'delete') {
      if (typeof body.id !== 'string' || !/^[\da-f-]{36}$/i.test(body.id)) return NextResponse.json({ error: 'Thiếu mã khoản chi.' }, { status: 400, headers });
      const { error } = await db.from('finance_entries').delete().eq('id', body.id);
      if (error) throw error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action !== 'add') return NextResponse.json({ error: 'Thao tác không hợp lệ.' }, { status: 400, headers });
    const kind = body.kind;
    const amount = Math.round(Number(body.amount));
    let entryDate = String(body.entry_date || '');
    let label = String(body.label || '').trim().slice(0, 120);
    let category = null;
    if (!KINDS.includes(kind)) return NextResponse.json({ error: 'Loại khoản chi không hợp lệ.' }, { status: 400, headers });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000_000) return NextResponse.json({ error: 'Số tiền không hợp lệ.' }, { status: 400, headers });
    if (kind === 'fixed') {
      if (!isMonthKey(body.month)) return NextResponse.json({ error: 'Tháng không hợp lệ.' }, { status: 400, headers });
      const cat = FIXED_CATEGORIES.find(c => c.key === body.category);
      if (!cat) return NextResponse.json({ error: 'Chọn loại chi cố định.' }, { status: 400, headers });
      entryDate = monthBounds(body.month).start;
      category = cat.key;
      label = label || cat.label;
    } else if (!DATE.test(entryDate)) {
      return NextResponse.json({ error: 'Ngày không hợp lệ.' }, { status: 400, headers });
    }
    if (!label) return NextResponse.json({ error: kind === 'salary' ? 'Nhập tên nhân viên.' : 'Nhập nội dung.' }, { status: 400, headers });
    const { data, error } = await db.from('finance_entries').insert({
      entry_date: entryDate, kind, category, label, amount,
      note: String(body.note || '').trim().slice(0, 300) || null,
      created_by_name: session.user.full_name || null,
    }).select('*').single();
    if (error) {
      if (missingTable(error)) return NextResponse.json({ error: 'Chưa cài bảng sổ thu chi trên cơ sở dữ liệu (owner_finance.sql).' }, { status: 503, headers });
      throw error;
    }
    return NextResponse.json({ ok: true, entry: data }, { headers });
  } catch (error) {
    console.error('[admin/finance] POST', error);
    return NextResponse.json({ error: 'Không lưu được, thử lại.' }, { status: 500, headers });
  }
}
