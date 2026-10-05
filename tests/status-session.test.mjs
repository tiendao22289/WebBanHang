import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession, redactLog, SESSION_SECONDS } from '../src/lib/statusSession.mjs';
const secret = 'test-secret'.repeat(6);
const id = '12345678-1234-1234-1234-123456789abc';
test('signed sessions are valid only before expiry and with correct key', () => {
  const token = signSession(id, secret, 100000);
  assert.equal(verifySession(token, secret, 100000).staffId, id);
  assert.equal(verifySession(token, 'wrong-secret', 100000), null);
  assert.equal(verifySession(token, secret, 100000 + SESSION_SECONDS * 1000), null);
  assert.equal(verifySession(token + '.extra', secret, 100000), null);
  assert.equal(verifySession(null, secret), null);
  assert.equal(verifySession('forged-admin-id', secret), null);
  assert.equal(verifySession(signSession('not-a-uuid', secret), secret), null);
});
test('logs redact known secrets, JWT, PAT, passwords and connection credentials', () => {
  const log = redactLog('secret-known eyJabc.abc.def sbp_abcdef password=foo postgres://postgres:pass@localhost token="hidden value"', ['secret-known']);
  for (const value of ['secret-known', 'eyJabc', 'sbp_abcdef', 'password=foo', ':pass@', 'hidden value']) assert.ok(!log.includes(value));
  assert.ok(log.includes('REDACTED'));
});
