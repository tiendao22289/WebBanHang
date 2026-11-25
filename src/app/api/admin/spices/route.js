/**
 * /api/admin/spices — Gọi gia vị (trang /admin/spices): nhân viên, quản lý, admin gửi đơn cho chủ gia vị; chủ gia vị soạn
 * hàng và điền giá qua link riêng (/giavi/<mã>, API /api/spice-supplier); nhân viên bấm Đã nhận. Đơn đã nhận ghi nợ chủ
 * gia vị và là chi phí gia vị của ngày nhận trong Sổ thu chi; chủ quán trả gom (pay). Mỗi việc ghi vào order.log
 * (ai gọi / thêm / đổi giá / nhận / huỷ, lúc nào) để sau không tranh cãi.
 *
 * GET → { me, suppliers, items, orders (60 ngày gần đây + mọi đơn chưa nhận), lastPrices, balances (admin), payments (admin) }
 * GET ?stats=day|month|year (admin) → { stats: spiceStats(...) }
 * POST {action}:
 *   create { supplier_id, lines: [{ name, unit, qty }], note } — ai cũng được; giá lấy giá lần trước của chủ gia vị đó
 *   add_lines { id, lines, note } — thêm món vào đơn chưa nhận (ai cũng được)
 *   receive { id, updated_at, received: [số nhận từng dòng | null = đủ] } — ai cũng được, chỉ một lần
 *   cancel { id, reason } — người gọi (đơn chưa nhận) hoặc quản lý / admin
 *   set_prices { id, updated_at, prices: [{ index, price }] } — admin, sửa mọi lúc
 *   save_supplier { id?, name, phone, active } · new_link { id } · save_item { id?, name, unit, active } — admin
 *   pay { supplier_id, amount, method, paid_date, note } · delete_payment { id } — admin
 */
import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';
import { nowMs } from '@/lib/trueTime.mjs';
import {
  addLines, applyPrices, buildLines, cancelOrder, cleanName, createOrderRow, itemKey, lastPrices, receiveOrder,
  spiceStats, statsFrom, supplierBalances, vnDateOf,
} from '@/lib/spiceOrders.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAYMENT = 1_000_000_000;
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const newToken = () => randomBytes(24).toString('base64url');
const nowIso = () => new Date(nowMs()).toISOString();
const missingTable = error => ['PGRST205', '42P01'].includes(error?.code);
const NOT_READY = 'Chưa cài phần Gọi gia vị trên máy chủ (chạy Apply Finance Migration).';
const CHANGED = 'Đơn vừa được người khác cập nhật, tải lại rồi làm lại.';

async function readAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

const readSuppliers = db => db.from('spice_suppliers').select('*').order('created_at');
async function readOrder(db, id) {
  const { data, error } = await db.from('spice_orders').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
// Ghi đơn chỉ khi đơn chưa bị đổi từ lúc đọc (updated_at): hai người bấm cùng lúc thì người sau phải tải lại.
async function updateOrder(db, order, patch, at) {
  const { data, error } = await db.from('spice_orders').update({ ...patch, updated_at: at })
    .eq('id', order.id).eq('updated_at', order.updated_at).select('*');
  if (error) throw error;
  return data?.[0] || null;
}
const supplierHistory = (db, supplierId) => readAll(() => db.from('spice_orders').select('supplier_id, items, created_at, cancelled_at')
  .eq('supplier_id', supplierId).order('created_at', { ascending: false }));

export async function GET(request) {
  try {
    const s = await getStaffSession(request);
    if (s.code !== 200) return fail(s.code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập.', s.code);
    const user = s.user, isAdmin = user.role === 'admin';
    const db = staffDatabase(user.id);
    const params = new URL(request.url).searchParams;
    const today = vnDateOf(nowIso());

    const period = params.get('stats');
    if (period) {
      if (!isAdmin) return fail('Chỉ chủ quán xem thống kê.', 403);
      if (!['day', 'month', 'year'].includes(period)) return fail('Kỳ không hợp lệ.');
      const from = statsFrom(period, today);
      const [orders, suppliers] = await Promise.all([
        readAll(() => db.from('spice_orders').select('id, supplier_id, items, received_at, received_date, cancelled_at').gte('received_date', from).order('id')),
        readSuppliers(db),
      ]);
      if (suppliers.error) throw suppliers.error;
      const supplierNames = Object.fromEntries((suppliers.data || []).map(x => [x.id, x.name]));
      return NextResponse.json({ period, from, today, stats: spiceStats(orders, { period, supplierNames }) }, { headers });
    }

    const since = new Date(nowMs() - 60 * 86400000).toISOString();
    const [suppliers, items, recent, open, payments] = await Promise.all([
      readSuppliers(db),
      db.from('spice_items').select('*').order('name'),
      readAll(() => db.from('spice_orders').select('*').gte('created_at', since).order('created_at', { ascending: false })),
      readAll(() => db.from('spice_orders').select('*').is('received_at', null).is('cancelled_at', null).order('created_at', { ascending: false })),
      isAdmin ? readAll(() => db.from('spice_payments').select('*').order('paid_date', { ascending: false })) : Promise.resolve([]),
    ]);
    for (const r of [suppliers, items]) if (r.error) throw r.error;
    const byId = new Map([...recent, ...open].map(o => [o.id, o]));
    const orders = [...byId.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const list = suppliers.data || [];
    const lastPricesOut = Object.fromEntries(list.map(x => [x.id, Object.fromEntries([...lastPrices(orders, x.id)].map(([k, v]) => [k, v.price]))]));
    let balances = null;
    if (isAdmin) {
      const all = await readAll(() => db.from('spice_orders').select('id, supplier_id, items, received_at, cancelled_at').not('received_at', 'is', null).order('id'));
      balances = supplierBalances(all, payments);
    }
    return NextResponse.json({
      me: { id: user.id, name: user.full_name, role: user.role }, today,
      // Mã link để nhân viên gửi cho chủ gia vị qua Zalo; ai đăng nhập cũng thấy.
      suppliers: list.filter(x => isAdmin || x.active).map(x => ({ id: x.id, name: x.name, phone: x.phone || '', token: x.token, active: x.active })),
      items: (items.data || []).filter(i => isAdmin || i.active),
      orders, lastPrices: lastPricesOut, balances, payments: isAdmin ? payments : [],
    }, { headers });
  } catch (error) {
    if (missingTable(error)) return fail(NOT_READY, 503);
    console.error('[admin/spices] GET', error);
    return fail('Không tải được dữ liệu gia vị.', 500);
  }
}

async function rememberItems(db, lines) {
  const { data: known } = await db.from('spice_items').select('name');
  const knownKeys = new Set((known || []).map(i => itemKey(i.name)));
  const fresh = lines.filter(l => !knownKeys.has(itemKey(l.name))).map(l => ({ name: l.name, unit: l.unit || null }));
  if (fresh.length) {
    const { error } = await db.from('spice_items').insert(fresh);
    if (error) console.error('[admin/spices] items', error);
  }
}

export async function POST(request) {
  try {
    const s = await getStaffSession(request);
    if (s.code !== 200) return fail(s.code === 503 ? 'Không kiểm tra được đăng nhập.' : 'Cần đăng nhập.', s.code);
    const user = s.user, isAdmin = user.role === 'admin', canManage = isAdmin || user.role === 'manager';
    const db = staffDatabase(user.id);
    const body = await request.json().catch(() => ({}));
    const at = nowIso(), by = user.full_name || 'Nhân viên';
    const ok = extra => NextResponse.json({ ok: true, ...extra }, { headers });

    if (body.action === 'create') {
      if (!UUID.test(String(body.supplier_id || ''))) return fail('Chọn chủ gia vị.');
      const { data: supplier, error } = await db.from('spice_suppliers').select('*').eq('id', body.supplier_id).maybeSingle();
      if (error) throw error;
      if (!supplier || !supplier.active) return fail('Chủ gia vị này không còn nhận đơn.');
      // Giá lần trước của chính chủ gia vị này: điền sẵn (chủ gia vị sửa được), món chưa từng có giá để trống.
      const built = buildLines(body.lines, { last: lastPrices(await supplierHistory(db, supplier.id), supplier.id), by, at });
      if (built.error) return fail(built.error);
      const row = createOrderRow({ lines: built.lines, note: str(body.note, 300), by, byId: user.id, at, supplierId: supplier.id });
      const { data, error: insertError } = await db.from('spice_orders').insert(row).select('*');
      if (insertError) throw insertError;
      await rememberItems(db, built.lines);
      return ok({ order: data?.[0] || null, supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone || '', token: supplier.token } });
    }

    if (['add_lines', 'receive', 'cancel', 'set_prices'].includes(body.action)) {
      if (!UUID.test(String(body.id || ''))) return fail('Không thấy đơn.');
      const order = await readOrder(db, body.id);
      if (!order) return fail('Không thấy đơn.', 404);
      if (body.updated_at && body.updated_at !== order.updated_at && body.action !== 'add_lines') return fail(CHANGED, 409);
      let result;
      if (body.action === 'add_lines') {
        result = addLines(order, body.lines, { last: lastPrices(await supplierHistory(db, order.supplier_id), order.supplier_id), by, at, note: str(body.note, 300) });
      } else if (body.action === 'receive') {
        result = receiveOrder(order, body.received, { by, at });
      } else if (body.action === 'cancel') {
        if (!canManage && order.created_by !== user.id) return fail('Chỉ người gọi đơn hoặc quản lý huỷ được.', 403);
        result = cancelOrder(order, { by, at, reason: str(body.reason, 200) });
      } else {
        if (!isAdmin) return fail('Chỉ chủ quán sửa giá ở đây.', 403);
        result = applyPrices(order, body.prices, { by, at, who: 'admin' });
      }
      if (result.error) return fail(result.error);
      if (!result.patch) return ok({ order });
      const saved = await updateOrder(db, order, result.patch, at);
      if (!saved) return fail(CHANGED, 409);
      if (body.action === 'add_lines') await rememberItems(db, result.lines);
      const supplier = body.action === 'add_lines'
        ? (await db.from('spice_suppliers').select('id, name, phone, token').eq('id', order.supplier_id).maybeSingle()).data : null;
      return ok({ order: saved, ...(supplier ? { supplier } : {}) });
    }

    if (!isAdmin) return fail('Chỉ chủ quán làm được việc này.', 403);

    if (body.action === 'save_supplier') {
      const name = cleanName(body.name);
      if (!name) return fail('Nhập tên chủ gia vị.');
      const row = { name, phone: str(body.phone, 20).replace(/[^\d+]/g, '') || null, active: body.active !== false, updated_at: at };
      if (body.id) {
        if (!UUID.test(String(body.id))) return fail('Không thấy chủ gia vị.');
        const { data, error } = await db.from('spice_suppliers').update(row).eq('id', body.id).select('*');
        if (error) throw error;
        if (!data?.length) return fail('Không thấy chủ gia vị.', 404);
        return ok({ supplier: data[0] });
      }
      const { data, error } = await db.from('spice_suppliers').insert({ ...row, token: newToken(), created_at: at }).select('*');
      if (error) throw error;
      return ok({ supplier: data?.[0] || null });
    }

    if (body.action === 'new_link') {
      if (!UUID.test(String(body.id || ''))) return fail('Không thấy chủ gia vị.');
      const { data, error } = await db.from('spice_suppliers').update({ token: newToken(), updated_at: at }).eq('id', body.id).select('*');
      if (error) throw error;
      if (!data?.length) return fail('Không thấy chủ gia vị.', 404);
      return ok({ supplier: data[0] });
    }

    if (body.action === 'save_item') {
      const name = cleanName(body.name);
      if (!name) return fail('Nhập tên món.');
      if (body.id && !UUID.test(String(body.id))) return fail('Không thấy món.');
      const row = { name, unit: cleanName(body.unit, 20) || null, active: body.active !== false };
      const { data: all, error: readError } = await db.from('spice_items').select('id, name');
      if (readError) throw readError;
      if ((all || []).some(i => itemKey(i.name) === itemKey(name) && i.id !== body.id)) return fail('Đã có món này.');
      const q = body.id ? db.from('spice_items').update(row).eq('id', body.id) : db.from('spice_items').insert(row);
      const { data, error } = await q.select('*');
      if (error) throw error;
      return ok({ item: data?.[0] || null });
    }

    if (body.action === 'pay') {
      if (!UUID.test(String(body.supplier_id || ''))) return fail('Chọn chủ gia vị.');
      const amount = Math.round(Number(String(body.amount ?? '').replace(/\D/g, '')) || 0);
      if (amount < 1000 || amount > MAX_PAYMENT) return fail('Số tiền trả không hợp lệ.');
      const today = vnDateOf(at);
      const paidDate = DATE.test(String(body.paid_date || '')) ? body.paid_date : today;
      if (paidDate > today) return fail('Ngày trả không được sau hôm nay.');
      const { data, error } = await db.from('spice_payments').insert({
        supplier_id: body.supplier_id, amount, method: body.method === 'transfer' ? 'transfer' : 'cash', paid_date: paidDate,
        note: str(body.note, 300) || null, created_by_name: by, created_at: at,
      }).select('*');
      if (error) throw error;
      return ok({ payment: data?.[0] || null });
    }

    if (body.action === 'delete_payment') {
      if (!UUID.test(String(body.id || ''))) return fail('Không thấy lần trả.');
      const { error } = await db.from('spice_payments').delete().eq('id', body.id);
      if (error) throw error;
      return ok({});
    }

    return fail('Thao tác không hợp lệ.');
  } catch (error) {
    if (missingTable(error)) return fail(NOT_READY, 503);
    console.error('[admin/spices] POST', error);
    return fail('Không lưu được, thử lại.', 500);
  }
}
