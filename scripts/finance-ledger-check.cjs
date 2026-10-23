// Xem nhanh các bill trong Sổ thu chi của một ngày trên DB thật (chỉ đọc).
// Repo công khai → không in tên / SĐT khách. Chạy bởi workflow "Finance Ledger Check".
const fs = require('node:fs');
const envFile = process.argv[2] || 'C:\Tool\SupabaseLocal\production.env';
const date = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3] || '') ? process.argv[3] : new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const query = async sql => {
    const r = await fetch(`${new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin}/pg/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`SQL HTTP ${r.status}`);
    return r.json();
  };
  const rows = await query(`SELECT l.order_id, l.paid_at, l.recorded_at, l.table_number, l.payment_method, l.amount,
      jsonb_array_length(l.items) AS item_lines, o.status AS order_status, o.created_at AS order_created,
      o.paid_at AS order_paid_at, EXISTS (SELECT 1 FROM public.table_bill_history h WHERE h.order_id = l.order_id) AS in_history
    FROM public.finance_revenue_ledger l LEFT JOIN public.orders o ON o.id = l.order_id
    WHERE l.business_date = '${date}' ORDER BY l.paid_at`);
  const paper = await query(`SELECT received_at, amount, payment_method FROM public.finance_manual_receipts WHERE business_date = '${date}' ORDER BY received_at`);
  console.log(JSON.stringify({ date, bills: rows.map(r => ({ ...r, order_id: String(r.order_id).slice(0, 8) })), paper }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
