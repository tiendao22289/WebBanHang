const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvConfig } = require('@next/env');
const { createClient } = require('@supabase/supabase-js');

const root = path.resolve(__dirname, '..');
loadEnvConfig(root);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const website = process.env.LOCAL_WEBSITE_URL || 'http://localhost:3000';
assert.equal(url, 'http://localhost:8000');
assert.ok(anon && service && anon !== service);

async function main() {
  const client = createClient(url, anon, { auth: { persistSession: false } });
  for (const table of ['menu_items', 'tables', 'printers', 'print_jobs']) {
    const { error } = await client.from(table).select('*', { head: true }).limit(1);
    assert.ifError(error);
    console.log(`PASS: local website read ${table}`);
  }
  for (const route of ['/', '/admin/tables', '/order', '/api/menu/sales-stats']) {
    const response = await fetch(website + route, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, route);
    console.log(`PASS: production HTTP ${route}`);
  }
  const response = await fetch(website + '/api/admin/stats?period=today', {
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, 'Server service-role connection');
  console.log('PASS: server API using local service-role key');
  let localUrlFound = false;
  function checkBundle(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) checkBundle(file);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(file, 'utf8');
        assert.ok(!content.includes(service), 'Service-role key leaked into client bundle');
        assert.ok(!content.includes('wglhqlrumieujmugpxel.supabase.co'), 'Cloud URL in client bundle');
        localUrlFound ||= content.includes(url);
      }
    }
  }
  checkBundle(path.join(root, '.next', 'static'));
  assert.ok(localUrlFound, 'Local URL must be compiled into client bundle');
  console.log('PASS: client bundle uses local URL, no cloud URL or service-role key');
}
main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
