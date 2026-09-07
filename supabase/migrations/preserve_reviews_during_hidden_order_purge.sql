-- Keep customer feedback even when hidden orders are purged from reporting data.
-- Reviewed hidden orders remain excluded from statistics via is_hidden_from_stats,
-- but their rating and feedback stay available on the admin Reviews page.

SELECT cron.unschedule('purge-hidden-orders')
WHERE EXISTS (
  SELECT 1
  FROM cron.job
  WHERE jobname = 'purge-hidden-orders'
);

SELECT cron.schedule(
  'purge-hidden-orders',
  '0 20 * * *', -- 03:00 Asia/Ho_Chi_Minh
  'DELETE FROM public.orders WHERE is_hidden_from_stats = true AND customer_rating IS NULL AND customer_feedback IS NULL'
);
