/**
 * /api/lucky/spin — Quay vòng xoay may mắn.
 *
 * VÌ SAO ĐẶT Ở SERVER: kết quả quay và việc trừ tiền phải nằm ngoài tầm
 * với của máy khách. Bảng lucky_spins chỉ cho anon ĐỌC, mọi thao tác ghi
 * đi qua route này bằng SERVICE_ROLE_KEY, nên khách không thể tự tạo lượt
 * quay, tự chọn giải nhất hay tự bớt tiền.
 *
 * Client gửi lên: { tableId, name, phone }
 * Server tự làm: kiểm tra điều kiện → quay theo trọng số → LƯU lượt quay ở
 * trạng thái chờ. Quà chỉ vào hoá đơn sau khi khách Quan tâm Zalo OA và
 * webhook Zalo xác nhận (giống ưu đãi Quan tâm Zalo).
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  drawLuckyPrize, calcLuckyDiscount, fetchLuckyPrizes,
  LUCKY_SETTING_KEYS, parseLuckyConfig,
} from '@/lib/luckyWheel';

export const dynamic = 'force-dynamic';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let p = digits;
  if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  return /^0\d{9}$/.test(p) ? p : null;
}

function fail(message) {
  return NextResponse.json({ ok: false, message });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const tableId = String(body.tableId || '').trim();
    const name = String(body.name || '').trim();
    const phone = normalizePhone(body.phone);

    if (!tableId) return fail('Thiếu thông tin bàn, Quý khách quét lại mã giúp quán nhé!');
    if (!name) return fail('Quý khách cho quán xin tên với ạ 😊');
    if (!phone) return fail('Số điện thoại chưa đúng ạ — Quý khách nhập 10 số giúp quán nhé.');

    const supabase = getServiceClient();
    if (!supabase) {
      console.error('[Lucky] Thiếu SUPABASE_SERVICE_ROLE_KEY');
      return fail('Quán chưa mở được vòng xoay, Quý khách gọi nhân viên giúp ạ!');
    }

    // ── Cấu hình ────────────────────────────────────────────────
    const { data: settingRows } = await supabase
      .from('settings').select('key, value').in('key', LUCKY_SETTING_KEYS);
    const cfg = parseLuckyConfig(settingRows);
    if (!cfg.enabled) return fail('Vòng xoay đang tạm nghỉ, Quý khách thông cảm nhé!');

    // ── Bàn + nhóm bàn gộp ──────────────────────────────────────
    const { data: table } = await supabase
      .from('tables').select('id, merged_with, table_type, occupied_at').eq('id', tableId).maybeSingle();
    if (!table) return fail('Không tìm thấy bàn, Quý khách quét lại mã giúp quán ạ!');

    const hostId = table.merged_with || table.id;
    const { data: groupTables } = await supabase
      .from('tables').select('id, table_type').or(`id.eq.${hostId},merged_with.eq.${hostId}`);
    const groupIds = (groupTables || []).map(t => t.id);
    if (groupIds.length === 0) groupIds.push(hostId);
    const isTakeaway = (groupTables || []).find(t => t.id === hostId)?.table_type === 'takeaway';

    // Mốc 00:00 hôm nay theo giờ VN (server chạy UTC nên phải quy đổi rõ)
    const vnDayKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const startOfToday = new Date(`${vnDayKey}T00:00:00.000+07:00`);

    // ── Đã quay trong lượt khách này chưa ───────────────────────
    // Mang về: mọi khách dùng chung 1 bàn ảo → xét theo SĐT trong ngày.
    if (isTakeaway) {
      const { data: spun } = await supabase
        .from('lucky_spins').select('id')
        .eq('customer_phone', phone)
        .gte('created_at', startOfToday.toISOString())
        .limit(1);
      if (spun?.length) return fail('Quý khách đã quay hôm nay rồi ạ. Hẹn lần ghé sau nha! 👋');
    } else {
      const sessionStart = table.occupied_at || startOfToday.toISOString();
      const { data: spun } = await supabase
        .from('lucky_spins').select('id')
        .eq('host_table_id', hostId)
        .gte('created_at', sessionStart)
        .limit(1);
      if (spun?.length) return fail('Bàn mình đã quay một lượt rồi ạ. Cảm ơn Quý khách nhiều nha! 🥰');
    }

    // ── Cooldown theo số điện thoại ─────────────────────────────
    if (cfg.cooldownDays > 0) {
      const cutoff = new Date(Date.now() - cfg.cooldownDays * 86400000).toISOString();
      const { data: recent } = await supabase
        .from('lucky_spins').select('id')
        .eq('customer_phone', phone)
        .gte('created_at', cutoff)
        .limit(1);
      if (recent?.length) return fail('Số này vừa quay gần đây rồi ạ. Hẹn Quý khách lần sau nha! 👋');
    }

    // ── Tổng bill hôm nay của nhóm bàn ──────────────────────────
    let billsQuery = supabase
      .from('orders')
      .select('id, total_amount, customer_phone, created_at')
      .in('table_id', groupIds)
      .in('status', ['pending', 'preparing', 'completed'])
      .gte('created_at', startOfToday.toISOString())
      .order('created_at', { ascending: true });
    if (isTakeaway) billsQuery = billsQuery.eq('customer_phone', phone);

    const { data: orders } = await billsQuery;
    const bills = (orders || []).filter(o => o.customer_phone !== 'BAO_BEP');
    const total = bills.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);

    if (bills.length === 0) {
      return fail('Quý khách gọi vài món trước nha, rồi quay là quà vào hoá đơn liền 😊');
    }
    if (cfg.minBill > 0 && total < cfg.minBill) {
      return fail(`Vòng xoay dành cho hoá đơn từ ${cfg.minBill.toLocaleString('vi-VN')}đ ạ. Quý khách gọi thêm chút nữa nhé 😋`);
    }

    // ── Lưu thông tin khách (mục tiêu chính: có data để chăm sóc) ──
    try {
      const { data: existing } = await supabase
        .from('customers').select('id, name').eq('phone', phone).maybeSingle();
      if (existing) {
        await supabase.from('customers')
          .update({ name: name || existing.name, last_visit_at: new Date().toISOString() })
          .eq('id', existing.id);
      } else {
        await supabase.from('customers')
          .insert({ name, phone, last_visit_at: new Date().toISOString() });
      }
    } catch (_) { /* không để lỗi CRM cản việc quay */ }

    // ── QUAY ────────────────────────────────────────────────────
    // Cơ cấu quà lấy từ bảng lucky_prizes (Admin > Cài đặt sửa được)
    const prizes = await fetchLuckyPrizes(supabase);
    const prize = drawLuckyPrize(prizes);
    if (!prize) return fail('Quán chưa cài phần quà nào, Quý khách gọi nhân viên giúp ạ!');
    const discount = calcLuckyDiscount(total, prize, cfg.max);

    // Chốt lượt quay TRƯỚC khi ghi vào bill — unique index (bàn + lượt
    // khách) chặn hai máy bấm cùng lúc.
    const { data: spin, error: spinErr } = await supabase
      .from('lucky_spins')
      .insert({
        table_id: tableId,
        host_table_id: hostId,
        customer_name: name,
        customer_phone: phone,
        prize_key: String(prize.id),
        prize_type: prize.type,
        prize_value: prize.value,
        prize_label: prize.label,
        bill_total: total,
        discount_amount: discount,
        // Tắt yêu cầu quan tâm Zalo trong Cài đặt thì áp quà ngay
        status: cfg.requireFollow ? 'waiting_follow' : 'pending_apply',
      })
      .select()
      .maybeSingle();

    if (spinErr?.code === '23505') {
      return fail('Bàn mình đã quay một lượt rồi ạ 🥰');
    }
    if (spinErr || !spin) {
      console.error('[Lucky] insert lỗi:', spinErr);
      return fail('Quán chưa ghi nhận được, Quý khách thử lại giúp ạ!');
    }

    // Không yêu cầu quan tâm Zalo → áp quà vào hoá đơn ngay tại đây
    if (!cfg.requireFollow) {
      await supabase.from('lucky_spins')
        .update({ status: 'waiting_follow' }).eq('id', spin.id);
      const { applyLuckySpin } = await import('@/lib/zaloRewardServer');
      await applyLuckySpin(supabase, { ...spin, status: 'waiting_follow' }, null,
        (m) => console.log('[Lucky]', m));
    }

    // Còn lại: quà CHƯA vào hoá đơn. Khách phải Quan tâm Zalo OA trước —
    // webhook Zalo xác nhận rồi server mới áp quà (applyLuckySpin trong
    // lib/zaloRewardServer.js). Nhờ vậy quà luôn đi kèm lượt quan tâm thật.
    return NextResponse.json({
      ok: true,
      spinId: spin.id,
      prizeKey: prize.key,
      prizeType: prize.type,
      prizeLabel: prize.label,
      discountAmount: discount,   // số tiền dự kiến, chốt lại lúc áp
      billTotal: total,
      needFollow: cfg.requireFollow,
    });
  } catch (err) {
    console.error('[Lucky] lỗi:', err);
    return fail('Quán gặp lỗi nhỏ, Quý khách thử lại giúp ạ!');
  }
}
