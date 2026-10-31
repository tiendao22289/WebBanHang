/**
 * GET /api/voucher/status — công tắc voucher chung (Admin > Voucher) đang bật không.
 * Trang gọi món dùng để ẩn ô nhập mã / nút Voucher và ô "Voucher lần sau" trên vòng xoay.
 * Bảng voucher_settings chỉ máy chủ đọc được nên trang khách hỏi qua đây.
 */
import { NextResponse } from 'next/server';
import { statusDatabase } from '@/lib/statusAuth';
import { loadVoucherSwitch } from '@/lib/voucherServer.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let on = false;
  try {
    on = await loadVoucherSwitch(statusDatabase());
  } catch (error) {
    console.error('[voucher/status]', error); // lỗi → coi như tắt
  }
  return NextResponse.json({ on }, { headers: { 'Cache-Control': 'no-store' } });
}
