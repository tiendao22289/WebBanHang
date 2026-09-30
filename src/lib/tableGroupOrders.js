// Keep every table in a merged group visible on each table card and in its bill.
export function getTableGroupOrders(table, tables, ordersByTable) {
  if (!table) return [];
  const hostId = table.merged_with || table.id;
  const groupIds = [hostId, ...tables.filter(t => t.merged_with === hostId && t.id !== hostId).map(t => t.id)];
  return groupIds.flatMap(id => ordersByTable[id] || []);
}
