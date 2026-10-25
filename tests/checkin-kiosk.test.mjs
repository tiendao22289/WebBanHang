import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as token from '../src/lib/checkinToken.mjs';
import * as rules from '../src/lib/attendanceRules.mjs';
import * as clockApply from '../src/lib/clockApply.mjs';
import * as faceCheck from '../src/lib/faceCheck.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const SECRET = 'service-role-test-key'.repeat(2);
const KIOSK = '00000000-0000-4000-8000-00000000eeee';
const STAFF = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'Phát', role: 'staff' };
const ADMIN = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin' };

test('QR codes are signed, name their kiosk, and expire after 2 minutes', () => {
  const now = Date.parse('2026-10-24T10:00:00Z');
  const qr = token.kioskQrToken(SECRET, KIOSK, now);
  assert.ok(qr.length < 100, 'short enough for a clear QR');
  const read = token.readKioskQrToken(qr, SECRET, now + 60000);
  assert.deepEqual([read.kioskId, read.ageMs], [KIOSK, 60000]);
  assert.equal(token.readKioskQrToken(qr, SECRET, now + 121000), null);
  assert.equal(token.readKioskQrToken(qr.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), SECRET, now), null, 'edited QR');
  assert.equal(token.readKioskQrToken(qr, 'x'.repeat(40), now), null, 'other secret');
  assert.notEqual(token.kioskQrToken(SECRET, KIOSK, now), qr, 'every code has its own number');

  const cookie = token.signKioskCookie(KIOSK, SECRET, now);
  assert.equal(token.readKioskCookie(cookie, SECRET, now), KIOSK);
  assert.equal(token.readKioskCookie(cookie.replace(KIOSK, STAFF.id), SECRET, now), null);
});

test('same wifi: IPv4 must match, IPv6 shares the /64; kiosk addresses expire after 15 minutes', () => {
  assert.ok(rules.sameNetwork('1.2.3.4', '1.2.3.4'));
  assert.ok(!rules.sameNetwork('1.2.3.4', '1.2.3.5'));
  assert.ok(rules.sameNetwork('2405:4802:a:b::1', '2405:4802:a:b:ffff:1:2:3'));
  assert.ok(!rules.sameNetwork('2405:4802:a:b::1', '2405:4802:a:c::1'));
  assert.ok(!rules.sameNetwork('1.2.3.4', '2405:4802:a:b::1'));
  const now = Date.now();
  const kiosk = { recent_ips: rules.rememberIp([{ ip: '9.9.9.9', at: new Date(now - 20 * 60000).toISOString() }], '1.2.3.4', now) };
  assert.ok(rules.onKioskNetwork('1.2.3.4', kiosk, now));
  assert.ok(!rules.onKioskNetwork('9.9.9.9', kiosk, now), 'an address the kiosk used 20 minutes ago no longer counts');
  assert.ok(!rules.onKioskNetwork('1.2.3.4', kiosk, now + 16 * 60000));
  assert.equal(rules.clientIp(new Map([['cf-connecting-ip', '::ffff:1.2.3.4']])), '1.2.3.4');
});

const SHOP_HOURS = { valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 };

test('new shop hours and shifts apply from their day on; days already worked keep the old ones', () => {
  const R = rules.normalizeRules({ hours_from: '2026-10-25' },
    [{ staff_id: 'a', valid_from: '2026-10-26', start_time: '17:00', end_time: '23:00' }, { staff_id: 'a', valid_from: '2026-10-28', start_time: null, end_time: null }],
    [SHOP_HOURS, { valid_from: '2026-10-27', opening_time: '15:00', closing_time: '23:30', grace_minutes: 5 }]);
  const at = d => { const s = rules.shiftOf(R, 'a', d); return `${s.start}-${s.end}${s.own ? ' own' : ''}`; };
  assert.deepEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'].map(at), ['14:00-23:00', '17:00-23:00 own', '17:00-23:00 own', '15:00-23:30']);
  assert.deepEqual([rules.hoursOn(R, '2026-10-26').grace, rules.hoursOn(R, '2026-10-27').grace], [10, 5]);
  // Ca 25/10 vẫn tính theo giờ quán cũ dù sau đó có ca riêng.
  const day25 = rules.sessionHours({ staff_id: 'a', date: '2026-10-25', clock_in: '2026-10-25T07:00:00Z', clock_out: '2026-10-25T16:00:00Z' }, R);
  assert.equal(day25.countedMs / 60000, 540);
  assert.equal(rules.shiftOf(rules.normalizeRules({}, [], []), 'x', '2026-10-25').start, '14:00', 'not set up yet: 14:00–23:00');
});

test('forgotten clock-outs close at the end of the person\'s shift', () => {
  const R = rules.normalizeRules({}, [{ staff_id: 'p', valid_from: '2000-01-01', start_time: '14:00', end_time: '18:00' }], [SHOP_HOURS]);
  const s = { staff_id: 'a', date: '2026-10-24', clock_in: '2026-10-24T10:00:00Z', clock_out: null };
  assert.equal(rules.forgottenClockOut(s, R, Date.parse('2026-10-24T19:59:00Z')), null, 'still within 4 hours after closing (02:59)');
  assert.equal(rules.forgottenClockOut(s, R, Date.parse('2026-10-24T20:00:00Z')).toISOString(), '2026-10-24T16:00:00.000Z');
  const late = { ...s, clock_in: '2026-10-24T16:30:00Z' };
  assert.equal(rules.forgottenClockOut(late, R, Date.parse('2026-10-24T20:31:00Z')).toISOString(), '2026-10-24T16:30:00.000Z', 'clocked in after closing → 0 hours');
  // Lượt mở lúc 01:30 (dọn quán, ghi ngày hôm sau) theo ca hôm trước: tự đóng lúc 05:30, không treo tới đêm hôm sau.
  const cleanup = { staff_id: 'a', date: '2026-10-25', clock_in: '2026-10-24T18:30:00Z', clock_out: null };
  assert.equal(rules.forgottenClockOut(cleanup, R, Date.parse('2026-10-24T22:29:00Z')), null);
  assert.equal(rules.forgottenClockOut(cleanup, R, Date.parse('2026-10-24T22:30:00Z')).toISOString(), '2026-10-24T18:30:00.000Z');
  // Ca riêng 14:00–18:00: có thể đang ở lại làm nên chờ tới sau giờ đóng quán mới đóng, nhưng ghi ra ca lúc 18:00.
  const part = { ...s, staff_id: 'p' };
  assert.equal(rules.forgottenClockOut(part, R, Date.parse('2026-10-24T14:00:00Z')), null);
  assert.equal(rules.forgottenClockOut(part, R, Date.parse('2026-10-24T20:00:00Z')).toISOString(), '2026-10-24T11:00:00.000Z');
  assert.equal(rules.forgottenClockOut({ ...s, clock_out: '2026-10-24T15:00:00Z' }, R, Date.now()), null);
});

test('pay counts only the shift: 10 minutes of grace, outside time waits for the owner', () => {
  // Quán 14:00–23:00 giờ VN = 07:00Z–16:00Z; tính theo ca từ 25/10.
  const R = rules.normalizeRules({ hours_from: '2026-10-25' }, [{ staff_id: 'night', valid_from: '2000-01-01', start_time: '18:00', end_time: '01:30' }], [SHOP_HOURS]);
  assert.equal(rules.shiftWindow('2026-10-25', '14:00', '23:00').end.toISOString(), '2026-10-25T16:00:00.000Z');
  assert.equal(rules.shiftWindow('2026-10-25', '18:00', '01:30').end.toISOString(), '2026-10-25T18:30:00.000Z', 'a shift can end after midnight');
  const ses = (clock_in, clock_out, staff_id = 'a', date = '2026-10-25') => ({ staff_id, date, clock_in, clock_out });
  const minutes = (s, review) => { const h = rules.sessionHours(s, R, review); return [h.countedMs, h.earlyMs, h.stayMs, h.pendingMs].map(ms => ms / 60000); };

  assert.deepEqual(minutes(ses('2026-10-25T07:08:00Z', '2026-10-25T16:05:00Z')), [540, 0, 0, 0], 'in 14:08, out 23:05: a full 9 hours');
  const longDay = ses('2026-10-25T06:10:00Z', '2026-10-25T16:45:00Z');
  assert.deepEqual(minutes(longDay), [540, 50, 45, 95], 'in 13:10, out 23:45: 9 hours, 95 minutes wait for the owner');
  assert.deepEqual(minutes(longDay, { status: 'approved', minutes: 95 }), [635, 50, 45, 0]);
  assert.deepEqual(minutes(longDay, { status: 'rejected', minutes: 0 }), [540, 50, 45, 0]);
  assert.deepEqual(minutes(ses('2026-10-25T07:25:00Z', '2026-10-25T15:40:00Z')), [495, 0, 0, 0], 'late 25 and left 20 early: only the time present');
  assert.deepEqual(minutes(ses('2026-10-25T10:55:00Z', '2026-10-25T18:20:00Z', 'night')), [450, 0, 0, 0], 'own shift 18:00–01:30');
  // Ra rồi vào lại lúc 00:10 để dọn (ngày ghi là hôm sau) → ở lại sau ca hôm trước, không phải vào sớm.
  const cleanup = rules.sessionHours(ses('2026-10-25T17:10:00Z', '2026-10-25T17:40:00Z', 'a', '2026-10-26'), R);
  assert.deepEqual([cleanup.earlyMs, cleanup.stayMs / 60000], [0, 30]);
  const before = rules.sessionHours(ses('2026-10-24T06:10:00Z', '2026-10-24T16:45:00Z', 'a', '2026-10-24'), R);
  assert.deepEqual([before.countedMs / 60000, before.pendingMs, before.byShift], [635, 0, false], 'days before the switch count as before');
});

test('late, early, left early and stayed flags per person per day', () => {
  const R = rules.normalizeRules({ hours_from: '2026-10-25' }, [], [SHOP_HOURS]);
  const day = [
    { staff_id: 'a', date: '2026-10-25', clock_in: '2026-10-25T07:25:00Z', clock_out: '2026-10-25T10:00:00Z' },
    { staff_id: 'a', date: '2026-10-25', clock_in: '2026-10-25T10:30:00Z', clock_out: '2026-10-25T16:45:00Z' },
  ];
  const f = rules.dayFlags(day, R);
  assert.deepEqual(f, { late: 25, early: 0, leftEarly: 0, stayed: 45 }, 'a break in the middle is not late or early');
  assert.deepEqual(rules.flagTexts(f), ['trễ 25 phút', 'ở lại 45 phút']);
  assert.deepEqual(rules.dayFlags([{ ...day[0], clock_in: '2026-10-25T06:10:00Z', clock_out: '2026-10-25T15:40:00Z' }], R), { late: 0, early: 50, leftEarly: 20, stayed: 0 });
  assert.deepEqual(rules.dayFlags([{ ...day[0], clock_in: '2026-10-25T07:08:00Z', clock_out: '2026-10-25T15:55:00Z' }], R), { late: 0, early: 0, leftEarly: 0, stayed: 0 }, 'within 10 minutes');
  assert.deepEqual(rules.dayFlags([{ ...day[0], date: '2026-10-24' }], R), { late: 0, early: 0, leftEarly: 0, stayed: 0 }, 'not before the switch');
  // Về 23:00 rồi quay lại dọn 00:20–00:50: ở lại 30 phút (đúng số phút chờ duyệt), không phải 1 giờ 50 phút.
  assert.deepEqual(rules.dayFlags([{ ...day[0], clock_in: '2026-10-25T07:00:00Z', clock_out: '2026-10-25T16:00:00Z' },
    { staff_id: 'a', date: '2026-10-26', clock_in: '2026-10-25T17:20:00Z', clock_out: '2026-10-25T17:50:00Z' }], R), { late: 0, early: 0, leftEarly: 0, stayed: 30 });
  assert.equal(rules.durationText(95), '1 giờ 35 phút');
  assert.equal(rules.durationText(60), '1 giờ');
});

const source = readFileSync(new URL('../src/app/api/checkin/kiosk/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

function load(state, user) {
  const NextResponse = { json: (body, init = {}) => {
    const res = { status: init.status || 200, body };
    Object.defineProperty(res, 'cookies', { value: { set: (k, v) => { res.setCookies = { ...res.setCookies, [k]: v }; } }, enumerable: false });
    return res;
  } };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...token, ...rules, ...clockApply, ...faceCheck, URL, Number, Math, String, JSON, Date, Promise, STATUS_COOKIE: 'local_admin_session',
    console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: SECRET } },
    getStaffSession: async () => (user ? { code: 200, user } : { code: 401 }),
    nowMs: () => Date.now(), refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true, checkedAt: null, source: 'test' }),
    statusDatabase: () => fakeDb(state), staffDatabase: () => fakeDb(state),
  });
}
const kioskReq = (cookie, shown = '', ip = '113.161.1.2') => ({
  url: `https://x/api/checkin/kiosk?t=${encodeURIComponent(shown)}`,
  headers: new Map([['cf-connecting-ip', ip]]),
  cookies: { get: k => (k === token.KIOSK_COOKIE && cookie ? { value: cookie } : undefined) },
});
const plain = v => JSON.parse(JSON.stringify(v));

test('only an admin turns a phone into a kiosk, and that phone is logged out of admin', async () => {
  const state = { checkin_kiosks: [] };
  const req = { json: async () => ({ action: 'activate', name: 'Quầy chính' }), headers: new Map([['cf-connecting-ip', '113.161.1.2']]), url: 'https://x/api/checkin/kiosk' };
  assert.equal((await load(state, null).POST(req)).status, 401);
  assert.equal((await load(state, STAFF).POST(req)).status, 403);
  const res = await load(state, ADMIN).POST(req);
  assert.equal(res.status, 200);
  assert.equal(state.checkin_kiosks[0].name, 'Quầy chính');
  assert.equal(token.readKioskCookie(res.setCookies[token.KIOSK_COOKIE], SECRET), state.checkin_kiosks[0].id);
  assert.equal(res.setCookies.local_admin_session, '', 'admin login removed from the counter phone');
});

test('the kiosk keeps a code for 30 seconds, swaps it once used and shows who clocked', async () => {
  const state = { checkin_kiosks: [{ id: KIOSK, name: 'Quầy', revoked_at: null, recent_ips: [] }], checkin_nonces: [], checkin_scans: [], staff: [STAFF] };
  const api = load(state, null);
  assert.equal(plain(await api.GET(kioskReq(null))).status, 401, 'a normal phone cannot get codes');
  const cookie = token.signKioskCookie(KIOSK, SECRET);
  const first = plain(await api.GET(kioskReq(cookie)));
  assert.equal(first.status, 200);
  assert.equal(token.readKioskQrToken(first.body.token, SECRET).kioskId, KIOSK);
  assert.equal(state.checkin_kiosks[0].recent_ips[0].ip, '113.161.1.2', 'shop wifi address remembered');

  assert.equal(plain(await api.GET(kioskReq(cookie, first.body.token))).body.token, first.body.token, 'same code while fresh and unused');
  const { nonce } = token.readKioskQrToken(first.body.token, SECRET);
  state.checkin_nonces.push({ nonce, staff_id: STAFF.id });
  state.checkin_scans.push({ nonce, staff_id: STAFF.id, action: 'in', created_at: new Date().toISOString() });
  const next = plain(await api.GET(kioskReq(cookie, first.body.token)));
  assert.notEqual(next.body.token, first.body.token, 'new code right after someone used it');
  assert.deepEqual([next.body.lastScan.name, next.body.lastScan.action], ['Phát', 'in']);

  assert.equal(next.body.lastFail, null, 'nothing blocked');

  // Đang bật chặn thật: lượt quét bằng 4G bị chặn → máy quầy báo chưa thành công (chỉ trong 15 giây, chỉ máy quầy đó).
  const ago = s => new Date(Date.now() - s * 1000).toISOString();
  state.checkin_scans.push(
    { id: 'b-old', kiosk_id: KIOSK, staff_id: STAFF.id, action: 'blocked', warnings: ['unknown_device'], created_at: ago(40) },
    { id: 'b-other', kiosk_id: 'another-kiosk', staff_id: STAFF.id, action: 'blocked', warnings: ['other_network'], created_at: ago(2) },
    { id: 'b-new', kiosk_id: KIOSK, staff_id: STAFF.id, action: 'blocked', warnings: ['other_network'], created_at: ago(3) });
  const failed = plain(await api.GET(kioskReq(cookie, next.body.token)));
  assert.deepEqual([failed.body.lastFail.id, failed.body.lastFail.name, failed.body.lastFail.reason], ['b-new', 'Phát', 'other_network']);
  state.checkin_scans = state.checkin_scans.filter(x => x.id !== 'b-new');
  assert.equal(plain(await api.GET(kioskReq(cookie, next.body.token))).body.lastFail, null, 'older than 15 seconds or another kiosk: not shown');

  const old = token.kioskQrToken(SECRET, KIOSK, Date.now() - 31000);
  assert.notEqual(plain(await api.GET(kioskReq(cookie, old))).body.token, old, 'new code after 30 seconds');

  state.checkin_kiosks[0].revoked_at = new Date().toISOString();
  assert.equal(plain(await api.GET(kioskReq(cookie))).status, 401, 'switched off from the Lương page');
});

test('late minutes are rounded down so they match the clock on screen', () => {
  const R = rules.normalizeRules({ hours_from: '2026-10-25' }, [], [SHOP_HOURS]);
  // 16:59:40 với ca 14:00 → trễ 2 giờ 59 phút, không phải 3 giờ.
  const f = rules.dayFlags([{ staff_id: 'a', date: '2026-10-25', clock_in: '2026-10-25T09:59:40Z', clock_out: null }], R);
  assert.equal(f.late, 179);
  assert.deepEqual(rules.flagTexts(f), ['trễ 2 giờ 59 phút']);
});

test('the work day at night: clean-up after midnight is still the shift before', () => {
  const R = rules.normalizeRules({ hours_from: '2026-10-25' }, [], [SHOP_HOURS]);
  assert.equal(rules.currentWorkDay(R, 'a', Date.parse('2026-11-28T17:45:00Z')), '2026-11-28', '00:45 is still the 28th');
  assert.equal(rules.currentWorkDay(R, 'a', Date.parse('2026-11-28T20:30:00Z')), '2026-11-29', '03:30 is past closing + 4 hours');
  assert.equal(rules.currentWorkDay(R, 'a', Date.parse('2026-11-29T03:00:00Z')), '2026-11-29');
  assert.equal(rules.currentWorkDay(null, 'a', Date.parse('2026-11-28T17:45:00Z')), '2026-11-29', 'no rules: the calendar day');
});
