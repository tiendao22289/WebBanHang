/**
 * zaloRewardServer.js — Logic quà "Quan tâm Zalo OA" chạy PHÍA SERVER.
 *
 * Dùng chung cho 2 API route:
 *  - /api/zalo/webhook     : Zalo bắn event follow / nhắn tin về
 *  - /api/zalo/claim-ready : máy khách vừa tạo yêu cầu, nhờ kiểm ngay
 *                            (bắt trường hợp khách đã follow + nhắn SĐT
 *                             TRƯỚC khi bấm nút trên web)
 *
 * CHỈ import từ server (route handler) — file này cần SERVICE_ROLE_KEY,
 * tuyệt đối không import vào component chạy trên máy khách.
 */

import { createClient } from '@supabase/supabase-js';
import { parseChannelConfig, calcReviewDiscount, getChannel } from '@/lib/reviewReward';

// Yêu cầu quá 30 phút không hoàn tất thì bỏ qua (khách đã rời quán / thử nghịch)
export const CLAIM_FRESH_MINUTES = 30;

// Khớp tự động "vừa bấm nút → vừa quan tâm" trong khung này. Ngắn để hạn chế
// trùng giữa các bàn; dài hơn 3 phút thì khách đã đi làm việc khác.
export const TIMING_MATCH_MINUTES = 3;

export function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // thiếu key → không xử lý gì (an toàn hơn là chạy bằng anon)
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Chuẩn hoá SĐT VN về dạng 0xxxxxxxxx; trả null nếu không hợp lệ. */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let p = digits;
  if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  if (p.startsWith('0084')) p = '0' + p.slice(4);
  return /^0\d{9}$/.test(p) ? p : null;
}

/** Rút SĐT đầu tiên tìm thấy trong 1 đoạn text chat. */
export function extractPhoneFromText(text) {
  const m = String(text || '').match(/(\+?84|0)[\s.\-]?(\d[\s.\-]?){8,10}\d/);
  return m ? normalizePhone(m[0]) : null;
}

/** Đọc cấu hình kênh Zalo từ settings (dùng chung parse với web). */
export async function loadZaloConfig(supabase) {
  const ch = getChannel('zalo');
  const keys = ['enabled', 'url', 'percent', 'max', 'min_bill', 'cooldown_days'].map(f => `${ch.prefix}_${f}`);
  keys.push('zalo_auto_enabled');
  const { data } = await supabase.from('settings').select('key, value').in('key', keys);
  const cfg = parseChannelConfig(data, 'zalo');
  const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  cfg.autoEnabled = map.zalo_auto_enabled === 'true';
  return cfg;
}

/** Đánh dấu yêu cầu không hợp lệ kèm lý do khách sẽ đọc được. */
export async function blockClaim(supabase, claimId, reason) {
  await supabase.from('zalo_reward_claims')
    .update({ status: 'blocked', block_reason: reason })
    .eq('id', claimId)
    .eq('status', 'waiting_follow');
}

/** Tài khoản Zalo này có đang quan tâm OA không? */
async function isFollowing(supabase, zaloUserId) {
  const { data } = await supabase
    .from('zalo_followers').select('followed_at, unfollowed_at')
    .eq('zalo_user_id', zaloUserId).maybeSingle();
  return !!data?.followed_at && !data.unfollowed_at;
}

/**
 * Tìm yêu cầu đang chờ khớp với SĐT này rồi trả quà.
 * Dùng khi khách nhắn SĐT cho OA (cách khớp chắc chắn nhất).
 */
export async function tryApplyReward(supabase, zaloUserId, phone, log = () => {}) {
  if (!(await isFollowing(supabase, zaloUserId))) {
    log(`bỏ qua: ${zaloUserId} chưa/không còn quan tâm OA`);
    return;
  }

  const freshCutoff = new Date(Date.now() - CLAIM_FRESH_MINUTES * 60000).toISOString();
  const { data: claims } = await supabase
    .from('zalo_reward_claims')
    .select('*')
    .eq('customer_phone', phone)
    .eq('status', 'waiting_follow')
    .gte('created_at', freshCutoff)
    .order('created_at', { ascending: false })
    .limit(1);
  const claim = claims?.[0];
  if (!claim) { log(`không có yêu cầu chờ cho SĐT ${phone}`); return; }

  return applyRewardToClaim(supabase, claim, zaloUserId, log);
}

/**
 * KHỚP TỰ ĐỘNG THEO THỜI GIAN — khách chỉ cần bấm Quan tâm, không phải nhắn SĐT.
 *
 * Chỉ khớp khi trong khung thời gian ngắn có ĐÚNG MỘT yêu cầu đang chờ:
 * lúc đó "người vừa quan tâm" chắc chắn là "người vừa bấm nút trên web".
 * Có 2 yêu cầu cùng lúc (2 bàn bấm gần nhau) thì KHÔNG đoán — để khách nhắn
 * SĐT cho chắc, tránh trừ tiền sai bàn.
 */
export async function tryApplyRewardByTiming(supabase, zaloUserId, log = () => {}) {
  if (!(await isFollowing(supabase, zaloUserId))) return { matched: false, reason: 'chưa quan tâm' };

  const cutoff = new Date(Date.now() - TIMING_MATCH_MINUTES * 60000).toISOString();
  const { data: claims } = await supabase
    .from('zalo_reward_claims')
    .select('*')
    .eq('status', 'waiting_follow')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(3);

  if (!claims?.length) { log('không có yêu cầu nào đang chờ để khớp theo thời gian'); return { matched: false, reason: 'không có yêu cầu' }; }
  if (claims.length > 1) {
    log(`${claims.length} yêu cầu cùng lúc → không đoán, chờ khách nhắn SĐT`);
    return { matched: false, reason: 'nhiều yêu cầu cùng lúc' };
  }

  await applyRewardToClaim(supabase, claims[0], zaloUserId, log);
  return { matched: true };
}

/**
 * Chiều ngược lại của khớp theo thời gian: đã có yêu cầu cụ thể (khách vừa
 * bấm nút / vừa quay lại web), đi tìm người VỪA quan tâm OA để ghép.
 *
 * Cũng chỉ ghép khi có ĐÚNG MỘT người vừa quan tâm và chưa gắn SĐT nào —
 * nhiều người cùng lúc thì không đoán.
 */
export async function tryApplyRewardForClaim(supabase, claim, log = () => {}) {
  const cutoff = new Date(Date.now() - TIMING_MATCH_MINUTES * 60000).toISOString();
  const { data: followers } = await supabase
    .from('zalo_followers')
    .select('zalo_user_id, phone, followed_at')
    .is('unfollowed_at', null)
    .is('phone', null)                 // chưa gắn SĐT = chưa từng ghép với ai
    .gte('followed_at', cutoff)
    .order('followed_at', { ascending: false })
    .limit(3);

  if (!followers?.length) { log('chưa thấy ai vừa quan tâm OA'); return { matched: false }; }
  if (followers.length > 1) {
    log(`${followers.length} người vừa quan tâm cùng lúc → không đoán`);
    return { matched: false, reason: 'nhiều người cùng lúc' };
  }

  await applyRewardToClaim(supabase, claim, followers[0].zalo_user_id, log);
  return { matched: true };
}

/**
 * Kiểm tra điều kiện rồi trừ tiền cho MỘT yêu cầu cụ thể.
 * Idempotent — Zalo gửi lại event cũng không trừ hai lần.
 */
async function applyRewardToClaim(supabase, claim, zaloUserId, log = () => {}) {
  const phone = claim.customer_phone;
  const cfg = await loadZaloConfig(supabase);
  if (!cfg.autoEnabled || !cfg.enabled) {
    return blockClaim(supabase, claim.id, 'Chương trình tạm ngưng, Quý khách thông cảm nhé!');
  }

  // 2) Cooldown — khoá theo cả SĐT lẫn tài khoản Zalo
  if (cfg.cooldownDays > 0) {
    const cutoff = new Date(Date.now() - cfg.cooldownDays * 86400000).toISOString();
    const { data: recent } = await supabase
      .from('zalo_reward_claims')
      .select('id')
      .eq('status', 'verified')
      .gte('verified_at', cutoff)
      .or(`customer_phone.eq.${phone},zalo_user_id.eq.${zaloUserId}`)
      .limit(1);
    if (recent?.length) {
      return blockClaim(supabase, claim.id, 'Quý khách vừa nhận quà Zalo gần đây rồi ạ. Hẹn lần ghé sau nha! 👋');
    }
  }

  // 3) Tổng bill của nhóm bàn hôm nay (server tự tính, không tin client)
  const { data: groupTables } = await supabase
    .from('tables')
    .select('id, table_type')
    .or(`id.eq.${claim.host_table_id},merged_with.eq.${claim.host_table_id}`);
  const groupIds = (groupTables || []).map(t => t.id);
  if (groupIds.length === 0) groupIds.push(claim.host_table_id);
  const hostTable = (groupTables || []).find(t => t.id === claim.host_table_id);
  const isTakeaway = hostTable?.table_type === 'takeaway';

  // 00:00 hôm nay theo GIỜ VIỆT NAM — server (Vercel) chạy UTC nên không
  // được dùng setHours(0,0,0,0) trực tiếp (sẽ thành 07:00 VN, lệch ngày).
  const vnDayKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const startOfToday = new Date(`${vnDayKey}T00:00:00.000+07:00`);
  let billsQuery = supabase
    .from('orders')
    .select('id, total_amount, customer_phone, created_at')
    .in('table_id', groupIds)
    .in('status', ['pending', 'preparing', 'completed'])
    .gte('created_at', startOfToday.toISOString())
    .order('created_at', { ascending: true });
  // Mang về: mọi khách chung 1 bàn ảo → chỉ tính bill của đúng SĐT này
  if (isTakeaway) billsQuery = billsQuery.eq('customer_phone', phone);

  const { data: groupOrders } = await billsQuery;
  const bills = (groupOrders || []).filter(o => o.customer_phone !== 'BAO_BEP');
  const total = bills.reduce((s, o) => s + (Number(o.total_amount) || 0), 0);

  if (bills.length === 0 || (cfg.minBill > 0 && total < cfg.minBill)) {
    return blockClaim(supabase, claim.id,
      `Quà này dành cho hoá đơn từ ${cfg.minBill.toLocaleString('vi-VN')}đ. Quý khách gọi thêm chút nữa rồi nhắn lại SĐT cho quán nha 😋`);
  }

  const discount = calcReviewDiscount(total, cfg);
  if (discount <= 0) {
    return blockClaim(supabase, claim.id, 'Quán chưa tính được mức giảm, Quý khách gọi nhân viên giúp ạ!');
  }

  // 4) Chốt trạng thái TRƯỚC khi trừ tiền — unique index (bàn + lượt khách)
  //    chặn nhận trùng nếu 2 event tới cùng lúc.
  const { data: locked, error: lockErr } = await supabase
    .from('zalo_reward_claims')
    .update({
      status: 'verified',
      zalo_user_id: zaloUserId,
      bill_total: total,
      discount_amount: discount,
      verified_at: new Date().toISOString(),
    })
    .eq('id', claim.id)
    .eq('status', 'waiting_follow')
    .select()
    .maybeSingle();

  if (lockErr?.code === '23505') {
    return blockClaim(supabase, claim.id, 'Bàn mình đã nhận quà Zalo trong lượt này rồi ạ. Cảm ơn Quý khách! 🥰');
  }
  if (lockErr || !locked) { log(`không chốt được yêu cầu ${claim.id}: ${lockErr?.message || 'đã xử lý nơi khác'}`); return; }

  // 5) Chèn dòng giảm giá vào bill cũ nhất của nhóm
  const targetOrderId = bills[0].id;
  const { data: item, error: itemErr } = await supabase
    .from('order_items')
    .insert({
      order_id: targetOrderId,
      menu_item_id: null,
      item_name: cfg.discountLabel,
      quantity: 1,
      unit_price: -discount,
      is_gift: false,
    })
    .select()
    .maybeSingle();

  if (itemErr || !item) {
    // Trả yêu cầu về chờ để lần sau thử lại — không "verified mà không trừ tiền"
    await supabase.from('zalo_reward_claims')
      .update({ status: 'waiting_follow', verified_at: null, discount_amount: 0 })
      .eq('id', claim.id);
    log(`chèn dòng giảm giá thất bại: ${itemErr?.message}`);
    return;
  }

  // 6) Tính lại tổng bill từ DB cho chắc
  const { data: itemsNow } = await supabase
    .from('order_items').select('unit_price, quantity').eq('order_id', targetOrderId);
  const newTotal = (itemsNow || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
  await supabase.from('orders').update({ total_amount: newTotal }).eq('id', targetOrderId);

  await supabase.from('zalo_reward_claims')
    .update({ applied_order_id: targetOrderId, applied_item_id: item.id })
    .eq('id', claim.id);

  // 7) CRM: nối tài khoản Zalo ↔ SĐT khách (cả 2 bảng) để sau này gửi
  //    tin chăm sóc đích danh. Khớp theo thời gian thì đây là chỗ DUY NHẤT
  //    biết được SĐT của người vừa quan tâm.
  try {
    await supabase.from('customers')
      .update({ zalo_user_id: zaloUserId, last_visit_at: new Date().toISOString() })
      .eq('phone', phone);
    await supabase.from('zalo_followers')
      .update({ phone }).eq('zalo_user_id', zaloUserId).is('phone', null);
  } catch (_) { /* không quan trọng bằng việc quà đã vào */ }

  log(`✅ đã giảm ${discount}đ cho SĐT ${phone} (yêu cầu ${claim.id}, order ${targetOrderId})`);
}

/** Xử lý 1 event webhook của Zalo OA. */
export async function handleZaloEvent(supabase, ev, log = () => {}) {
  const name = ev.event_name;
  const uid = ev.follower?.id || ev.sender?.id || null;
  if (!name || !uid) return;

  const now = new Date().toISOString();

  if (name === 'follow') {
    // Ghi nhận follow; giữ SĐT cũ nếu đã có (khách nhắn SĐT trước khi follow)
    const { data: existing } = await supabase
      .from('zalo_followers').select('phone').eq('zalo_user_id', uid).maybeSingle();
    await supabase.from('zalo_followers').upsert({
      zalo_user_id: uid,
      followed_at: now,
      unfollowed_at: null,
      last_event_at: now,
    }, { onConflict: 'zalo_user_id' });
    // Nhắn SĐT trước, follow sau → khớp luôn không bắt khách nhắn lại
    if (existing?.phone) {
      await tryApplyReward(supabase, uid, existing.phone, log);
      return;
    }
    // Chưa biết SĐT → khớp theo thời gian: khách chỉ cần bấm Quan tâm
    await tryApplyRewardByTiming(supabase, uid, log);
    return;
  }

  if (name === 'unfollow') {
    await supabase.from('zalo_followers')
      .update({ unfollowed_at: now, last_event_at: now })
      .eq('zalo_user_id', uid);
    return;
  }

  if (name === 'user_send_text' || name === 'user_submit_info') {
    // user_submit_info: SĐT do Zalo xác thực (khách bấm nút chia sẻ)
    // user_send_text : khách tự gõ SĐT vào chat — vẫn an toàn vì phải
    //                  ĐANG follow + khớp yêu cầu + cooldown theo tài khoản
    const phone = name === 'user_submit_info'
      ? normalizePhone(ev.info?.phone)
      : extractPhoneFromText(ev.message?.text);
    if (!phone) return;

    const { data: existing } = await supabase
      .from('zalo_followers').select('zalo_user_id').eq('zalo_user_id', uid).maybeSingle();
    if (existing) {
      await supabase.from('zalo_followers')
        .update({ phone, last_event_at: now }).eq('zalo_user_id', uid);
    } else {
      // Nhắn tin nhưng chưa từng follow → lưu SĐT chờ, followed_at để trống
      await supabase.from('zalo_followers')
        .insert({ zalo_user_id: uid, phone, followed_at: null, last_event_at: now });
    }
    await tryApplyReward(supabase, uid, phone, log);
  }
}
