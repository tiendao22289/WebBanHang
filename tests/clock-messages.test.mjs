import test from 'node:test';
import assert from 'node:assert/strict';
import { kioskQrToken } from '../src/lib/checkinToken.mjs';
import { normalizeRules } from '../src/lib/attendanceRules.mjs';
import { clockSummary, punctuality, qrClockToken, spokenClock, spokenClockError, spokenKiosk, spokenTime, tokenFresh } from '../src/lib/clockMessages.mjs';

const SECRET = 'service-role-test-key'.repeat(2);
const KIOSK = '00000000-0000-4000-8000-00000000eeee';
const SITE = 'https://ocbaokhang.online';

test('the in-app scanner only takes the kiosk check-in link and a fresh code', () => {
  const token = kioskQrToken(SECRET, KIOSK);
  assert.equal(qrClockToken(`${SITE}/checkin?t=${encodeURIComponent(token)}`), token);
  assert.equal(qrClockToken(`  ${SITE}/checkin?t=${token}\n`), token, 'spaces around the text are ignored');
  assert.equal(qrClockToken(`https://www.ocbaokhang.online/checkin?t=${token}`), token, 'with or without www (the server checks the signature)');
  assert.equal(qrClockToken(`${SITE}/order?t=${token}`), null, 'a table QR, not the kiosk');
  assert.equal(qrClockToken(`${SITE}/checkin`), null, 'no code');
  assert.equal(qrClockToken('WIFI:S:quan;T:WPA;P:123;;'), null, 'not a link');
  assert.equal(qrClockToken(`javascript:alert(1)//checkin?t=${token}`), null);
  assert.equal(tokenFresh(token), true);
  // Máy chủ ở quán chậm 9 phút rưỡi: mã vừa tạo vẫn phải quét được (máy chủ tự kiểm hạn 2 phút bằng đồng hồ của nó).
  assert.equal(tokenFresh(kioskQrToken(SECRET, KIOSK, Date.now() - 9.5 * 60000)), true, 'a slow shop server clock');
  assert.equal(tokenFresh(kioskQrToken(SECRET, KIOSK, Date.now() + 5 * 60000)), true, 'a slow phone clock');
  assert.equal(tokenFresh(kioskQrToken(SECRET, KIOSK, Date.now() - 2 * 3600000)), false, 'a photo of yesterday\'s code');
  assert.equal(tokenFresh('abc'), false);
});

test('after a scan the staff see the time, today\'s hours and whether they were on time', () => {
  const R = normalizeRules({ hours_from: '2026-10-25' }, [], [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]);
  const first = { id: 's1', staff_id: 'a', date: '2026-11-02', clock_in: '2026-11-02T07:25:00Z', clock_out: '2026-11-02T10:00:00Z' };
  const second = { id: 's2', staff_id: 'a', date: '2026-11-02', clock_in: '2026-11-02T10:30:00Z', clock_out: null };
  const inResult = { clocked: 'in', at: second.clock_in, session: second, sessions: [first, second] };
  assert.match(clockSummary(inResult), /^🟢 Vào ca lúc \d\d:30\n⏱ Tổng tích luỹ hôm nay: 2,6 giờ$/);
  assert.equal(punctuality('in', second, inResult.sessions, R, 'a'), '⏰ Trễ 25 phút so với ca 14:00.', 'the first clock-in of the day decides lateness');
  const out = { ...second, clock_out: '2026-11-02T16:00:00Z' };
  const outResult = { clocked: 'out', at: out.clock_out, session: out, sessions: [first, out] };
  assert.match(clockSummary(outResult), /^🔴 Ra ca lúc \d\d:00 · Ca này: 5,5 giờ\n✅ Tổng hôm nay: 8,1 giờ$/);
  assert.equal(punctuality('out', out, outResult.sessions, R, 'a'), '✅ Ra ca đúng giờ.');
  assert.equal(punctuality('in', second, [], null, 'a'), '', 'nothing before the shop hours are set');
});

test('leaving 30 minutes or more early tells the staff it is cut from pay (from November)', () => {
  const R = normalizeRules({ hours_from: '2026-10-25' }, [], [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }]);
  const out = (date, time) => { const s = { id: 's', staff_id: 'a', date, clock_in: `${date}T07:00:00Z`, clock_out: `${date}T${time}:00Z` }; return punctuality('out', s, [s], R, 'a'); };
  assert.equal(out('2026-11-04', '13:00'), '⏰ Về sớm 3 giờ so với giờ hết ca 23:00. Về sớm từ 30 phút bị trừ lương theo giờ về sớm.');
  assert.equal(out('2026-11-04', '15:40'), '⏰ Về sớm 20 phút so với giờ hết ca 23:00.');
  assert.equal(out('2026-10-27', '13:00'), '⏰ Về sớm 3 giờ so với giờ hết ca 23:00.');
});

test('the scan result is read aloud in plain Vietnamese: success or not, with the time', () => {
  assert.equal(spokenTime('2026-10-25T07:05:00Z'), '14 giờ 05', 'Vietnam time, read as hours and minutes');
  assert.equal(spokenTime('2026-10-25T17:30:00.000Z'), '0 giờ 30');
  assert.equal(spokenClock({ clocked: 'in', at: '2026-10-25T07:05:00Z' }), 'Quét mã thành công. Vào ca lúc 14 giờ 05.');
  assert.equal(spokenClock({ clocked: 'out', at: '2026-10-25T15:40:00Z' }), 'Quét mã thành công. Ra ca lúc 22 giờ 40.');
  assert.equal(spokenClockError('⚠️ Điện thoại chưa vào wifi quán. Bật wifi quán (tắt 4G) rồi quét lại mã trên máy quầy.'),
    'Quét mã chưa thành công. Điện thoại chưa vào wifi quán. Bật wifi quán (tắt 4G) rồi quét lại mã trên máy quầy.', 'no emoji read out');
  assert.equal(spokenKiosk({ ok: true, name: 'Phát', action: 'in', at: '2026-10-25T07:05:00Z' }), 'Phát, quét mã thành công. Vào ca lúc 14 giờ 05.');
  assert.equal(spokenKiosk({ ok: true, name: 'Phát', action: 'out', at: '2026-10-25T15:40:00Z' }), 'Phát, quét mã thành công. Ra ca lúc 22 giờ 40.');
  assert.equal(spokenKiosk({ ok: false, name: 'Phát', reason: 'other_network' }), 'Phát, quét mã chưa thành công. Điện thoại chưa vào wifi quán.');
  assert.equal(spokenKiosk({ ok: false, name: 'Phát', reason: null }), 'Phát, quét mã chưa thành công. Xem lại trên điện thoại.');
});
