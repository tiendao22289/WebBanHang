import test from 'node:test';
import assert from 'node:assert/strict';
import { kioskQrToken } from '../src/lib/checkinToken.mjs';
import { normalizeRules } from '../src/lib/attendanceRules.mjs';
import { clockSummary, punctuality, qrClockToken, tokenFresh } from '../src/lib/clockMessages.mjs';

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
  assert.equal(tokenFresh(kioskQrToken(SECRET, KIOSK, Date.now() - 5 * 60000)), false, 'older than 2 minutes (+1 minute of clock drift)');
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
