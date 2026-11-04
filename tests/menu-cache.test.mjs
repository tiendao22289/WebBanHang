import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// menuCache.js: máy nhân viên ở trang Bàn không vào được /admin/menu, nên cache menu phải tự làm mới
// (quá 3 phút, hoặc quay lại tab sau 1 phút) — nhưng poll bàn vẫn không đọc menu mỗi lần.
const source = readFileSync(new URL('../src/lib/menuCache.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

function load({ menu = [{ id: 'bia', name: 'Bia', price: 20000, is_available: true }], fail = false } = {}) {
  const env = { now: Date.parse('2026-11-04T12:00:00Z'), reads: 0, store: new Map(), listeners: {}, visibility: 'visible', menu };
  const query = rows => {
    const q = { select: () => q, order: () => q,
      then: (ok, bad) => Promise.resolve(fail ? { data: null, error: { message: 'offline' } } : { data: structuredClone(rows()), error: null }).then(ok, bad) };
    return q;
  };
  const listen = (type, fn) => { (env.listeners[type] ||= []).push(fn); };
  const unlisten = (type, fn) => { env.listeners[type] = (env.listeners[type] || []).filter(f => f !== fn); };
  const api = vm.runInNewContext(`${source}\n({ readMenuCache, writeMenuCache, getMenuCached, fetchMenuFromServer, watchMenuCache, isMenuCacheFresh })`, {
    supabase: { from: table => { if (table === 'menu_items') env.reads++; return query(() => (table === 'menu_items' ? env.menu : [])); } },
    localStorage: { getItem: k => env.store.get(k) ?? null, setItem: (k, v) => env.store.set(k, v), removeItem: k => env.store.delete(k) },
    window: { addEventListener: listen, removeEventListener: unlisten },
    document: { addEventListener: listen, removeEventListener: unlisten, get visibilityState() { return env.visibility; } },
    Date: { now: () => env.now }, JSON, Number, Array, Promise, Error, console: { error() {} },
  });
  const fire = type => (env.listeners[type] || []).forEach(fn => fn());
  return { api, env, fire };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('polls inside 3 minutes read the cache; after that the menu is read again with the new price', async () => {
  const { api, env } = load();
  await api.getMenuCached();
  assert.equal(env.reads, 1, 'cache miss → one read');
  env.now += 2 * 60000;
  for (let i = 0; i < 20; i++) await api.getMenuCached();
  assert.equal(env.reads, 1, 'no request on every poll');
  env.menu = [{ id: 'bia', name: 'Bia', price: 25000, is_available: true }, { id: 'moi', name: 'Món mới', price: 50000, is_available: true }];
  env.now += 61000;
  const fresh = await api.getMenuCached();
  assert.equal(env.reads, 2);
  assert.deepEqual(fresh.items.map(i => [i.id, i.price]), [['bia', 25000], ['moi', 50000]]);
  assert.equal(fresh.savedAt, env.now);
});

test('several readers at once share one request, and a failed read keeps the old menu', async () => {
  const { api, env } = load();
  await Promise.all([api.getMenuCached(), api.getMenuCached(), api.getMenuCached()]);
  assert.equal(env.reads, 1);
  const offline = load({ fail: true });
  offline.env.store = env.store; // cùng localStorage: menu cũ đã lưu
  offline.env.now = env.now + 10 * 60000;
  const old = await offline.api.getMenuCached();
  assert.equal(old.items[0].price, 20000);
  await assert.rejects(load({ fail: true }).api.getMenuCached(), /offline/, 'nothing saved and offline → error as before');
});

test('coming back to the tab refreshes a menu older than 1 minute and hands it to the page', async () => {
  const { api, env, fire } = load();
  await api.getMenuCached();
  const seen = [];
  const stop = api.watchMenuCache(menu => seen.push(menu.items[0].price));
  env.now += 30000;
  fire('visibilitychange');
  await flush();
  assert.equal(env.reads, 1, 'still fresh after 30 s');
  env.menu = [{ id: 'bia', name: 'Bia', price: 22000, is_available: true }];
  env.now += 40000;
  env.visibility = 'hidden';
  fire('visibilitychange');
  await flush();
  assert.equal(env.reads, 1, 'nothing while hidden');
  env.visibility = 'visible';
  fire('visibilitychange');
  await flush();
  assert.equal(env.reads, 2);
  assert.deepEqual(seen, [20000, 22000]);
  stop();
  env.now += 120000;
  fire('visibilitychange');
  await flush();
  assert.equal(env.reads, 2, 'stopped on unmount');
});

test('the staff page applies only a newer menu, so a slow old read never overwrites a fresh one', () => {
  const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
  const applySource = page.slice(page.indexOf('  const menuSavedAtRef = useRef(-1);'), page.indexOf('  const lastFullFetchRef = useRef(0);'));
  const seen = [];
  const applyMenu = vm.runInNewContext(`${applySource.replace('useRef(-1)', '{ current: -1 }').replace('useCallback(', '(').replace(/, \[\]\);\s*$/, ');')}\napplyMenu`, {
    setMenuItems: items => seen.push(items.map(i => `${i.name}:${i.price}`).join(',')), setCategories() {},
  });
  applyMenu({ savedAt: 200, items: [{ name: 'Bia', price: 25000, is_available: true }, { name: 'Ghẹ', price: 1, is_available: false }], categories: [] });
  applyMenu({ savedAt: 100, items: [{ name: 'Bia', price: 20000, is_available: true }], categories: [] });
  applyMenu({ savedAt: 200, items: [{ name: 'Bia', price: 25000, is_available: true }], categories: [] });
  assert.deepEqual(seen, ['Bia:25000']);
  assert.match(page, /applyMenu\(cachedMenu\); \/\/ cache vừa được làm mới/, 'the bill poll applies a refreshed menu too');
  assert.match(page, /useEffect\(\(\) => watchMenuCache\(applyMenu\), \[applyMenu\]\);/);
});
