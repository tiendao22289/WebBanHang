import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { NextResponse } from 'next/server.js';
import { STATUS_COOKIE, SESSION_SECONDS, signSession, verifySession } from '../src/lib/statusSession.mjs';
import { hashPin, isHashedPin, pinMatches } from '../src/lib/staffPin.mjs';

const secret = 'route-test-secret'.repeat(4);
const id = '12345678-1234-1234-1234-123456789abc';
const source = readFileSync(new URL('../src/app/api/admin/session/route.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

// Exercise the route with real NextResponse cookies and an isolated staff lookup.
// staff có PIN cũ lưu chữ thường 'test-pin'; mọi lệnh update được ghi lại.
function route(getStaffSession, role = 'admin', staff = { id, role, pin: 'test-pin', phone: 'test-phone' }, updates = [], hasLeft = async () => false) {
  const database = { from: () => ({
    select: () => ({ eq: (k, v) => ({ limit: async () => ({ data: v === staff.phone ? [{ ...staff }] : [], error: null }) }) }),
    update: values => ({ eq: () => { updates.push(values); Object.assign(staff, values); return Promise.resolve({ error: null }); } }),
  }) };
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key'.repeat(2);
  return compileFunction(`${source}\nreturn { GET, POST, DELETE };`, [
    'NextResponse', 'getStatusSecret', 'getStaffSession', 'statusDatabase',
    'STATUS_COOKIE', 'SESSION_SECONDS', 'signSession', 'hashPin', 'isHashedPin', 'pinMatches', 'hasLeft',
  ])(NextResponse, () => secret, getStaffSession, () => database, STATUS_COOKIE, SESSION_SECONDS, signSession, hashPin, isHashedPin, pinMatches, hasLeft);
}

function request(method = 'GET', secure = false, pin = 'test-pin') {
  return new Request('http://localhost:3001/api/admin/session', {
    method, headers: { host: 'localhost:3001', origin: 'http://localhost:3001',
      ...(secure ? { 'x-forwarded-proto': 'https' } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    }, ...(method === 'POST' ? { body: JSON.stringify({ phone: 'test-phone', pin }) } : {}),
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

test('PINs are checked against the stored hash and old plain PINs are hashed on first login', async () => {
  const staff = { id, role: 'staff', pin: 'test-pin', phone: 'test-phone' };
  const updates = [];
  const api = route(async () => ({ code: 200, user: { id, role: 'staff' } }), 'staff', staff, updates);
  assert.equal((await api.POST(request('POST', false, 'wrong'))).status, 401);
  const ok = await api.POST(request('POST'));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).user.pin, undefined, 'the PIN never goes back to the browser');
  assert.ok(isHashedPin(staff.pin), 'plain PIN replaced by its hash');
  assert.ok(updates[0].last_login, 'last login stamped by the server');
  assert.equal((await api.POST(request('POST'))).status, 200, 'the hashed PIN still logs in');
  assert.equal((await api.POST(request('POST', false, 'wrong'))).status, 401);
});

test('someone who has left cannot log in any more', async () => {
  const api = route(async () => ({ code: 401 }), 'staff', undefined, [], async () => true);
  const response = await api.POST(request('POST'));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /nghỉ việc/);
  assert.equal(response.headers.get('set-cookie'), null, 'no session cookie');
});
