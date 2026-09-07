import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const flow = await import(`data:text/javascript;base64,${Buffer.from(read('../src/lib/luckyRewardFlow.js')).toString('base64')}`);
const { luckyRewardState, luckyPrizeTitle, shouldResumeLucky, hasPendingLuckySpin } = flow;
const page = read('../src/app/order/page.jsx');
const restoreSource = page.slice(page.indexOf('  async function restoreWheel('), page.indexOf('  wheelResumeRef.current = restoreWheel;'));
const today = new Date();
const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const base = { id: 'spin-1', status: 'waiting_follow', prize_type: 'gift_drink', prize_value: 1, created_at: today.toISOString() };

function harness(spin = base, options = {}) {
  const store = new Map([['lucky_spin_table-1', spin.id], ['lucky_spin_table-1_pending', spin.id]]);
  const seen = { checks: 0, reads: 0, orders: 0 };
  const context = {
    Date, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    wheelResumeBusyRef: { current: false }, wheelGiftBusyRef: { current: false }, wheelOpeningRef: { current: false },
    wheelSpinning: false, wheelOpen: false, activeTableId: 'table-1', urlTableId: 'table-1',
    wheelSpinRef: { current: null }, customerPhoneRef: { current: '0900000000' },
    wheelStorageKey: () => 'lucky_spin_table-1', shouldResumeLucky, luckyRewardState,
    getTodayStr: () => dayKey, startOfTodayISO: () => dayKey, getSavedSession: () => ({}),
    rememberWheel: id => store.set('lucky_spin_table-1_pending', id),
    fetchWheelDrinkItems: async () => {}, checkWheelReward: async () => { seen.checks++; },
    refreshPreviousOrdersReliably: () => { seen.orders++; },
    setWheelOpen: v => { context.wheelOpen = v; },
    setWheelPrize: v => { seen.prize = v; }, setWheelSpin: v => { seen.spin = v; },
    setWheelErr: v => { seen.error = v; }, setShowLuckyNudge: () => {}, setReviewOpen: () => {},
    setWheelGiftOptionItem: () => {}, setWheelGiftSelectedOptions: () => {},
    supabase: {
      rpc() {
        seen.reads++;
        return { maybeSingle: async () => ({ data: options.rpcError ? null : spin, error: options.rpcError }) };
      },
      from(table) {
        const result = table === 'orders'
          ? { data: options.noOrders ? [] : [{ id: 'order-1', customer_phone: '0900000000' }], error: options.ordersError }
          : { data: [{ id: 'table-1', table_type: 'normal' }], error: null };
        const q = { select: () => q, eq: () => q, in: () => q, gte: () => q, or: () => q,
          maybeSingle: async () => ({ data: { occupied_at: options.sessionStart || null }, error: null }),
          then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
        return q;
      },
    },
  };
  return { store, seen, context, restore: vm.runInNewContext(`(${restoreSource.trim()})`, context) };
}

test('a saved gift choice without a bill item must remain receivable', () => {
  assert.equal(luckyRewardState({ ...base, status: 'applied', gift_menu_item_id: 'drink' }), 'choose_gift');
  assert.equal(luckyRewardState({ ...base, gift_menu_item_id: 'drink' }), 'waiting_follow');
});

test('discount reservation is not success until the bill item exists', () => {
  const discount = { ...base, status: 'applied', prize_type: 'percent' };
  assert.equal(luckyRewardState(discount), 'saving');
  assert.equal(luckyRewardState({ ...discount, applied_item_id: 'discount-line' }), 'done');
});

test('success title uses the actual percentage instead of an admin placeholder', () => {
  assert.equal(luckyPrizeTitle({ prize_type: 'percent', prize_value: 9, prize_label: 'Phần quà mới' }), 'Giảm 9% hoá đơn');
  assert.equal(luckyPrizeTitle({ prizeType: 'percent', prizeValue: 5 }), 'Giảm 5% hoá đơn');
});

test('reload restores an unfinished reward and starts checking', async () => {
  const h = harness();
  await h.restore();
  assert.equal(h.context.wheelOpen, true);
  assert.equal(h.seen.prize.spinId, base.id);
  assert.equal(h.seen.checks, 1);
});

test('focus restore does not duplicate requests while the wheel is opening', async () => {
  const h = harness();
  h.context.wheelOpeningRef.current = true;
  await h.restore();
  assert.equal(h.seen.reads, 0);
  assert.equal(h.context.wheelOpen, false);
});

test('gift confirmed while away returns to gift selection', async () => {
  const h = harness({ ...base, status: 'applied' });
  await h.restore();
  assert.equal(luckyRewardState(h.seen.spin), 'choose_gift');
  assert.equal(h.context.wheelOpen, true);
});

test('discount delivered while away returns to the unacknowledged success screen', async () => {
  const h = harness({ ...base, status: 'applied', prize_type: 'percent', applied_item_id: 'line' });
  await h.restore();
  assert.equal(h.context.wheelOpen, true);
  assert.equal(luckyRewardState(h.seen.spin), 'done');
  assert.equal(h.seen.orders, 1);
});

test('choosing later stops automatic reopening, but manual reopening is allowed', async () => {
  const h = harness();
  h.store.set('lucky_spin_table-1_dismissed', base.id);
  await h.restore();
  assert.equal(h.context.wheelOpen, false);
  assert.equal(h.seen.reads, 0);
  await h.restore(true);
  assert.equal(h.context.wheelOpen, true);
});

test('temporary read failure preserves the saved reward for a later retry', async () => {
  const options = { rpcError: { message: 'offline' } };
  const h = harness(base, options);
  await h.restore();
  assert.equal(h.store.get('lucky_spin_table-1'), base.id);
  assert.ok(h.seen.error);
  options.rpcError = null;
  await h.restore();
  assert.equal(h.context.wheelOpen, true);
});

test('new guests at the same table do not restore the old reward', async () => {
  const h = harness(base, { sessionStart: new Date(today.getTime() + 60000).toISOString() });
  await h.restore();
  assert.equal(h.context.wheelOpen, false);
  assert.equal(h.store.has('lucky_spin_table-1'), false);
});

test('closed bills stop restoration; database errors do not delete the reward', async () => {
  const closed = harness(base, { noOrders: true });
  await closed.restore();
  assert.equal(closed.context.wheelOpen, false);
  assert.equal(closed.store.has('lucky_spin_table-1'), false);
  const offline = harness(base, { ordersError: { message: 'offline' } });
  await offline.restore();
  assert.equal(offline.store.has('lucky_spin_table-1'), true);
});

test('old cached spins do not reopen without an explicit pending receipt', () => {
  assert.equal(shouldResumeLucky({ ...base, status: 'applied', applied_item_id: 'line' }, null, null), false);
  assert.equal(shouldResumeLucky(base, null, null), false);
  assert.equal(shouldResumeLucky(base, base.id, null), true);
  assert.equal(hasPendingLuckySpin(base.id, null), false);
  assert.equal(hasPendingLuckySpin(base.id, base.id), true);
});
test('older mobile browsers generate a valid retry UUID without randomUUID', () => {
  const id = flow.newLuckyRequestId({ getRandomValues: bytes => bytes.fill(7) });
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

const nudgeSource = page.slice(page.indexOf('  async function checkLuckyNudge()'), page.indexOf('  // Recover an invitation'));
function nudgeHarness(configs) {
  const seen = { shown: false, reads: 0, billReads: 0, stored: false };
  const fn = vm.runInNewContext(`(${nudgeSource.trim()})`, {
    supabase: {}, luckyWheelEnabled: true, luckyWheelAutoNudge: true, luckyWheelMinBill: 150000,
    fetchLuckyNudgeConfig: async () => configs[Math.min(seen.reads++, configs.length - 1)],
    setLuckyWheelEnabled: value => { seen.enabled = value; },
    setLuckyWheelAutoNudge: value => { seen.auto = value; },
    setShowLuckyNudge: value => { seen.shown = value; },
    localStorage: { getItem: () => null, setItem: () => { seen.stored = true; } },
    fetchSessionStart: async () => '2026-09-07T09:13:55.494Z',
    luckyNudgeStorageKey: session => `nudge_${session}`, wheelStorageKey: () => 'spin',
    fetchGroupBillTotal: async () => { seen.billReads++; return 200000; },
    reviewGroupIds: () => ['table'], reviewPhoneFilter: () => null,
    groupOrders: [], previousOrders: [], isLuckyWheelItem: () => false,
    fetchLuckyPrizes: async () => [], setLuckyNudgeMaxPercent: () => {},
  });
  return { seen, run: fn };
}
const nudgeOn = { enabled: true, autoNudge: true, minBill: 150000 };

test('saved OFF overrides stale ON in an already-open customer tab', async () => {
  const h = nudgeHarness([{ ...nudgeOn, autoNudge: false }]);
  await h.run();
  assert.equal(h.seen.shown, false);
  assert.equal(h.seen.billReads, 0);
  assert.equal(h.seen.stored, false);
});

test('disabling invitations during bill loading cancels the pending popup', async () => {
  const h = nudgeHarness([nudgeOn, { ...nudgeOn, autoNudge: false }]);
  await h.run();
  assert.equal(h.seen.reads, 2);
  assert.equal(h.seen.shown, false);
  assert.equal(h.seen.stored, false);
});

test('settings read failure never falls back to the cached ON state', async () => {
  const h = nudgeHarness([null]);
  await h.run();
  assert.equal(h.seen.shown, false);
});

test('an enabled invitation still opens once when the bill qualifies', async () => {
  const h = nudgeHarness([nudgeOn]);
  await h.run();
  assert.equal(h.seen.shown, true);
  assert.equal(h.seen.stored, true);
});

test('enabling the wheel revives a tab that loaded while it was disabled', async () => {
  const h = nudgeHarness([nudgeOn]);
  await h.run();
  assert.equal(h.seen.enabled, true);
  assert.equal(h.seen.auto, true);
  assert.equal(h.seen.shown, true);
});

test('the invitation marker is scoped to the current occupied table session', async () => {
  const seenKeys = [];
  const h = nudgeHarness([nudgeOn]);
  h.run = vm.runInNewContext(`(${nudgeSource.trim()})`, {
    supabase: {}, luckyWheelEnabled: false, luckyWheelAutoNudge: false,
    fetchLuckyNudgeConfig: async () => nudgeOn,
    setLuckyWheelEnabled: value => { h.seen.enabled = value; },
    setLuckyWheelAutoNudge: value => { h.seen.auto = value; }, setShowLuckyNudge: value => { h.seen.shown = value; },
    fetchSessionStart: async () => '2026-09-07T09:13:55.494Z',
    luckyNudgeStorageKey: session => `nudge_${session}`, wheelStorageKey: () => 'spin',
    localStorage: { getItem: key => key === 'nudge_previous-session' ? '1' : null,
      setItem: key => seenKeys.push(key) },
    fetchGroupBillTotal: async () => 200000, reviewGroupIds: () => ['table'], reviewPhoneFilter: () => null,
    groupOrders: [], previousOrders: [], isLuckyWheelItem: () => false,
    fetchLuckyPrizes: async () => [], setLuckyNudgeMaxPercent: () => {},
  });
  await h.run();
  assert.deepEqual(seenKeys, ['nudge_2026-09-07T09:13:55.494Z']);
  assert.equal(h.seen.shown, true);
});
