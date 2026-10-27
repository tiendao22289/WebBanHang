// Kiểm tra tổng thể một ngày, CHỈ ĐỌC: tiền, bill thiếu / bàn còn mở, ảnh CK, huỷ / bớt món, chấm công, Sổ tay.
// Chạy bởi workflow "Finance Day Audit" trên runner của máy chủ, đọc C:\Tool\SupabaseLocal\production.env.
// Gọi web đang chạy ở 127.0.0.1:3000, ký bằng HMAC của khoá service role ('finance-day-audit').
// Kho mã công khai: kết quả không có tên / SĐT khách, không có tên nhân viên (NV-xxxx). Không in khoá bí mật.
const crypto = require('node:crypto');
const fs = require('node:fs');

const envFile = process.argv[2] || 'C:\Tool\SupabaseLocal\production.env';
const date = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3] || '') ? process.argv[3] : '';
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  const secret = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || secret.length < 40) throw new Error('Thiếu SUPABASE_SERVICE_ROLE_KEY.');
  const key = crypto.createHmac('sha256', secret).update('finance-day-audit').digest('hex');
  const response = await fetch('http://127.0.0.1:3000/api/admin/finance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-finance-report-key': key },
    body: JSON.stringify({ action: 'day_audit', ...(date ? { date } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status} ${result.error || 'Web không trả kết quả kiểm tra.'}`);
  console.log(JSON.stringify(result.audit, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
