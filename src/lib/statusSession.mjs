import { createHmac, timingSafeEqual } from 'node:crypto';

export const STATUS_COOKIE = process.env.APP_ENV === 'dev' ? 'local_dev_admin_session' : 'local_admin_session';
export const SESSION_SECONDS = 8 * 60 * 60;

export function signSession(staffId, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ staffId, exp: Math.floor(now / 1000) + SESSION_SECONDS })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function verifySession(token, secret, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = createHmac('sha256', secret).update(payload).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(session.staffId)) return null;
    if (!Number.isSafeInteger(session.exp) || session.exp <= Math.floor(now / 1000)) return null;
    return session;
  } catch { return null; }
}

export function redactLog(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]')
    .replace(/sbp_[a-f0-9]+/gi, '[REDACTED TOKEN]')
    .replace(/((?:password|secret|token|api[_-]?key|authorization|pin)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[REDACTED]@');
}
