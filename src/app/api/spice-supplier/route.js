/**
 * /api/spice-supplier — trang của chủ gia vị (/giavi/<mã>), không cần đăng nhập: mã bí mật trong link
 * (spice_suppliers.token, chủ quán bấm "Đổi link" là link cũ hết dùng). Chủ gia vị chỉ thấy đơn của chính mình.
 *
 * GET ?t=<mã> → { supplier: { name }, summary (đã giao / quán đã trả / quán còn thiếu), orders (mọi đơn chưa nhận + 60 ngày),
 *               payments (các lần quán trả), days (đối soát từng ngày 60 ngày: đủ / thiếu / dư / sai, nợ cuối ngày) }
 * POST { t, id, updated_at, prices: [{ index, price }], done, note } → điền / sửa giá, báo "Đã soạn xong", ghi chú.
 *   Đơn chưa nhận: sửa giá mọi dòng; đơn đã nhận: chỉ điền được dòng còn trống giá (sửa giá thì báo chủ quán).
 * POST { t, id, updated_at, add: [{ name, unit, qty, price }] } → chủ gia vị tự thêm món (quán gọi thiếu), đơn chưa nhận.
 * POST { t, id, updated_at, paid: true | false } → chủ gia vị đánh dấu đơn đã nhận tiền / chưa (sổ riêng, mục Thống kê).
 * POST { t, ids: [id…], paid: true | false } → đánh dấu nhiều đơn đã tích chọn một lần (đơn không hợp lệ thì bỏ qua, báo số đơn đã đổi).
 * POST { t, id, deliver_to: <mã nhân viên> } → báo đã giao hàng cho nhân viên đó (đổi được đến khi quán nhận); GET trả staff [{ id, name }].
 * GET còn trả history: mọi đơn quán đã nhận (gọn) để chủ gia vị thống kê đã / chưa thanh toán, số lượng từng món.
 */
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { statusDatabase } from '@/lib/statusAuth';
import { nowMs } from '@/lib/trueTime.mjs';
import { vnDay } from '@/lib/staffDeparture.mjs';
import { applyPrices, deliverOrder, lastPrices, orderTotal, setSupplierPaid, supplierAddLines, supplierDays, supplierSummary, vnDateOf } from '@/lib/spiceOrders.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };
const TOKEN = /^[A-Za-z0-9_-]{24,64}$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });
const nowIso = () => new Date(nowMs()).toISOString();
const BAD_LINK = 'Link không đúng hoặc đã được quán đổi. Xin quán gửi link mới.';
const CHANGED = 'Đơn vừa có người cập nhật (quán thêm món hoặc đã nhận). Tải lại rồi điền lại.';

async function readAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

// Nhân viên đang làm trong quán (chủ gia vị chọn người nhận hàng): chỉ tên + mã riêng theo link (không lộ mã nhân viên thật),
// bỏ người đã nghỉ. Mã đổi khi quán đổi link.
const staffKey = (id, token) => createHash('sha256').update(`${token}:${id}`).digest('hex').slice(0, 16);
async function shopStaff(db, token) {
  const { data, error } = await db.from('staff').select('id, full_name').order('full_name');
  if (error) throw error;
  const today = vnDay();
  const { data: gone } = await db.from('staff_departures').select('staff_id, last_day');
  const left = new Set((gone || []).filter(g => g.last_day && String(g.last_day).slice(0, 10) < today).map(g => g.staff_id));
  return (data || []).filter(s => s.full_name && !left.has(s.id)).map(s => ({ id: s.id, key: staffKey(s.id, token), name: s.full_name }));
}

async function supplierOf(db, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  const { data, error } = await db.from('spice_suppliers').select('id, name, active, token').eq('token', token).maybeSingle();
  if (error) throw error;
  return data?.active ? data : null;
}

// Chủ gia vị thấy gì của đơn: không có mã nhân viên, không có giá đầu vào của chủ gia vị khác.
const view = o => ({
  id: o.id, items: o.items, total: o.total, note: o.note, supplier_note: o.supplier_note, created_at: o.created_at,
  created_by_name: o.created_by_name, priced_at: o.priced_at, received_at: o.received_at, received_by_name: o.received_by_name,
  cancelled_at: o.cancelled_at, cancelled_by_name: o.cancelled_by_name, log: o.log || [], updated_at: o.updated_at,
  delivered_to_name: o.delivered_to_name || null, delivered_at: o.delivered_at || null,
  supplier_paid_at: o.supplier_paid_at || null, paid_confirmed_at: o.paid_confirmed_at || null, paid_method: o.paid_method || null,
});
// Đơn đã nhận, gọn, cho mục Thống kê của chủ gia vị.
const slim = o => ({
  id: o.id, created_at: o.created_at, received_at: o.received_at, received_date: o.received_date, total: o.total, cancelled_at: o.cancelled_at || null,
  supplier_paid_at: o.supplier_paid_at || null, paid_confirmed_at: o.paid_confirmed_at || null, paid_method: o.paid_method || null, updated_at: o.updated_at,
  items: (o.items || []).map(l => ({ name: l.name, unit: l.unit, qty: l.qty, received_qty: l.received_qty ?? null, price: l.price ?? null, check: l.check, by_supplier: !!l.by_supplier })),
});

export async function GET(request) {
  try {
    const db = statusDatabase();
    const supplier = await supplierOf(db, new URL(request.url).searchParams.get('t'));
    if (!supplier) return fail(BAD_LINK, 404);
    const since = new Date(nowMs() - 60 * 86400000).toISOString();
    const [all, payments, staff] = await Promise.all([
      readAll(() => db.from('spice_orders').select('*').eq('supplier_id', supplier.id).order('created_at', { ascending: false })),
      readAll(() => db.from('spice_payments').select('supplier_id, amount, method, paid_date, note, created_at').eq('supplier_id', supplier.id).order('paid_date', { ascending: false })),
      shopStaff(db, supplier.token),
    ]);
    const orders = all.filter(o => o.created_at >= since || (!o.received_at && !o.cancelled_at));
    return NextResponse.json({
      supplier: { name: supplier.name }, summary: supplierSummary(all, payments),
      orders: orders.map(view), payments: payments.slice(0, 60).map(({ supplier_id: _s, ...p }) => p),
      days: supplierDays(all, payments, { from: vnDateOf(since) }),
      staff: staff.map(({ key, name }) => ({ id: key, name })),
      history: all.filter(o => o.received_at || o.cancelled_at).map(slim),
    }, { headers });
  } catch (error) {
    console.error('[spice-supplier] GET', error);
    return fail('Không tải được, thử lại sau.', 500);
  }
}

export async function POST(request) {
  try {
    const db = statusDatabase();
    const body = await request.json().catch(() => ({}));
    const supplier = await supplierOf(db, body.t);
    if (!supplier) return fail(BAD_LINK, 404);
    if (Array.isArray(body.ids) && typeof body.paid === 'boolean') {
      const ids = [...new Set(body.ids.map(String))].filter(id => UUID.test(id)).slice(0, 200);
      if (!ids.length) return fail('Chưa chọn đơn nào.');
      const { data: list, error: readError } = await db.from('spice_orders').select('*').eq('supplier_id', supplier.id).in('id', ids);
      if (readError) throw readError;
      const at = nowIso();
      let changed = 0, total = 0;
      for (const order of list || []) {
        const r = setSupplierPaid(order, body.paid, { by: supplier.name, at });
        if (r.error || !r.patch) continue;
        const { data, error: saveError } = await db.from('spice_orders').update({ ...r.patch, updated_at: at }).eq('id', order.id).eq('updated_at', order.updated_at).select('id');
        if (saveError) throw saveError;
        if (data?.length) { changed += 1; total += orderTotal(order.items); }
      }
      return NextResponse.json({ ok: true, changed, total }, { headers });
    }
    if (!UUID.test(String(body.id || ''))) return fail('Không thấy đơn.');
    const { data: order, error } = await db.from('spice_orders').select('*').eq('id', body.id).eq('supplier_id', supplier.id).maybeSingle();
    if (error) throw error;
    if (!order) return fail('Không thấy đơn.', 404);
    if (order.paid_confirmed_at) return fail('Quán đã xác nhận thanh toán đơn này — đơn đã khoá, không sửa được nữa.');
    if (body.updated_at && body.updated_at !== order.updated_at) return fail(CHANGED, 409);
    const at = nowIso();
    let result;
    if (Array.isArray(body.add)) {
      const history = await readAll(() => db.from('spice_orders').select('id, supplier_id, items, created_at, cancelled_at').eq('supplier_id', supplier.id).order('created_at', { ascending: false }));
      result = supplierAddLines(order, body.add, { last: lastPrices(history, supplier.id), by: supplier.name, at });
    } else if (body.deliver_to !== undefined) {
      const key = String(body.deliver_to || '');
      const who = /^[\da-f]{16}$/.test(key) ? (await shopStaff(db, body.t)).find(x => x.key === key) : null;
      if (!who) return fail('Chọn nhân viên nhận hàng.');
      result = deliverOrder(order, who, { by: supplier.name, at });
    } else if (typeof body.paid === 'boolean') {
      result = setSupplierPaid(order, body.paid, { by: supplier.name, at });
    } else {
      result = applyPrices(order, Array.isArray(body.prices) ? body.prices : [], {
        by: supplier.name, at, who: 'supplier', done: body.done === true, ...(typeof body.note === 'string' ? { note: body.note } : {}),
      });
    }
    if (result.error) return fail(result.error);
    if (!result.patch) return NextResponse.json({ ok: true, order: view(order) }, { headers });
    const { data, error: saveError } = await db.from('spice_orders').update({ ...result.patch, updated_at: at })
      .eq('id', order.id).eq('updated_at', order.updated_at).select('*');
    if (saveError) throw saveError;
    if (!data?.length) return fail(CHANGED, 409);
    return NextResponse.json({ ok: true, order: view(data[0]) }, { headers });
  } catch (error) {
    console.error('[spice-supplier] POST', error);
    return fail('Không lưu được, thử lại.', 500);
  }
}
