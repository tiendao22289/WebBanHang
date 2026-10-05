const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadEnvConfig } = require('@next/env');
const { createClient } = require('@supabase/supabase-js');
const isDev = process.env.LOCAL_VERIFY_MODE === 'dev';
process.env.NODE_ENV = isDev ? 'development' : 'production';
loadEnvConfig(process.cwd(), isDev);
const url = process.env.LOCAL_STATUS_BASE_URL || 'http://127.0.0.1:3000';
const database = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function login(staff) {
  const response = await fetch(`${url}/api/admin/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ phone: staff.phone, pin: String(staff.pin) }),
  });
  assert.equal(response.status, 200, 'Real credentials should sign in');
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=strict'));
  assert.ok(!(await response.text()).includes('"pin"'));
  return cookie.split(';')[0];
}

async function main() {
  assert.equal((await fetch(`${url}/api/admin/status`)).status, 401);
  assert.equal((await fetch(`${url}/api/admin/status?log=website`)).status, 401);
  assert.equal((await fetch(`${url}/api/admin/status`, { headers: { Cookie: 'local_admin_session=forged' } })).status, 401);
  console.log('PASS: anonymous and forged sessions cannot read status or logs');
  const { data, error } = await database.from('staff').select('id,phone,pin,role');
  assert.ifError(error);
  const admin = data.find(staff => staff.role === 'admin');
  assert.ok(admin);
  const cookie = await login(admin);
  const session = await fetch(`${url}/api/admin/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.id, admin.id);
  console.log('PASS: shared admin session is restored without another login');
  let response = await fetch(`${url}/api/admin/status`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('cache-control').includes('no-store'));
  const status = await response.json();
  console.log(JSON.stringify({ services: status.services, printers: status.printers, cron: status.cron }, null, 2));
  assert.equal(status.services.filter(service => service.id.startsWith('supabase:')).length, 11);
  assert.equal(status.environment, isDev ? 'dev' : 'prod');
  if (isDev) {
    assert.ok(!status.services.some(service => service.id === 'printing' || service.id === 'tunnel' || service.id === 'public'));
    assert.ok(status.cron.length > 0 && status.cron.every(job => !job.active));
  } else {
    assert.ok(status.services.some(service => service.id === 'printing' && service.state === 'healthy'));
    assert.ok(status.cron.some(job => job.active));
  }
  console.log(`PASS: admin status uses the ${isDev ? 'dev' : 'prod'} database and service scope`);
  for (const source of isDev ? ['website', 'supabase:db'] : ['website', 'printing', 'tunnel', 'supabase:db']) {
    response = await fetch(`${url}/api/admin/status?log=${encodeURIComponent(source)}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const { log } = await response.json();
    assert.ok(typeof log === 'string' && log.length > 0);
    assert.ok(!log.includes(process.env.SUPABASE_SERVICE_ROLE_KEY));
    assert.ok(!log.includes(fs.readFileSync('C:/Tool/SupabaseLocal/named-tunnel.token', 'utf8').trim()));
  }
  assert.equal((await fetch(`${url}/api/admin/status?log=../../credentials.env`, { headers: { Cookie: cookie } })).status, 400);
  console.log('PASS: allowlisted, redacted logs; arbitrary file paths rejected');
  const staff = data.find(row => row.role !== 'admin');
  if (staff) {
    const staffCookie = await login(staff);
    assert.equal((await fetch(`${url}/api/admin/status`, { headers: { Cookie: staffCookie } })).status, 403);
    assert.equal((await fetch(`${url}/api/admin/status?log=website`, { headers: { Cookie: staffCookie } })).status, 403);
    console.log('PASS: authenticated non-admin is forbidden');
  } else console.log('SKIP: no non-admin staff fixture available');
  response = await fetch(`${url}/api/admin/session`, { method: 'DELETE', headers: { Origin: url, Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('set-cookie').includes('Max-Age=0'));
  console.log('PASS: logout clears the HTTP-only cookie');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
