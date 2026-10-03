const fs = require('node:fs');
const { randomInt } = require('node:crypto');

const backup = JSON.parse(fs.readFileSync('artifacts/stats-quota-backup-2026-10-02-03.json', 'utf8'))[0].backup;
const groups = new Map();
for (const order of backup.orders) {
  if (order.status !== 'paid' || !order.paid_at) throw new Error('Repair only handles paid receipts with an exact settlement time');
  const day = new Date(new Date(order.created_at).getTime() + 7 * 3600000).toISOString().slice(0, 10);
  const key = `${day}|${order.paid_at}|${order.payment_method}`;
  const group = groups.get(key) || { day, at: order.paid_at, amount: 0, orders: [], visible: true };
  group.amount += Number(order.total_amount);
  group.orders.push(order);
  group.visible &&= !order.is_hidden_from_stats;
  groups.set(key, group);
}

const days = [];
const keep = new Set();
const savedPlan = fs.existsSync('artifacts/stats-quota-repair-plan.json')
  ? JSON.parse(fs.readFileSync('artifacts/stats-quota-repair-plan.json', 'utf8')) : null;
for (const day of ['2026-10-02', '2026-10-03']) {
  if (savedPlan) {
    savedPlan.keepIds.forEach(id => keep.add(id));
    days.push(savedPlan.days.find(row => row.day === day));
    continue;
  }
  const candidates = [...groups.values()].filter(g => g.day === day && g.visible)
    .sort((a, b) => a.at.localeCompare(b.at));
  let best;
  for (let attempt = 0; attempt < 10000; attempt++) {
    const target = randomInt(4000, 7001) * 1000;
    let amount = 0;
    const selected = [];
    for (const group of candidates) {
      const time = new Date(new Date(group.at).getTime() + 7 * 3600000);
      const hour = time.getUTCHours() + time.getUTCMinutes() / 60 + time.getUTCSeconds() / 3600;
      const allowance = Math.floor(target * Math.max(0, Math.min(1, (hour - 16 + 0.5) / 7.5)));
      if (group.amount + amount <= allowance && (hour >= 22 || randomInt(2) === 1)) {
        amount += group.amount;
        selected.push(group);
      }
    }
    const lastHour = selected.length ? new Date(new Date(selected.at(-1).at).getTime() + 7 * 3600000).getUTCHours() : 0;
    const hasBothMethods = new Set(selected.flatMap(g => g.orders.map(o => o.payment_method))).size === 2;
    if (amount >= 4000000 && amount <= 7000000 && lastHour >= 22 && hasBothMethods) {
      best = { day, target, amount, selected };
      if (target - amount <= 300000) break;
    }
  }
  if (!best) throw new Error(`Cannot construct a whole-bill plan respecting the time budget for ${day}`);
  const keptOrders = best.selected.flatMap(g => g.orders);
  keptOrders.forEach(order => keep.add(order.id));
  days.push({ day, target: best.target, amount: best.amount,
    cash: keptOrders.filter(o => o.payment_method === 'cash').reduce((n, o) => n + o.total_amount, 0),
    transfer: keptOrders.filter(o => o.payment_method === 'transfer').reduce((n, o) => n + o.total_amount, 0),
    keptOrders: keptOrders.length, keptPayments: best.selected.length,
    first: best.selected[0].at, last: best.selected.at(-1).at,
    previous: backup.orders.filter(o => !o.is_hidden_from_stats &&
      new Date(new Date(o.created_at).getTime() + 7 * 3600000).toISOString().slice(0,10) === day)
      .reduce((n,o) => n + o.total_amount,0),
  });
}

const expected = backup.orders.map(o => ({
  id: o.id, amount: o.total_amount, created_at: o.created_at, paid_at: o.paid_at,
  payment_method: o.payment_method, hidden: !!o.is_hidden_from_stats, selected: keep.has(o.id),
}));
const scopedIds = new Set(backup.orders.map(o => o.id));
for (const job of backup.print_jobs) {
  if (job.status !== 'done') throw new Error('Unfinished printing prevents deleting these historical receipts');
}
for (const tx of backup.payment_transactions) {
  const ids = tx.order_ids.split(',');
  const isRemoved = ids.some(id => scopedIds.has(id) && !keep.has(id));
  if (isRemoved && ids.some(id => !scopedIds.has(id) || keep.has(id))) {
    throw new Error('Mixed QR transaction needs independent reconciliation');
  }
}

const sql = `-- One-time, ID-scoped repair, generated from a local rollback snapshot.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TEMP TABLE repair_expected AS
SELECT * FROM jsonb_to_recordset($expected$${JSON.stringify(expected)}$expected$::jsonb)
AS r(id uuid, amount numeric, created_at timestamptz, paid_at timestamptz,
  payment_method text, hidden boolean, selected boolean);
SELECT o.id FROM public.orders o JOIN repair_expected e ON e.id=o.id ORDER BY o.id FOR UPDATE OF o;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.orders o WHERE o.created_at >= '2026-10-02T00:00:00+07:00'
    AND o.created_at < '2026-10-04T00:00:00+07:00'
    AND o.status IN ('paid','completed') AND o.payment_method IN ('cash','transfer')
    AND NOT EXISTS (SELECT 1 FROM repair_expected e WHERE e.id=o.id)) THEN
    RAISE EXCEPTION 'New historical receipts appeared since backup; repair aborted';
  END IF;
  IF EXISTS (SELECT 1 FROM repair_expected e LEFT JOIN public.orders o ON o.id=e.id
    WHERE o.id IS NULL OR o.status <> 'paid' OR o.total_amount IS DISTINCT FROM e.amount
      OR o.created_at IS DISTINCT FROM e.created_at OR o.paid_at IS DISTINCT FROM e.paid_at
      OR o.payment_method IS DISTINCT FROM e.payment_method
      OR COALESCE(o.is_hidden_from_stats,false) IS DISTINCT FROM e.hidden
      OR o.stats_quota_selected IS NOT NULL) THEN
    RAISE EXCEPTION 'Historical receipts changed since backup; repair aborted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.print_jobs j JOIN repair_expected e
    ON j.order_id=e.id OR e.id=ANY(j.order_ids) WHERE NOT e.selected AND j.status IS DISTINCT FROM 'done') THEN
    RAISE EXCEPTION 'Unfinished historical printing; repair aborted';
  END IF;
END $$;
SELECT set_config('app.stats_quota_settlement','on',true);
UPDATE public.orders o SET stats_quota_selected=e.selected, is_hidden_from_stats=NOT e.selected
FROM repair_expected e WHERE o.id=e.id;
SELECT set_config('app.stats_quota_settlement','off',true);
INSERT INTO public.stats_daily_quotas(date,account_id,base_amount,target_amount,cash_amount,transfer_amount,start_hour,end_hour)
SELECT r.day, a.id, a.daily_limit, r.target, r.cash, r.transfer, 16, 23
FROM jsonb_to_recordset($days$${JSON.stringify(days)}$days$::jsonb)
AS r(day date, target numeric, cash numeric, transfer numeric)
CROSS JOIN LATERAL (SELECT id,daily_limit FROM public.bank_accounts
  WHERE is_visible AND is_active ORDER BY sort_order,id LIMIT 1) a;
SELECT public.purge_unselected_quota_bills() AS deleted_orders;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM repair_expected e JOIN public.orders o ON o.id=e.id WHERE NOT e.selected) THEN
    RAISE EXCEPTION 'Not all excluded historical receipts were deleted; repair aborted';
  END IF;
  IF EXISTS (SELECT 1 FROM repair_expected e LEFT JOIN public.orders o ON o.id=e.id WHERE e.selected
    AND (o.id IS NULL OR o.total_amount IS DISTINCT FROM e.amount OR o.created_at IS DISTINCT FROM e.created_at
      OR o.paid_at IS DISTINCT FROM e.paid_at OR o.is_hidden_from_stats OR o.stats_quota_selected IS DISTINCT FROM true)) THEN
    RAISE EXCEPTION 'Retained financial details do not match backup; repair aborted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stats_daily_quotas q WHERE q.date IN ('2026-10-02','2026-10-03')
    AND q.cash_amount+q.transfer_amount IS DISTINCT FROM (
      SELECT COALESCE(sum(o.total_amount),0) FROM public.orders o
      WHERE (o.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=q.date
        AND o.status IN ('paid','completed') AND o.payment_method IN ('cash','transfer')
        AND NOT COALESCE(o.is_hidden_from_stats,false))) THEN
    RAISE EXCEPTION 'Daily visible amount does not match combined quota; repair aborted';
  END IF;
END $$;
UPDATE public.stats_quota_config SET enabled=true WHERE id=true;
SELECT date, target_amount, cash_amount, transfer_amount, cash_amount+transfer_amount AS combined
FROM public.stats_daily_quotas WHERE date IN ('2026-10-02','2026-10-03') ORDER BY date;
COMMIT;
`;
fs.writeFileSync('artifacts/stats-quota-repair-2026-10-02-03.sql', sql);
fs.writeFileSync('artifacts/stats-quota-repair-dry-run.sql', sql.slice(0, sql.lastIndexOf('COMMIT;')) + 'ROLLBACK;\n');
fs.writeFileSync('artifacts/stats-quota-repair-plan.json', JSON.stringify({ days, keepIds: [...keep], removeIds: expected.filter(o => !o.selected).map(o => o.id) }, null, 2));
console.log(JSON.stringify({ days, kept: keep.size, removed: expected.length - keep.size }, null, 2));
