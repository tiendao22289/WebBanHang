/**
 * /api/admin/finance — Sổ thu chi của chủ quán (chỉ admin).
 *
 * GET ?month=YYYY-MM  → doanh thu thật từng ngày (finance_revenue_ledger),
 *                       tiền đi chợ trong Sổ tay, nước ngọt, lương, chi cố định.
 * GET ?date=YYYY-MM-DD → chi tiết 1 ngày: từng bill + từng phiếu Sổ tay.
 * POST {action:'add'|'delete'} → thêm/xoá khoản tự nhập (nước ngọt, lương, cố định).
 * POST {action:'close'}       → chốt sổ ngày (tiền mặt đếm được, tiền thật từng tài khoản).
 * POST {action:'copy_fixed'}  → chép chi cố định của tháng trước sang tháng đang xem.
 *
 * Chạy bằng service role vì các bảng sổ thu chi đã chặn anon. Không liên quan
 * tới /admin/stats.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, statusDatabase } from '@/lib/statusAuth';
import { FINANCE_START_DATE, FIXED_CATEGORIES, closeDifferences, isMonthKey, monthBounds, noteCost, suspiciousNoteItems, summarizeMonth, vnDate, vnDayStartIso } from '@/lib/ownerFinance.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const missingTable = error => ['PGRST205', '42P01'].includes(error?.code);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['drink', 'salary', 'fixed', 'custom'];
const CATEGORY_SCOPES = ['salary', 'fixed', 'tab'];
const MAX_CATEGORIES_PER_SCOPE = 30;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const MAX_AMOUNT = 10_000_000_000;

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
    suspicious: suspiciousNoteItems(items).map(i => `${i.name}: ${i.price}`),
    paid: Number(note.amount) || 0, debt: Number(note.debt) || 0,
    debtLeft: Math.max(0, (Number(note.debt) || 0) - (Number(note.paid_debt) || 0)), items, text: text.slice(0, 500) };
}

const notesBetween = (db, fromIso, toIso) => readAll(() => db.from('staff_notes')
  .select('id, created_at, note_type, amount, debt, paid_debt, content, staff ( full_name )')
  .eq('note_type', 'expense').gte('created_at', fromIso).lt('created_at', toIso)
  .order('created_at', { ascending: true }));

// Mục / tab tự đặt (kể cả đã ẩn, để khoản cũ vẫn có tên). Chưa cài bảng → [].
const readCategories = db => db.from('finance_categories').select('*').order('created_at')
  .then(r => { if (r.error) { if (missingTable(r.error)) return []; throw r.error; } return r.data || []; });

const readClose = (db, date) => db.from('finance_day_closes').select('*').eq('business_date', date).maybeSingle()
  .then(r => { if (r.error && !missingTable(r.error)) throw r.error; return r.data || null; });

/**
 * Bill đã thanh toán (còn trong lịch sử bàn 10 giờ) mà chưa có trong sổ.
 * Chỉ xét bill thanh toán SAU dòng sổ đầu tiên — trước lúc cài sổ thì đương
 * nhiên chưa có, không phải lỗi. Lịch sử bàn không có thì bỏ qua.
 */
async function findMissingBills(db) {
  const first = await db.from('finance_revenue_ledger').select('recorded_at').order('recorded_at', { ascending: true }).limit(1);
  if (first.error) throw first.error;
  const since = first.data?.[0]?.recorded_at;
  if (!since) return [];
  const history = await db.from('table_bill_history').select('order_id, paid_at, snapshot')
    .gt('expires_at', new Date().toISOString()).gte('paid_at', since).order('paid_at', { ascending: true });
  if (history.error) { if (missingTable(history.error)) return []; throw history.error; }
  const rows = history.data || [];
  if (!rows.length) return [];
  const recorded = await db.from('finance_revenue_ledger').select('order_id').in('order_id', rows.map(r => r.order_id));
  if (recorded.error) throw recorded.error;
  const have = new Set((recorded.data || []).map(r => r.order_id));
  return rows.filter(r => !have.has(r.order_id)).map(r => ({
    orderId: r.order_id, paidAt: r.paid_at, tableNumber: r.snapshot?.table_number ?? null,
    customerName: r.snapshot?.customer_name || null, paymentMethod: r.snapshot?.payment_method || null,
    amount: Math.max(0, (r.snapshot?.order_items || []).reduce((sum, i) => sum + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0)),
  }));
}

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
      const [bills, notes, entries, close] = await Promise.all([
        readAll(() => db.from('finance_revenue_ledger')
          .select('order_id, paid_at, table_number, customer_name, payment_method, account_id, amount, items')
          .eq('business_date', date).order('paid_at', { ascending: true })),
        notesBetween(db, vnDayStartIso(date), vnDayStartIso(nextDay)),
        db.from('finance_entries').select('*').eq('entry_date', date).order('created_at').then(r => { if (r.error) throw r.error; return r.data || []; }),
        readClose(db, date),
      ]);
      const day = { cash: 0, byAccount: {} };
      for (const bill of bills) {
        const amount = Number(bill.amount) || 0;
        if (bill.payment_method !== 'transfer') { day.cash += amount; continue; }
        const key = bill.account_id || 'unknown';
        day.byAccount[key] = (day.byAccount[key] || 0) + amount;
      }
      return NextResponse.json({ date, today, startDate: FINANCE_START_DATE, bills,
        notes: notes.map(noteView).filter(n => n.cost > 0), entries,
        close, closeDiff: closeDifferences(day, close), dayCash: day.cash, dayByAccount: day.byAccount }, { headers });
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
    const [notes, entriesResult, accountsResult, staffResult, closesResult, missingBills, categories] = await Promise.all([
      notesBetween(db, vnDayStartIso(start), vnDayStartIso(next)),
      db.from('finance_entries').select('*').gte('entry_date', start).lt('entry_date', next).order('entry_date').order('created_at'),
      db.from('bank_accounts').select('id, account_name, bank_name, account_number').order('sort_order'),
      db.from('staff').select('id, full_name').order('full_name'),
      db.from('finance_day_closes').select('*').gte('business_date', start).lt('business_date', next),
      findMissingBills(db).catch(error => { console.error('[admin/finance] missing bills', error); return null; }),
      readCategories(db),
    ]);
    for (const result of [entriesResult, accountsResult, staffResult]) if (result.error) throw result.error;
    if (closesResult.error && !missingTable(closesResult.error)) throw closesResult.error;
    const entries = entriesResult.data || [];
    const summary = summarizeMonth({ month, revenue, notes, entries, closes: closesResult.data || [], categories, today });
    const monthlyTabs = new Set(categories.filter(c => c.scope === 'tab' && c.schedule === 'monthly').map(c => c.id));
    return NextResponse.json({
      ...summary, today, startDate: FINANCE_START_DATE, fixedCategories: FIXED_CATEGORIES, categories,
      entries: entries.filter(e => e.kind !== 'fixed'),
      // Khoản của tab nhập theo tháng — liệt kê riêng như chi cố định.
      customMonthlyEntries: entries.filter(e => e.kind === 'custom' && monthlyTabs.has(e.category)),
      accounts: (accountsResult.data || []).map(a => ({ id: a.id, name: [a.bank_name, a.account_name].filter(Boolean).join(' · ') || 'Tài khoản', last4: String(a.account_number || '').slice(-4) })),
      staff: (staffResult.data || []).map(s => s.full_name).filter(Boolean),
      // null = không kiểm tra được (khác với [] = đã kiểm, không thiếu bill nào).
      missingBills,
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
      if (typeof body.id !== 'string' || !UUID.test(body.id)) return NextResponse.json({ error: 'Thiếu mã khoản chi.' }, { status: 400, headers });
      const { error } = await db.from('finance_entries').delete().eq('id', body.id);
      if (error) throw error;
      return NextResponse.json({ ok: true }, { headers });
    }

    if (body.action === 'close') {
      const date = String(body.date || '');
      if (!DATE.test(date) || date < FINANCE_START_DATE || date > vnDate(Date.now())) {
        return NextResponse.json({ error: 'Ngày chốt sổ không hợp lệ.' }, { status: 400, headers });
      }
      // '' / null = chưa nhập ô đó; NaN = nhập sai.
      const money = value => {
        if (value === null || value === undefined || value === '') return null;
        const n = Math.round(Number(value));
        return Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT ? n : NaN;
      };
      const cash = money(body.cash_counted);
      if (Number.isNaN(cash)) return NextResponse.json({ error: 'Tiền mặt không hợp lệ.' }, { status: 400, headers });
      const bank = {};
      const input = body.bank_counted && typeof body.bank_counted === 'object' ? body.bank_counted : {};
      for (const [acc, value] of Object.entries(input)) {
        if (!UUID.test(acc)) return NextResponse.json({ error: 'Tài khoản không hợp lệ.' }, { status: 400, headers });
        const amount = money(value);
        if (Number.isNaN(amount)) return NextResponse.json({ error: 'Số tiền tài khoản không hợp lệ.' }, { status: 400, headers });
        if (amount !== null) bank[acc] = amount;
      }
      if (cash === null && !Object.keys(bank).length) {
        return NextResponse.json({ error: 'Nhập tiền mặt đếm được hoặc tiền của một tài khoản.' }, { status: 400, headers });
      }
      const { data, error } = await db.from('finance_day_closes').upsert({
        business_date: date, cash_counted: cash, bank_counted: bank,
        note: String(body.note || '').trim().slice(0, 300) || null,
        closed_by_name: session.user.full_name || null, closed_at: new Date().toISOString(),
      }, { onConflict: 'business_date' }).select('*').single();
      if (error) {
        if (missingTable(error)) return NextResponse.json({ error: 'Chưa cài bảng chốt sổ trên cơ sở dữ liệu (owner_finance.sql).' }, { status: 503, headers });
        throw error;
      }
      return NextResponse.json({ ok: true, close: data }, { headers });
    }

    if (body.action === 'copy_fixed') {
      if (!isMonthKey(body.month)) return NextResponse.json({ error: 'Tháng không hợp lệ.' }, { status: 400, headers });
      const { start, next } = monthBounds(body.month);
      const prevMonth = new Date(Date.parse(`${start}T00:00:00Z`) - 86400000).toISOString().slice(0, 7);
      const prev = monthBounds(prevMonth);
      const [current, previous] = await Promise.all([
        db.from('finance_entries').select('id').eq('kind', 'fixed').gte('entry_date', start).lt('entry_date', next),
        db.from('finance_entries').select('category, label, amount, note').eq('kind', 'fixed')
          .gte('entry_date', prev.start).lt('entry_date', prev.next).order('created_at'),
      ]);
      for (const result of [current, previous]) if (result.error) throw result.error;
      if (current.data?.length) return NextResponse.json({ error: 'Tháng này đã có chi cố định, không chép đè.' }, { status: 409, headers });
      if (!previous.data?.length) {
        return NextResponse.json({ error: `Tháng ${prevMonth.slice(5)}/${prevMonth.slice(0, 4)} chưa có chi cố định để chép.` }, { status: 400, headers });
      }
      const { data, error } = await db.from('finance_entries').insert(previous.data.map(e => ({
        entry_date: start, kind: 'fixed', category: e.category, label: e.label, amount: e.amount, note: e.note,
        created_by_name: session.user.full_name || null,
      }))).select('*');
      if (error) throw error;
      return NextResponse.json({ ok: true, entries: data }, { headers });
    }

    if (body.action === 'add_category') {
      const scope = body.scope;
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const schedule = scope === 'tab' && body.schedule === 'monthly' ? 'monthly' : 'daily';
      if (!CATEGORY_SCOPES.includes(scope)) return NextResponse.json({ error: 'Loại mục không hợp lệ.' }, { status: 400, headers });
      if (!name) return NextResponse.json({ error: scope === 'tab' ? 'Nhập tên tab.' : 'Nhập tên mục.' }, { status: 400, headers });
      const active = (await readCategories(db)).filter(c => c.scope === scope && !c.archived);
      const builtIn = scope === 'fixed' ? FIXED_CATEGORIES.map(c => c.label)
        : scope === 'tab' ? ['Nước ngọt / bia', 'Lương', 'Chi cố định'] : ['Lương'];
      if ([...builtIn, ...active.map(c => c.name)].some(n => n.toLowerCase() === name.toLowerCase())) {
        return NextResponse.json({ error: `"${name}" đã có rồi.` }, { status: 409, headers });
      }
      if (active.length >= MAX_CATEGORIES_PER_SCOPE) return NextResponse.json({ error: 'Đã đủ số mục tối đa, ẩn bớt mục cũ trước.' }, { status: 400, headers });
      const { data, error } = await db.from('finance_categories').insert({
        scope, name, schedule, created_by_name: session.user.full_name || null,
      }).select('*').single();
      if (error) {
        if (missingTable(error)) return NextResponse.json({ error: 'Chưa cài bảng mục chi trên cơ sở dữ liệu (owner_finance.sql).' }, { status: 503, headers });
        throw error;
      }
      return NextResponse.json({ ok: true, category: data }, { headers });
    }

    if (body.action === 'archive_category') {
      if (typeof body.id !== 'string' || !UUID.test(body.id)) return NextResponse.json({ error: 'Thiếu mã mục.' }, { status: 400, headers });
      const { error } = await db.from('finance_categories').update({ archived: true }).eq('id', body.id);
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
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return NextResponse.json({ error: 'Số tiền không hợp lệ.' }, { status: 400, headers });
    // Mục tự đặt còn đang dùng (chưa ẩn) thuộc đúng nhóm.
    const ownCategory = async scope => {
      if (typeof body.category !== 'string' || !UUID.test(body.category)) return null;
      return (await readCategories(db)).find(c => c.id === body.category && c.scope === scope && !c.archived) || null;
    };
    let monthly = kind === 'fixed';
    if (kind === 'fixed') {
      const builtIn = FIXED_CATEGORIES.find(c => c.key === body.category);
      const own = builtIn ? null : await ownCategory('fixed');
      if (!builtIn && !own) return NextResponse.json({ error: 'Chọn mục chi cố định.' }, { status: 400, headers });
      category = builtIn ? builtIn.key : own.id;
      label = label || (builtIn ? builtIn.label : own.name);
    } else if (kind === 'salary' && body.category) {
      const own = await ownCategory('salary');
      if (!own) return NextResponse.json({ error: 'Loại lương không còn, chọn lại.' }, { status: 400, headers });
      category = own.id;
    } else if (kind === 'custom') {
      const tab = await ownCategory('tab');
      if (!tab) return NextResponse.json({ error: 'Tab này không còn, tải lại trang.' }, { status: 400, headers });
      category = tab.id;
      monthly = tab.schedule === 'monthly';
      label = label || tab.name;
    }
    if (monthly) {
      if (!isMonthKey(body.month)) return NextResponse.json({ error: 'Tháng không hợp lệ.' }, { status: 400, headers });
      entryDate = monthBounds(body.month).start;
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
