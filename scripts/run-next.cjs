const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { loadEnvConfig } = require('@next/env');
const { assertRuntimeEnvironment } = require('../src/lib/runtime-mode.cjs');
const command = process.argv[2];
if (!['dev', 'build', 'start'].includes(command)) throw new Error('Expected dev, build or start.');
const mode = command === 'dev' ? 'dev' : 'prod';
process.env.NODE_ENV = mode === 'dev' ? 'development' : 'production';
// Do not let stale shell variables override the environment-specific local files.
for (const key of ['APP_ENV', 'NEXT_PUBLIC_APP_ENV', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_PROXY_PATH', 'ADMIN_SESSION_SECRET']) delete process.env[key];
const root = path.resolve(__dirname, '..');
if (mode === 'dev' && fs.existsSync(path.join(root, '.env.local'))) {
  for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match && match[1] !== 'NODE_ENV') delete process.env[match[1]];
  }
}
loadEnvConfig(root, mode === 'dev');
const settings = assertRuntimeEnvironment(mode, process.env);
const args = [require.resolve('next/dist/bin/next'), command];
if (command !== 'build') args.push('--hostname', '127.0.0.1', '--port', String(settings.webPort));
args.push(...process.argv.slice(3));
const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
