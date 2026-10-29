/**
 * /api/admin/vouchers — voucher tặng khách (xem src/lib/voucher.mjs, supabase/migrations/vouchers.sql).
 *
 * Nhân viên (trang Bàn):
 *   POST { action: 'lookup', phones }          mã còn dùng được của SĐT trên bill
 *   POST { action: 'redeem', code, orderIds }  dùng mã: trừ thẳng vào bill (SQL redeem_voucher)
 * Chủ quán (trang Voucher):
 *   GET  ?view=list | customers | config
 *   POST { action: 'create', ... }             tạo mã tặng khách (mỗi khách 1 mã, hoặc N mã không tên)
 *   POST { action: 'send', ids, force? }       nhắn mã qua Zalo OA
 *   POST { action: 'cancel', id }              huỷ mã chưa dùng
 *   POST { action: 'config', config }          lưu cài đặt "Hẹn lần sau"
 *
 * Bảng vouchers chỉ service role đọc/ghi; route kiểm cookie đăng nhập do máy chủ ký.
 */
import { NextResponse } from 'next/server';
import { getStaffSession, statusDatabase } from '@/lib/statusAuth';
import { sendOaText } from '@/lib/zaloOa';
import {
  normalizeVoucherCode, normalizePhone, giftWindow, fillVoucherMessage, GIFT_MESSAGE_TEMPLATE,
  NEXT_VOUCHER_KEYS, checkNextVoucherConfig, parseNextVoucherConfig,
} from '@/lib/voucher.mjs';
import {
  activeVouchersForPhones, insertVoucher, loadNextVoucherConfig, sendVoucherZalo,
} from '@/lib/voucherServer.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const fail = (error, status = 400) => NextResponse.json({ error }, { status, headers });
const missingTable = error => ['PGRST205', '42P01', '42883', 'PGRST202'].includes(error?.code);
const NOT_INSTALLED = 'Chưa cài bảng voucher trên máy chủ (migration vouchers.sql).';
const log = m => console.log('[vouchers]', m);

async function staff(request) {
  const session = await getStaffSession(request);
  return session.code === 200 ? session.user : { denied: session.code };
}

export async function GET(request) {
  const user = await staff(request);
  if (user.denied) return fail('Chưa đăng nhập.', user.denied);
  if (user.role !== 'admin') return fail('Chỉ chủ quán xem được trang Voucher.', 403);
  const db = statusDatabase();
  const view = new URL(request.url).searchParams.get('view') || 'list';
  try {
    if (view === 'config') {
      return NextResponse.json({ config: await loadNextVoucherConfig(db) }, { headers });
    }
    if (view === 'customers') {
      const [customers, followers] = await Promise.all([
        db.from('customers').select('id, name, phone, visit_count, total_spent, last_visit_at, zalo_user_id')
          .order('last_visit_at', { ascending: false, nullsFirst: false }).limit(3000),
        db.from('zalo_followers').select('phone, unfollowed_at').not('phone', 'is', null).limit(5000),
      ]);
      if (customers.error) throw customers.error;
      const zaloPhones = new Set((followers.data || []).filter(f => !f.unfollowed_at).map(f => f.phone));
      return NextResponse.json({
        customers: (customers.data || []).map(c => ({
          id: c.id, name: c.name, phone: c.phone, visits: c.visit_count || 0, spent: c.total_spent || 0,
          lastVisitAt: c.last_visit_at, hasZalo: !!c.zalo_user_id || zaloPhones.has(c.phone),
        })),
      }, { headers });
    }
    // Danh sách + thống kê: mã tạo trong 120 ngày gần nhất.
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const { data, error } = await db.from('vouchers')
      .select('id, code, source, batch_name, discount_type, discount_value, max_discount, min_bill, valid_from, valid_until, customer_phone, customer_name, message, status, used_at, used_by_name, used_table_id, discount_amount, bill_total, sent_at, send_error, created_at, created_by_name')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(3000);
    if (error) {
      if (missingTable(error)) return NextResponse.json({ vouchers: [], notInstalled: true }, { headers });
      throw error;
    }
    const tableIds = [...new Set((data || []).map(v => v.used_table_id).filter(Boolean))];
    let tableNumbers = {};
    if (tableIds.length) {
      const { data: tables } = await db.from('tables').select('id, table_number').in('id', tableIds);
      tableNumbers = Object.fromEntries((tables || []).map(t => [t.id, t.table_number]));
    }
    return NextResponse.json({
      vouchers: (data || []).map(v => ({ ...v, used_table_number: tableNumbers[v.used_table_id] ?? null })),
    }, { headers });
  } catch (error) {
    console.error('[vouchers] GET', error);
    return fail('Không tải được dữ liệu voucher, thử lại.', 500);
  }
}

export async function POST(request) {
  const user = await staff(request);
  if (user.denied) return fail('Chưa đăng nhập.', user.denied);
  const body = await request.json().catch(() => ({}));
  const db = statusDatabase();
  const action = body.action;
  try {
    if (action === 'lookup') {
      const phones = Array.isArray(body.phones) ? body.phones : [];
      const vouchers = await activeVouchersForPhones(db, phones).catch(error => {
        if (missingTable(error)) return [];
        throw error;
      });
      return NextResponse.json({ vouchers }, { headers });
    }

    if (action === 'redeem') {
      const code = normalizeVoucherCode(body.code);
      if (!code) return fail('Mã voucher gồm 6 ký tự sau chữ BK, ví dụ BK-7K3P9X.');
      const orderIds = (Array.isArray(body.orderIds) ? body.orderIds : []).filter(id => UUID.test(id));
      if (!orderIds.length || orderIds.length > 50) return fail('Bàn chưa có bill để trừ voucher.');
      const { data, error } = await db.rpc('redeem_voucher', {
        p_code: code, p_order_ids: orderIds, p_staff_id: user.id, p_staff_name: user.full_name || null,
      });
      if (error) {
        if (missingTable(error)) return fail(NOT_INSTALLED, 503);
        throw error;
      }
      return NextResponse.json(data || { ok: false }, { headers });
    }

    if (user.role !== 'admin') return fail('Chỉ chủ quán làm được thao tác này.', 403);

    if (action === 'create') {
      const type = body.type === 'percent' ? 'percent' : 'amount';
      const value = Math.round(Number(body.value) || 0);
      const max = type === 'percent' ? Math.max(0, Math.round(Number(body.max) || 0)) : 0;
      const minBill = Math.max(0, Math.round(Number(body.minBill) || 0));
      if (type === 'percent' && !(value >= 1 && value <= 100)) return fail('% giảm phải từ 1 đến 100.');
      if (type === 'amount' && !(value >= 1000)) return fail('Số tiền giảm phải từ 1.000đ.');
      if (!DAY.test(body.fromDay || '') || !DAY.test(body.toDay || '')) return fail('Chọn ngày bắt đầu và ngày hết hạn.');
      const win = giftWindow(body.fromDay, body.toDay);
      if (!win) return fail('Ngày hết hạn phải sau ngày bắt đầu và chưa qua.');
      const template = String(body.message || GIFT_MESSAGE_TEMPLATE).slice(0, 1000);
      const batchName = String(body.batchName || '').trim().slice(0, 80) || 'Tặng khách';

      // Người nhận: danh sách khách (mỗi người 1 mã gắn SĐT) hoặc N mã không tên.
      const recipients = [];
      for (const r of Array.isArray(body.recipients) ? body.recipients.slice(0, 500) : []) {
        const phone = normalizePhone(r?.phone);
        if (phone && !recipients.some(x => x.phone === phone)) recipients.push({ phone, name: String(r.name || '').trim().slice(0, 60) || null });
      }
      const blank = Math.min(200, Math.max(0, Math.round(Number(body.count) || 0)));
      if (!recipients.length && !blank) return fail('Chọn khách nhận voucher, hoặc nhập số mã cần tạo.');

      const base = {
        source: 'gift', batch_name: batchName, discount_type: type, discount_value: value, max_discount: max,
        min_bill: minBill, valid_from: win.validFrom, valid_until: win.validUntil, created_by_name: user.full_name || null,
      };
      const created = [];
      const targets = recipients.length ? recipients : Array.from({ length: blank }, () => ({ phone: null, name: null }));
      for (const r of targets) {
        const row = { ...base, customer_phone: r.phone, customer_name: r.name };
        const voucher = await insertVoucher(db, row);
        const message = fillVoucherMessage(template, voucher);
        await db.from('vouchers').update({ message }).eq('id', voucher.id);
        created.push({ ...voucher, message });
      }
      return NextResponse.json({ vouchers: created }, { headers });
    }

    if (action === 'send') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter(id => UUID.test(id)).slice(0, 200);
      if (!ids.length) return fail('Chọn mã cần gửi.');
      const { data, error } = await db.from('vouchers').select('*').in('id', ids);
      if (error) throw error;
      const results = [];
      for (const v of data || []) {
        if (v.status !== 'active') { results.push({ id: v.id, ok: false, message: 'Mã đã dùng / đã huỷ.' }); continue; }
        if (!v.customer_phone) { results.push({ id: v.id, ok: false, message: 'Mã chưa gắn SĐT — chép tin để gửi tay.' }); continue; }
        const r = await sendVoucherZalo(db, v, { send: sendOaText, force: !!body.force, log });
        results.push({ id: v.id, ...r });
      }
      return NextResponse.json({ results }, { headers });
    }

    if (action === 'cancel') {
      if (!UUID.test(body.id || '')) return fail('Thiếu mã cần huỷ.');
      const { data, error } = await db.from('vouchers').update({ status: 'cancelled' })
        .eq('id', body.id).eq('status', 'active').select('id').maybeSingle();
      if (error) throw error;
      if (!data) return fail('Mã đã dùng hoặc đã huỷ rồi.');
      return NextResponse.json({ ok: true }, { headers });
    }

    if (action === 'config') {
      const c = body.config || {};
      const cfg = parseNextVoucherConfig(Object.entries({
        voucher_next_enabled: c.enabled ? 'true' : 'false',
        voucher_next_min_bill: c.minBill, voucher_next_type: c.type, voucher_next_value: c.value,
        voucher_next_max: c.max, voucher_next_use_min_bill: c.useMinBill, voucher_next_days: c.days,
        voucher_next_repeat: c.repeat ? 'true' : 'false',
      }).map(([key, value]) => ({ key, value: value == null ? '' : String(value) })));
      const problem = checkNextVoucherConfig(cfg);
      if (problem) return fail(problem);
      const rows = {
        voucher_next_enabled: String(cfg.enabled), voucher_next_min_bill: String(cfg.minBill),
        voucher_next_type: cfg.type, voucher_next_value: String(cfg.value), voucher_next_max: String(cfg.max),
        voucher_next_use_min_bill: String(cfg.useMinBill), voucher_next_days: String(cfg.days),
        voucher_next_repeat: String(cfg.repeat),
      };
      const { error } = await db.from('settings')
        .upsert(NEXT_VOUCHER_KEYS.map(key => ({ key, value: rows[key] })), { onConflict: 'key' });
      if (error) throw error;
      return NextResponse.json({ config: cfg }, { headers });
    }

    return fail('Thao tác không hợp lệ.');
  } catch (error) {
    console.error('[vouchers] POST', action, error);
    if (missingTable(error)) return fail(NOT_INSTALLED, 503);
    return fail(error?.message && /voucher/i.test(error.message) ? error.message : 'Không lưu được, thử lại giúp nhé.', 500);
  }
}
