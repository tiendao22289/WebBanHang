/**
 * /api/zalo/webhook — Nhận sự kiện từ Zalo OA và TỰ ĐỘNG trả quà
 * "Quan tâm Zalo OA" (không cần nhân viên duyệt).
 *
 * ── Luồng hoạt động ─────────────────────────────────────────────
 *  1. Khách nhập SĐT trên web order → tạo zalo_reward_claims
 *     (status waiting_follow) → bấm nút mở OA.
 *  2. Khách bấm QUAN TÂM  → Zalo bắn event `follow` về đây.
 *  3. Khách nhắn SĐT vào chat OA (hoặc bấm nút chia sẻ SĐT nếu OA
 *     có gửi request-info) → event `user_send_text` / `user_submit_info`.
 *  4. Server khớp SĐT ↔ claim đang chờ → kiểm tra đủ điều kiện →
 *     chèn dòng giảm giá vào bill → claim = verified → realtime đẩy
 *     xuống máy khách "đã bớt tiền".
 *
 * ── Vì sao khách không gian lận được ────────────────────────────
 *  * Route này chạy bằng SUPABASE_SERVICE_ROLE_KEY; RLS chặn anon
 *    UPDATE zalo_reward_claims và chặn toàn bộ zalo_followers.
 *  * "Đã follow" chỉ có thể do Zalo bắn event vào đây — khách không
 *    tự ghi được.
 *  * Cooldown khoá theo CẢ SĐT lẫn zalo_user_id: đổi số khai láo
 *    cũng kẹt vì tài khoản Zalo đã nhận rồi; đổi tài khoản Zalo
 *    thì cần SIM mới — chi phí cao hơn giá trị quà (trần 10k).
 *  * Mọi con số (tổng bill, % giảm, trần) đều server tự tính lại
 *    từ DB, không tin bất kỳ giá trị nào client gửi.
 *
 * ── Cấu hình cần có ─────────────────────────────────────────────
 *  ENV  SUPABASE_SERVICE_ROLE_KEY  (bắt buộc — Supabase Dashboard > Settings > API)
 *  ENV  ZALO_APP_SECRET            (khuyến nghị — bật kiểm chữ ký X-ZEvent-Signature)
 *  Webhook URL khai trên developers.zalo.me: https://<domain>/api/zalo/webhook
 */

import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { parseChannelConfig, calcReviewDiscount, getChannel } from '@/lib/reviewReward';

export const dynamic = 'force-dynamic';

// Claim quá 30 phút không hoàn tất thì bỏ qua (khách đã rời quán / thử nghịch)
const CLAIM_FRESH_MINUTES = 30;

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // thiếu key → không xử lý gì (an toàn hơn là chạy bằng anon)
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Chuẩn hoá SĐT VN về dạng 0xxxxxxxxx; trả null nếu không hợp lệ. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let p = digits;
  if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  if (p.startsWith('0084')) p = '0' + p.slice(4);
  return /^0\d{9}$/.test(p) ? p : null;
}

/** Rút SĐT đầu tiên tìm thấy trong 1 đoạn text chat. */
function extractPhoneFromText(text) {
  const m = String(text || '').match(/(\+?84|0)[\s.\-]?(\d[\s.\-]?){8,10}\d/);
  return m ? normalizePhone(m[0]) : null;
}

/**
 * Kiểm chữ ký Zalo (X-ZEvent-Signature: "mac=<sha256>").
 * Công thức theo docs OA: sha256(appId + rawBody + timestamp + OASecretKey).
 * Chỉ kiểm khi có ZALO_APP_SECRET; sai công thức sẽ thấy log để đối chiếu.
 */
function verifySignature(rawBody, body, signatureHeader) {
  const secret = process.env.ZALO_APP_SECRET;
  if (!secret) return { ok: true, skipped: true };
  const mac = String(signatureHeader || '').replace(/^mac=/, '').trim();
  if (!mac) return { ok: false, reason: 'thiếu header X-ZEvent-Signature' };
  const appId = String(body.app_id || '');
  const ts = String(body.timestamp || '');
  const expected = crypto.createHash('sha256').update(appId + rawBody + ts + secret).digest('hex');
  return expected === mac
    ? { ok: true }
    : { ok: false, reason: 'chữ ký không khớp' };
}

/** Đọc cấu hình kênh Zalo từ settings (dùng chung parse với web). */
async function loadZaloConfig(supabase) {
  const ch = getChannel('zalo');
  const keys = ['enabled', 'url', 'percent', 'max', 'min_bill', 'cooldown_days'].map(f => `${ch.prefix}_${f}`);
  keys.push('zalo_auto_enabled');
  const { data } = await supabase.from('settings').select('key, value').in('key', keys);
  const cfg = parseChannelConfig(data, 'zalo');
  const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  cfg.autoEnabled = map.zalo_auto_enabled === 'true';
  return cfg;
}

/** Đánh dấu claim không hợp lệ kèm lý do khách sẽ đọc được. */
async function blockClaim(supabase, claimId, reason) {
  await supabase.from('zalo_reward_claims')
    .update({ status: 'blocked', block_reason: reason })
    .eq('id', claimId)
    .eq('status', 'waiting_follow');
}

/**
 * Tìm claim đang chờ khớp với SĐT này và trả quà nếu đủ điều kiện.
 * Mọi bước đều idempotent — Zalo có thể gửi lại event, không sao.
 */
async function tryApplyReward(supabase, zaloUserId, phone, log) {
  // 0) Bắt buộc: tài khoản này ĐANG follow (nguồn: event follow của Zalo)
  const { data: follower } = await supabase
    .from('zalo_followers').select('*').eq('zalo_user_id', zaloUserId).maybeSingle();
  if (!follower?.followed_at || follower.unfollowed_at) {
    log(`bỏ qua: ${zaloUserId} chưa/không còn quan tâm OA`);
    return;
  }

  // 1) Claim mới nhất đang chờ của SĐT này
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
  if (!claim) { log(`không có claim chờ cho SĐT ${phone}`); return; }

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
  if (lockErr || !locked) { log(`không chốt được claim ${claim.id}: ${lockErr?.message || 'đã xử lý nơi khác'}`); return; }

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
    // Trả claim về chờ để event sau thử lại — không "verified mà không trừ tiền"
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

  // 7) CRM: gắn zalo_user_id vào hồ sơ khách (best-effort)
  try {
    await supabase.from('customers')
      .update({ zalo_user_id: zaloUserId, last_visit_at: new Date().toISOString() })
      .eq('phone', phone);
  } catch (_) { /* không quan trọng bằng việc quà đã vào */ }

  log(`✅ đã giảm ${discount}đ cho SĐT ${phone} (claim ${claim.id}, order ${targetOrderId})`);
}

async function handleEvent(supabase, ev, log) {
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
    if (existing?.phone) await tryApplyReward(supabase, uid, existing.phone, log);
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
    //                  ĐANG follow + khớp claim + cooldown theo tài khoản
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

// Zalo gọi GET khi khai báo webhook — chỉ cần 200
export async function GET() {
  return NextResponse.json({ ok: true, service: 'zalo-oa-webhook' });
}

export async function POST(request) {
  const logs = [];
  const log = (m) => { logs.push(m); console.log('[Zalo Webhook]', m); };

  try {
    const rawBody = await request.text();
    let body;
    try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }

    const sig = verifySignature(rawBody, body, request.headers.get('x-zevent-signature'));
    if (!sig.ok) {
      console.warn('[Zalo Webhook] từ chối:', sig.reason);
      return NextResponse.json({ ok: false, reason: sig.reason }, { status: 401 });
    }

    const supabase = getServiceClient();
    if (!supabase) {
      console.error('[Zalo Webhook] Thiếu SUPABASE_SERVICE_ROLE_KEY — không xử lý event.');
      // Vẫn trả 200 để Zalo không dồn retry; lỗi cấu hình xem ở server log
      return NextResponse.json({ ok: false, reason: 'server chưa cấu hình' });
    }

    log(`event: ${body.event_name}`);
    // Trả 200 NGAY cho Zalo (yêu cầu phản hồi < 2s), phần xử lý
    // (khớp SĐT, trừ tiền) chạy nền sau khi response đã gửi.
    after(async () => {
      try {
        await handleEvent(supabase, body, log);
      } catch (err) {
        console.error('[Zalo Webhook] xử lý nền lỗi:', err);
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[Zalo Webhook] lỗi:', err);
    // 200 để tránh Zalo retry dồn dập; chi tiết nằm trong log
    return NextResponse.json({ ok: false });
  }
}
