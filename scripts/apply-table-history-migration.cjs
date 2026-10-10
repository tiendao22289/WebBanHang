const fs = require('node:fs');
const path = require('node:path');
const { loadEnvConfig } = require('@next/env');
const { assertRuntimeEnvironment } = require('../src/lib/runtime-mode.cjs');

process.env.NODE_ENV = 'production';
loadEnvConfig(path.resolve(__dirname, '..'), false);
assertRuntimeEnvironment('prod', process.env);
const base = 'http://127.0.0.1:8000';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error('Production server credential is missing.');
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function query(sql) {
  const response = await fetch(base + '/pg/query', {
    method: 'POST', headers, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`History migration SQL HTTP ${response.status}, code ${error.code || 'unknown'}.`);
  }
  return response.json();
}

(async () => {
  const [before] = await query(`SELECT
    to_regclass('public.dev_environment_marker') IS NOT NULL AS is_dev,
    to_regclass('public.table_bill_history') IS NOT NULL AS installed,
    to_regclass('cron.job') IS NOT NULL AS has_cron,
    md5(pg_get_functiondef(to_regprocedure('public.complete_table_payment_atomic(uuid,uuid[],numeric,text,uuid,boolean,uuid,text,text)'))) AS settlement_hash,
    md5(pg_get_functiondef(to_regprocedure('public.purge_unselected_quota_bills()'))) AS quota_purge_hash;`);
  if (before.is_dev) throw new Error('Refusing to apply production migration to DEV.');
  if (!before.has_cron) throw new Error('pg_cron is required for automatic history expiration.');
  const file = before.installed ? 'table_bill_history_best_effort.sql' : 'table_bill_history_10h.sql';
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', file), 'utf8'));
  const [after] = await query(`SELECT
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.orders'::regclass
      AND tgname='capture_table_bill_history' AND tgenabled='O') AS has_trigger,
    position('EXCEPTION WHEN OTHERS' IN pg_get_functiondef('public.capture_table_bill_history()'::regprocedure)) > 0 AS nonblocking,
    EXISTS (SELECT 1 FROM cron.job WHERE jobname='purge-expired-table-bill-history'
      AND active AND schedule='* * * * *'
      AND command='SELECT public.purge_expired_table_bill_history()') AS has_cleanup,
    md5(pg_get_functiondef(to_regprocedure('public.complete_table_payment_atomic(uuid,uuid[],numeric,text,uuid,boolean,uuid,text,text)'))) AS settlement_hash,
    md5(pg_get_functiondef(to_regprocedure('public.purge_unselected_quota_bills()'))) AS quota_purge_hash;`);
  if (!after.has_trigger || !after.nonblocking || !after.has_cleanup
    || after.settlement_hash !== before.settlement_hash || after.quota_purge_hash !== before.quota_purge_hash) {
    throw new Error('Production history migration verification failed. Web activation cancelled.');
  }
  const response = await fetch(base + '/rest/v1/table_bill_history?select=order_id&limit=0', { headers });
  if (!response.ok) throw new Error(`History API HTTP ${response.status}. Web activation cancelled.`);
  console.log('PASS: production history trigger, non-blocking capture, minute cleanup and API; settlement/quota functions unchanged.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
