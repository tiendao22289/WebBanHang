import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createTableOrderReadGuard, createTableOrderRefresh, expandTableRefreshScope,
  getCachedOrderTableIds, getTableOrderChangeScope, mergeTableOrders, readOpenTableOrders, withCachedMenuOptions,
} from '../src/lib/tableOrderRefresh.mjs';

const tables = [{ id: 'a' }, { id: 'b', merged_with: 'a' }, { id: 'c' }];
const orders = {
  a: [{ id: 'o1', table_id: 'a', order_items: [{ id: 'i1', menu_item_id: 'm1' }] }],
  c: [{ id: 'o2', table_id: 'c', order_items: [{ id: 'i2' }] }],
};

test('local edits refresh only their bill tables, with a safe fallback for uncached bills', () => {
  assert.deepEqual(getCachedOrderTableIds(orders, ['o1']), ['a']);
  assert.deepEqual(getCachedOrderTableIds(orders, ['o1', 'o2']), ['a', 'c']);
  assert.equal(getCachedOrderTableIds(orders, ['unknown']), null);
});

test('an item update and a primary-key-only deletion target their cached table', () => {
  for (const payload of [
    { new: { id: 'i1', order_id: 'o1' }, old: { id: 'i1' } },
    { old: { id: 'i1' }, eventType: 'DELETE' },
  ]) {
    const scope = getTableOrderChangeScope('order_items', payload, orders);
    assert.deepEqual(scope.tableIds, ['a']);
    assert.deepEqual(scope.orderIds, []);
    assert.equal(scope.full, false);
  }
});

test('moving a bill refreshes the old cached table and the new table', () => {
  const scope = getTableOrderChangeScope('orders', {
    old: { id: 'o1' }, new: { id: 'o1', table_id: 'c' },
  }, orders);
  assert.deepEqual(new Set(scope.tableIds), new Set(['a', 'c']));
  assert.equal(scope.full, false);
});

test('a new item queues a parent lookup; an unresolvable deletion falls back to a full read', () => {
  const scope = getTableOrderChangeScope('order_items', { new: { id: 'new-item', order_id: 'new-order' } }, orders);
  assert.deepEqual(scope.orderIds, ['new-order']);
  assert.equal(scope.full, false);
  assert.equal(getTableOrderChangeScope('order_items', { old: { id: 'unknown' } }, orders).full, true);
});

test('moving an item between bills refreshes both source and destination', () => {
  const scope = getTableOrderChangeScope('order_items', {
    old: { id: 'i1' }, new: { id: 'i1', order_id: 'o2' },
  }, orders);
  assert.deepEqual(new Set(scope.tableIds), new Set(['a', 'c']));
});

test('merge, unmerge and table deletion refresh both the old and new groups', () => {
  assert.deepEqual(expandTableRefreshScope(['b'], tables), ['b', 'a']);
  const changed = [{ id: 'a' }, { id: 'b', merged_with: 'c' }, { id: 'c' }];
  assert.deepEqual(new Set(expandTableRefreshScope(['b'], changed, tables)), new Set(['a', 'b', 'c']));
  assert.deepEqual(new Set(expandTableRefreshScope(['a'], [{ id: 'b' }, { id: 'c' }], tables)), new Set(['a', 'b']));
});

test('an empty scoped response clears paid/deleted bills and preserves unrelated tables', () => {
  const next = mergeTableOrders(orders, [], ['a', 'b']);
  assert.deepEqual(next.a, []);
  assert.deepEqual(next.b, []);
  assert.equal(next.c, orders.c);
  assert.equal(orders.a.length, 1);
});

test('full reads use non-null FK filtering; scoped reads contain only affected IDs', async () => {
  for (const ids of [null, ['a', 'b']]) {
    const calls = [];
    const query = {
      select: value => { calls.push(['select', value]); return query; },
      not: (...args) => { calls.push(['not', ...args]); return query; },
      in: (...args) => { calls.push(['in', ...args]); return query; },
      order: (...args) => { calls.push(['order', ...args]); return Promise.resolve({ data: [] }); },
    };
    await readOpenTableOrders({ from: name => { assert.equal(name, 'orders'); return query; } }, ids);
    assert.equal(calls[0][1].includes('category_id, options'), false);
    assert.deepEqual(calls[1], ids === null ? ['not', 'table_id', 'is', null] : ['in', 'table_id', ids]);
    assert.deepEqual(calls[2], ['in', 'status', ['pending', 'preparing', 'completed']]);
  }
});

test('cached options preserve gifts, modifiers and deleted menu references', () => {
  const data = [{ id: 'bill', order_items: [
    { menu_item_id: 'm1', is_gift: true, item_options: [{ choice: 'large' }], menu_item: { name: 'Current name', category_id: 'cat' } },
    { item_name: 'Manual discount', menu_item: null },
  ] }];
  const options = [{ name: 'Size', choices: ['large'], promoDivisors: [2] }];
  const hydrated = withCachedMenuOptions(data, [{ id: 'm1', is_available: false, options }]);
  assert.equal(hydrated[0].order_items[0].menu_item.options, options);
  assert.equal(hydrated[0].order_items[0].menu_item.name, 'Current name');
  assert.equal(hydrated[0].order_items[0].is_gift, true);
  assert.deepEqual(hydrated[0].order_items[0].item_options, [{ choice: 'large' }]);
  assert.equal(hydrated[0].order_items[1].menu_item, null);
  assert.equal(data[0].order_items[0].menu_item.options, undefined);
});

test('a slow full response cannot overwrite a newer scoped bill', () => {
  const guard = createTableOrderReadGuard();
  const full = guard.begin();
  const scoped = guard.begin(['a']);
  const updated = scoped(orders, [{ id: 'new', table_id: 'a' }]);
  const next = full(updated, [{ id: 'stale', table_id: 'a' }, { id: 'fresh-c', table_id: 'c' }]);
  assert.equal(next.a[0].id, 'new');
  assert.equal(next.c[0].id, 'fresh-c');
});

test('a newer full read supersedes an older scoped response and clears absent bills', () => {
  const guard = createTableOrderReadGuard();
  const scoped = guard.begin(['a']);
  const full = guard.begin();
  const cleared = full(orders, []);
  assert.deepEqual(cleared.a, []);
  assert.deepEqual(cleared.c, []);
  assert.deepEqual(scoped(cleared, orders.a).a, []);
});

function schedulerHarness(execute) {
  const timers = new Map();
  let id = 0;
  const refresh = createTableOrderRefresh(execute, {
    setTimer(fn) { timers.set(++id, fn); return id; },
    clearTimer(key) { timers.delete(key); },
  });
  return { refresh, timers, tick() {
    const [key, fn] = timers.entries().next().value;
    timers.delete(key);
    return fn();
  } };
}

test('a burst accumulates all tables and events during a slow read get one trailing read', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const h = schedulerHarness(async batch => {
    calls.push([...batch.tableIds]);
    if (calls.length === 1) await gate;
  });
  h.refresh.schedule({ tableIds: ['a'] });
  h.refresh.schedule({ tableIds: ['b'] });
  const first = h.tick();
  for (let i = 0; i < 20; i++) h.refresh.schedule({ tableIds: [i % 2 ? 'a' : 'c'] });
  assert.equal(h.timers.size, 0);
  assert.deepEqual(calls, [['a', 'b']]);
  release();
  await first;
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.deepEqual(calls, [['a', 'b'], ['c', 'a']]);
});

test('full fallback subsumes scoped events; disposal cancels queued work', async () => {
  const calls = [];
  const h = schedulerHarness(async batch => { calls.push(batch); });
  h.refresh.schedule({ tableIds: ['a'] });
  h.refresh.schedule({ full: true, tables: true });
  await h.tick();
  assert.equal(calls[0].full, true);
  assert.equal(calls[0].tables, true);
  h.refresh.schedule({ tableIds: ['b'] });
  h.refresh.dispose();
  h.refresh.schedule({ tableIds: ['c'] });
  assert.equal(h.timers.size, 0);
});

test('a failed request does not lock the scheduler', async () => {
  let count = 0;
  const h = schedulerHarness(async () => { if (++count === 1) throw new Error('offline'); });
  h.refresh.schedule({ tableIds: ['a'] });
  await assert.rejects(h.tick(), /offline/);
  h.refresh.schedule({ tableIds: ['b'] });
  await h.tick();
  assert.equal(count, 2);
});

test('initial page load starts bill and table reads concurrently and hydrates cached options', async () => {
  const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
  const section = page.slice(page.indexOf('  const fetchTables = useCallback('), page.indexOf('  // ─── Danh sách máy in'));
  const callback = section.match(/useCallback\(([\s\S]*), \[\]\);/)[1];
  let releaseTables;
  let releaseOrders;
  const calls = [];
  let state = orders;
  let loading = true;
  const options = [{ __category_id: 'drinks' }];
  const context = {
    lastFullFetchRef: { current: 0 },
    orderReadGuardRef: { current: createTableOrderReadGuard() },
    tablesStateRef: { current: tables },
    supabase: { from() { return { select() { return {
      order() { calls.push('tables'); return new Promise(resolve => { releaseTables = resolve; }); },
    }; } }; } },
    getMenuCached: async () => ({ items: [{ id: 'm1', name: 'Drink', is_available: true, options }], categories: [] }),
    readOpenTableOrders: (_client, ids) => {
      assert.equal(ids, undefined);
      calls.push('orders');
      return new Promise(resolve => { releaseOrders = resolve; });
    },
    expandTableRefreshScope, withCachedMenuOptions,
    fetchLuckyStatusRef: { current: null },
    setTables() {}, setMenuItems() {}, setCategories() {},
    setOrders(updater) { state = updater(state); },
    setLoading(value) { loading = value; },
    console,
  };
  const load = vm.runInNewContext(`(${callback})`, context)();
  assert.deepEqual(calls, ['tables', 'orders']);
  releaseOrders({ data: [{ id: 'o1', table_id: 'a', order_items: [{ menu_item_id: 'm1', menu_item: { name: 'Drink' } }] }], error: null });
  await Promise.resolve();
  assert.equal(loading, true);
  releaseTables({ data: tables, error: null });
  await load;
  assert.equal(loading, false);
  assert.equal(state.a[0].order_items[0].menu_item.options, options);
  assert.deepEqual(state.c, []);
});
