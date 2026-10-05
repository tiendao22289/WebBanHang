function runtimeSettings(mode) {
  if (!['dev', 'prod'].includes(mode)) throw new Error('APP_ENV must be dev or prod.');
  return {
    mode,
    nodeEnv: mode === 'dev' ? 'development' : 'production',
    apiPort: mode === 'dev' ? '8001' : '8000',
    webPort: mode === 'dev' ? 3001 : 3000,
    distDir: mode === 'dev' ? '.next-dev' : '.next',
    runtimeDirectory: mode === 'dev' ? 'C:\\Tool\\SupabaseDev' : 'C:\\Tool\\SupabaseLocal',
    composeDirectory: mode === 'dev' ? '/opt/webbanhang-supabase-dev' : '/opt/webbanhang-supabase',
    sessionCookie: mode === 'dev' ? 'local_dev_admin_session' : 'local_admin_session',
  };
}

function assertRuntimeEnvironment(mode, env) {
  const settings = runtimeSettings(mode);
  if (env.NODE_ENV !== settings.nodeEnv || env.APP_ENV !== mode) {
    throw new Error(`Refusing ${mode} startup with mismatched environment. Run npm run ${mode === 'dev' ? 'dev' : 'build/start'} or configure-environments.cjs.`);
  }
  let url;
  try { url = new URL(env.NEXT_PUBLIC_SUPABASE_URL); } catch { throw new Error('Missing local Supabase URL.'); }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === settings.apiPort;
  const remoteDev = mode === 'dev' && env.DEV_SUPABASE_REMOTE_URL === env.NEXT_PUBLIC_SUPABASE_URL &&
    url.protocol === 'https:' && url.hostname.endsWith('.ts.net') && url.port === '8443';
  if ((!local && !remoteDev) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Refusing ${mode} startup: Supabase must use local port ${settings.apiPort}.`);
  }
  for (const key of ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!env[key] || env[key].length < 40 || env[key].startsWith('replace_')) throw new Error(`Missing ${mode} credential: ${key}`);
  }
  return settings;
}
module.exports = { runtimeSettings, assertRuntimeEnvironment };
