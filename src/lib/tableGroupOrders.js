export const OPEN_BILL_STATUSES = ['pending', 'preparing', 'completed'];

// Keep every table in a merged group visible on each table card and in its bill.
export function getTableGroupOrders(table, tables, ordersByTable) {
  if (!table) return [];
  const hostId = table.merged_with || table.id;
  const groupIds = [hostId, ...tables.filter(t => t.merged_with === hostId && t.id !== hostId).map(t => t.id)];
  return groupIds.flatMap(id => ordersByTable[id] || []);
}

// Ngày bán hàng của quán: 05:00 sáng (giờ Việt Nam) đến 05:00 hôm sau — quán bán qua nửa đêm, nên
// không cắt lúc 00:00 (giống "hết hôm nay" ở menuAvailability.mjs và giờ máy tự kiểm sổ).
const VN_OFFSET_MS = 7 * 3600000;
const SHOP_DAY_START_HOUR = 5;

/** Mốc 05:00 (giờ VN) mở đầu ngày bán hàng đang chạy, dạng ISO. */
export function shopDayStartISO(nowMs = Date.now()) {
  const vn = new Date(nowMs + VN_OFFSET_MS - SHOP_DAY_START_HOUR * 3600000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), SHOP_DAY_START_HOUR) - VN_OFFSET_MS).toISOString();
}

/** Ngày bán hàng đang chạy "YYYY-MM-DD" (00:20 sáng 5/11 vẫn là ngày 4/11). */
export function shopDayKey(nowMs = Date.now()) {
  return new Date(nowMs + VN_OFFSET_MS - SHOP_DAY_START_HOUR * 3600000).toISOString().slice(0, 10);
}

/**
 * Tổng tiền các bill CHƯA THU của nhóm bàn (bỏ bill "Gọi nhân viên"). Bill đang mở luôn tính, dù gọi
 * từ trước 00:00. Mang về (phoneFilter = SĐT khách, mọi khách chung 1 bàn ảo): chỉ bill hôm nay (từ 05:00).
 */
export async function fetchOpenGroupTotal(supabase, tableIds, phoneFilter = null, nowMs = Date.now()) {
  const ids = (tableIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  let q = supabase.from('orders').select('total_amount, customer_phone')
    .in('table_id', ids).in('status', OPEN_BILL_STATUSES);
  if (phoneFilter) q = q.eq('customer_phone', phoneFilter).gte('created_at', shopDayStartISO(nowMs));
  const { data } = await q;
  return (data || []).filter(o => o.customer_phone !== 'BAO_BEP')
    .reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
}

// Bill nhận dòng Cộng / Trừ / Giảm % hay quà của cả nhóm bàn: bill đang mở CŨ nhất, bỏ bill "Gọi nhân viên"
// (BAO_BEP). Bill đó không vào Sổ thu chi nên dòng tiền ghi vào đó sẽ mất khỏi sổ; cùng cách với duyệt
// đánh giá, vòng xoay, Zalo. Không có bill nào khác thì trả null.
export function representativeBill(bills) {
  return (bills || []).filter(o => OPEN_BILL_STATUSES.includes(o.status) && o.customer_phone !== 'BAO_BEP')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;
}
