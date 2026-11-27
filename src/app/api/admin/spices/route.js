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
 *   receive { id, updated_at, received: [null = đủ | { check: ok|short|over|wrong, qty, note }], note } — ai cũng được, một lần
 *   recheck { id, updated_at, received, note } — quản lý / chủ quán kiểm lại đơn đã nhận (đối soát)
 * GET ?days=<supplier_id> → { days: supplierDays(...) } 60 ngày (nhân viên / quản lý không thấy tiền đã trả, nợ cuối ngày)
 *   cancel { id, reason } — người gọi (đơn chưa nhận) hoặc quản lý / admin; đơn ĐÃ nhận: chỉ admin, bắt buộc lý do
 *   set_prices { id, updated_at, prices: [{ index, price }] } — admin, sửa mọi lúc
 *   save_supplier { id?, name, phone, active } · new_link { id } · save_item { id?, name, unit, default_qty, active } — admin
 *   save_items { text } — admin dán nhiều món một lần ("Muối 2 kg" mỗi dòng), món đã có thì cập nhật số / đơn vị
 *   replace_items { text } — admin sửa CẢ danh sách bằng chữ: đúng thứ tự dòng, món không còn trong chữ bị xoá
 *   move_item { id, dir: -1 | 1 } · delete_item { id } — admin xếp / xoá món (đơn cũ giữ tên món, không ảnh hưởng)
 *   Món nhân viên gõ thêm khi gọi chỉ nằm trong đơn đó, không tự vào danh sách (danh sách do chủ quán quyết).
 *   pay { supplier_id, amount, method, paid_date, note } · delete_payment { id } — admin
 *   confirm_paid { ids, ok, note } — admin xác nhận (ok) / báo không đúng (ok=false) lời báo "đã nhận tiền" của chủ gia vị
 */
import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getStaffSession, staffDatabase } from '@/lib/statusAuth';
import { nowMs } from '@/lib/trueTime.mjs';
import {
  addLines, applyPrices, buildLines, confirmSupplierPaid, orderTotal, recheckOrder, supplierDays, parseItemLines, parseQty, moveItem, planItemList, cancelOrder, cleanName, createOrderRow, itemKey, lastPrices, receiveOrder,
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

    const daysOf = params.get('days');
    if (daysOf) {
      if (!UUID.test(daysOf)) return fail('Không thấy chủ gia vị.');
      const [orders, payments] = await Promise.all([
        readAll(() => db.from('spice_orders').select('id, supplier_id, items, note, supplier_note, log, created_at, created_by_name, received_at, received_date, received_by_name, cancelled_at, supplier_paid_at, paid_confirmed_at')
          .eq('supplier_id', daysOf).not('received_at', 'is', null).order('id')),
        isAdmin ? readAll(() => db.from('spice_payments').select('supplier_id, amount, method, note, paid_date').eq('supplier_id', daysOf).order('id')) : Promise.resolve([]),
      ]);
      const from = vnDateOf(new Date(nowMs() - 60 * 86400000).toISOString());
      let days = supplierDays(orders, payments, { from });
      if (!isAdmin) days = days.filter(d => d.orders.length).map(d => ({ ...d, paid: 0, payments: [], balance: null }));
      return NextResponse.json({ days, today }, { headers });
    }

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
      const all = await readAll(() => db.from('spice_orders').select('id, supplier_id, items, received_at, received_date, cancelled_at, supplier_paid_at, paid_confirmed_at').not('received_at', 'is', null).order('id'));
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
      return ok({ order: data?.[0] || null, supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone || '', token: supplier.token } });
    }

    if (['add_lines', 'receive', 'recheck', 'cancel', 'set_prices'].includes(body.action)) {
      if (!UUID.test(String(body.id || ''))) return fail('Không thấy đơn.');
      const order = await readOrder(db, body.id);
      if (!order) return fail('Không thấy đơn.', 404);
      if (body.updated_at && body.updated_at !== order.updated_at && body.action !== 'add_lines') return fail(CHANGED, 409);
      let result;
      if (body.action === 'add_lines') {
        result = addLines(order, body.lines, { last: lastPrices(await supplierHistory(db, order.supplier_id), order.supplier_id), by, at, note: str(body.note, 300) });
      } else if (body.action === 'receive') {
        result = receiveOrder(order, body.received, { by, at, note: str(body.note, 300) });
      } else if (body.action === 'recheck') {
        if (!canManage) return fail('Chỉ quản lý hoặc chủ quán kiểm lại được.', 403);
        result = recheckOrder(order, body.received, { by, at, note: str(body.note, 300) });
      } else if (body.action === 'cancel') {
        if (order.received_at && !isAdmin) return fail('Đơn đã nhận hàng, chỉ chủ quán huỷ được.', 403);
        if (!canManage && order.created_by !== user.id) return fail('Chỉ người gọi đơn hoặc quản lý huỷ được.', 403);
        result = cancelOrder(order, { by, at, reason: str(body.reason, 200), owner: isAdmin && !!order.received_at });
      } else {
        if (!isAdmin) return fail('Chỉ chủ quán sửa giá ở đây.', 403);
        result = applyPrices(order, body.prices, { by, at, who: 'admin' });
      }
      if (result.error) return fail(result.error);
      if (!result.patch) return ok({ order });
      const saved = await updateOrder(db, order, result.patch, at);
      if (!saved) return fail(CHANGED, 409);
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
      const qty = body.default_qty === '' || body.default_qty === null || body.default_qty === undefined ? null : parseQty(String(body.default_qty));
      if (qty === null && body.default_qty !== '' && body.default_qty !== null && body.default_qty !== undefined) return fail('Số lượng mặc định không hợp lệ.');
      const row = { name, unit: cleanName(body.unit, 20) || null, default_qty: qty, active: body.active !== false };
      const { data: all, error: readError } = await db.from('spice_items').select('id, name, sort');
      if (readError) throw readError;
      if ((all || []).some(i => itemKey(i.name) === itemKey(name) && i.id !== body.id)) return fail('Đã có món này.');
      // Món mới vào cuối danh sách.
      const q = body.id ? db.from('spice_items').update(row).eq('id', body.id)
        : db.from('spice_items').insert({ ...row, sort: Math.max(0, ...(all || []).map(i => Number(i.sort) || 0)) + 1 });
      const { data, error } = await q.select('*');
      if (error) throw error;
      return ok({ item: data?.[0] || null });
    }

    if (body.action === 'save_items') {
      const list = parseItemLines(body.text);
      if (!list.length) return fail('Chưa có món nào. Mỗi dòng một món, vd: Muối 2 kg');
      const { data: all, error: readError } = await db.from('spice_items').select('id, name, sort');
      if (readError) throw readError;
      const byKey = new Map((all || []).map(i => [itemKey(i.name), i]));
      let sort = Math.max(0, ...(all || []).map(i => Number(i.sort) || 0));
      let added = 0, updated = 0;
      for (const it of list) {
        const old = byKey.get(itemKey(it.name));
        const patch = { ...(it.unit ? { unit: it.unit } : {}), ...(it.qty !== null ? { default_qty: it.qty } : {}), active: true };
        if (old) {
          const { error } = await db.from('spice_items').update(patch).eq('id', old.id);
          if (error) throw error;
          updated += 1;
        } else {
          sort += 1;
          const { error } = await db.from('spice_items').insert({ name: it.name, unit: it.unit || null, default_qty: it.qty, sort, active: true });
          if (error) throw error;
          added += 1;
        }
      }
      return ok({ added, updated });
    }

    if (body.action === 'replace_items') {
      const { data: all, error: readError } = await db.from('spice_items').select('*');
      if (readError) throw readError;
      const plan = planItemList(all || [], body.text);
      if (plan.error) return fail(plan.error);
      // Xoá trước (để đổi tên "Ớt" → "ớt" không vướng trùng tên), rồi sửa, rồi thêm.
      if (plan.deletes.length) {
        const { error } = await db.from('spice_items').delete().in('id', plan.deletes);
        if (error) throw error;
      }
      for (const u of plan.updates) {
        const { error } = await db.from('spice_items').update(u.patch).eq('id', u.id);
        if (error) throw error;
      }
      if (plan.inserts.length) {
        const { error } = await db.from('spice_items').insert(plan.inserts);
        if (error) throw error;
      }
      return ok({ total: (all || []).length - plan.deletes.length + plan.inserts.length, added: plan.inserts.length, removed: plan.deletes.length });
    }

    if (body.action === 'move_item' || body.action === 'delete_item') {
      if (!UUID.test(String(body.id || ''))) return fail('Không thấy món.');
      if (body.action === 'delete_item') {
        const { data, error } = await db.from('spice_items').delete().eq('id', body.id).select('id');
        if (error) throw error;
        if (!data?.length) return fail('Không thấy món.', 404);
        return ok({});
      }
      const { data: all, error: readError } = await db.from('spice_items').select('id, name, sort');
      if (readError) throw readError;
      for (const c of moveItem(all || [], body.id, Number(body.dir))) {
        const { error } = await db.from('spice_items').update({ sort: c.sort }).eq('id', c.id);
        if (error) throw error;
      }
      return ok({});
    }

    if (body.action === 'confirm_paid') {
      // { ids: [...], ok: true | false, note } — chủ quán xác nhận / báo không đúng lời báo đã nhận tiền của chủ gia vị.
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [body.id]).map(String))].filter(id => UUID.test(id)).slice(0, 200);
      if (!ids.length) return fail('Chưa chọn đơn nào.');
      const { data: list, error: readError } = await db.from('spice_orders').select('*').in('id', ids);
      if (readError) throw readError;
      let changed = 0, total = 0;
      const errors = [];
      for (const order of list || []) {
        const r = confirmSupplierPaid(order, body.ok !== false, { by, at, note: str(body.note, 200) });
        if (r.error) { errors.push(r.error); continue; }
        const saved = await updateOrder(db, order, r.patch, at);
        if (saved) { changed += 1; total += orderTotal(order.items); }
      }
      if (!changed && errors.length) return fail(errors[0]);
      return ok({ changed, total });
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
