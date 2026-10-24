import test from 'node:test';
import assert from 'node:assert/strict';
import { clockStatus, nowMs, syncClock } from '../src/lib/trueTime.mjs';

const near = (a, b) => Math.abs(a - b) < 2000;

test('attendance time follows the internet clock, not a wrong shop computer clock', async () => {
  // Máy tính ở quán chậm 9 phút rưỡi: Cloudflare trả giờ thật.
  const slow = 9.5 * 60000;
  const cloudflare = async () => ({ text: async () => `fl=1\nts=${((Date.now() + slow) / 1000).toFixed(3)}\nloc=VN\n`, headers: new Map() });
  assert.ok(near(await syncClock(cloudflare), slow));
  assert.ok(near(nowMs(), Date.now() + slow), 'clock-in times use the corrected time');
  assert.equal(clockStatus().synced, true);
  assert.ok(near(-clockStatus().offsetMs, -slow), 'the owner is told the computer is 9.5 minutes slow');

  // Cloudflare bị chặn → hỏi Google (tiêu đề Date).
  const asked = [];
  const google = async url => {
    asked.push(url);
    if (url.includes('cdn-cgi')) throw new Error('blocked');
    return { text: async () => '', headers: { get: k => (k === 'date' ? new Date(Date.now() - 60000).toUTCString() : null) } };
  };
  const fast = await syncClock(google);
  assert.ok(near(fast, -60000), 'a computer 1 minute fast');
  assert.equal(asked.length, 3);

  // Mất mạng: giữ độ lệch vừa có, không quay về giờ máy tính.
  assert.equal(await syncClock(async () => { throw new Error('offline'); }), fast);
  assert.ok(near(nowMs(), Date.now() - 60000));
});
