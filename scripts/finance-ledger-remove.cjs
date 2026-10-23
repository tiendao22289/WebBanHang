// Bỏ MỘT bill khỏi Sổ thu chi trên DB thật theo yêu cầu chủ quán (vd. bill ca đêm
// trước ngày sổ bắt đầu). Chỉ xoá khi khớp đúng ngày + đầu mã bill + số tiền và chỉ
// có đúng 1 dòng. Không đụng orders / lịch sử bàn / thống kê.
// node scripts/finance-ledger-remove.cjs <env> <YYYY-MM-DD> <8 ký tự đầu mã bill> <số tiền>
const fs = require('node:fs');
const [envFile, date, prefix, amount] = process.argv.slice(2);
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^[0-9a-f]{8}$/.test(prefix || '') || !/^\d+$/.test(amount || '')) throw new Error('Thiếu ngày / mã bill / số tiền.');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const query = async sql => {
    const r = await fetch(`${new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin}/pg/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`SQL HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const where = `business_date = '${date}' AND order_id::text LIKE '${prefix}%' AND amount = ${Number(amount)}`;
  const found = await query(`SELECT order_id FROM public.finance_revenue_ledger WHERE ${where}`);
  if (found.length !== 1) throw new Error(`Cần đúng 1 bill khớp, đang có ${found.length}. Không xoá gì.`);
  const history = await query(`SELECT expires_at > now() AS still_in_history FROM public.table_bill_history WHERE order_id = '${found[0].order_id}'`);
  await query(`DELETE FROM public.finance_revenue_ledger WHERE ${where}`);
  console.log(JSON.stringify({ removed: prefix, date, amount: Number(amount), historyStillLive: history[0]?.still_in_history ?? false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
