import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderRefresh } from '../src/lib/orderRefresh.mjs';

test('a burst during a slow request becomes one trailing read of the latest state', async () => {
  const refresh = createOrderRefresh();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const first = refresh(async () => { seen.push('start'); await gate; seen.push('end'); });
  await Promise.resolve();
  for (let i = 0; i < 100; i++) refresh(async () => { seen.push(i); });
  assert.deepEqual(seen, ['start']);
  release();
  await first;
  assert.deepEqual(seen, ['start', 'end', 99]);
});

test('a failed read does not lock subsequent refreshes', async () => {
  const refresh = createOrderRefresh();
  await assert.rejects(refresh(async () => { throw new Error('offline'); }), /offline/);
  let recovered = false;
  await refresh(async () => { recovered = true; });
  assert.equal(recovered, true);
});
