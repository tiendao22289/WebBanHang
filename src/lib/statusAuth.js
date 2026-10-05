import 'server-only';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { STATUS_COOKIE, verifySession } from './statusSession.mjs';

let secret;
export function getStatusSecret() {
  if (secret) return secret;
  if (process.env.ADMIN_SESSION_SECRET?.length >= 32) return (secret = process.env.ADMIN_SESSION_SECRET);
  if (process.platform !== 'win32') throw new Error('ADMIN_SESSION_SECRET is required on this host.');
  const file = process.env.APP_ENV === 'dev' ? 'C:\\Tool\\SupabaseDev\\status-session.key' : 'C:\\Tool\\SupabaseLocal\\status-session.key';
  try { secret = readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { writeFileSync(file, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
    secret = readFileSync(file, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('Invalid session signing key.');
  return secret;
}

export function statusDatabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(6000) }) },
  });
}

export async function getStaffSession(request) {
  const session = verifySession(request.cookies.get(STATUS_COOKIE)?.value, getStatusSecret());
  if (!session) return { code: 401 };
  const { data, error } = await statusDatabase().from('staff').select('id,full_name,phone,role').eq('id', session.staffId).maybeSingle();
  if (error) return { code: 503 };
  return data ? { code: 200, user: data } : { code: 401 };
}

export async function requireStatusAdmin(request) {
  const session = await getStaffSession(request);
  if (session.code !== 200) return session.code;
  return session.user.role === 'admin' ? 200 : 403;
}
