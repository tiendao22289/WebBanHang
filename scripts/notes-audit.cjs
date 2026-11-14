// Kiểm tra Sổ tay trên DB thật (chỉ đọc): tự tính lại từng phiếu và so với số đã lưu, nợ / lần trả nợ,
// tiền thừa chuyển phiếu / trả chủ / bù tiền bỏ thêm, ô thống kê từng tháng. Chạy bởi workflow "Notes Audit".
// Repo công khai → không in tên / SĐT / nội dung phiếu (src/lib/notesAudit.mjs chỉ đưa ra mã ngắn và số tiền).
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const envFile = process.argv[2] || String.raw`C:\Tool\SupabaseLocal\production.env`;
const monthArg = /^\d{4}-\d{2}(,\d{4}-\d{2})*$/.test(process.argv[3] || '') ? process.argv[3].split(',') : null;
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
  const { notesAudit } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'notesAudit.mjs')).href);
  const notes = await query('SELECT id, staff_id, note_type, content, amount, debt, paid_debt, created_at FROM public.staff_notes ORDER BY created_at');
  const payments = await query('SELECT id, note_id, item_index, amount, paid_at, paid_from_note_id FROM public.staff_note_payments ORDER BY paid_at');
  // Mặc định: tháng này và tháng trước (giờ VN).
  const now = new Date(Date.now() + 7 * 3600000);
  const ym = d => d.toISOString().slice(0, 7);
  const months = monthArg || [ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), ym(now)];
  console.log(JSON.stringify(notesAudit({ notes, payments, months }), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
