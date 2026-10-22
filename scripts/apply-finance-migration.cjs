// Cài supabase/migrations/owner_finance.sql vào DB THẬT trên máy chủ quán.
// Chạy bởi workflow "Apply Finance Migration" (chạy tay) trên runner của máy
// chủ, đọc C:\Tool\SupabaseLocal\production.env. Chỉ chạy khi đúng là
// Supabase prod cục bộ (http://localhost:8000) và không phải DB DEV.
// Không in khoá bí mật. File SQL chạy lại được nhiều lần.
const fs = require('node:fs');
const path = require('node:path');

const envFile = process.argv[2] || 'C:\\Tool\\SupabaseLocal\\production.env';
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '8000') {
    throw new Error('Chỉ cài vào Supabase prod cục bộ cổng 8000.');
  }
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.length < 40) throw new Error('Thiếu SUPABASE_SERVICE_ROLE_KEY.');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const base = url.origin;
  const query = async sql => {
    const response = await fetch(`${base}/pg/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`SQL HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };

  // DB DEV có bảng đánh dấu; DB thật thì không.
  const [marker] = await query(`SELECT to_regclass('public.dev_environment_marker') AS dev, to_regclass('public.orders') AS orders`);
  if (marker.dev) throw new Error('Đây là DB DEV, dừng lại.');
  if (!marker.orders) throw new Error('Không thấy bảng orders, sai DB.');

  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'owner_finance.sql'), 'utf8');
  await query(sql);

  const [check] = await query(`SELECT
    to_regclass('public.finance_revenue_ledger') IS NOT NULL AS ledger,
    to_regclass('public.finance_entries') IS NOT NULL AS entries,
    to_regclass('public.finance_day_closes') IS NOT NULL AS day_closes,
    to_regclass('public.finance_categories') IS NOT NULL AS categories,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_finance_revenue' AND tgrelid = 'public.orders'::regclass AND tgenabled = 'O') AS trigger_on,
    NOT has_table_privilege('anon', 'public.finance_revenue_ledger', 'SELECT') AS anon_blocked,
    (SELECT count(*)::int FROM public.finance_revenue_ledger) AS ledger_rows`);
  console.log(JSON.stringify(check));
  if (!check.ledger || !check.entries || !check.day_closes || !check.categories || !check.trigger_on || !check.anon_blocked) {
    throw new Error('Cài chưa đủ, xem kết quả kiểm tra ở trên.');
  }
  console.log('Đã cài sổ thu chi vào DB thật.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
