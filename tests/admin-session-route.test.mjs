import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { NextResponse } from 'next/server.js';
import { STATUS_COOKIE, SESSION_SECONDS, signSession, verifySession } from '../src/lib/statusSession.mjs';

const secret = 'route-test-secret'.repeat(4);
const id = '12345678-1234-1234-1234-123456789abc';
const source = readFileSync(new URL('../src/app/api/admin/session/route.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

// Exercise the route with real NextResponse cookies and an isolated staff lookup.
function route(getStaffSession, role = 'admin') {
  const database = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
    single: async () => ({ data: { id, role }, error: null }),
  }) }) }) }) };
  return compileFunction(`${source}\nreturn { GET, POST, DELETE };`, [
    'NextResponse', 'getStatusSecret', 'getStaffSession', 'statusDatabase',
    'STATUS_COOKIE', 'SESSION_SECONDS', 'signSession',
  ])(NextResponse, () => secret, getStaffSession, () => database, STATUS_COOKIE, SESSION_SECONDS, signSession);
}

function request(method = 'GET', secure = false) {
  return new Request('http://localhost:3001/api/admin/session', {
    method, headers: { host: 'localhost:3001', origin: 'http://localhost:3001',
      ...(secure ? { 'x-forwarded-proto': 'https' } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    }, ...(method === 'POST' ? { body: JSON.stringify({ phone: 'test-phone', pin: 'test-pin' }) } : {}),
  });
}

for (const role of ['admin', 'staff']) {
  test(`${role} login and session restoration persist and renew a signed 90-day cookie`, async () => {
    const api = route(async () => ({ code: 200, user: { id, role } }), role);
    for (const response of [await api.POST(request('POST')), await api.GET(request())]) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).user.role, role);
      const cookie = response.cookies.get(STATUS_COOKIE);
      assert.equal(cookie.maxAge, 90 * 24 * 60 * 60);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.sameSite, 'strict');
      assert.equal(cookie.path, '/');
      assert.equal(verifySession(cookie.value, secret)?.staffId, id);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await api.GET(request('GET', true))).cookies.get(STATUS_COOKIE).secure, true);
    const logout = await api.DELETE(request('DELETE'));
    assert.equal(logout.cookies.get(STATUS_COOKIE).maxAge, 0);
  });
}

test('invalid sessions and temporary database failures never issue a new cookie', async () => {
  for (const code of [401, 503]) {
    const response = await route(async () => ({ code })).GET(request());
    assert.equal(response.status, code);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const response = await route(async () => { throw new Error('Database unavailable'); }).GET(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('cross-origin requests cannot login or logout', async () => {
  const api = route(async () => ({ code: 401 }));
  for (const method of ['POST', 'DELETE']) {
    const req = request(method);
    req.headers.set('origin', 'https://other.example');
    const response = await api[method](req);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});
