export function transactionMatchesOpenBill(transaction, openOrders) {
  const expectedIds = String(transaction?.order_ids || '').split(',').filter(Boolean).sort();
  const currentIds = (openOrders || []).map(order => order.id).sort();
  if (!expectedIds.length || expectedIds.join(',') !== currentIds.join(',')) return false;
  const total = openOrders.reduce((sum, order) => sum + (order.order_items || [])
    .reduce((itemSum, item) => itemSum + Number(item.unit_price || 0) * Number(item.quantity || 0), 0), 0);
  return total > 0 && total === Number(transaction.total_amount);
}
