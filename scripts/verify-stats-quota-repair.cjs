const fs = require('node:fs');
const assert = require('node:assert/strict');
const original = JSON.parse(fs.readFileSync('artifacts/stats-quota-backup-2026-10-02-03.json', 'utf8'))[0].backup;
const plan = JSON.parse(fs.readFileSync('artifacts/stats-quota-repair-plan.json', 'utf8'));
const current = JSON.parse(fs.readFileSync('artifacts/stats-quota-post-repair.json', 'utf8'))[0].verified;
const keep = new Set(plan.keepIds);
assert.equal(current.orders.length, plan.keepIds.length);
for (const expected of original.orders.filter(order => keep.has(order.id))) {
  const actual = current.orders.find(order => order.id === expected.id);
  assert.ok(actual, 'Selected receipt disappeared');
  const { stats_quota_selected, ...rest } = actual;
  assert.equal(stats_quota_selected, true);
  assert.deepEqual(rest, expected, 'Selected receipt financial/customer data changed');
}
const sort = rows => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
assert.deepEqual(sort(current.items), sort(original.order_items.filter(item => keep.has(item.order_id))));
assert.deepEqual(sort(current.bank_totals), sort(original.bank_daily_totals), 'Actual bank totals changed');
for (const order of original.orders.filter(order => order.customer_rating || order.customer_feedback)) {
  if (keep.has(order.id)) continue;
  assert.ok(current.reviews.some(review => review.table_id === order.table_id && review.rating === order.customer_rating
    && review.feedback === order.customer_feedback && review.customer_name === order.customer_name), 'Customer feedback missing');
}
assert.equal(current.config.enabled, true);
assert.equal(current.fixtures, 0);
assert.ok(current.cron.some(job => job.name === 'purge-unselected-quota-bills' && job.active));
for (const day of plan.days) {
  const q = current.quota.find(row => row.date === day.day);
  assert.equal(q.cash_amount + q.transfer_amount, day.amount);
  assert.equal(q.target_amount, day.target);
  assert.ok(day.amount >= 4000000 && day.amount <= 7000000);
}
console.log(JSON.stringify({ result: 'VERIFIED', selectedReceiptsUnchanged: keep.size,
  removedReceipts: plan.removeIds.length, bankTotalsUnchanged: true,
  customerFeedbackPreserved: true, enabled: true, rollbackFixturesRemaining: current.fixtures }, null, 2));
