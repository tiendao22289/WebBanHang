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
import { luckyItemName, calcLuckyDiscount, LUCKY_SETTING_KEYS, parseLuckyConfig, isGiftPrizeType } from '@/lib/luckyWheel';

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
 * Zalo chỉ cho biết TÀI KHOẢN vừa quan tâm, không cho SĐT, nên phải suy ra
 * "ai vừa bấm nút trên web" bằng thời gian: ghép với yêu cầu đang chờ LÂU
 * NHẤT trong khung TIMING_MATCH_MINUTES (ai bấm trước phục vụ trước).
 *
 * Vì sao ghép theo thứ tự vẫn công bằng khi 2 bàn bấm gần nhau: mỗi lượt
 * quan tâm thật chỉ trả đúng MỘT phần quà, nên tổng quà trao ra luôn bằng
 * tổng lượt quan tâm — không phát thừa. Bàn còn lại nhận ngay khi khách của
 * họ bấm quan tâm.
 */
export async function tryApplyRewardByTiming(supabase, zaloUserId, log = () => {}) {
  if (!(await isFollowing(supabase, zaloUserId))) return { matched: false, reason: 'chưa quan tâm' };

  const cutoff = new Date(Date.now() - TIMING_MATCH_MINUTES * 60000).toISOString();
  const { data: claims } = await supabase
    .from('zalo_reward_claims')
    .select('*')
    .eq('status', 'waiting_follow')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true })   // chờ lâu nhất được ghép trước
    .limit(1);

  if (!claims?.length) { log('không có yêu cầu nào đang chờ để khớp theo thời gian'); return { matched: false, reason: 'không có yêu cầu' }; }

  await applyRewardToClaim(supabase, claims[0], zaloUserId, log);
  return { matched: true };
}

/**
 * Chiều ngược lại của khớp theo thời gian: đã có yêu cầu cụ thể (khách vừa
 * bấm nút / vừa quay lại web), đi tìm người VỪA quan tâm OA để ghép.
 *
 * Chỉ xét người CHƯA gắn SĐT (tức chưa từng được ghép với yêu cầu nào), và
 * lấy người quan tâm sớm nhất — cùng nguyên tắc trước/sau như chiều kia.
 */
export async function tryApplyRewardForClaim(supabase, claim, log = () => {}) {
  const cutoff = new Date(Date.now() - TIMING_MATCH_MINUTES * 60000).toISOString();
  const { data: followers } = await supabase
    .from('zalo_followers')
    .select('zalo_user_id, phone, followed_at')
    .is('unfollowed_at', null)
    .is('phone', null)                 // chưa gắn SĐT = chưa từng ghép với ai
    .gte('followed_at', cutoff)
    .order('followed_at', { ascending: true })  // quan tâm sớm nhất ghép trước
    .limit(1);

  if (!followers?.length) { log('chưa thấy ai vừa quan tâm OA'); return { matched: false }; }

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

  // ── CHẶN TRÙNG DỰA TRÊN CHÍNH BILL ─────────────────────────────
  // Đây là lớp chặn cuối và chắc nhất: dù bảng yêu cầu bị xoá (lúc thử
  // nghiệm), mốc lượt khách bị trống làm ràng buộc trong DB vô hiệu, hay
  // hai luồng xử lý chạy song song — nếu bill của bàn ĐÃ có dòng giảm giá
  // Zalo thì không giảm thêm lần nữa.
  const { data: dupLines } = await supabase
    .from('order_items')
    .select('id')
    .in('order_id', bills.map(b => b.id))
    .ilike('item_name', '%Zalo%')
    .lt('unit_price', 0)
    .limit(1);
  if (dupLines?.length) {
    log(`bàn đã có dòng giảm giá Zalo trong bill → bỏ qua yêu cầu ${claim.id}`);
    return blockClaim(supabase, claim.id, 'Bàn mình đã nhận quà Zalo cho hoá đơn này rồi ạ. Cảm ơn Quý khách nhiều nha! 🥰');
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

// ==============================================================
//  VONG XOAY MAY MAN - qua chi vao hoa don sau khi khach quan tam OA
// ==============================================================

/** Danh dau luot quay khong dung duoc, kem ly do khach doc. */
async function blockSpin(supabase, spinId, reason) {
  await supabase.from('lucky_spins')
    .update({ status: 'blocked', block_reason: reason })
    .eq('id', spinId)
    .eq('status', 'waiting_follow');
}

/** Lay cac bill (orders) hom nay cua nhom ban ung voi 1 luot quay — dung
 * chung cho ca buoc tinh tong bill lan buoc chot qua cu the sau nay. */
async function getSpinBills(supabase, spin) {
  const { data: groupTables } = await supabase
    .from('tables').select('id, table_type')
    .or(`id.eq.${spin.host_table_id},merged_with.eq.${spin.host_table_id}`);
  const groupIds = (groupTables || []).map(t => t.id);
  if (groupIds.length === 0) groupIds.push(spin.host_table_id);
  const isTakeaway = (groupTables || []).find(t => t.id === spin.host_table_id)?.table_type === 'takeaway';

  const vnDayKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const startOfToday = new Date(`${vnDayKey}T00:00:00.000+07:00`);
  let billsQuery = supabase
    .from('orders')
    .select('id, total_amount, customer_phone, created_at')
    .in('table_id', groupIds)
    .in('status', ['pending', 'preparing', 'completed'])
    .gte('created_at', startOfToday.toISOString())
    .order('created_at', { ascending: true });
  if (isTakeaway) billsQuery = billsQuery.eq('customer_phone', spin.customer_phone);

  const { data: orders } = await billsQuery;
  return (orders || []).filter(o => o.customer_phone !== 'BAO_BEP');
}

/**
 * Chen dong qua THAT vao bill cho mon/nuoc khach da chon cu the
 * (spin.gift_menu_item_id) — dung cho qua loai gift_drink/gift_dish. Neu
 * khach CHUA chon xong (gift_menu_item_id van null) thi bo qua, khong lam
 * gi ca — pickGiftItem() se goi lai ham nay ngay khi khach chon. Co the bi
 * goi tu 2 huong (webhook Zalo xac nhan truoc, hoac khach chon mon truoc)
 * nhung khong bao gio ghi 2 lan vi applied_item_id chi duoc set dung 1 lan.
 */
export async function finalizeGiftItem(supabase, spin, targetOrderId, log = () => {}) {
  if (!spin.gift_menu_item_id || spin.applied_item_id) return null;

  // Số lượng tặng do Admin cấu hình trên chính phần quà (Cài đặt > Vòng
  // xoay > Số lượng tặng) — chốt lúc quay (spin.prize_value), không đổi
  // theo cấu hình sau này. Ghi chú rõ nguồn gốc để bếp/thu ngân không nhầm
  // với món tặng của khuyến mãi khác.
  const { data: item, error: itemErr } = await supabase
    .from('order_items')
    .insert({
      order_id: targetOrderId,
      menu_item_id: spin.gift_menu_item_id,
      item_options: spin.gift_item_options || [],
      quantity: Number(spin.prize_value) || 1,
      unit_price: 0,
      is_gift: true,
      note: 'Quà tặng từ vòng quay may mắn',
    })
    .select()
    .maybeSingle();

  if (itemErr || !item) {
    log(`ghi mon qua vong xoay that bai: ${itemErr?.message}`);
    return null;
  }

  await supabase.from('lucky_spins').update({ applied_item_id: item.id }).eq('id', spin.id);
  return item;
}

/**
 * Khach chon xong mon/nuoc cu the cho qua gift_drink/gift_dish — luu lua
 * chon, roi neu Zalo da xac nhan xong tu truoc (status da 'applied' nhung
 * applied_item_id con trong vi luc do chua co lua chon) thi ghi luon vao
 * bill tai day. Goi tu route /api/lucky/pick-gift.
 */
export async function pickGiftItem(supabase, spinId, menuItemId, itemOptions, log = () => {}) {
  const { data: spin } = await supabase.from('lucky_spins').select('*').eq('id', spinId).maybeSingle();
  if (!spin) return { ok: false, message: 'Không tìm thấy lượt quay, Quý khách quay lại giúp ạ!' };
  if (!isGiftPrizeType(spin.prize_type)) return { ok: false, message: 'Quà này không cần chọn món ạ.' };
  if (spin.applied_item_id) return { ok: false, message: 'Quà đã vào hoá đơn rồi ạ, cảm ơn Quý khách!' };
  if (spin.status === 'blocked') return { ok: false, message: spin.block_reason || 'Lượt quay này không dùng được nữa ạ.' };

  // Tu tinh lai danh sach hop le o server — khong tin menuItemId client gui
  // len nam dung danh sach khach nhin thay (chan sua request chon mon khac).
  let allowedIds;
  if (spin.prize_type === 'gift_dish') {
    const { data: giftItems } = await supabase
      .from('menu_items').select('id').eq('is_gift_item', true).eq('is_available', true);
    allowedIds = new Set((giftItems || []).map(i => i.id));
  } else {
    const { data: setting } = await supabase
      .from('settings').select('value').eq('key', 'lucky_wheel_drink_item_ids').maybeSingle();
    try { allowedIds = new Set(JSON.parse(setting?.value || '[]')); } catch { allowedIds = new Set(); }
  }
  if (!allowedIds.has(menuItemId)) {
    return { ok: false, message: 'Món này không nằm trong danh sách được tặng ạ.' };
  }

  const cleanOptions = Array.isArray(itemOptions) ? itemOptions : [];
  const { error: updErr } = await supabase.from('lucky_spins')
    .update({ gift_menu_item_id: menuItemId, gift_item_options: cleanOptions })
    .eq('id', spinId);
  if (updErr) return { ok: false, message: 'Quán chưa lưu được, Quý khách thử lại giúp ạ!' };

  // Zalo da xac nhan tu truoc (status='applied' do claim_lucky_wheel_slot),
  // chi con thieu dung buoc chon mon — ghi vao bill ngay bay gio.
  if (spin.status === 'applied') {
    const bills = await getSpinBills(supabase, spin);
    if (bills.length === 0) {
      return { ok: false, message: 'Hoá đơn của bàn đã thanh toán nên quán chưa áp quà được ạ.' };
    }
    const targetOrderId = spin.applied_order_id || bills[0].id;
    const item = await finalizeGiftItem(
      supabase,
      { ...spin, gift_menu_item_id: menuItemId, gift_item_options: cleanOptions },
      targetOrderId, log
    );
    return { ok: true, applied: !!item };
  }

  return { ok: true, applied: false };
}

/** Ghi qua cua mot luot quay vao hoa don. Idempotent. */
export async function applyLuckySpin(supabase, spin, zaloUserId, log = () => {}) {
  // Quà đã chốt lúc quay — đọc lại từ chính lượt quay để cơ cấu quà có
  // thay đổi sau đó cũng không làm sai phần khách đã trúng.
  const prize = {
    label: spin.prize_label,
    type: spin.prize_type,
    value: Number(spin.prize_value) || 0,
  };

  const { data: settingRows } = await supabase
    .from('settings').select('key, value').in('key', LUCKY_SETTING_KEYS);
  const cfg = parseLuckyConfig(settingRows);

  // Tai khoan Zalo nay da nhan qua vong xoay gan day chua — chan viec dung
  // nhieu SDT khac nhau nhung cung 1 tai khoan Zalo that de quay/nhan lap lai.
  if (zaloUserId && cfg.cooldownDays > 0) {
    const zaloCutoff = new Date(Date.now() - cfg.cooldownDays * 86400000).toISOString();
    const { data: recentZalo } = await supabase
      .from('lucky_spins').select('id')
      .eq('zalo_user_id', zaloUserId)
      .eq('status', 'applied')
      .gte('verified_at', zaloCutoff)
      .limit(1);
    if (recentZalo?.length) {
      return blockSpin(supabase, spin.id, 'Tai khoan Zalo nay da nhan qua vong xoay gan day roi a, hen Quy khach lan sau nha! 👋');
    }
  }

  // Bill cua nhom ban, tinh lai tu dau (khong tin so cu luc quay)
  const bills = await getSpinBills(supabase, spin);
  if (bills.length === 0) {
    return blockSpin(supabase, spin.id, 'Hoa don cua ban da thanh toan nen quan chua ap qua duoc a.');
  }

  const total = bills.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
  const isGift = isGiftPrizeType(prize.type);
  const discount = calcLuckyDiscount(total, prize, cfg.max);
  if (!isGift && discount <= 0) {
    return blockSpin(supabase, spin.id, 'Quan chua tinh duoc muc giam, Quy khach goi nhan vien giup a!');
  }

  // Chot 1 SLOT duy nhat cho bill nay — RPC co pg_advisory_xact_lock theo
  // host_table_id, gop lam 2 viec trong CUNG 1 khoa: (1) kiem tra bill da co
  // luot quay nao khac 'applied' chua (dua tren applied_order_id, quan he
  // that, khong con dua vao so khop chu 'VONG XOAY' de tranh loi dau cau),
  // (2) chot trang thai waiting_follow -> applied. Nho co khoa, 2 khach
  // cung ban bam Quan tam Zalo dung 1 luc cung KHONG the ca 2 deu qua duoc
  // buoc kiem tra roi cung ghi tien vao bill — chi 1 nguoi thang.
  const targetOrderId = bills[0].id;
  const { data: claimed } = await supabase.rpc('claim_lucky_wheel_slot', {
    p_spin_id: spin.id,
    p_host_table_id: spin.host_table_id,
    p_check_order_ids: bills.map(b => b.id),
    p_target_order_id: targetOrderId,
    p_zalo_user_id: zaloUserId,
    p_bill_total: total,
    p_discount_amount: discount,
  });
  if (!claimed) {
    return blockSpin(supabase, spin.id, '1 hoa don chi duoc nhan 1 lan qua vong xoay - ban minh da nhan roi a!');
  }

  if (isGift) {
    // Slot da chot (status='applied', khong ai khac gianh duoc nua) — nhung
    // CHI ghi dong bill neu khach da chon xong mon/nuoc cu the. Neu Zalo xac
    // nhan nhanh hon luc khach chon (hay gap khi tat "phai Quan tam Zalo" —
    // ap qua chay NGAY luc quay, truoc khi khach kip thay man hinh chon mon),
    // cu de trong — pickGiftItem() se ghi bill ngay khi khach chon xong, KHONG
    // mat qua, KHONG ghi nhan chung chung nua.
    await finalizeGiftItem(supabase, spin, targetOrderId, log);
  } else {
    const { data: item, error: itemErr } = await supabase
      .from('order_items')
      .insert({
        order_id: targetOrderId,
        menu_item_id: null,
        item_name: luckyItemName(prize),
        quantity: 1,
        unit_price: -discount,
        is_gift: false,
      })
      .select()
      .maybeSingle();

    if (itemErr || !item) {
      // Tra lai slot vua chot — khong "applied" ma khong co dong tien nao ca
      await supabase.from('lucky_spins')
        .update({ status: 'waiting_follow', verified_at: null, applied_order_id: null }).eq('id', spin.id);
      log(`ghi qua vong xoay that bai: ${itemErr?.message}`);
      return;
    }

    const { data: itemsNow } = await supabase
      .from('order_items').select('unit_price, quantity').eq('order_id', targetOrderId);
    const newTotal = (itemsNow || []).reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', targetOrderId);

    await supabase.from('lucky_spins')
      .update({ applied_item_id: item.id })
      .eq('id', spin.id);
  }

  try {
    await supabase.from('customers')
      .update({ zalo_user_id: zaloUserId, last_visit_at: new Date().toISOString() })
      .eq('phone', spin.customer_phone);
    await supabase.from('zalo_followers')
      .update({ phone: spin.customer_phone }).eq('zalo_user_id', zaloUserId).is('phone', null);
  } catch (_) { }

  log(`da ap qua vong xoay "${prize.label}" cho luot quay ${spin.id}`);
}

/**
 * Nguoi nay vua quan tam OA -> tim luot quay dang cho de ap qua.
 * Cung nguyen tac truoc/sau nhu uu dai Zalo: luot cho lau nhat duoc ap truoc.
 */
export async function tryApplyLuckyByTiming(supabase, zaloUserId, log = () => {}) {
  if (!(await isFollowing(supabase, zaloUserId))) return { matched: false };

  const cutoff = new Date(Date.now() - TIMING_MATCH_MINUTES * 60000).toISOString();
  const { data: spins } = await supabase
    .from('lucky_spins')
    .select('*')
    .eq('status', 'waiting_follow')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(1);

  if (!spins?.length) return { matched: false };
  await applyLuckySpin(supabase, spins[0], zaloUserId, log);
  return { matched: true };
}

/** Chieu nguoc: co luot quay cu the, tim nguoi vua quan tam de ghep. */
export async function tryApplyLuckyForSpin(supabase, spin, log = () => {}) {
  const cutoff = new Date(Date.now() - TIMING_MATCH_MINUTES * 60000).toISOString();
  const { data: followers } = await supabase
    .from('zalo_followers')
    .select('zalo_user_id')
    .is('unfollowed_at', null)
    .not('followed_at', 'is', null)
    .gte('last_event_at', cutoff)
    .order('last_event_at', { ascending: true })
    .limit(1);

  if (!followers?.length) return { matched: false };
  await applyLuckySpin(supabase, spin, followers[0].zalo_user_id, log);
  return { matched: true };
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
    // Nhắn SĐT trước, follow sau → khớp luôn không bắt khách nhắn lại.
    // Kiểm tra CẢ 2 loại thưởng (Quan tâm Zalo thường + vòng xoay) — thiếu
    // dòng lucky_spins ở đây từng khiến khách có SĐT đã gắn Zalo từ trước
    // (vd đã test/nhận ưu đãi Zalo thường 1 lần) quay vòng xoay xong follow
    // lại không bao giờ được áp quà, vì nhánh này return sớm sau khi chỉ
    // check tryApplyReward.
    if (existing?.phone) {
      await tryApplyReward(supabase, uid, existing.phone, log);
      const { data: spins } = await supabase
        .from('lucky_spins').select('*')
        .eq('customer_phone', existing.phone).eq('status', 'waiting_follow')
        .order('created_at', { ascending: false }).limit(1);
      if (spins?.length) await applyLuckySpin(supabase, spins[0], uid, log);
      return;
    }
    // Chưa biết SĐT → khớp theo thời gian: khách chỉ cần bấm Quan tâm
    const r = await tryApplyRewardByTiming(supabase, uid, log);
    if (!r.matched) await tryApplyLuckyByTiming(supabase, uid, log);
    return;
  }

  if (name === 'unfollow') {
    await supabase.from('zalo_followers')
      .update({ unfollowed_at: now, last_event_at: now })
      .eq('zalo_user_id', uid);
    return;
  }

  if (name === 'user_send_text' || name === 'user_submit_info') {
    // KHÁCH ĐÃ QUAN TÂM TỪ TRƯỚC: Zalo chỉ bắn `follow` đúng lần đầu bấm
    // Quan tâm, nên khách quen không sinh event nào — không thể ghép. Đường
    // duy nhất còn lại là họ NHẮN MỘT TIN cho OA: tin nào cũng được, không
    // cần là số điện thoại.
    const phone = name === 'user_submit_info'
      ? normalizePhone(ev.info?.phone)
      : extractPhoneFromText(ev.message?.text);

    const { data: existing } = await supabase
      .from('zalo_followers').select('zalo_user_id, phone, followed_at').eq('zalo_user_id', uid).maybeSingle();

    if (existing) {
      await supabase.from('zalo_followers')
        .update({ last_event_at: now, ...(phone ? { phone } : {}) })
        .eq('zalo_user_id', uid);
    } else {
      // Nhắn tin mà chưa có trong bảng: khách quan tâm từ lâu (trước khi quán
      // bật webhook) nên chưa từng có event follow. Coi như đang quan tâm —
      // Zalo chỉ chuyển tin nhắn của người đã vào chat với OA.
      await supabase.from('zalo_followers')
        .insert({ zalo_user_id: uid, phone: phone || null, followed_at: now, last_event_at: now });
    }

    if (phone) {
      // Có SĐT trong tin nhắn → khớp chắc chắn nhất
      await tryApplyReward(supabase, uid, phone, log);
      // Luot quay cua chinh SDT nay (neu co) cung duoc ap
      const { data: spins } = await supabase
        .from('lucky_spins').select('*')
        .eq('customer_phone', phone).eq('status', 'waiting_follow')
        .order('created_at', { ascending: false }).limit(1);
      if (spins?.length) await applyLuckySpin(supabase, spins[0], uid, log);
      return;
    }
    // Tin nhắn bất kỳ (“chào quán”, sticker chữ...) → khớp theo thời gian
    const r2 = await tryApplyRewardByTiming(supabase, uid, log);
    if (!r2.matched) await tryApplyLuckyByTiming(supabase, uid, log);
  }
}
