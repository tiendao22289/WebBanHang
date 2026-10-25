import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as pin from '../src/lib/staffPin.mjs';
import * as token from '../src/lib/checkinToken.mjs';
import * as rules from '../src/lib/attendanceRules.mjs';
import * as payroll from '../src/lib/payroll.mjs';
import * as payrollMonth from '../src/lib/payrollMonth.mjs';
import * as clockApply from '../src/lib/clockApply.mjs';
import * as faceCheck from '../src/lib/faceCheck.mjs';
import * as departure from '../src/lib/staffDeparture.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const { FACE_DIM, FACE_TRIES, bestScore, enrollConsistency, faceOutcome, faceVector, faceVectors, wrongStreak } = faceCheck;
const SECRET = 'service-role-test-key'.repeat(2);
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Phát', role: 'staff' };
const LAN = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Lan', role: 'staff' };
const KIOSK = '00000000-0000-4000-8000-00000000eeee';
const SHOP_IP = '113.161.1.2';
const plain = v => JSON.parse(JSON.stringify(v));

// Dấu mặt giả: mỗi "người" một hướng ngẫu nhiên cố định; ảnh khác của cùng người = lệch một chút.
function face(seed) {
  let x = seed * 2654435761 % 4294967296;
  return Array.from({ length: FACE_DIM }, () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 - 0.5; });
}
const shot = (seed, jitter = 1) => face(seed).map((v, i) => v + 0.08 * (face(seed * 31 + jitter)[i]));
const PHAT = 11, LAN_FACE = 22, STRANGER = 33;

const strip = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const workforceSrc = strip('../src/app/api/admin/workforce/route.js');
const kioskSrc = strip('../src/app/api/checkin/kiosk/route.js');
const response = { json: (body, init = {}) => {
  const res = { status: init.status || 200, body };
  Object.defineProperty(res, 'cookies', { value: { set: (k, v) => { res.setCookies = { ...res.setCookies, [k]: v }; } }, enumerable: false });
  return res;
} };
const common = (state, user, db = () => fakeDb(state)) => ({
  NextResponse: response, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure,
  createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Date, Promise, STATUS_COOKIE: 'local_admin_session',
  nowMs: () => Date.now(), refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true, checkedAt: null, source: 'test' }),
  console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: SECRET } },
  getStaffSession: async () => (user ? { code: 200, user } : { code: 401 }), staffDatabase: db, statusDatabase: db,
});
const workforce = (state, user, db) => vm.runInNewContext(`${workforceSrc}\n({ GET, POST })`, common(state, user, db));
const kiosk = state => vm.runInNewContext(`${kioskSrc}\n({ GET, POST })`, common(state, null));

const KIOSK_CK = token.signKioskCookie(KIOSK, SECRET);
const kioskCookies = (cookie = KIOSK_CK) => ({ get: k => (k === token.KIOSK_COOKIE ? { value: cookie } : undefined) });
// Máy quầy (app) hỏi mã; trả về mã đang hiện và lượt chờ so mặt.
const poll = async (api, shown = '') => plain(await api.GET({ url: `https://x/api/checkin/kiosk?t=${encodeURIComponent(shown)}&app=1.0`,
  headers: new Map([['cf-connecting-ip', SHOP_IP]]), cookies: kioskCookies() })).body;
const verify = async (api, body, cookie) => plain(await api.POST({ json: async () => ({ action: 'face_verify', ...body }), headers: new Map(), cookies: kioskCookies(cookie) }));
const scan = async (state, user, qr, device = user.id.slice(-4).repeat(6)) => plain(await workforce(state, user).POST({
  json: async () => ({ action: 'clock', token: qr }), headers: new Map([['cf-connecting-ip', SHOP_IP], ['user-agent', 'iPhone']]),
  cookies: { get: k => (k === token.DEVICE_COOKIE ? { value: device } : undefined) },
}));
const status = async (state, user, id) => plain(await workforce(state, user).GET({ url: `http://x/api/admin/workforce?face_check=${id}` })).body;
const admin = async (state, body, extra = {}) => plain(await workforce(state, ADMIN).POST({ json: async () => body, headers: new Map(), cookies: kioskCookies(), ...extra }));

const shop = () => ({
  attendance_sessions: [], checkin_nonces: [], checkin_scans: [], staff_checkin_devices: [], attendance_changes: [],
  checkin_settings: [{ id: 1, enforce: false }],
  checkin_kiosks: [{ id: KIOSK, name: 'Quầy', revoked_at: null, recent_ips: [{ ip: SHOP_IP, at: new Date().toISOString() }] }],
  staff: [{ ...ADMIN }, { ...STAFF }, { ...LAN }],
  staff_face_templates: [
    { staff_id: STAFF.id, model: faceCheck.FACE_MODEL, embeddings: [shot(PHAT, 1), shot(PHAT, 2), shot(PHAT, 3)].map(faceVector), created_at: new Date().toISOString() },
    { staff_id: LAN.id, model: faceCheck.FACE_MODEL, embeddings: [shot(LAN_FACE, 1), shot(LAN_FACE, 2), shot(LAN_FACE, 3)].map(faceVector), created_at: new Date().toISOString() },
  ],
});

test('face prints: only 128 real numbers, scaled to length 1; same person scores high, others low', () => {
  assert.equal(faceVector([1, 2, 3]), null);
  assert.equal(faceVector(Array(FACE_DIM).fill(0)), null);
  assert.equal(faceVector([...Array(FACE_DIM - 1).fill(1), Number.NaN]), null);
  const v = faceVector(face(1));
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  assert.equal(faceVectors([face(1)], 3, 5), null, 'enrolment needs 3 to 5 prints');
  const phat = [shot(PHAT, 1), shot(PHAT, 2), shot(PHAT, 3)].map(faceVector);
  assert.ok(bestScore([faceVector(shot(PHAT, 9))], phat) > 0.9);
  assert.ok(bestScore([faceVector(shot(STRANGER, 9))], phat) < 0.3);
  assert.ok(enrollConsistency(phat) > 0.9);
  assert.ok(enrollConsistency([phat[0], phat[1], faceVector(face(STRANGER))]) < 0.3, 'two people in one enrolment');
});

test('wrong face twice is not counted; the third time in a row the shift waits for the owner', () => {
  assert.equal(faceOutcome(0.62, 0.4, 2), 'ok');
  assert.equal(faceOutcome(0.1, 0.4, 0), 'wrong');
  assert.equal(faceOutcome(0.1, 0.4, 1), 'wrong');
  assert.equal(faceOutcome(0.1, 0.4, FACE_TRIES - 1), 'review');
  // Mới nhất trước: lượt hết giờ / huỷ không làm đứt chuỗi; lần đúng thì chuỗi bắt đầu lại.
  assert.equal(wrongStreak([{ status: 'wrong' }, { status: 'expired' }, { status: 'wrong' }, { status: 'ok' }, { status: 'wrong' }]), 2);
  assert.equal(wrongStreak([{ status: 'review' }, { status: 'wrong' }]), 0);
});

test('a held shift is left out of pay and late counts until the owner approves it', () => {
  const rulesV = rules.normalizeRules({ hours_from: '2026-11-01' }, [], [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]);
  const day = d => ({ id: `s${d}`, staff_id: 'a', date: `2026-11-0${d}`, clock_in: `2026-11-0${d}T07:30:00Z`, clock_out: `2026-11-0${d}T16:00:00Z` });
  const sessions = [day(2), day(3), { ...day(4), face_hold: true }];
  const pay = payroll.computeSalary({ year: 2026, month: 11, staffId: 'a', sessions, config: { base_salary: 2600000 }, rules: rulesV });
  assert.equal(pay.workUnits, 2);
  assert.equal(pay.byDay['2026-11-04'], undefined);
  const t = payroll.monthTallies({ sessions, rules: rulesV, key: '2026-11' });
  assert.equal(t.late.count, 2, 'only the two counted days are late');
});

test('scan, look at the kiosk, right face: the shift starts at the time of the scan', async () => {
  const state = shop();
  const api = kiosk(state);
  const first = await poll(api);
  assert.equal(state.checkin_kiosk_apps[0].kiosk_id, KIOSK, 'the kiosk app is noted');
  const res = await scan(state, STAFF, first.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.face?.id, 'the phone is told to look at the kiosk');
  assert.equal(state.attendance_sessions.length, 0, 'no time is written before the face check');

  const next = await poll(api, first.token);
  assert.equal(next.lastScan, null, 'the kiosk does not say "done" yet');
  assert.deepEqual([next.faceCheck.id, next.faceCheck.name, next.faceCheck.clocked], [res.body.face.id, 'Phát', 'in']);
  assert.equal((await status(state, STAFF, res.body.face.id)).status, 'waiting');
  assert.equal((await status(state, LAN, res.body.face.id)).status, 'missing', 'only the person who scanned sees it');

  const ok = await verify(api, { id: next.faceCheck.id, embeddings: [shot(PHAT, 7)] });
  assert.deepEqual([ok.status, ok.body.result, ok.body.name, ok.body.clocked], [200, 'ok', 'Phát', 'in']);
  assert.equal(state.attendance_sessions.length, 1);
  assert.equal(state.attendance_sessions[0].clock_in, new Date(Date.parse(state.checkin_face_checks[0].created_at)).toISOString(), 'time of the scan');
  assert.equal(state.checkin_scans.at(-1).action, 'in');
  assert.equal(state.checkin_scans.at(-1).nonce, token.readKioskQrToken(first.token, SECRET).nonce);
  const phone = await status(state, STAFF, res.body.face.id);
  assert.deepEqual([phone.status, phone.result.clocked, phone.result.face_hold], ['ok', 'in', false]);
  assert.equal((await poll(api, next.token)).faceCheck, null, 'nothing left to check');
  assert.equal((await verify(api, { id: next.faceCheck.id, embeddings: [shot(PHAT, 7)] })).body.done, true, 'a second answer changes nothing');
  assert.equal(state.attendance_sessions.length, 1);
});

test('wrong face: not counted twice, the third time the shift is written but waits for the owner', async () => {
  const state = shop();
  const api = kiosk(state);
  let shown = (await poll(api)).token;
  const attempt = async () => {
    const res = await scan(state, STAFF, shown);
    const p = await poll(api, shown);
    shown = p.token;
    return { id: res.body.face.id, answer: (await verify(api, { id: p.faceCheck.id, embeddings: [shot(STRANGER, 5)] })).body };
  };
  const one = await attempt();
  assert.deepEqual([one.answer.result, one.answer.tries_left], ['wrong', 2]);
  assert.equal((await status(state, STAFF, one.id)).tries_left, 2);
  // Máy quầy không thấy chớp mắt: không tính là sai.
  const res = await scan(state, STAFF, shown);
  const p = await poll(api, shown);
  shown = p.token;
  assert.deepEqual((await verify(api, { id: p.faceCheck.id, reason: 'no_blink' })).body.result, 'expired');
  assert.equal((await status(state, STAFF, res.body.face.id)).reason, 'no_blink');
  assert.deepEqual((await attempt()).answer.tries_left, 1);
  assert.equal(state.attendance_sessions.length, 0, 'wrong faces write no time');

  const third = await attempt();
  assert.equal(third.answer.result, 'review');
  assert.equal(state.attendance_sessions.length, 1, 'the third time the time is written');
  const held = state.attendance_face_reviews[0];
  assert.deepEqual([held.attendance_id, held.clocked, held.status], [state.attendance_sessions[0].id, 'in', 'pending']);
  assert.equal((await status(state, STAFF, third.id)).result.face_hold, true);
  const month = await payrollMonth.loadPayrollMonth(fakeDb(state), ...[new Date(Date.now() + 7 * 3600000)].map(d => [d.getUTCFullYear(), d.getUTCMonth() + 1]).flat());
  assert.equal(month.sessions[0].face_hold, true, 'pay leaves it out');
  const me = plain(await workforce(state, STAFF).GET({ url: 'http://x/api/admin/workforce?me=1' })).body;
  assert.equal(me.open.face_hold, true, 'the staff see it is waiting');

  // Chủ xem danh sách, bấm Đúng người → tính lương.
  const overview = plain(await workforce(state, ADMIN).GET({ url: 'http://x/api/admin/workforce?faces=1' })).body;
  assert.equal(overview.reviews.length, 1);
  assert.equal(overview.reviews[0].session.id, held.attendance_id);
  assert.equal(JSON.stringify(overview).includes('embeddings'), false, 'face prints never leave the server');
  assert.equal((await admin(state, { action: 'decide_face', attendance_id: held.attendance_id, clocked: 'in', status: 'approved' })).status, 200);
  assert.equal(state.attendance_face_reviews[0].status, 'approved');
  assert.equal((await admin(state, { action: 'decide_face', attendance_id: held.attendance_id, clocked: 'in', status: 'approved' })).status, 409);
  const after = await payrollMonth.loadPayrollMonth(fakeDb(state), ...[new Date(Date.now() + 7 * 3600000)].map(d => [d.getUTCFullYear(), d.getUTCMonth() + 1]).flat());
  assert.equal(after.sessions[0].face_hold, undefined);
});

test('the owner says it was not that person: the clock-in is removed and logged', async () => {
  const state = shop();
  state.attendance_sessions.push({ id: 'att-1', staff_id: STAFF.id, date: '2026-11-02', clock_in: '2026-11-02T07:00:00Z', clock_out: null });
  state.attendance_face_reviews = [{ attendance_id: 'att-1', clocked: 'in', staff_id: STAFF.id, status: 'pending', created_at: '2026-11-02T07:00:00Z' }];
  assert.equal((await admin(state, { action: 'decide_face', attendance_id: '00000000-0000-4000-8000-000000000001', clocked: 'in', status: 'rejected' })).status, 404);
  state.attendance_sessions[0].id = '00000000-0000-4000-8000-0000000000a1';
  state.attendance_face_reviews[0].attendance_id = '00000000-0000-4000-8000-0000000000a1';
  assert.equal(plain(await workforce(state, STAFF).POST({ json: async () => ({ action: 'decide_face', attendance_id: '00000000-0000-4000-8000-0000000000a1', clocked: 'in', status: 'rejected' }), headers: new Map() })).status, 403);
  assert.equal((await admin(state, { action: 'decide_face', attendance_id: '00000000-0000-4000-8000-0000000000a1', clocked: 'in', status: 'rejected' })).status, 200);
  assert.equal(state.attendance_sessions.length, 0);
  assert.equal(state.attendance_face_reviews[0].status, 'rejected');
  assert.equal(state.attendance_changes.at(-1).field_name, 'deleted');

  // Lượt ra ca không đúng người: bỏ giờ ra, ca mở lại.
  state.attendance_sessions.push({ id: '00000000-0000-4000-8000-0000000000a2', staff_id: STAFF.id, date: '2026-11-03', clock_in: '2026-11-03T07:00:00Z', clock_out: '2026-11-03T15:00:00Z' });
  state.attendance_face_reviews.push({ attendance_id: '00000000-0000-4000-8000-0000000000a2', clocked: 'out', staff_id: STAFF.id, status: 'pending' });
  assert.equal((await admin(state, { action: 'decide_face', attendance_id: '00000000-0000-4000-8000-0000000000a2', clocked: 'out', status: 'rejected' })).status, 200);
  assert.equal(state.attendance_sessions[0].clock_out, null);
});

test('no face check without the app, with the check switched off, or for someone with no face sample', async () => {
  // Máy quầy web (không phải app): chấm như cũ.
  let state = shop();
  let qr = token.kioskQrToken(SECRET, KIOSK);
  assert.equal((await scan(state, STAFF, qr)).body.clocked, 'in');

  // Chủ tắt so mặt.
  state = shop();
  state.checkin_face_settings = [{ id: 1, enabled: false, level: 'normal' }];
  await poll(kiosk(state));
  assert.equal((await scan(state, STAFF, token.kioskQrToken(SECRET, KIOSK))).body.clocked, 'in');

  // Chưa có mặt mẫu: chấm như cũ, ghi cảnh báo để chủ biết.
  state = shop();
  state.staff_face_templates = state.staff_face_templates.filter(t => t.staff_id !== STAFF.id);
  await poll(kiosk(state));
  const res = await scan(state, STAFF, token.kioskQrToken(SECRET, KIOSK));
  assert.equal(res.body.clocked, 'in');
  assert.deepEqual(plain(res.body.warnings), ['no_face']);

  // Hết 1 phút máy quầy chưa so: lượt quét hết giờ.
  state = shop();
  const api = kiosk(state);
  qr = (await poll(api)).token;
  const waiting = await scan(state, STAFF, qr);
  state.checkin_face_checks[0].created_at = new Date(Date.now() - 70000).toISOString();
  assert.equal((await poll(api, qr)).faceCheck, null);
  assert.equal(state.checkin_face_checks[0].status, 'expired');
  assert.equal((await status(state, STAFF, waiting.body.face.id)).status, 'expired');
  assert.equal(state.attendance_sessions.length, 0);
});

test('another kiosk cannot answer, and a new scan replaces the one still waiting', async () => {
  const state = shop();
  const api = kiosk(state);
  const qr1 = (await poll(api)).token;
  const a = await scan(state, STAFF, qr1);
  const qr2 = (await poll(api, qr1)).token;
  const b = await scan(state, STAFF, qr2);
  assert.equal(state.checkin_face_checks.find(c => c.id === a.body.face.id).status, 'cancelled');
  const other = token.signKioskCookie('00000000-0000-4000-8000-00000000ffff', SECRET);
  assert.equal((await verify(api, { id: b.body.face.id, embeddings: [shot(PHAT, 4)] }, other)).status, 404);
  assert.equal((await verify(api, { id: b.body.face.id, embeddings: [[1, 2, 3]] })).status, 400);
  assert.equal((await verify(api, { id: b.body.face.id, embeddings: [shot(PHAT, 4)] })).body.result, 'ok');
});

test('face samples: only the owner takes them, blurry or mixed samples are refused, a face already on file asks first', async () => {
  const state = shop();
  const enroll = (body, user = ADMIN) => workforce(state, user).POST({ json: async () => ({ action: 'face_enroll', ...body }), headers: new Map(), cookies: kioskCookies() }).then(plain);
  const prints = seed => [1, 2, 3].map(j => shot(seed, j + 40));
  assert.equal((await enroll({ staff_id: STAFF.id, embeddings: prints(PHAT) }, STAFF)).status, 403);
  assert.equal((await enroll({ staff_id: STAFF.id, embeddings: prints(PHAT).slice(0, 2) })).status, 400);
  assert.equal((await enroll({ staff_id: STAFF.id, embeddings: [...prints(PHAT).slice(0, 2), face(STRANGER)] })).status, 422);

  // Lấy mặt Lan nhưng ghi tên Phát: máy hỏi lại.
  const dup = await enroll({ staff_id: STAFF.id, embeddings: prints(LAN_FACE) });
  assert.deepEqual([dup.status, dup.body.duplicate], [409, 'Lan']);
  const forced = await enroll({ staff_id: STAFF.id, embeddings: prints(LAN_FACE), force: true });
  assert.equal(forced.status, 200);
  const ok = await enroll({ staff_id: STAFF.id, embeddings: prints(PHAT) });
  assert.deepEqual([ok.status, ok.body.count], [200, 3]);
  const mine = state.staff_face_templates.filter(t => t.staff_id === STAFF.id);
  assert.equal(mine.length, 1, 'new samples replace the old ones');
  assert.equal(mine[0].kiosk_id, KIOSK);
  assert.ok(mine[0].embeddings.every(v => v.length === FACE_DIM));

  const overview = plain(await workforce(state, ADMIN).GET({ url: 'http://x/api/admin/workforce?faces=1' })).body;
  assert.equal(overview.staff.find(p => p.id === STAFF.id).face.count, 3);

  assert.equal((await admin(state, { action: 'save_face_settings', level: 'strict', enabled: false })).body.settings.level, 'strict');
  assert.equal((await admin(state, { action: 'save_face_settings', level: 'max' })).status, 400);
  assert.equal((await admin(state, { action: 'face_delete', staff_id: LAN.id })).status, 200);
  assert.equal(state.staff_face_templates.some(t => t.staff_id === LAN.id), false);

  // Cho nghỉ việc: xoá luôn dấu mặt mẫu.
  assert.equal((await admin(state, { action: 'staff_depart', staff_id: STAFF.id, last_day: '2026-11-30', reason: 'nghỉ' })).status, 200);
  assert.equal(state.staff_face_templates.length, 0);
});

test('right after the web goes live, before the face tables exist, clocking and pay work as before', async () => {
  const FACE_TABLES = ['staff_face_templates', 'checkin_face_checks', 'attendance_face_reviews', 'checkin_face_settings', 'checkin_kiosk_apps'];
  const state = shop();
  // Như PostgREST khi bảng chưa có.
  const missing = () => {
    const q = new Proxy({}, { get: (_, k) => (k === 'then'
      ? (ok, bad) => Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.x' in the schema cache" } }).then(ok, bad)
      : () => q) });
    return q;
  };
  const db = () => { const real = fakeDb(state); return { ...real, from: t => (FACE_TABLES.includes(t) ? missing() : real.from(t)) }; };
  const res = plain(await workforce(state, STAFF, db).POST({ json: async () => ({ action: 'clock', token: token.kioskQrToken(SECRET, KIOSK) }),
    headers: new Map([['cf-connecting-ip', SHOP_IP]]), cookies: { get: () => ({ value: 'P'.repeat(24) }) } }));
  assert.deepEqual([res.status, res.body.clocked], [200, 'in']);
  assert.equal(plain(await workforce(state, STAFF, db).GET({ url: 'http://x/api/admin/workforce?me=1' })).status, 200);
  const d = new Date(Date.now() + 7 * 3600000);
  const month = `year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`;
  assert.equal(plain(await workforce(state, ADMIN, db).GET({ url: `http://x/api/admin/workforce?payroll=1&${month}` })).status, 200);
  assert.equal(plain(await workforce(state, ADMIN, db).GET({ url: `http://x/api/admin/workforce?stats=1&${month}` })).status, 200);
  assert.equal(plain(await workforce(state, ADMIN, db).GET({ url: 'http://x/api/admin/workforce?faces=1' })).body.missing, true, 'the Lương page says it is updating');
});

test('the phone keeps waiting while the kiosk answer is being written', async () => {
  const state = shop();
  state.checkin_face_checks = [{ id: '00000000-0000-4000-8000-0000000000c1', staff_id: STAFF.id, kiosk_id: KIOSK, status: 'ok', attendance_id: null, clocked: 'in', created_at: new Date().toISOString() }];
  assert.equal((await status(state, STAFF, '00000000-0000-4000-8000-0000000000c1')).status, 'waiting');
});
