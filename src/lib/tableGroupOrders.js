export const OPEN_BILL_STATUSES = ['pending', 'preparing', 'completed'];

// Keep every table in a merged group visible on each table card and in its bill.
export function getTableGroupOrders(table, tables, ordersByTable) {
  if (!table) return [];
  const hostId = table.merged_with || table.id;
  const groupIds = [hostId, ...tables.filter(t => t.merged_with === hostId && t.id !== hostId).map(t => t.id)];
  return groupIds.flatMap(id => ordersByTable[id] || []);
}

// Bill nhận dòng Cộng / Trừ / Giảm % hay quà của cả nhóm bàn: bill đang mở CŨ nhất, bỏ bill "Gọi nhân viên"
// (BAO_BEP). Bill đó không vào Sổ thu chi nên dòng tiền ghi vào đó sẽ mất khỏi sổ; cùng cách với duyệt
// đánh giá, vòng xoay, Zalo. Không có bill nào khác thì trả null.
export function representativeBill(bills) {
  return (bills || []).filter(o => OPEN_BILL_STATUSES.includes(o.status) && o.customer_phone !== 'BAO_BEP')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;
}
