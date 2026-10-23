// Gửi báo cáo Sổ thu chi ngày hôm qua tới Zalo của chủ quán.
// Chạy bởi workflow "Finance Daily Report" (8 giờ sáng) trên runner của máy
// chủ, đọc C:\Tool\SupabaseLocal\production.env. Gọi web đang chạy ở
// 127.0.0.1:3000, ký bằng HMAC của khoá service role. Không in khoá bí mật.
const crypto = require('node:crypto');
const fs = require('node:fs');

const envFile = process.argv[2] || 'C:\Tool\SupabaseLocal\production.env';
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  const secret = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || secret.length < 40) throw new Error('Thiếu SUPABASE_SERVICE_ROLE_KEY.');
  const key = crypto.createHmac('sha256', secret).update('finance-daily-report').digest('hex');
  const response = await fetch('http://127.0.0.1:3000/api/admin/finance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-finance-report-key': key },
    body: JSON.stringify({ action: 'daily_report' }),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json().catch(() => ({}));
  console.log(`HTTP ${response.status} ${JSON.stringify(result)}`);
  if (!response.ok) throw new Error('Web không nhận yêu cầu gửi báo cáo.');
  // Chưa liên kết Zalo / Zalo từ chối: trang Sổ thu chi đã hiện lý do, không làm đỏ workflow mỗi ngày.
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
