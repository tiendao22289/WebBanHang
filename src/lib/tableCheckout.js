export function isPaidTableCheckout(table, session, currentOrders = []) {
  if (table?.status !== 'available' || !table.last_payment_at || !session?.orderId) return false;
  const order = currentOrders.find(item => item.id === session.orderId);
  const startedAt = order?.created_at || session.lastActive;
  const started = new Date(startedAt).getTime();
  const paid = new Date(table.last_payment_at).getTime();
  return Number.isFinite(started) && Number.isFinite(paid) && paid >= started;
}
