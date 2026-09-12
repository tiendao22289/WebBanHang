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
import { sendGiftItemPrintJob } from '@/lib/print';
import { sendOaText } from '@/lib/zaloOa';

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
  const { data: groupTables, error: tableError } = await supabase
    .from('tables').select('id, table_type, occupied_at')
    .or(`id.eq.${spin.host_table_id},merged_with.eq.${spin.host_table_id}`);
  if (tableError) throw tableError;
  const host = groupTables?.find(t => t.id === spin.host_table_id);
  if (!host) return [];
  // Never deliver an old customer's reward into the next customer's bill.
  if (host.table_type !== 'takeaway' && host.occupied_at &&
      new Date(spin.created_at) < new Date(host.occupied_at)) return [];
  const groupIds = (groupTables || []).map(t => t.id);
  if (groupIds.length === 0) groupIds.push(spin.host_table_id);
  const isTakeaway = (groupTables || []).find(t => t.id === spin.host_table_id)?.table_type === 'takeaway';

  const vnDayKey = new Date(new Date(spin.created_at).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const startOfToday = new Date(`${vnDayKey}T00:00:00.000+07:00`);
  let billsQuery = supabase
    .from('orders')
    .select('id, total_amount, customer_phone, created_at')
    .in('table_id', groupIds)
    .in('status', ['pending', 'preparing', 'completed'])
    .gte('created_at', startOfToday.toISOString())
    .order('created_at', { ascending: true });
  if (isTakeaway) billsQuery = billsQuery.eq('customer_phone', spin.customer_phone);

  const { data: orders, error: ordersError } = await billsQuery;
  if (ordersError) throw ordersError;
  return (orders || []).filter(o => o.customer_phone !== 'BAO_BEP');
}

/** Deliver the saved gift with a stable item ID and idempotent print job.
 * A failed step leaves the slot reserved so claim-ready can resume it. */
export async function finalizeGiftItem(supabase, spin, targetOrderId, log = () => {}) {
  if (!spin.gift_menu_item_id) return null;
  const quantity = Number(spin.prize_value) || 1;
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Số lượng phần quà chưa hợp lệ. Vui lòng gọi nhân viên.');
  // Stable primary key: two requests or an uncertain network result cannot
  // create two gift lines for the same spin. Retry reconciles this same line.
  const itemId = spin.applied_item_id || spin.id;
  let { data: existing, error: readError } = await supabase.from('order_items')
    .select('*').eq('id', itemId).maybeSingle();
  if (readError) throw readError;
  if (!existing) {
    // Older versions used random item IDs. Reconcile an unlinked legacy gift
    // rather than delivering a second copy after upgrading the server.
    const { data: legacy, error } = await supabase.from('order_items').select('*')
      .eq('order_id', targetOrderId).eq('note', 'Quà tặng từ vòng quay may mắn');
    if (error) throw error;
    if (legacy?.length > 1) throw new Error('Có nhiều dòng quà cũ; cần nhân viên đối chiếu trước khi nhận tiếp.');
    existing = legacy?.[0] || null;
  }

  // Số lượng tặng do Admin cấu hình trên chính phần quà (Cài đặt > Vòng
  // xoay > Số lượng tặng) — chốt lúc quay (spin.prize_value), không đổi
  // theo cấu hình sau này. Ghi chú rõ nguồn gốc để bếp/thu ngân không nhầm
  // với món tặng của khuyến mãi khác.
  let item = existing;
  if (!item) {
  const { data: inserted, error: itemErr } = await supabase
    .from('order_items')
    .insert({
      id: itemId,
      order_id: targetOrderId,
      menu_item_id: spin.gift_menu_item_id,
      item_options: spin.gift_item_options || [],
      quantity,
      unit_price: 0,
      is_gift: true,
      note: 'Quà tặng từ vòng quay may mắn',
    })
    .select()
    .maybeSingle();

  if (itemErr) {
    if (itemErr.code !== '23505') throw itemErr;
    const { data: concurrent, error } = await supabase.from('order_items')
      .select('*').eq('id', itemId).maybeSingle();
    if (error) throw error;
    item = concurrent;
  } else {
    item = inserted;
  }
  }
  if (!item || item.order_id !== targetOrderId || item.menu_item_id !== spin.gift_menu_item_id
      || Number(item.quantity) !== quantity || Number(item.unit_price) !== 0
      || JSON.stringify(item.item_options || []) !== JSON.stringify(spin.gift_item_options || [])) {
    throw new Error('Dòng quà chưa khớp với phần đã trúng; cần nhân viên kiểm tra.');
  }

  // Queue this gift once before acknowledging it. If queueing fails,
  // leave the receipt pending so polling can retry without adding a new item.
  try {
    const printResult = await sendGiftItemPrintJob(supabase, targetOrderId, item.id);
    if (!printResult.success) throw new Error('Quà đã ghi vào bill nhưng chưa gửi được tới máy in. Quý khách bấm kiểm tra lại hoặc gọi nhân viên.');
  } catch (printErr) {
    log(`in qua vong xoay loi (khong anh huong bill): ${printErr.message}`);
    throw printErr;
  }

  const { error: receiptError } = await supabase.from('lucky_spins')
    .update({ applied_item_id: item.id }).eq('id', spin.id);
  if (receiptError) throw receiptError;

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
  if (spin.applied_item_id) return { ok: true, applied: true };
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

  const { data: menu, error: menuError } = await supabase.from('menu_items')
    .select('id, is_available, hidden_until, options').eq('id', menuItemId).maybeSingle();
  if (menuError) throw menuError;
  if (!menu?.is_available || (menu.hidden_until && new Date(menu.hidden_until) > new Date())) {
    return { ok: false, message: 'Món này đang hết. Quý khách chọn món khác hoặc gọi nhân viên giúp nhé.' };
  }

  const cleanOptions = Array.isArray(itemOptions) ? itemOptions : [];
  const definitions = (menu.options || []).filter(o => o.name && o.choices?.length);
  if (cleanOptions.length !== definitions.length || definitions.some(def => {
    const choices = cleanOptions.filter(o => o?.name === def.name);
    return choices.length !== 1 || !def.choices.includes(choices[0].choice);
  })) return { ok: false, message: 'Quý khách chọn đầy đủ loại/khẩu vị của món quà nhé.' };
  const { error: updErr } = await supabase.from('lucky_spins')
    .update({ gift_menu_item_id: menuItemId, gift_item_options: cleanOptions })
    .eq('id', spinId).is('gift_menu_item_id', null);
  if (updErr) return { ok: false, message: 'Quán chưa lưu được, Quý khách thử lại giúp ạ!' };
  const { data: saved, error: savedError } = await supabase.from('lucky_spins')
    .select('*').eq('id', spinId).maybeSingle();
  if (savedError || !saved) return { ok: false, message: 'Chưa đọc được lựa chọn. Quý khách bấm kiểm tra nhận quà nhé.' };

  // Zalo da xac nhan tu truoc (status='applied' do claim_lucky_wheel_slot),
  // chi con thieu dung buoc chon mon — ghi vao bill ngay bay gio.
  if (saved.status === 'applied') {
    const bills = await getSpinBills(supabase, saved);
    if (!bills.some(b => b.id === saved.applied_order_id)) {
      return { ok: false, message: 'Hoá đơn của bàn đã thanh toán nên quán chưa áp quà được ạ.' };
    }
    const targetOrderId = saved.applied_order_id;
    const item = await finalizeGiftItem(
      supabase,
      saved,
      targetOrderId, log
    );
    if (!item) {
      return { ok: false, applied: false, message: 'Quà chưa được ghi vào hoá đơn. Quý khách bấm chọn lại món để thử nhận quà lần nữa, hoặc gọi nhân viên giúp nhé!' };
    }
    return { ok: true, applied: true };
  }

  return { ok: true, applied: false };
}

/**
 * Nhắn cho khách qua Zalo rằng quà đã vào hoá đơn.
 *
 * VÌ SAO CẦN: khách rời web sang app Zalo để Quan tâm; lúc quay lại trang order
 * có thể đã bị hệ điều hành tắt nên không thấy màn hình "nhận quà thành công".
 * Tin nhắn nằm lại trong Zalo nên khách luôn biết, xem lúc nào cũng được.
 *
 * KHÔNG BAO GIỜ được làm hỏng luồng quà: quà đã ghi vào bill rồi, tin nhắn chỉ
 * là thông báo — mọi lỗi gửi tin đều nuốt và ghi log.
 */
async function notifyLuckyPrizeApplied(supabase, spin, log = () => {}) {
  if (!spin?.zalo_user_id) return; // cấp tay / chưa gắn Zalo thì không có ai để nhắn
  try {
    // Đọc lại từ DB: số tiền giảm do RPC tính, bản ghi truyền vào có thể cũ.
    const { data: fresh } = await supabase.from('lucky_spins')
      .select('prize_label, discount_amount, applied_item_id').eq('id', spin.id).maybeSingle();
    if (!fresh?.applied_item_id) return; // chưa thật sự vào bill thì đừng báo nhầm
    const money = Number(fresh.discount_amount) || 0;
    const detail = money > 0
      ? `Hoá đơn của Quý khách được giảm ${money.toLocaleString('vi-VN')}đ ạ.`
      : 'Phần quà đã được thêm vào hoá đơn, nhân viên mang ra ngay ạ!';
    await sendOaText(supabase, spin.zalo_user_id,
      `🎉 Chúc mừng Quý khách trúng "${fresh.prize_label || 'quà vòng xoay'}"!\n`
      + `${detail}\nCảm ơn Quý khách đã ủng hộ Ốc Bảo Khang ạ!`, log);
  } catch (err) {
    log(`khong gui duoc tin bao nhan qua: ${err.message}`);
  }
}

/** Resume a reserved reward after a timeout/crash without creating another line. */
export async function completeLuckySpin(supabase, spin, log = () => {}) {
  const result = await finishLuckyReward(supabase, spin, log);
  await notifyLuckyPrizeApplied(supabase, spin, log);
  return result;
}

async function finishLuckyReward(supabase, spin, log = () => {}) {
  if (spin.prize_type === 'percent') {
    // Database owns the live discount and totals; never overwrite them with
    // the older amount captured when the customer spun the wheel.
    const { data, error } = await supabase.rpc('refresh_lucky_percent_reward', { p_spin_id: spin.id });
    if (error) throw new Error(`Chưa cập nhật được giảm giá theo tổng bill: ${error.message || 'vui lòng thử lại'}`);
    if (!data) throw new Error('Bill nhận quà đã đóng. Vui lòng gọi nhân viên.');
    return data;
  }
  const bills = await getSpinBills(supabase, spin);
  const targetOrderId = spin.applied_order_id;
  if (!bills.some(b => b.id === targetOrderId)) {
    throw new Error('Bill nhận quà đã đóng hoặc không còn thuộc lượt khách này. Vui lòng gọi nhân viên.');
  }
  if (isGiftPrizeType(spin.prize_type)) {
    return finalizeGiftItem(supabase, spin, targetOrderId, log);
  }
  const discount = Number(spin.discount_amount);
  if (!(discount > 0)) throw new Error('Số tiền giảm chưa hợp lệ.');
  const id = spin.applied_item_id || spin.id;
  let { data: item, error: readError } = await supabase.from('order_items').select('*').eq('id', id).maybeSingle();
  if (readError) throw readError;
  if (!item) {
    const { data: legacy, error } = await supabase.from('order_items').select('*')
      .eq('order_id', targetOrderId).eq('item_name', luckyItemName({ type: spin.prize_type, value: spin.prize_value }));
    if (error) throw error;
    if (legacy?.length > 1) throw new Error('Có nhiều dòng giảm giá cũ; cần nhân viên đối chiếu.');
    item = legacy?.[0] || null;
  }
  if (!item) {
    const result = await supabase.from('order_items').insert({ id, order_id: targetOrderId,
      menu_item_id: null, item_name: luckyItemName({ type: spin.prize_type, value: spin.prize_value }),
      quantity: 1, unit_price: -discount, is_gift: false }).select().maybeSingle();
    if (result.error && result.error.code !== '23505') throw result.error;
    if (result.error) {
      const retry = await supabase.from('order_items').select('*').eq('id', id).maybeSingle();
      if (retry.error) throw retry.error;
      item = retry.data;
    } else item = result.data;
  }
  if (!item || item.order_id !== targetOrderId || Number(item.unit_price) !== -discount || Number(item.quantity) !== 1) {
    throw new Error('Dòng giảm giá chưa khớp phần quà. Vui lòng gọi nhân viên.');
  }
  const { data: items, error: itemsError } = await supabase.from('order_items')
    .select('unit_price, quantity').eq('order_id', targetOrderId);
  if (itemsError || !items?.length) throw itemsError || new Error('Chưa đọc được bill để tính tiền.');
  const total = items.reduce((sum, row) => sum + Number(row.unit_price) * Number(row.quantity), 0);
  const { data: updated, error: totalError } = await supabase.from('orders')
    .update({ total_amount: total }).eq('id', targetOrderId)
    .in('status', ['pending', 'preparing', 'completed']).select('id').maybeSingle();
  if (totalError || !updated) throw totalError || new Error('Bill đã đóng trước khi nhận quà xong.');
  const { error: receiptError } = await supabase.from('lucky_spins')
    .update({ applied_item_id: item.id }).eq('id', spin.id);
  if (receiptError) throw receiptError;
  return item;
}

/** Ghi qua cua mot luot quay vao hoa don. Idempotent. */
export async function applyLuckySpin(supabase, spin, zaloUserId, log = () => {}) {
  const { data: current, error: currentError } = await supabase.from('lucky_spins')
    .select('*').eq('id', spin.id).maybeSingle();
  if (currentError) throw currentError;
  if (!current || current.status === 'blocked') return;
  spin = current;
  // A slot already reserved for this spin is a retry, not a cooldown breach.
  if (spin.status === 'applied') return completeLuckySpin(supabase, spin, log);
  // Quà đã chốt lúc quay — đọc lại từ chính lượt quay để cơ cấu quà có
  // thay đổi sau đó cũng không làm sai phần khách đã trúng.
  const prize = {
    label: spin.prize_label,
    type: spin.prize_type,
    value: Number(spin.prize_value) || 0,
  };

  const { data: settingRows, error: settingsError } = await supabase
    .from('settings').select('key, value').in('key', LUCKY_SETTING_KEYS);
  if (settingsError) throw settingsError;
  const cfg = parseLuckyConfig(settingRows);

  // Tai khoan Zalo nay da nhan qua vong xoay gan day chua — chan viec dung
  // nhieu SDT khac nhau nhung cung 1 tai khoan Zalo that de quay/nhan lap lai.
  if (zaloUserId && cfg.cooldownDays > 0) {
    const zaloCutoff = new Date(Date.now() - cfg.cooldownDays * 86400000).toISOString();
    const { data: recentZalo, error: cooldownError } = await supabase
      .from('lucky_spins').select('id')
      .eq('zalo_user_id', zaloUserId)
      .eq('status', 'applied')
      .gte('verified_at', zaloCutoff)
      .limit(1);
    if (cooldownError) throw cooldownError;
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
  const { data: claimed, error: claimError } = await supabase.rpc('claim_lucky_wheel_slot', {
    p_spin_id: spin.id,
    p_host_table_id: spin.host_table_id,
    p_check_order_ids: bills.map(b => b.id),
    p_target_order_id: targetOrderId,
    p_zalo_user_id: zaloUserId,
    p_bill_total: total,
    p_discount_amount: discount,
  });
  if (claimError) throw claimError; // A DB outage is not "this bill already received a gift".
  if (!claimed) {
    const { data: concurrent, error } = await supabase.from('lucky_spins').select('*').eq('id', spin.id).maybeSingle();
    if (error) throw error;
    if (concurrent?.status === 'applied') return completeLuckySpin(supabase, concurrent, log);
    return blockSpin(supabase, spin.id, '1 hoa don chi duoc nhan 1 lan qua vong xoay - ban minh da nhan roi a!');
  }

  await completeLuckySpin(supabase, { ...spin, status: 'applied',
    applied_order_id: targetOrderId, discount_amount: discount }, log);

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
 * Admin cấp quà TAY cho 1 lượt quay bị kẹt (khách đã Quan tâm Zalo nhưng quà
 * chưa vào bill, hoặc admin muốn giải quyết cho khách). Bỏ qua yêu cầu follow
 * và bỏ qua cooldown chống gian lận — admin đã tự xác nhận. VẪN dùng chung
 * khoá chốt slot + completeLuckySpin để không ghi trùng và không vượt quá 1
 * quà/bill. Idempotent: gọi lại trên lượt đã xong chỉ trả về already=true.
 */
export async function grantLuckySpinManually(supabase, spinId, log = () => {}) {
  const { data: spin } = await supabase.from('lucky_spins').select('*').eq('id', spinId).maybeSingle();
  if (!spin) return { ok: false, message: 'Không tìm thấy lượt quay.' };
  if (spin.applied_item_id) return { ok: true, already: true };
  const prize = { label: spin.prize_label, type: spin.prize_type, value: Number(spin.prize_value) || 0 };
  const isGift = isGiftPrizeType(prize.type);
  if (isGift && !spin.gift_menu_item_id) {
    return { ok: false, message: 'Khách chưa chọn món/nước quà nên chưa cấp tay được — nhờ khách chọn trước ở màn hình vòng xoay.' };
  }

  // Slot đã chốt từ trước (status='applied' nhưng finalize lỗi) → chỉ ghi nốt.
  if (spin.status === 'applied' && spin.applied_order_id) {
    await completeLuckySpin(supabase, spin, log);
    return { ok: true };
  }

  // Lượt bị chặn (vd cooldown) mà admin muốn cấp bù → mở lại để chốt slot.
  if (spin.status === 'blocked') {
    await supabase.from('lucky_spins').update({ status: 'waiting_follow', block_reason: null }).eq('id', spin.id);
    spin.status = 'waiting_follow';
  }

  const { data: settingRows } = await supabase.from('settings').select('key, value').in('key', LUCKY_SETTING_KEYS);
  const cfg = parseLuckyConfig(settingRows);
  const bills = await getSpinBills(supabase, spin);
  if (bills.length === 0) return { ok: false, message: 'Hoá đơn của bàn đã đóng nên không cấp được quà.' };
  const total = bills.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
  const discount = calcLuckyDiscount(total, prize, cfg.max);
  if (!isGift && discount <= 0) return { ok: false, message: 'Chưa tính được mức giảm cho bill này.' };

  const targetOrderId = bills[0].id;
  const { data: claimed, error: claimError } = await supabase.rpc('claim_lucky_wheel_slot', {
    p_spin_id: spin.id, p_host_table_id: spin.host_table_id, p_check_order_ids: bills.map(b => b.id),
    p_target_order_id: targetOrderId, p_zalo_user_id: spin.zalo_user_id || null,
    p_bill_total: total, p_discount_amount: discount,
  });
  if (claimError) return { ok: false, message: 'Lỗi khi chốt quà, vui lòng thử lại.' };
  if (!claimed) {
    const { data: concurrent } = await supabase.from('lucky_spins').select('*').eq('id', spin.id).maybeSingle();
    if (concurrent?.status === 'applied') { await completeLuckySpin(supabase, concurrent, log); return { ok: true }; }
    return { ok: false, message: '1 hoá đơn chỉ nhận 1 lần quà — bill này đã có lượt quay khác nhận rồi.' };
  }
  await completeLuckySpin(supabase, { ...spin, status: 'applied',
    applied_order_id: targetOrderId, discount_amount: discount }, log);
  log(`admin cap qua tay cho luot quay ${spin.id}`);
  return { ok: true };
}

/**
 * Danh sách lượt quay CHƯA vào bill trong ngày (theo giờ VN) để trang admin
 * hiển thị trạng thái/lỗi trên từng bàn. Trả kèm tên/SĐT cho nhân viên phục
 * vụ (route gọi bằng SERVICE_ROLE_KEY, không lộ ra anon). Mỗi lượt gắn 1
 * adminState:
 *  - 'error'   : Zalo đã xác nhận Quan tâm (zalo_user_id có, hoặc đã 'applied')
 *                nhưng quà chưa vào bill → nghi lỗi hệ thống, cần xử lý.
 *  - 'waiting' : đang chờ khách Quan tâm Zalo.
 *  - 'blocked' : bị chặn (đã nhận gần đây / bill đóng...).
 */
export async function listAdminLuckySpins(supabase) {
  const vnDayKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const startOfToday = new Date(`${vnDayKey}T00:00:00.000+07:00`).toISOString();
  const { data, error } = await supabase.from('lucky_spins')
    .select('id, table_id, host_table_id, customer_name, customer_phone, prize_type, prize_value, prize_label, status, zalo_user_id, gift_menu_item_id, applied_item_id, block_reason, created_at')
    .gte('created_at', startOfToday)
    .is('applied_item_id', null)
    .in('status', ['waiting_follow', 'applied', 'blocked'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(s => {
    const followConfirmed = !!s.zalo_user_id || s.status === 'applied';
    const adminState = s.status === 'blocked' ? 'blocked'
      : followConfirmed ? 'error' : 'waiting';
    return {
      id: s.id, tableId: s.table_id, hostTableId: s.host_table_id,
      customerName: s.customer_name, customerPhone: s.customer_phone,
      prizeType: s.prize_type, prizeValue: s.prize_value, prizeLabel: s.prize_label,
      status: s.status, adminState, followConfirmed,
      giftChosen: !!s.gift_menu_item_id, blockReason: s.block_reason, createdAt: s.created_at,
    };
  });
}

// An anonymous follow event cannot identify a wheel customer. Never guess by
// timing — that binds a stranger's Zalo account to an innocent guest's spin and
// then blocks it with a false "already claimed" message (findings from the
// follow-only trial). The guest sends the phone entered for this spin in the OA
// chat; that is the only reliable link between a follow and a spin.
export async function tryApplyLuckyByTiming() {
  return { matched: false, reason: 'need_phone_message' };
}

export async function tryApplyLuckyForSpin(supabase, spin) {
  // Only resume an identity already recorded from the explicit phone message.
  if (spin.zalo_user_id && await isFollowing(supabase, spin.zalo_user_id)) {
    await applyLuckySpin(supabase, spin, spin.zalo_user_id);
    return { matched: true };
  }
  return { matched: false, reason: 'need_phone_message' };
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
    // KHÔNG gửi tin hướng dẫn ở đây. Zalo đã tự gửi "Tin chào mừng" của OA
    // đúng lúc khách bấm Quan tâm, nên gửi thêm sẽ ra hai tin chồng nhau, rối
    // cho khách và tốn hạn mức tin của OA. Lời mời nhắn SĐT giờ nằm trong tin
    // chào mừng (soạn ở trang quản lý OA). Tin xác nhận sau khi quà vào bill
    // vẫn do hệ thống gửi — xem notifyLuckyPrizeApplied.
    // Existing phone mappings may have come from timing-based social rewards.
    // Wheel rewards require an explicit phone message for this interaction.
    if (existing?.phone) {
      await tryApplyReward(supabase, uid, existing.phone, log);
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
      // Only a phone explicitly sent in this event identifies a wheel customer.
      if (!(await isFollowing(supabase, uid))) return;
      // Có SĐT trong tin nhắn → khớp chắc chắn nhất
      // Luot quay cua chinh SDT nay (neu co) cung duoc ap
      const { data: spins, error: spinsError } = await supabase
        .from('lucky_spins').select('*')
        .eq('customer_phone', phone).eq('status', 'waiting_follow')
        .order('created_at', { ascending: false }).limit(1);
      if (spinsError) throw spinsError;
      if (spins?.length) {
        const spin = spins[0];
        if (!spin.zalo_user_id) {
          const { error } = await supabase.from('lucky_spins').update({ zalo_user_id: uid })
            .eq('id', spin.id).eq('status', 'waiting_follow').is('zalo_user_id', null);
          if (error) throw error;
        }
        const { data: bound, error } = await supabase.from('lucky_spins').select('*').eq('id', spin.id).maybeSingle();
        if (error) throw error;
        if (bound?.zalo_user_id === uid) await applyLuckySpin(supabase, bound, uid, log);
      }
      await tryApplyReward(supabase, uid, phone, log);
      return;
    }
    // Tin nhắn bất kỳ (“chào quán”, sticker chữ...) → khớp theo thời gian
    const r2 = await tryApplyRewardByTiming(supabase, uid, log);
    if (!r2.matched) await tryApplyLuckyByTiming(supabase, uid, log);
  }
}
