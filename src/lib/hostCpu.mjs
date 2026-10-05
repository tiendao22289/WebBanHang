import { cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const fields = ['user', 'nice', 'sys', 'idle', 'irq'];

export function cpuUsagePercent(before, after) {
  if (!before.length || before.length !== after.length) return null;
  let total = 0;
  let idle = 0;
  for (let index = 0; index < before.length; index++) {
    for (const field of fields) {
      const previous = before[index].times?.[field];
      const current = after[index].times?.[field];
      if (!Number.isFinite(previous) || !Number.isFinite(current) || current < previous) return null;
      const elapsed = current - previous;
      total += elapsed;
      if (field === 'idle') idle += elapsed;
    }
  }
  return total > 0 ? Math.round((total - idle) / total * 1000) / 10 : null;
}

export async function sampleCpuUsage() {
  try {
    const before = cpus();
    await delay(1000);
    return cpuUsagePercent(before, cpus());
  } catch { return null; }
}
