# Daily Statistics Bill Quota

## Scope

POS table checkout uses one Vietnam-calendar-day budget for selected cash and
transfer receipts. The base is the first active visible bank account's daily
limit. The random target is between `max(1, base - 1,000,000)` and
`base + 2,000,000` VND and remains fixed for the day.

The budget opens gradually from 16:00 to 23:00. Eligible whole bills are selected
with 50% probability, rising to 100% in the final hour. A bill never exceeds the
currently opened budget. Low sales or large whole bills can leave the final
total below the target or below its lower bound; no amounts are fabricated.

Transfer routing is decided before displaying the QR: selected bills use A,
excluded bills use active hidden B/C accounts. Cash uses the same reporting
budget but never increases the bank-transfer ledger. The settings account A
counter displays the combined reporting amount and the saved target; B/C retain
their real bank totals. Custom `/admin/qr` transfers and cash receipts are unchanged.

## Retention And Dependencies

New selected receipts have immutable financial fields and immutable item rows.
Existing feedback updates remain allowed. Old receipts are never reclassified
or purged by this migration.

New excluded receipts are deleted only after payment succeeds and all related
print jobs are `done`. Pending/failed jobs keep their hidden receipts until
printing finishes; otherwise printers and reprint actions would lose their
source data. Cleanup runs on the next excluded settlement and every five minutes
when `pg_cron` is available. Without `pg_cron`, configure an equivalent worker
to call `public.purge_unselected_quota_bills()` as a privileged database role.

Cleanup deletes the bill, item rows, finished print snapshots and its QR
transaction records. Customer feedback is moved to the existing
`customer_reviews` table without a bill ID or amount. Daily quota totals and
bank-account totals are retained. Customer checkout uses the table's payment
timestamp so deleted paid receipts do not appear cancelled.

## Deploy

1. Deploy the matching POS, customer checkout and settings code first. The POS
   falls back to the existing routing only if the new RPC is absent or disabled.
   A network/validation failure stops QR creation.
2. Apply `supabase/migrations/stats_daily_bill_quota.sql` after
   `complete_table_payment_atomic.sql`, `protect_settled_order_items.sql`,
   `order_total_follows_items.sql` and `add_order_feedback_columns.sql`.
3. Keep the feature disabled while checking existing cash, transfer and custom
   QR behavior. The migration is disabled by default and is repeatable.
4. Reconcile pending QR payments from older clients before activation. Refresh
   all cashier clients. Activate during an empty checkout queue, preferably
   before the next business day, using:

```sql
UPDATE public.stats_quota_config
SET enabled = true, start_hour = 16, end_hour = 23
WHERE id = true;
```

5. Check a selected cash receipt, selected A transfer, excluded B/C transfer,
   merged-table payment, reopen/retry, customer payment notification and printer
   retry. Confirm selected receipt totals match the stats API and account A's
   combined counter. Confirm unselected receipts disappear only when printing
   is finished. No historical deletions are part of activation.

The first quota of a day seeds its totals from existing visible cash/transfer
receipts so activating mid-day cannot reset that day's reporting amount. Daily
base/target/window/account are fixed after initialization. Changed QR amounts or
groups must be prepared again; the server never silently changes the receiving
account at confirmation. An old-day QR requires reconciliation after midnight.

## Disable

Reconcile outstanding quota QR screens first, then:

```sql
UPDATE public.stats_quota_config SET enabled = false WHERE id = true;
```

This restores the original POS settlement/routing through the preserved legacy
function. Previously selected receipts remain protected. A disabled flag does
not restore receipts already deleted. Do not replace the original settlement
function by rerunning its old migration over the quota wrapper.

## Verification

```powershell
rtk proxy node --test tests/stats-daily-bill-quota.test.mjs tests/stats-quota-client.test.mjs
rtk proxy node --test tests/*.test.mjs
rtk npm run build
```

Database tests use PGlite, not the production Supabase instance. Before enabling
production, verify its foreign keys, triggers and scheduled cleanup. Anonymous
POS RPC access follows the repository's existing login design; this migration
does not redesign admin authentication.
