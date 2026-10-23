import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as pin from '../src/lib/staffPin.mjs';
import * as token from '../src/lib/checkinToken.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const SECRET = 'service-role-test-key'.repeat(2);
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Phát', role: 'staff' };

function load(state, user) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Date, Promise,
    console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: SECRET } },
    getStaffSession: async () => (user ? { code: 200, user } : { code: 401 }), staffDatabase: () => fakeDb(state),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));
const post = async (api, body, headers = new Map()) => plain(await api.POST({ json: async () => body, headers }));

test('staff clock in only with the signed QR shown at the shop', async () => {
  const state = { attendance_sessions: [] };
  const staff = load(state, STAFF);
  assert.equal((await post(staff, { action: 'clock' })).status, 403);
  assert.equal((await post(staff, { action: 'clock', token: String(Math.floor(Date.now() / 300000)) })).status, 403, 'the old guessable token is refused');
  const qr = plain(await load(state, ADMIN).GET({ url: 'http://x/api/admin/workforce?qr=1' })).body.token;
  assert.equal(plain(await staff.GET({ url: 'http://x/api/admin/workforce?qr=1' })).status, 403, 'staff cannot fetch the QR code');
  const inRes = await post(staff, { action: 'clock', token: qr });
  assert.deepEqual([inRes.status, inRes.body.clocked], [200, 'in']);
  assert.equal((await post(staff, { action: 'clock', token: qr })).body.clocked, 'out');
  assert.equal(state.attendance_sessions.length, 1);
  assert.equal(state.attendance_sessions[0].staff_id, STAFF.id);
  assert.ok(state.attendance_sessions[0].clock_out);
});

test('only admins change salary, fines, approvals and accounts', async () => {
  const state = { payroll_requests: [], payroll_config: [], payroll_violations: [], staff: [{ ...ADMIN, pin: 'x' }, { ...STAFF, pin: 'y' }] };
  const staff = load(state, STAFF);
  for (const body of [
    { action: 'save_config', staff_id: STAFF.id, base_salary: 99000000 },
    { action: 'add_violation', staff_id: STAFF.id, amount: 1, reason: 'x', month: 10, year: 2026 },
    { action: 'set_pin', staff_id: ADMIN.id, pin: '1111' },
    { action: 'create_account', full_name: 'X', phone: '0900000000', pin: '1234', role: 'admin' },
    { action: 'delete_account', staff_id: ADMIN.id },
  ]) assert.equal((await post(staff, body)).status, 403, body.action);
  assert.equal((await post(staff, { action: 'request', type: 'advance', amount: '500.000', reason: 'ứng' })).status, 200);
  const req = state.payroll_requests[0];
  assert.deepEqual([req.staff_id, req.amount, req.status], [STAFF.id, 500000, 'pending']);
  assert.equal((await post(staff, { action: 'decide_request', id: req.id, status: 'approved' })).status, 403);
  assert.equal((await post(load(state, ADMIN), { action: 'decide_request', id: req.id, status: 'approved' })).status, 200);
  assert.equal(state.payroll_requests[0].status, 'approved');
});

test('PINs are stored hashed and plain old PINs can be hashed by the server job', async () => {
  const state = { staff: [{ id: STAFF.id, full_name: 'Phát', phone: '0911111111', role: 'staff', pin: '123456' }] };
  const admin = load(state, ADMIN);
  const created = await post(admin, { action: 'create_account', full_name: 'Lan', phone: '0922222222', pin: '4321', role: 'staff' });
  assert.equal(created.status, 200);
  const lan = state.staff.find(s => s.phone === '0922222222');
  assert.ok(pin.isHashedPin(lan.pin) && pin.pinMatches(lan.pin, lan.id, '4321', SECRET));
  assert.equal((await post(admin, { action: 'create_account', full_name: 'Lan 2', phone: '0922222222', pin: '4321' })).status, 409, 'phone must be unique');
  assert.equal((await post(admin, { action: 'set_pin', staff_id: lan.id, pin: '12' })).status, 400, 'PIN is 4–8 digits');

  const nobody = load(state, null);
  assert.equal((await post(nobody, { action: 'hash_all_pins' })).status, 401);
  const key = createHmac('sha256', SECRET).update('staff-maintenance').digest('hex');
  const r = await post(nobody, { action: 'hash_all_pins' }, new Map([['x-server-key', key]]));
  assert.deepEqual([r.status, r.body.hashed], [200, 1]);
  assert.ok(pin.pinMatches(state.staff[0].pin, STAFF.id, '123456', SECRET));
  assert.equal((await post(admin, { action: 'delete_account', staff_id: ADMIN.id })).status, 400, 'cannot delete yourself');
});

test('admin attendance edits are logged and compared by time, not text', async () => {
  const state = { attendance_sessions: [{ id: '00000000-0000-4000-8000-000000000009', staff_id: STAFF.id, date: '2026-10-23', clock_in: '2026-10-23T01:00:00+00:00', clock_out: null }], attendance_edit_log: [] };
  const admin = load(state, ADMIN);
  const same = await post(admin, { action: 'edit_attendance', id: state.attendance_sessions[0].id, clock_in: '2026-10-23T01:00:00.000Z', clock_out: null });
  assert.equal(same.body.changed, 0, 'same moment written differently is not a change');
  const r = await post(admin, { action: 'edit_attendance', id: state.attendance_sessions[0].id, clock_in: '2026-10-23T01:00:00.000Z', clock_out: '2026-10-23T09:30:00.000Z' });
  assert.equal(r.body.changed, 1);
  assert.equal(state.attendance_sessions[0].clock_out, '2026-10-23T09:30:00.000Z');
  assert.deepEqual(plain(state.attendance_edit_log.map(l => [l.field_name, l.changed_by])), [['clock_out', 'Chủ quán']]);
});
