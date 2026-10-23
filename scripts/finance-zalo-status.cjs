// Xem nhanh trạng thái liên kết báo cáo Zalo trên DB thật (chỉ đọc).
// Repo công khai → chỉ in số lượng, thời gian, mã lỗi Zalo; không in Zalo id,
// mã liên kết hay khoá. Chạy bởi workflow "Finance Zalo Status" (chạy tay).
const fs = require('node:fs');

const envFile = process.argv[2] || 'C:\Tool\SupabaseLocal\production.env';
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const query = async sql => {
    const response = await fetch(`${url.origin}/pg/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`SQL HTTP ${response.status}`);
    return response.json();
  };
  const [row] = await query(`SELECT value, updated_at FROM public.finance_settings WHERE key = 'zalo_report'`);
  const v = row?.value || {};
  const now = Date.now();
  const [token] = await query(`SELECT t.refresh_token IS NOT NULL AS authorized, t.expires_at, to_jsonb(t)->>'last_send_error' AS last_send_error FROM public.zalo_oa_tokens t WHERE t.id = 'default'`);
  const [hook] = await query(`SELECT value FROM public.settings WHERE key = 'debug_zalo_signature'`);
  const [recent] = await query(`SELECT count(*)::int AS n, max(last_event_at) AS last FROM public.zalo_followers WHERE last_event_at > now() - interval '3 hours'`);
  const zaloError = text => {
    if (!text) return null;
    const code = /"error":\s*(-?\d+)/.exec(text)?.[1];
    const message = /"message":\s*"([^"]{0,200})"/.exec(text)?.[1];
    return { at: String(text).slice(0, 24), code: code ?? null, message: message ?? String(text).slice(25, 120) };
  };
  console.log(JSON.stringify({
    report: row ? {
      settingsUpdatedAt: row.updated_at, owners: (v.ownerIds || []).length,
      codeLive: !!v.linkCode && Number(v.linkCodeExpires) > now,
      codeCreatedAt: v.linkCodeExpires ? new Date(Number(v.linkCodeExpires) - 30 * 60000).toISOString() : null,
      wrongAttempts: v.linkAttempts || 0, lastSentAt: v.lastSentAt || null, lastError: zaloError(v.lastError),
    } : 'chưa có cài đặt',
    oa: token ? { authorized: token.authorized, tokenExpiresAt: token.expires_at, lastSendError: zaloError(token.last_send_error) } : 'không có token',
    lastWebhookAt: hook?.value ? String(hook.value).slice(0, 24) : null,
    followersActiveLast3h: recent,
  }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
