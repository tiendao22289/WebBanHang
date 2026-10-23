/**
 * /api/admin/finance — Sổ thu chi của chủ quán (chỉ admin).
 *
 * GET ?month=YYYY-MM  → doanh thu thật từng ngày (finance_revenue_ledger),
 *                       tiền đi chợ trong Sổ tay, nước ngọt, lương, chi cố định.
 * GET ?date=YYYY-MM-DD → chi tiết 1 ngày: từng bill + từng phiếu Sổ tay.
 * GET ?items=1&from&to → bán ra theo món, nhập vào theo hàng Sổ tay, gom theo nhóm.
 * POST {action:'save_item_group'|'delete_item_group'} → nhóm so bán / nhập.
 * POST {action:'add'|'delete'} → thêm/xoá khoản tự nhập (nước ngọt, lương, cố định).
 * POST {action:'close'}       → chốt sổ ngày (tiền mặt đếm được, tiền thật từng tài khoản).
 * POST {action:'copy_fixed'}  → chép chi cố định của tháng trước sang tháng đang xem.
 * POST {action:'verify'}      → đánh dấu bill chuyển khoản đã / chưa đối chiếu.
 * POST {action:'zalo_link_code'|'zalo_unlink'|'zalo_test'} → báo cáo Zalo hằng ngày.
 * POST {action:'daily_report'} + header x-finance-report-key → gửi báo cáo
 *      (workflow "Finance Daily Report" gọi lúc 8 giờ sáng, không cần đăng nhập).
 *
 * Chạy bằng service role vì các bảng sổ thu chi đã chặn anon. Không liên quan
 * tới /admin/stats.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sendOaText } from '@/lib/zaloOa';
import { notesReportMessages, packMessages } from '@/lib/notesReport.mjs';
import { compareBlock, lossBlock, staffBlock } from '@/lib/dailyInsights.mjs';
import { LINK_CODE_MINUTES, REPORT_SECTIONS, readReportSettings, reportPlan, reportSections, reportStatus, saveReportSettings, validSendAt } from '@/lib/financeZaloLink.mjs';
import { getStaffSession, statusDatabase } from '@/lib/statusAuth';
import { signReceiptImages } from '@/lib/receiptImages.mjs';
import { FINANCE_START_DATE, FIXED_CATEGORIES, closeDifferences, dailyReportText, isMonthKey, itemKey, summarizeItems, monthBounds, noteCost, noteLineWarnings, noteMismatch, suspiciousNoteItems, summarizeMonth, vnDate, vnDayStartIso } from '@/lib/ownerFinance.mjs';

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
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// Ảnh CK chỉ giữ 3 tháng — bill cũ hơn thì không còn "thiếu ảnh" để chụp bổ sung.
const photoKeepFrom = today => addDays(today, -90);

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
    // Tổng phiếu đã lưu khác tổng các dòng tính lại (lỗi cũ "2,5kg" → 25kg...); cảnh báo từng dòng.
    mismatch: noteMismatch(note), lineWarnings: noteLineWarnings(note),
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

// Bill giấy (nhập tay). Chưa cài bảng → [].
const readPaper = (db, from, to) => db.from('finance_manual_receipts').select('*')
  .gte('business_date', from).lt('business_date', to).order('received_at', { ascending: true })
  .then(r => { if (r.error) { if (missingTable(r.error)) return []; throw r.error; } return r.data || []; });

const readClose = (db, date) => db.from('finance_day_closes').select('*').eq('business_date', date).maybeSingle()
  .then(r => { if (r.error && !missingTable(r.error)) throw r.error; return r.data || null; });

/**
 * Bill đã thanh toán (còn trong lịch sử bàn 10 giờ) mà chưa có trong sổ,
 * tính từ ngày sổ bắt đầu — kể cả bill thu trước lúc cài bảng sổ trong ngày
 * đó, miễn lịch sử bàn còn giữ. Lịch sử bàn không có thì bỏ qua.
 */
async function findMissingBills(db) {
  const probe = await db.from('finance_revenue_ledger').select('order_id').limit(1);
  if (probe.error) throw probe.error; // chưa cài bảng sổ → báo lên trên
  const since = vnDayStartIso(FINANCE_START_DATE);
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
    snapshot: r.snapshot,
  }));
}

/**
 * Tự bổ sung vào sổ các bill đã thu mà trigger ghi sổ bỏ sót (lỗi hiếm), lấy
 * từ lịch sử bàn 10 giờ — để sổ không thiếu bill nào. Bỏ qua bill đã được
 * mở lại / huỷ sau khi thu (còn trong orders nhưng không còn 'paid'); bill đã
 * bị dọn khỏi orders thì vẫn bổ sung vì lịch sử bàn chỉ ghi lúc thanh toán.
 * Không đụng tới orders hay trang Thống kê.
 */
async function repairMissingBills(db) {
  const missing = await findMissingBills(db);
  if (!missing.length) return { recovered: [], unrecovered: [] };
  const ids = missing.map(m => m.orderId);
  const orders = await db.from('orders').select('id, status').in('id', ids);
  if (orders.error) throw orders.error;
  const statusById = new Map((orders.data || []).map(o => [o.id, o.status]));
  // Tài khoản nhận tiền: giao dịch QR của đúng bill (có thể đã bị dọn → để trống).
  const accountOf = async orderId => {
    const { data } = await db.from('payment_transactions').select('order_ids, account_id')
      .like('order_ids', `%${orderId}%`).in('status', ['pending', 'completed']);
    return (data || []).find(t => t.account_id && String(t.order_ids || '').split(',').includes(orderId))?.account_id || null;
  };
  const recovered = [], unrecovered = [];
  for (const bill of missing) {
    const status = statusById.get(bill.orderId);
    if (status && status !== 'paid') continue; // mở lại / huỷ sau khi thu → không phải doanh thu
    const items = (bill.snapshot?.order_items || []).map(i => ({
      name: i.item_name || i.menu_item?.name || null, quantity: i.quantity, unit_price: i.unit_price,
      options: i.item_options ?? null, is_gift: i.is_gift ?? null,
    }));
    const { error } = await db.from('finance_revenue_ledger').upsert({
      order_id: bill.orderId, paid_at: bill.paidAt, business_date: vnDate(bill.paidAt),
      table_number: bill.tableNumber === null ? null : String(bill.tableNumber), customer_name: bill.customerName,
      payment_method: bill.paymentMethod, account_id: bill.paymentMethod === 'transfer' ? await accountOf(bill.orderId) : null,
      amount: bill.amount, items,
    }, { onConflict: 'order_id', ignoreDuplicates: true });
    const view = { orderId: bill.orderId, paidAt: bill.paidAt, tableNumber: bill.tableNumber, customerName: bill.customerName, paymentMethod: bill.paymentMethod, amount: bill.amount };
    if (error) { console.error('[admin/finance] repair', error); unrecovered.push(view); } else recovered.push(view);
  }
  return { recovered, unrecovered };
}

// Bill chuyển khoản trong khoảng ngày: chưa có ảnh CK / chưa đối chiếu.
async function transferAlerts(db, from, to, today) {
  const keepFrom = photoKeepFrom(today);
  const [bills, paper] = await Promise.all([
    readAll(() => db.from('finance_revenue_ledger').select('order_id, business_date, transfer_image_path, verified_at')
      .eq('payment_method', 'transfer').gte('business_date', from).lt('business_date', addDays(to, 1)).order('order_id')),
    readAll(() => db.from('finance_manual_receipts').select('id, business_date, transfer_image_path, verified_at')
      .eq('payment_method', 'transfer').gte('business_date', from).lt('business_date', addDays(to, 1)).order('id'))
      .catch(error => { if (missingTable(error)) return []; throw error; }),
  ]);
  const rows = [...bills, ...paper];
  return {
    missingPhoto: rows.filter(r => !r.transfer_image_path && r.business_date >= keepFrom).length,
    unchecked: rows.filter(r => !r.verified_at).length,
  };
}

// Số liệu cả tháng (dùng cho trang Tổng quan và báo cáo Zalo).
async function loadMonth(db, month, today) {
  const { start, next } = monthBounds(month);
  const revenue = await readAll(() => db.from('finance_revenue_ledger')
    .select('order_id, business_date, amount, payment_method, account_id')
    .gte('business_date', start).lt('business_date', next).order('order_id'));
  const [notes, entriesResult, accountsResult, staffResult, closesResult, categories, paperBills] = await Promise.all([
    notesBetween(db, vnDayStartIso(start), vnDayStartIso(next)),
    db.from('finance_entries').select('*').gte('entry_date', start).lt('entry_date', next).order('entry_date').order('created_at'),
    db.from('bank_accounts').select('id, account_name, bank_name, account_number').order('sort_order'),
    db.from('staff').select('id, full_name').order('full_name'),
    db.from('finance_day_closes').select('*').gte('business_date', start).lt('business_date', next),
    readCategories(db),
    readPaper(db, start, next),
  ]);
  for (const result of [entriesResult, accountsResult, staffResult]) if (result.error) throw result.error;
  if (closesResult.error && !missingTable(closesResult.error)) throw closesResult.error;
  const entries = entriesResult.data || [];
  return {
    entries, categories,
    summary: summarizeMonth({ month, revenue, paperBills, notes, entries, closes: closesResult.data || [], categories, today }),
    accounts: (accountsResult.data || []).map(a => ({ id: a.id, name: [a.bank_name, a.account_name].filter(Boolean).join(' · ') || 'Tài khoản', last4: String(a.account_number || '').slice(-4) })),
    staff: (staffResult.data || []).map(s => s.full_name).filter(Boolean),
  };
}

// Workflow báo cáo trên máy chủ ký bằng khoá service role (không cần thêm bí mật mới).
function reportKeyOk(request) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const given = String(request.headers?.get?.('x-finance-report-key') || '');
  if (secret.length < 20 || !given) return false;
  const want = createHmac('sha256', secret).update('finance-daily-report').digest('hex');
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

const inChunks = (list, size = 150) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** Thất thoát / nhân viên / so sánh của một ngày (lỗi từng phần không chặn phần khác). */
async function insightBlocks(db, { date, range, sections }) {
  const blocks = [];
  const ledgerDay = await readAll(() => db.from('finance_revenue_ledger').select('order_id, table_number, paid_at, amount, items').eq('business_date', date).order('order_id'));
  const staffNames = Object.fromEntries(((await db.from('staff').select('id, full_name')).data || []).map(s => [s.id, s.full_name]));
  if (sections.loss) {
    try {
      const menu = (await db.from('menu_items').select('id, name, price')).data || [];
      const menuName = new Map(menu.map(m => [m.id, m.name]));
      const menuPrice = new Map(menu.map(m => [String(m.name || '').trim().toLowerCase(), Number(m.price) || 0]));
      const from = new Date(range.start.getTime() - 12 * 3600000).toISOString();
      const jobs = await readAll(() => db.from('print_jobs').select('id, order_id, order_ids, order_items_at_queue').gte('created_at', from).lt('created_at', range.end.toISOString()).order('id'));
      const printed = new Map();
      const printedIn = new Map();
      for (const job of jobs) {
        const snap = (job.order_items_at_queue || []).map(i => ({ ...i, name: i.item_name || menuName.get(i.menu_item_id) || 'Món' }));
        for (const orderId of new Set([job.order_id, ...(job.order_ids || [])].filter(Boolean))) {
          const own = snap.filter(i => !i.order_id || i.order_id === orderId);
          printed.set(orderId, [...(printed.get(orderId) || []), own]);
          for (const i of own) if (i.id) printedIn.set(i.id, orderId);
        }
      }
      // Món đang nằm ở bill khác (chuyển / gộp bàn) thì không phải bị bớt.
      const movedIds = new Set();
      for (const part of inChunks([...printedIn.keys()])) {
        const { data } = await db.from('order_items').select('id, order_id').in('id', part);
        for (const row of data || []) if (printedIn.get(row.id) && row.order_id !== printedIn.get(row.id)) movedIds.add(row.id);
      }
      const tables = new Map(((await db.from('tables').select('id, table_number')).data || []).map(t => [t.id, t.table_number]));
      const cancelledRows = ((await db.from('orders').select('id, table_id, total_amount, cancelled_by_name, cancelled_at, created_at').eq('status', 'cancelled')
        .gte('created_at', new Date(range.start.getTime() - 24 * 3600000).toISOString()).lt('created_at', range.end.toISOString())).data || [])
        .filter(o => { const t = new Date(o.cancelled_at || o.created_at).getTime(); return t >= range.start.getTime() && t < range.end.getTime(); })
        .map(o => ({ ...o, table_number: tables.get(o.table_id) }));
      blocks.push(lossBlock({ ledgerDay, printed, movedIds, cancelled: cancelledRows, menuPrice }));
    } catch (error) { console.error('[admin/finance] loss block', error); }
  }
  if (sections.staff) {
    try {
      const [sessions, pending] = await Promise.all([
        db.from('attendance_sessions').select('staff_id, clock_in, clock_out').eq('date', date).then(r => r.data || []),
        db.from('payroll_requests').select('staff_id, request_type, amount, days, reason').eq('status', 'pending').then(r => r.data || []),
      ]);
      blocks.push(staffBlock({ sessions, pending, staffNames }));
    } catch (error) { console.error('[admin/finance] staff block', error); }
  }
  if (sections.compare) {
    try {
      const revenueOf = async d => {
        if (d < FINANCE_START_DATE) return null;
        const [bills, paper] = await Promise.all([
          readAll(() => db.from('finance_revenue_ledger').select('order_id, amount').eq('business_date', d).order('order_id')),
          db.from('finance_manual_receipts').select('amount').eq('business_date', d).then(r => r.data || []),
        ]);
        return { revenue: [...bills, ...paper].reduce((a, x) => a + (Number(x.amount) || 0), 0), bills: bills.length + paper.length };
      };
      const [day, prev, week] = await Promise.all([revenueOf(date), revenueOf(addDays(date, -1)), revenueOf(addDays(date, -7))]);
      const weekdayLabel = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${date}T00:00:00Z`).getUTCDay()];
      blocks.push(compareBlock({ day: day || { revenue: 0, bills: 0 }, prev, week, weekdayLabel, ledgerDay }));
    } catch (error) { console.error('[admin/finance] compare block', error); }
  }
  return blocks;
}

/**
 * Gửi báo cáo một ngày tới các Zalo đã liên kết. scheduled = lần gửi tự động
 * buổi sáng: mỗi ngày chỉ gửi một lần.
 */
async function sendDailyReport(db, { date, today, scheduled }) {
  const settings = await readReportSettings(db);
  if (!settings) return { ok: false, error: 'Chưa cài bảng cài đặt sổ thu chi (owner_finance.sql).' };
  if (!settings.ownerIds.length) return { ok: false, error: 'Chưa liên kết Zalo nhận báo cáo.' };
  if (scheduled && settings.lastSentDate === date) return { ok: true, skipped: true };
  if (date < FINANCE_START_DATE) return { ok: false, error: 'Ngày này trước khi sổ bắt đầu.' };
  try { await repairMissingBills(db); } catch (error) { console.error('[admin/finance] repair', error); }
  const { summary, accounts } = await loadMonth(db, date.slice(0, 7), today);
  const day = summary.days.find(d => d.date === date);
  if (!day) return { ok: false, error: 'Không có số liệu ngày này.' };
  const upTo = summary.days.filter(d => d.date <= date);
  const monthTotals = { revenue: upTo.reduce((s, d) => s + d.revenue, 0), profit: upTo.reduce((s, d) => s + d.profit, 0) };
  const alerts = await transferAlerts(db, monthBounds(date.slice(0, 7)).start, date, today).catch(() => ({}));
  const text = dailyReportText({ day, monthTotals, accounts, alerts, title: scheduled ? 'Báo cáo' : 'Gửi thử' });
  // Các tin sau: thất thoát / nhân viên / so sánh, rồi Sổ tay của ngày (lỗi ở đây không chặn tin tổng kết).
  const sections = reportSections(settings);
  const range = { start: new Date(vnDayStartIso(date)), end: new Date(vnDayStartIso(addDays(date, 1))) };
  let insightMessages = [];
  try {
    const [, m, d] = date.split('-');
    insightMessages = packMessages(`📊 Chi tiết ${d}/${m}`, await insightBlocks(db, { date, range, sections }));
  } catch (error) { console.error('[admin/finance] insights', error); }
  let notesMessages = [];
  if (sections.notes) try {
    const [allNotes, payments, deleted, staff] = await Promise.all([
      readAll(() => db.from('staff_notes').select('id, staff_id, note_type, content, amount, debt, paid_debt, created_at, staff ( full_name )')
        .lt('created_at', range.end.toISOString()).order('created_at')),
      db.from('staff_note_payments').select('note_id, item_index, amount, paid_at, paid_from_note_id, created_by_name').then(r => (r.error ? [] : r.data || [])),
      // Phiếu bị xoá trong ngày (nhật ký trong DB).
      db.from('staff_data_audit').select('changed_at, old_row, staff_id').eq('table_name', 'staff_notes').eq('op', 'DELETE')
        .gte('changed_at', range.start.toISOString()).lt('changed_at', range.end.toISOString()).then(r => (r.error ? [] : r.data || [])),
      db.from('staff').select('id, full_name').then(r => (r.error ? [] : r.data || [])),
    ]);
    const dayNotes = allNotes.filter(n => new Date(n.created_at).getTime() >= range.start.getTime());
    const staffNames = Object.fromEntries(staff.map(x => [x.id, x.full_name]));
    notesMessages = notesReportMessages({ date, dayNotes, allNotes, payments, deleted, staffNames, range });
  } catch (error) { console.error('[admin/finance] notes report', error); }
  const results = [];
  for (const id of settings.ownerIds) {
    const first = await sendOaText(db, id, text).catch(error => ({ ok: false, detail: error.message }));
    results.push(first);
    if (!first.ok) continue;
    for (const message of [...insightMessages, ...notesMessages]) await sendOaText(db, id, message).catch(error => console.error('[admin/finance] report message', error));
  }
  const sent = results.filter(r => r.ok).length;
  const failed = results.find(r => !r.ok);
  const lastError = failed ? `${new Date().toISOString()} ${JSON.stringify(failed.detail ?? '')}`.slice(0, 300) : null;
  const latest = await readReportSettings(db);
  await saveReportSettings(db, { ...latest, lastSentAt: new Date().toISOString(), lastError, ...(scheduled && sent ? { lastSentDate: date } : {}) });
  return sent
    ? { ok: true, sent, total: results.length }
    : { ok: false, error: 'Zalo không gửi được. Mở Zalo, nhắn "ok" cho OA của quán rồi thử lại.' };
}

// Nhóm so bán ra / nhập vào (vd "Ốc hương"): finance_settings['item_groups'].
const MAX_ITEM_GROUPS = 60;
async function readItemGroups(db) {
  const { data, error } = await db.from('finance_settings').select('value').eq('key', 'item_groups').maybeSingle();
  if (error) { if (missingTable(error)) return null; throw error; }
  return Array.isArray(data?.value?.groups) ? data.value.groups : [];
}
async function saveItemGroups(db, groups) {
  const { error } = await db.from('finance_settings').upsert({ key: 'item_groups', value: { groups }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

export async function GET(request) {
  try {
    const session = await requireOwner(request);
    if (session.code !== 200) return deny(session.code);
    const params = new URL(request.url).searchParams;
    const db = statusDatabase();
    const today = vnDate(Date.now());

    // Bán ra theo món / nhập vào theo Sổ tay trong khoảng ngày.
    if (params.get('items')) {
      const to = DATE.test(params.get('to') || '') ? params.get('to') : today;
      const from = DATE.test(params.get('from') || '') ? params.get('from') : `${to.slice(0, 7)}-01`;
      if (from > to) return NextResponse.json({ error: 'Từ ngày phải trước đến ngày.' }, { status: 400, headers });
      if (addDays(from, 92) < to) return NextResponse.json({ error: 'Chỉ xem tối đa 3 tháng một lần.' }, { status: 400, headers });
      const start = from < FINANCE_START_DATE ? FINANCE_START_DATE : from;
      const next = addDays(to, 1);
      const [bills, paper, notes, drinks, groups] = await Promise.all([
        readAll(() => db.from('finance_revenue_ledger').select('order_id, items').gte('business_date', start).lt('business_date', next).order('order_id')),
        readPaper(db, start, next),
        notesBetween(db, vnDayStartIso(start), vnDayStartIso(next)),
        db.from('finance_entries').select('amount, label').eq('kind', 'drink').gte('entry_date', start).lt('entry_date', next)
          .then(r => { if (r.error) throw r.error; return r.data || []; }),
        readItemGroups(db),
      ]);
      const summary = summarizeItems({ bills, notes, drinks, groups: groups || [],
        paperRevenue: paper.reduce((s, p) => s + (Number(p.amount) || 0), 0) });
      return NextResponse.json({ from, to, ...summary, groupsReady: groups !== null }, { headers });
    }

    // Tra cứu bill (để đối chiếu ảnh chuyển khoản / ảnh bill giấy về sau).
    if (params.get('search')) {
      const to = DATE.test(params.get('to') || '') ? params.get('to') : today;
      const from = DATE.test(params.get('from') || '') ? params.get('from') : addDays(to, -6);
      if (from > to) return NextResponse.json({ error: 'Từ ngày phải trước đến ngày.' }, { status: 400, headers });
      if (addDays(from, 92) < to) return NextResponse.json({ error: 'Chỉ tra cứu tối đa 3 tháng một lần.' }, { status: 400, headers });
      const table = String(params.get('table') || '').trim().replace(/^b(àn)?\s*/i, '').slice(0, 20);
      const amount = Number(String(params.get('amount') || '').replace(/\D/g, '')) || null;
      const type = ['transfer', 'cash', 'paper'].includes(params.get('type')) ? params.get('type') : 'all';
      const onlyWithImage = params.get('image') === '1';
      // Bill CK chưa có ảnh (ảnh còn giữ được) — để chụp bổ sung.
      const missingImage = params.get('image') === 'missing';
      const account = UUID.test(params.get('account') || '') ? params.get('account') : null;
      const check = ['checked', 'unchecked'].includes(params.get('check')) ? params.get('check') : null;
      const keepFrom = photoKeepFrom(today);
      // Thẻ / thiếu ảnh / đối chiếu chỉ có nghĩa với bill chuyển khoản.
      const transferOnly = !!(account || missingImage || check);
      const LIMIT = 200;

      let bills = [];
      if (type !== 'paper') {
        let q = db.from('finance_revenue_ledger').select('order_id, paid_at, business_date, table_number, customer_name, payment_method, account_id, amount, items, transfer_image_path, verified_at, verified_by')
          .gte('business_date', from).lt('business_date', addDays(to, 1)).order('paid_at', { ascending: false }).limit(LIMIT);
        if (table) q = q.eq('table_number', table);
        if (amount) q = q.eq('amount', amount);
        if (type === 'transfer' || type === 'cash') q = q.eq('payment_method', type);
        if (onlyWithImage) q = q.not('transfer_image_path', 'is', null);
        if (transferOnly) q = q.eq('payment_method', 'transfer');
        if (account) q = q.eq('account_id', account);
        if (missingImage) q = q.is('transfer_image_path', null).gte('business_date', keepFrom);
        if (check === 'unchecked') q = q.is('verified_at', null);
        if (check === 'checked') q = q.not('verified_at', 'is', null);
        const r = await q;
        if (r.error) throw r.error;
        bills = r.data || [];
      }
      let paper = [];
      if (type === 'all' || type === 'paper' || type === 'transfer' || type === 'cash') {
        let q = db.from('finance_manual_receipts').select('*')
          .gte('business_date', from).lt('business_date', addDays(to, 1)).order('received_at', { ascending: false }).limit(LIMIT);
        if (table) q = q.ilike('table_label', `%${table}%`);
        if (amount) q = q.eq('amount', amount);
        if (type === 'transfer' || type === 'cash') q = q.eq('payment_method', type);
        const r = await q;
        if (r.error && !missingTable(r.error)) throw r.error;
        paper = (r.data || []).filter(p => (!onlyWithImage || p.transfer_image_path || p.image_path)
          && (!transferOnly || p.payment_method === 'transfer')
          && (!account || p.account_id === account)
          && (!missingImage || (!p.transfer_image_path && p.business_date >= keepFrom))
          && (check !== 'unchecked' || !p.verified_at) && (check !== 'checked' || !!p.verified_at));
      }
      const urls = await signReceiptImages(db, [...bills.map(b => b.transfer_image_path), ...paper.flatMap(p => [p.image_path, p.transfer_image_path])]);
      const results = [
        ...bills.map(b => ({ kind: 'bill', id: b.order_id, at: b.paid_at, date: b.business_date, table: b.table_number, customer: b.customer_name,
          method: b.payment_method, accountId: b.account_id, amount: Number(b.amount), items: b.items || [],
          transferImageUrl: urls[b.transfer_image_path] || null, imageExpired: !b.transfer_image_path && b.business_date < keepFrom,
          verifiedAt: b.verified_at || null, verifiedBy: b.verified_by || null })),
        ...paper.map(p => ({ kind: 'paper', id: p.id, at: p.received_at, date: p.business_date, table: p.table_label, customer: null,
          method: p.payment_method, accountId: p.account_id, amount: Number(p.amount), note: p.note, by: p.created_by_name,
          billImageUrl: urls[p.image_path] || null, transferImageUrl: urls[p.transfer_image_path] || null, imageExpired: !!p.images_purged_at,
          verifiedAt: p.verified_at || null, verifiedBy: p.verified_by || null })),
      ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, LIMIT);
      // Danh sách bàn có bill trong khoảng ngày (không theo bộ lọc) để chủ quán bấm chọn nhanh.
      const [ledgerTables, paperTables] = await Promise.all([
        readAll(() => db.from('finance_revenue_ledger').select('table_number').gte('business_date', from).lt('business_date', addDays(to, 1)).order('order_id')),
        readAll(() => db.from('finance_manual_receipts').select('table_label').gte('business_date', from).lt('business_date', addDays(to, 1)).order('id'))
          .catch(error => { if (missingTable(error)) return []; throw error; }),
      ]);
      const counts = {};
      for (const label of [...ledgerTables.map(r => r.table_number), ...paperTables.map(r => r.table_label)]) {
        const key = String(label || '').trim().replace(/^b(àn)?\s*/i, '');
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
      const tables = Object.entries(counts).map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
      const alerts = await transferAlerts(db, from, to, today).catch(() => null);
      return NextResponse.json({ from, to, results, tables, alerts, truncated: bills.length >= LIMIT || paper.length >= LIMIT }, { headers });
    }

    const date = params.get('date');
    if (date) {
      if (!DATE.test(date)) return NextResponse.json({ error: 'Ngày không hợp lệ.' }, { status: 400, headers });
      const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const [bills, notes, entries, close, paper] = await Promise.all([
        readAll(() => db.from('finance_revenue_ledger')
          .select('*')
          .eq('business_date', date).order('paid_at', { ascending: true })),
        notesBetween(db, vnDayStartIso(date), vnDayStartIso(nextDay)),
        db.from('finance_entries').select('*').eq('entry_date', date).order('created_at').then(r => { if (r.error) throw r.error; return r.data || []; }),
        readClose(db, date),
        readPaper(db, date, nextDay),
      ]);
      const urls = await signReceiptImages(db, [...bills.map(b => b.transfer_image_path), ...paper.flatMap(r => [r.image_path, r.transfer_image_path])]);
      const day = { cash: 0, byAccount: {} };
      for (const bill of [...bills, ...paper]) {
        const amount = Number(bill.amount) || 0;
        if (bill.payment_method !== 'transfer') { day.cash += amount; continue; }
        const key = bill.account_id || 'unknown';
        day.byAccount[key] = (day.byAccount[key] || 0) + amount;
      }
      return NextResponse.json({ date, today, startDate: FINANCE_START_DATE,
        bills: bills.map(({ transfer_image_path: path, ...b }) => ({ ...b, transfer_image_url: urls[path] || null })),
        paperBills: paper.map(r => ({ id: r.id, receivedAt: r.received_at, amount: Number(r.amount), paymentMethod: r.payment_method,
          accountId: r.account_id, tableLabel: r.table_label, note: r.note, createdByName: r.created_by_name,
          imageUrl: urls[r.image_path] || null, transferImageUrl: urls[r.transfer_image_path] || null, imagesPurged: !!r.images_purged_at })),
        notes: notes.map(noteView).filter(n => n.cost > 0), entries,
        close, closeDiff: closeDifferences(day, close), dayCash: day.cash, dayByAccount: day.byAccount }, { headers });
    }

    const month = params.get('month') || today.slice(0, 7);
    if (!isMonthKey(month)) return NextResponse.json({ error: 'Tháng không hợp lệ.' }, { status: 400, headers });
    const { start, next } = monthBounds(month);
    // Bổ sung bill bị sót trước khi đọc sổ, để con số tháng đã đủ.
    let repair = null;
    try { repair = await repairMissingBills(db); }
    catch (error) {
      if (missingTable(error)) return NextResponse.json({ error: 'Chưa cài bảng sổ thu chi trên cơ sở dữ liệu (owner_finance.sql).', setupMissing: true }, { status: 503, headers });
      console.error('[admin/finance] repair', error);
    }
    let loaded;
    try { loaded = await loadMonth(db, month, today); } catch (error) {
      if (missingTable(error)) return NextResponse.json({ error: 'Chưa cài bảng sổ thu chi trên cơ sở dữ liệu (owner_finance.sql).', setupMissing: true }, { status: 503, headers });
      throw error;
    }
    const { summary, entries, categories } = loaded;
    // Bill CK chưa có ảnh / chưa đối chiếu trong tháng; cột chưa cài thì bỏ qua.
    const alertTo = addDays(next, -1) < today ? addDays(next, -1) : today;
    const pending = start <= alertTo ? await transferAlerts(db, start, alertTo, today).catch(error => { console.error('[admin/finance] alerts', error); return null; }) : null;
    const zaloReport = reportStatus(await readReportSettings(db).catch(() => null));
    const monthlyTabs = new Set(categories.filter(c => c.scope === 'tab' && c.schedule === 'monthly').map(c => c.id));
    return NextResponse.json({
      ...summary, today, startDate: FINANCE_START_DATE, fixedCategories: FIXED_CATEGORIES, categories,
      entries: entries.filter(e => e.kind !== 'fixed'),
      // Khoản của tab nhập theo tháng — liệt kê riêng như chi cố định.
      customMonthlyEntries: entries.filter(e => e.kind === 'custom' && monthlyTabs.has(e.category)),
      accounts: loaded.accounts, staff: loaded.staff, transferAlerts: pending, zaloReport,
      // Bill sổ tự bổ sung lần này từ lịch sử bàn, và bill chưa bổ sung được
      // (null = không kiểm tra được).
      recoveredBills: repair ? repair.recovered : null,
      missingBills: repair ? repair.unrecovered : null,
    }, { headers });
  } catch (error) {
    console.error('[admin/finance] GET', error);
    return NextResponse.json({ error: 'Không đọc được sổ thu chi.' }, { status: 500, headers });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action === 'daily_report' && reportKeyOk(request)) {
      // Workflow gọi mỗi 30 phút; chỉ gửi khi tới giờ chủ quán chọn (mỗi ngày 1 lần).
      const db = statusDatabase();
      const today = vnDate(Date.now());
      const plan = reportPlan((await readReportSettings(db))?.sendAt);
      if (!DATE.test(body.date || '') && !plan.due) return NextResponse.json({ ok: true, skipped: `chưa tới giờ gửi ${plan.sendAt}` }, { headers });
      const date = DATE.test(body.date || '') ? body.date : plan.date;
      return NextResponse.json(await sendDailyReport(db, { date, today, scheduled: true }), { headers });
    }
    const session = await requireOwner(request);
    if (session.code !== 200) return deny(session.code);
    const db = statusDatabase();

    if (body.action === 'save_item_group' || body.action === 'delete_item_group') {
      const groups = await readItemGroups(db);
      if (groups === null) return NextResponse.json({ error: 'Chưa cài bảng cài đặt sổ thu chi (owner_finance.sql).' }, { status: 503, headers });
      if (body.action === 'delete_item_group') {
        await saveItemGroups(db, groups.filter(g => g.id !== body.id));
        return NextResponse.json({ ok: true }, { headers });
      }
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!name) return NextResponse.json({ error: 'Nhập tên nhóm, vd "Ốc hương".' }, { status: 400, headers });
      const keywords = [...new Set((Array.isArray(body.keywords) ? body.keywords : String(body.keywords || '').split(','))
        .map(k => String(k).trim().replace(/\s+/g, ' ').slice(0, 40)).filter(k => itemKey(k).length >= 2))].slice(0, 10);
      const existing = body.id ? groups.find(g => g.id === body.id) : null;
      if (body.id && !existing) return NextResponse.json({ error: 'Không tìm thấy nhóm.' }, { status: 404, headers });
      if (groups.some(g => g.id !== body.id && itemKey(g.name) === itemKey(name))) return NextResponse.json({ error: `Đã có nhóm "${name}".` }, { status: 409, headers });
      if (!existing && groups.length >= MAX_ITEM_GROUPS) return NextResponse.json({ error: 'Đã đủ số nhóm tối đa.' }, { status: 400, headers });
      const group = { id: existing?.id || randomUUID(), name, keywords: keywords.length ? keywords : [name] };
      await saveItemGroups(db, existing ? groups.map(g => g.id === group.id ? group : g) : [...groups, group]);
      return NextResponse.json({ ok: true, group }, { headers });
    }

    if (body.action === 'verify') {
      const table = body.kind === 'paper' ? 'finance_manual_receipts' : body.kind === 'bill' ? 'finance_revenue_ledger' : null;
      const key = body.kind === 'paper' ? 'id' : 'order_id';
      if (!table || typeof body.id !== 'string' || !UUID.test(body.id)) return NextResponse.json({ error: 'Thiếu bill cần đối chiếu.' }, { status: 400, headers });
      const patch = body.verified === false ? { verified_at: null, verified_by: null }
        : { verified_at: new Date().toISOString(), verified_by: session.user.full_name || null };
      const { data, error } = await db.from(table).update(patch).eq(key, body.id).eq('payment_method', 'transfer').select(key);
      if (error) throw error;
      if (!data?.length) return NextResponse.json({ error: 'Không tìm thấy bill chuyển khoản này.' }, { status: 404, headers });
      return NextResponse.json({ ok: true, verifiedAt: patch.verified_at, verifiedBy: patch.verified_by }, { headers });
    }

    if (['zalo_link_code', 'zalo_unlink', 'zalo_test', 'zalo_set_time', 'zalo_set_sections'].includes(body.action)) {
      const settings = await readReportSettings(db);
      if (!settings) return NextResponse.json({ error: 'Chưa cài bảng cài đặt sổ thu chi (owner_finance.sql).' }, { status: 503, headers });
      if (body.action === 'zalo_set_sections') {
        const input = body.sections && typeof body.sections === 'object' ? body.sections : {};
        const next = { ...settings, sections: Object.fromEntries(REPORT_SECTIONS.map(k => [k, input[k] !== false])) };
        await saveReportSettings(db, next);
        return NextResponse.json({ ok: true, zaloReport: reportStatus(next) }, { headers });
      }
      if (body.action === 'zalo_set_time') {
        if (!validSendAt(body.time)) return NextResponse.json({ error: 'Giờ gửi không hợp lệ.' }, { status: 400, headers });
        const next = { ...settings, sendAt: body.time };
        await saveReportSettings(db, next);
        return NextResponse.json({ ok: true, zaloReport: reportStatus(next) }, { headers });
      }
      if (body.action === 'zalo_test') {
        const today = vnDate(Date.now());
        const result = await sendDailyReport(db, { date: today, today, scheduled: false });
        const zaloReport = reportStatus(await readReportSettings(db));
        if (!result.ok) return NextResponse.json({ error: result.error, zaloReport }, { status: 400, headers });
        return NextResponse.json({ ok: true, sent: result.sent, zaloReport }, { headers });
      }
      const next = body.action === 'zalo_unlink'
        ? { ...settings, ownerIds: [], linkCode: null, linkCodeExpires: null }
        : { ...settings, linkCode: String(randomInt(0, 1_000_000)).padStart(6, '0'), linkCodeExpires: Date.now() + LINK_CODE_MINUTES * 60000, linkAttempts: 0 };
      await saveReportSettings(db, next);
      return NextResponse.json({ ok: true, zaloReport: reportStatus(next) }, { headers });
    }

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
