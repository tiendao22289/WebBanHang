import test from 'node:test';
import assert from 'node:assert/strict';
import { cashChange, cashChoices } from '../src/lib/cashChange.mjs';

test('quick "customer gave" buttons start with the exact bill and then the next round notes', () => {
  assert.deepEqual(cashChoices(300000), [300000, 500000, 1000000]);
  assert.deepEqual(cashChoices(328000), [328000, 330000, 350000, 400000]);
  assert.deepEqual(cashChoices(45000), [45000, 50000, 100000, 500000]);
  assert.deepEqual(cashChoices(1200000), [1200000, 1500000, 2000000]);
});

test('the change to give back, or how much is still missing', () => {
  assert.deepEqual(cashChange(300000, 500000), { change: 200000 });
  assert.deepEqual(cashChange(300000, 300000), { change: 0 });
  assert.deepEqual(cashChange(300000, 200000), { short: 100000 });
  assert.equal(cashChange(300000, 0), null);
  assert.equal(cashChange(300000, NaN), null);
});
