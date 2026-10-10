-- Removes the optional ten-hour archive. Archived snapshots are deleted.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE job_id bigint;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR job_id IN SELECT jobid FROM cron.job
      WHERE jobname = 'purge-expired-table-bill-history'
    LOOP
      PERFORM cron.unschedule(job_id);
    END LOOP;
  END IF;
END $$;

DROP TRIGGER IF EXISTS capture_table_bill_history ON public.orders;
DROP FUNCTION IF EXISTS public.capture_table_bill_history();
DROP FUNCTION IF EXISTS public.purge_expired_table_bill_history();
DROP TABLE IF EXISTS public.table_bill_history;
NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT
  to_regclass('public.table_bill_history') IS NULL AS history_table_removed,
  to_regprocedure('public.capture_table_bill_history()') IS NULL AS capture_removed,
  to_regprocedure('public.purge_expired_table_bill_history()') IS NULL AS cleanup_removed;
