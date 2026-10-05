import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuUsagePercent, sampleCpuUsage } from '../src/lib/hostCpu.mjs';

const cpu = (user = 0, idle = 0) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

test('CPU usage uses counter deltas, not cumulative uptime averages', () => {
  assert.equal(cpuUsagePercent([cpu(9000, 1000)], [cpu(9025, 1075)]), 25);
  assert.equal(cpuUsagePercent([cpu()], [cpu(1, 2)]), 33.3);
});
test('CPU usage weights elapsed time across all logical processors', () => {
  assert.equal(cpuUsagePercent([cpu(), cpu()], [cpu(100, 0), cpu(0, 300)]), 25);
});
test('zero and full CPU usage remain valid measurements', () => {
  assert.equal(cpuUsagePercent([cpu()], [cpu(0, 100)]), 0);
  assert.equal(cpuUsagePercent([cpu()], [cpu(100, 0)]), 100);
});
test('missing samples, counter resets and topology changes do not report misleading usage', () => {
  assert.equal(cpuUsagePercent([], []), null);
  assert.equal(cpuUsagePercent([cpu()], [cpu()]), null);
  assert.equal(cpuUsagePercent([cpu(2)], [cpu(1)]), null);
  assert.equal(cpuUsagePercent([cpu()], [cpu(), cpu()]), null);
  assert.equal(cpuUsagePercent([cpu()], [{ times: { idle: 10 } }]), null);
});
test('host sampling returns a percentage or an explicitly unavailable result', async () => {
  const value = await sampleCpuUsage();
  assert.ok(value === null || (Number.isFinite(value) && value >= 0 && value <= 100));
});
