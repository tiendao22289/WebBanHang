import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as pinLib from '../src/lib/adminPin.mjs';
import { isLockedPath, lockedSection } from '../src/lib/adminLockPaths.mjs';
import { hashPin, pinMatches } from '../src/lib/staffPin.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const SECRET = 's'.repeat(48);
const LOGIN_KEY = 'k'.repeat(40);
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Thy', role: 'staff' };

test('the PIN is stored only as a salted hash and 5 wrong tries lock it for 5 minutes', () => {
  const rec = pinLib.newPinRecord('2468', SECRET, 0);
  assert.ok(!JSON.stringify(rec).includes('2468'), 'the PIN itself is never stored');
  assert.equal(rec.len, 4);
  assert.equal(pinLib.pinMatchesRecord(rec, '2468', SECRET), true);
  assert.equal(pinLib.pinMatchesRecord(rec, '2469', SECRET), false);
  assert.equal(pinLib.pinMatchesRecord(rec, '24a8', SECRET), false);
  assert.equal(pinLib.pinMatchesRecord(rec, '2468', 'x'.repeat(48)), false, 'needs the server secret');

  let r = rec;
  for (let i = 0; i < 4; i++) r = pinLib.afterFail(r, 1000);
  assert.equal(pinLib.lockWait(r, 1000), 0, '4 wrong tries: still allowed');
  r = pinLib.afterFail(r, 1000);
  assert.equal(pinLib.lockWait(r, 1000), 300, '5th wrong try: 5 minutes');
  assert.equal(pinLib.lockWait(r, 1000 + 300000), 0);

  assert.deepEqual(['/admin/payroll', '/admin/stats', '/admin/customers', '/admin/settings', '/admin/finance', '/admin/finance/x'].map(isLockedPath), [true, true, true, true, true, true]);
  assert.deepEqual(['/admin/tables', '/admin/notes', '/admin/qr', '/admin/statsx'].map(isLockedPath), [false, false, false, false]);
  assert.equal(lockedSection('/admin/payroll'), 'payroll');
});

const plain = v => JSON.parse(JSON.stringify(v));
const source = readFileSync(new URL('../src/app/api/admin/lock/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export (?=async function|const)/gm, '');
function load(state, user = OWNER) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body, cookies: { set: () => { throw new Error('no cookie expected'); } } }) };
  const api = vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pinLib, pinMatches, Object, Number, Math, String, JSON, Date, Buffer, Promise, console: { error() {} },
    getStaffSession: async () => ({ code: 200, user }), getStatusSecret: () => SECRET, statusDatabase: () => fakeDb(state),
    process: { env: { SUPABASE_SERVICE_ROLE_KEY: LOGIN_KEY } },
  });
  return { get: () => api.GET({}), post: body => api.POST({ json: async () => body }) };
}

test('owner sets a PIN, every opening asks for it, 5 wrong tries lock it, the login PIN resets it; staff cannot use it', async () => {
  const state = { finance_settings: [], staff: [{ id: OWNER.id, pin: hashPin(OWNER.id, '9999', LOGIN_KEY) }] };
  const api = load(state);
  assert.deepEqual(plain((await api.get()).body), { hasPin: false, wait: 0, length: null });
  assert.equal((await api.post({ action: 'set', pin: '12' })).status, 400, '4 to 6 digits');
  assert.equal((await api.post({ action: 'set', pin: '2468' })).status, 200);
  assert.ok(!JSON.stringify(state.finance_settings).includes('2468'), 'only the hash is saved');
  assert.deepEqual(plain((await api.get()).body), { hasPin: true, wait: 0, length: 4 }, 'nothing says "already open": each opening asks again');

  assert.equal((await api.post({ action: 'set', pin: '1357', current: '0000' })).status, 401, 'changing needs the PIN in use');
  assert.equal((await api.post({ action: 'unlock', pin: '2468' })).status, 200);

  for (let i = 0; i < 4; i++) assert.equal((await api.post({ action: 'unlock', pin: '0000' })).status, 401);
  assert.equal((await api.post({ action: 'unlock', pin: '0000' })).status, 429, '5th wrong try locks it');
  assert.equal((await api.post({ action: 'unlock', pin: '2468' })).status, 429, 'even the right PIN waits 5 minutes');
  assert.ok((await api.get()).body.wait > 0);
  state.finance_settings[0].value.lockedUntil = new Date(Date.now() - 1000).toISOString();

  assert.equal((await api.post({ action: 'reset', loginPin: '1111', pin: '5555' })).status, 401, 'wrong login PIN');
  assert.equal((await api.post({ action: 'reset', loginPin: '9999', pin: '5555' })).status, 200);
  assert.equal((await api.post({ action: 'unlock', pin: '2468' })).status, 401, 'old PIN no longer works');
  assert.equal((await api.post({ action: 'unlock', pin: '5555' })).status, 200);

  const staff = load(state, STAFF);
  assert.equal((await staff.get()).status, 403);
  assert.equal((await staff.post({ action: 'unlock', pin: '5555' })).status, 403, 'staff accounts cannot use it');
});
