/**
 * /api/lucky/pick-gift — Khách chọn món/nước cụ thể sau khi quay trúng quà
 * "Tặng nước"/"Tặng món" trên vòng xoay.
 *
 * VÌ SAO Ở SERVER: phải tự tính lại danh sách món hợp lệ (không tin
 * menuItemId client gửi lên) để khách không thể sửa request tự chọn 1 món
 * đắt tiền không nằm trong danh sách được tặng.
 *
 * Toàn bộ logic (validate + lưu lựa chọn + ghi bill nếu Zalo đã xác nhận
 * xong từ trước) nằm trong `pickGiftItem()` — src/lib/zaloRewardServer.js —
 * dùng chung với đường webhook Zalo (`applyLuckySpin`) để không bao giờ ghi
 * quà 2 lần hay ghi thiếu, bất kể khách chọn món trước hay Quan tâm Zalo
 * xong trước.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { pickGiftItem } from '@/lib/zaloRewardServer';

export const dynamic = 'force-dynamic';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function fail(message) {
  return NextResponse.json({ ok: false, message });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const spinId = String(body.spinId || '').trim();
    const menuItemId = String(body.menuItemId || '').trim();
    const itemOptions = Array.isArray(body.itemOptions) ? body.itemOptions : [];

    if (!spinId) return fail('Thiếu thông tin lượt quay, Quý khách quay lại giúp ạ!');
    if (!menuItemId) return fail('Quý khách chưa chọn món ạ.');

    const supabase = getServiceClient();
    if (!supabase) {
      console.error('[Lucky] Thiếu SUPABASE_SERVICE_ROLE_KEY');
      return fail('Quán chưa ghi nhận được, Quý khách gọi nhân viên giúp ạ!');
    }

    const result = await pickGiftItem(supabase, spinId, menuItemId, itemOptions,
      (m) => console.log('[Lucky/pick-gift]', m));

    return NextResponse.json(result);
  } catch (err) {
    console.error('[Lucky/pick-gift] lỗi:', err);
    return fail('Quán gặp lỗi nhỏ, Quý khách thử lại giúp ạ!');
  }
}
