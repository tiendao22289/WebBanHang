const assert = require('node:assert/strict');
const { loadEnvConfig } = require('@next/env');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  process.env.NODE_ENV = 'development';
  loadEnvConfig(process.cwd(), true);
  assert.equal(process.env.APP_ENV, 'dev', 'Only run against the dev database');
  const base = 'http://127.0.0.1:3001';
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) },
  });
  const request = (options = {}) => fetch(`${base}/api/admin/session`, {
    ...options, signal: AbortSignal.timeout(60000),
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request({ headers: { Cookie: 'local_dev_admin_session=forged' } })).status, 401);
  for (const role of ['admin', 'staff']) {
    const { data, error } = await db.from('staff').select('id,phone,pin,role').eq('role', role).limit(1);
    assert.ok(!error, error ? `Dev staff lookup failed: ${error.message}` : 'Dev staff lookup must succeed');
    assert.ok(data?.[0], `Dev database needs a ${role} account`);
    const staff = data[0];
    const login = await request({ method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: staff.phone, pin: String(staff.pin) }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /Max-Age=7776000/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    const savedCookie = cookie.split(';')[0];
    const expiry = value => JSON.parse(Buffer.from(value.split('=')[1].split('.')[0], 'base64url').toString()).exp;
    await new Promise(resolve => setTimeout(resolve, 1100));
    // A fresh request with only the saved cookie models reopening the app.
    const restored = await request({ headers: { Cookie: savedCookie } });
    assert.equal(restored.status, 200);
    const user = (await restored.json()).user;
    assert.equal(user.id, staff.id);
    assert.equal(user.role, role);
    assert.match(restored.headers.get('cache-control'), /no-store/i);
    const renewedCookie = restored.headers.get('set-cookie');
    assert.match(renewedCookie, /Max-Age=7776000/i);
    assert.ok(expiry(renewedCookie) > expiry(savedCookie));
    const logout = await request({ method: 'DELETE', headers: { Origin: base, Cookie: savedCookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);
    console.log(`PASS ${role}: persistent cookie, restored identity, renewed expiry, logout clears cookie`);
  }
}

main().catch(async error => {
  const { redactLog } = await import('../src/lib/statusSession.mjs');
  console.error(`FAIL: ${redactLog(error.message, [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, process.env.ADMIN_SESSION_SECRET])}`);
  process.exitCode = 1;
});
