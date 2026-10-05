const assert = require('node:assert/strict');
const fs = require('node:fs');
function env(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
}
const dev = env('C:/Tool/SupabaseDev/credentials.env');
const prod = env('C:/Tool/SupabaseLocal/credentials.env');
async function verifyClient(port, config, other) {
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/admin/status`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const urls = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), base)).filter(url => url.pathname.endsWith('.js')))];
  let source = html;
  for (const url of urls) source += await (await fetch(url)).text();
  assert.ok(source.includes(config.NEXT_PUBLIC_SUPABASE_URL), `Client on port ${port} uses its own API URL`);
  assert.ok(source.includes(config.NEXT_PUBLIC_SUPABASE_ANON_KEY));
  assert.ok(!source.includes(other.NEXT_PUBLIC_SUPABASE_ANON_KEY), 'Other environment anon key is absent');
  assert.ok(!source.includes(config.SUPABASE_SERVICE_ROLE_KEY) && !source.includes(other.SUPABASE_SERVICE_ROLE_KEY), 'Service-role keys never enter client bundles');
  console.log(`PASS: browser bundle on ${port} uses the correct Supabase URL/key without server-key leakage`);
}
async function login(base, config) {
  const response = await fetch(`${config.SUPABASE_URL}/rest/v1/staff?role=eq.admin&select=phone,pin&limit=1`, { headers: { apikey: config.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}` } });
  const [staff] = await response.json();
  const result = await fetch(`${base}/api/admin/session`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: staff.phone, pin: String(staff.pin) }) });
  assert.equal(result.status, 200);
  return result.headers.get('set-cookie').split(';')[0];
}
async function main() {
  await verifyClient(3001, dev, prod);
  await verifyClient(3000, prod, dev);
  const devBase = 'http://127.0.0.1:3001';
  const prodBase = 'http://127.0.0.1:3000';
  const devCookie = await login(devBase, dev);
  const prodCookie = await login(prodBase, prod);
  assert.ok(devCookie.startsWith('local_dev_admin_session='));
  assert.ok(prodCookie.startsWith('local_admin_session='));
  assert.equal((await fetch(`${prodBase}/api/admin/status`, { headers: { Cookie: devCookie } })).status, 401);
  assert.equal((await fetch(`${prodBase}/api/admin/status`, { headers: { Cookie: devCookie.replace('local_dev_admin_session=', 'local_admin_session=') } })).status, 401);
  assert.equal((await fetch(`${devBase}/api/admin/status`, { headers: { Cookie: prodCookie.replace('local_admin_session=', 'local_dev_admin_session=') } })).status, 401);
  const devStatus = await (await fetch(`${devBase}/api/admin/status`, { headers: { Cookie: devCookie } })).json();
  assert.equal(devStatus.environment, 'dev');
  assert.ok(!devStatus.logSources.includes('printing') && !devStatus.logSources.includes('tunnel'));
  assert.equal((await fetch(`${devBase}/api/admin/status?log=printing`, { headers: { Cookie: devCookie } })).status, 400);
  console.log('PASS: login cookies/signing keys and admin logs are isolated between dev and prod');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
