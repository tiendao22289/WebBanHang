-- Paid orders, their item rows, and print jobs are financial audit records.
-- The old nightly job permanently deleted them when is_hidden_from_stats=true.
-- Keep the reporting flag's current behavior, but never purge the source data.
SELECT cron.unschedule('purge-hidden-orders')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'purge-hidden-orders'
);
