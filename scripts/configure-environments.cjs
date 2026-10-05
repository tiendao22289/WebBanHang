const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertRuntimeEnvironment } = require('../src/lib/runtime-mode.cjs');
const root = path.resolve(__dirname, '..');
const original = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
function parse(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function merge(text, values) {
  const keys = new Set(Object.keys(values));
  const lines = text.split(/\r?\n/).filter(line => !keys.has(line.slice(0, line.indexOf('='))));
  return lines.join('\n').trimEnd() + '\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}
const user = execFileSync('whoami.exe', { encoding: 'utf8' }).trim();
for (const mode of ['prod', 'dev']) {
  const credentials = parse(fs.readFileSync(mode === 'dev' ? 'C:/Tool/SupabaseDev/credentials.env' : 'C:/Tool/SupabaseLocal/credentials.env', 'utf8'));
  const nodeEnv = mode === 'dev' ? 'development' : 'production';
  const values = {
    APP_ENV: mode, NEXT_PUBLIC_APP_ENV: mode,
    NEXT_PUBLIC_SUPABASE_URL: credentials.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: credentials.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: credentials.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_SUPABASE_PROXY_PATH: mode === 'prod' ? '/supabase' : '',
  };
  assertRuntimeEnvironment(mode, { ...values, NODE_ENV: nodeEnv });
  // Empty every inherited application setting in dev so .env.local cannot supply prod integrations.
  const base = mode === 'prod' ? original : Object.keys(parse(original)).map(key => `${key}=`).join('\n');
  const file = path.join(root, `.env.${nodeEnv}.local`);
  fs.writeFileSync(file, merge(base, values), { mode: 0o600 });
  execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `${user}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'], { stdio: 'ignore' });
  console.log(`Configured ${mode}: Supabase local port ${mode === 'dev' ? 8001 : 8000}; ${path.basename(file)}`);
}
