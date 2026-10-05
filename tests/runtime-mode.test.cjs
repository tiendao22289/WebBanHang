const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeSettings, assertRuntimeEnvironment } = require('../src/lib/runtime-mode.cjs');
function env(mode) {
  return { APP_ENV: mode, NODE_ENV: mode === 'dev' ? 'development' : 'production',
    NEXT_PUBLIC_SUPABASE_URL: `http://localhost:${mode === 'dev' ? 8001 : 8000}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a'.repeat(50), SUPABASE_SERVICE_ROLE_KEY: 'b'.repeat(50) };
}
test('dev and prod have independent build folders, runtime directories and session cookies', () => {
  const dev = assertRuntimeEnvironment('dev', env('dev'));
  const prod = assertRuntimeEnvironment('prod', env('prod'));
  for (const key of ['apiPort','webPort','distDir','runtimeDirectory','composeDirectory','sessionCookie']) assert.notEqual(dev[key], prod[key]);
});
test('cross-environment or remote database URLs fail closed', () => {
  assert.throws(() => assertRuntimeEnvironment('dev', env('prod')));
  assert.throws(() => assertRuntimeEnvironment('prod', env('dev')));
  assert.throws(() => assertRuntimeEnvironment('dev', { ...env('dev'), NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:8000' }));
  assert.throws(() => assertRuntimeEnvironment('prod', { ...env('prod'), NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:8001' }));
  assert.throws(() => assertRuntimeEnvironment('dev', { ...env('dev'), NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co' }));
  assert.throws(() => runtimeSettings('test'));
});
test('missing or placeholder credentials cannot start an application', () => {
  assert.throws(() => assertRuntimeEnvironment('prod', { ...env('prod'), SUPABASE_SERVICE_ROLE_KEY: '' }));
  assert.throws(() => assertRuntimeEnvironment('dev', { ...env('dev'), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'replace_with_dev_key' }));
});
test('remote dev requires explicit Tailscale HTTPS opt-in; prod always rejects it', () => {
  const url = 'https://desktop-8sbg15n.tail012010.ts.net:8443';
  const remote = { ...env('dev'), NEXT_PUBLIC_SUPABASE_URL: url, DEV_SUPABASE_REMOTE_URL: url };
  assert.equal(assertRuntimeEnvironment('dev', remote).mode, 'dev');
  assert.throws(() => assertRuntimeEnvironment('dev', { ...remote, DEV_SUPABASE_REMOTE_URL: '' }));
  assert.throws(() => assertRuntimeEnvironment('prod', { ...env('prod'), NEXT_PUBLIC_SUPABASE_URL: url, DEV_SUPABASE_REMOTE_URL: url }));
  for (const bad of ['https://example.com:8443', 'http://desktop-8sbg15n.tail012010.ts.net:8443', url + '/rest/v1', url + '?key=x']) {
    assert.throws(() => assertRuntimeEnvironment('dev', { ...remote, NEXT_PUBLIC_SUPABASE_URL: bad, DEV_SUPABASE_REMOTE_URL: bad }));
  }
});
