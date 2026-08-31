import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * sales-stats — huy hiệu "🔥 Đã bán X" trên trang gọi món.
 *
 * get_menu_sales_stats() (xem src/lib/get_menu_sales_stats.sql) quét TOÀN BỘ
 * order_items từ trước đến giờ, không lọc theo ngày — càng chạy lâu bảng càng
 * to, câu này càng nặng. Số liệu này chỉ để trang trí, không cần đúng theo
 * giây, nên cache ở đây 10 phút: nhiều khách mở /order cùng lúc (giờ cao điểm)
 * chỉ cần 1 người đầu tiên trong 10 phút đó chạm DB, còn lại dùng chung cache.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { data: null, ts: 0 };

export async function GET() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.data);
  }

  const { data, error } = await supabase.rpc('get_menu_sales_stats');
  if (error) {
    console.error('[api/menu/sales-stats] RPC error:', error.message);
    // Còn cache cũ (dù đã hết hạn) thì trả tạm cho có, không thì trả rỗng —
    // đây là huy hiệu trang trí, không được để lỗi này chặn khách gọi món.
    return NextResponse.json(cache.data || []);
  }

  cache = { data: data || [], ts: now };
  return NextResponse.json(cache.data);
}
