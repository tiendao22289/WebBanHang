import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import vm from 'node:vm';
import * as lib from '../src/lib/menuAvailability.mjs';

const { isDishOff, isChoiceOff, shiftEndISO, offUntilISO, offLabel, dishChoices, cleanAvailabilityChanges, patchMenuItem, saveAvailability } = lib;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CAT = id(900);
const NOW = Date.parse('2026-10-29T15:00:00Z'); // 22:00 giờ VN
const TONIGHT = '2026-10-29T22:00:00.000Z';     // 5:00 sáng 30/10 giờ VN

const ghe = () => ({
  id: id(1), name: 'Món xào loại', price: 80000, is_available: true, hidden_until: null, category_id: CAT,
  options: [
    { name: 'LOẠI', choices: ['Sò long', 'Ghẹ', 'Móng tay', 'Răng mực'], prices: [80000, 100000, 80000, 80000],
      choiceCategories: [CAT, CAT, CAT, CAT], hiddenChoices: [false, false, false, false], promoDivisors: ['', '', '', ''] },
    { name: 'KHẨU VỊ', choices: ['Bình Thường', 'Làm Cay'], prices: [null, null], choiceCategories: ['', ''] },
    { __promo_divisor: 2 },
  ],
});

test('a dish or choice counts as off exactly when the customer page hides it', () => {
  assert.equal(isDishOff({ is_available: false }, NOW), true);
  assert.equal(isDishOff({ is_available: true, hidden_until: null }, NOW), false);
  assert.equal(isDishOff({ is_available: true, hidden_until: TONIGHT }, NOW), true);
  assert.equal(isDishOff({ is_available: true, hidden_until: '2026-10-29T14:00:00Z' }, NOW), false, 'an old hide has run out');
  assert.equal(isChoiceOff(true, NOW), true);
  assert.equal(isChoiceOff(false, NOW), false);
  assert.equal(isChoiceOff(TONIGHT, NOW), true);
  assert.equal(isChoiceOff('2026-10-29T14:00:00Z', NOW), false);
  assert.equal(isChoiceOff(undefined, NOW), false);

  // Trang khách vẫn dùng đúng các quy tắc này (đổi ở đó thì phải đổi ở menuAvailability.mjs).
  const order = readFileSync(new URL('../src/app/order/page.jsx', import.meta.url), 'utf8');
  assert.match(order, /\.from\('menu_items'\)\.select\('\*, category:categories\(name\)'\)\.eq\('is_available', true\)/);
  assert.match(order, /\.filter\(i => !i\.hidden_until \|\| new Date\(i\.hidden_until\) < now\)/);
  assert.ok(order.split("const isHidden = h === true || (typeof h === 'string' && new Date(h) > new Date());").length >= 3,
    'both choice lists on the customer page hide true / a future time');
});

test('"hết hôm nay" lasts until 5 am Vietnam time, because the shop sells past midnight', () => {
  assert.equal(shiftEndISO(NOW), TONIGHT);
  assert.equal(shiftEndISO(Date.parse('2026-10-29T18:30:00Z')), TONIGHT, '01:30 after midnight → 5:00 the same morning');
  assert.equal(shiftEndISO(Date.parse('2026-10-29T22:00:00Z')), '2026-10-30T22:00:00.000Z', 'at 5:00 sharp → the next morning');
  assert.equal(shiftEndISO(Date.parse('2026-10-29T03:00:00Z')), TONIGHT, '10:00 in the morning → 5:00 tomorrow');
  assert.equal(offLabel(TONIGHT, NOW), 'tắt đến 05:00 30/10');
  assert.equal(offLabel(true, NOW), 'tắt luôn');
  assert.equal(offLabel(false, NOW), '');
});

test('the four ways to turn off match the menu page: end of day, 2 hours, 4 hours, until turned back on', () => {
  assert.equal(offUntilISO('today', NOW), TONIGHT);
  assert.equal(offUntilISO('2h', NOW), '2026-10-29T17:00:00.000Z');
  assert.equal(offUntilISO('4h', NOW), '2026-10-29T19:00:00.000Z');
  assert.equal(offUntilISO('off', NOW), null);
  assert.equal(offLabel(offUntilISO('2h', NOW), NOW), 'tắt đến 00:00 30/10');
});

test('the panel lists every choice with its place in options, skipping the promo row', () => {
  const item = ghe();
  item.options[0].hiddenChoices[1] = TONIGHT;
  const list = dishChoices(item, NOW);
  assert.deepEqual(list.map(c => [c.option, c.optIndex, c.choice, c.index, c.off]), [
    ['LOẠI', 0, 'Sò long', 0, false], ['LOẠI', 0, 'Ghẹ', 1, true], ['LOẠI', 0, 'Móng tay', 2, false],
    ['LOẠI', 0, 'Răng mực', 3, false], ['KHẨU VỊ', 1, 'Bình Thường', 0, false], ['KHẨU VỊ', 1, 'Làm Cay', 1, false],
  ]);
  assert.equal(list[1].label, 'tắt đến 05:00 30/10');
});

test('turning choices off changes only their hidden flag; prices, print categories and the promo row stay', () => {
  const row = ghe();
  const { update, skipped } = patchMenuItem(row, { choices: [
    { option: 'LOẠI', optIndex: 0, choice: 'Ghẹ', index: 1, off: true },
    { option: 'KHẨU VỊ', optIndex: 1, choice: 'Làm Cay', index: 1, off: true },
  ] }, null);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Object.keys(update), ['options'], 'a choice change never touches is_available / hidden_until');
  const expected = ghe();
  expected.options[0].hiddenChoices = [false, true, false, false];
  expected.options[1].hiddenChoices = [false, true];
  assert.deepEqual(update.options, expected.options);
  assert.deepEqual(row, ghe(), 'the row that was read is not changed in place');

  const today = patchMenuItem(ghe(), { choices: [{ option: 'LOẠI', optIndex: 0, choice: 'Ghẹ', index: 1, off: true }] }, TONIGHT);
  assert.equal(today.update.options[0].hiddenChoices[1], TONIGHT, '"hết hôm nay" stores the time, like the menu page');

  const back = ghe();
  back.options[0].hiddenChoices[2] = true;
  const on = patchMenuItem(back, { choices: [{ option: 'LOẠI', optIndex: 0, choice: 'Móng tay', index: 2, off: false }] }, TONIGHT);
  assert.deepEqual(on.update.options[0].hiddenChoices, [false, false, false, false]);
});

test('a choice is found by its name when someone moved it, and reported when it is gone', () => {
  const row = ghe();
  row.options[0].choices = ['Ghẹ', 'Sò long', 'Móng tay', 'Răng mực']; // ai đó vừa đổi thứ tự
  const { update, skipped } = patchMenuItem(row, { choices: [
    { option: 'LOẠI', optIndex: 0, choice: 'Sò long', index: 0, off: true },
    { option: 'LOẠI', optIndex: 0, choice: 'Sò huyết', index: 3, off: true },
  ] }, null);
  assert.deepEqual(update.options[0].hiddenChoices, [false, true, false, false]);
  assert.deepEqual(skipped.map(c => c.choice), ['Sò huyết']);
});

test('dish switches use the same columns as the menu page eye button', () => {
  const change = off => ({ dish: off, choices: [] });
  assert.deepEqual(patchMenuItem(ghe(), change(true), TONIGHT).update, { is_available: true, hidden_until: TONIGHT });
  assert.deepEqual(patchMenuItem(ghe(), change(true), null).update, { is_available: false, hidden_until: null });
  assert.deepEqual(patchMenuItem({ ...ghe(), is_available: false }, change(false), TONIGHT).update, { is_available: true, hidden_until: null });
});

test('the browser body is cleaned: bad ids dropped, changes grouped per dish', () => {
  const c = cleanAvailabilityChanges({
    mode: 'weird',
    dishes: [{ id: id(1), off: true }, { id: 'drop table', off: true }],
    choices: [{ id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Ghẹ', index: 1, off: 1 }, { id: id(2), option: '', choice: 'x' }],
  });
  assert.equal(c.mode, 'today');
  assert.deepEqual(c.items, [{ id: id(1), dish: true, choices: [{ option: 'LOẠI', choice: 'Ghẹ', off: true, optIndex: 0, index: 1 }] }]);
  assert.deepEqual(['off', '2h', '4h', 'today', '3h'].map(mode => cleanAvailabilityChanges({ mode }).mode), ['off', '2h', '4h', 'today', 'today']);
});

// DB giả cho menu_items: eq('options', json) so sánh như jsonb (theo nội dung).
function menuDb(rows, { beforeWrite, guardError } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      assert.equal(table, 'menu_items');
      let op = 'read', values;
      const conds = [];
      const q = {
        select() { return q; },
        update(v) { op = 'update'; values = v; return q; },
        eq(k, v) { conds.push([k, v]); return q; },
        maybeSingle() { return q; },
        then(ok, bad) { return Promise.resolve().then(run).then(ok, bad); },
      };
      const match = r => conds.every(([k, v]) => (k === 'options' ? isDeepStrictEqual(r.options, JSON.parse(v)) : r[k] === v));
      function run() {
        if (op === 'read') return { data: structuredClone(rows.find(match) ?? null), error: null };
        beforeWrite?.(rows);
        if (guardError && conds.some(([k]) => k === 'options')) return { data: null, error: { message: 'operator does not exist: json = unknown' } };
        const hit = rows.filter(match);
        hit.forEach(r => Object.assign(r, structuredClone(values)));
        writes.push({ guarded: conds.some(([k]) => k === 'options'), rows: hit.length });
        return { data: hit.map(r => ({ id: r.id })), error: null };
      }
      return q;
    },
  };
}

test('saving several dishes and choices at once writes each dish once', async () => {
  const rows = [ghe(), { id: id(2), name: 'Nghêu hấp', is_available: true, hidden_until: null, options: [] }];
  const db = menuDb(rows);
  const r = await saveAvailability(db, cleanAvailabilityChanges({
    mode: 'today',
    dishes: [{ id: id(2), off: true }],
    choices: [{ id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Sò long', index: 0, off: true },
              { id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Ghẹ', index: 1, off: true }],
  }), NOW);
  assert.deepEqual(r.saved.map(s => s.name), ['Nghêu hấp', 'Món xào loại']);
  assert.deepEqual([r.failed, r.missing, r.skipped], [[], [], []]);
  assert.equal(r.until, TONIGHT);
  assert.deepEqual(rows[0].options[0].hiddenChoices, [TONIGHT, TONIGHT, false, false]);
  assert.deepEqual([rows[1].is_available, rows[1].hidden_until], [true, TONIGHT]);
  assert.equal(db.writes.length, 2);
});

test('"2 tiếng" hides a dish and a choice for two hours from the moment of saving', async () => {
  const rows = [ghe()];
  const r = await saveAvailability(menuDb(rows), cleanAvailabilityChanges({
    mode: '2h', dishes: [{ id: id(1), off: true }],
    choices: [{ id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Ghẹ', index: 1, off: true }],
  }), NOW);
  const twoHours = '2026-10-29T17:00:00.000Z';
  assert.equal(r.until, twoHours);
  assert.deepEqual([rows[0].is_available, rows[0].hidden_until], [true, twoHours]);
  assert.equal(rows[0].options[0].hiddenChoices[1], twoHours);
  assert.equal(isDishOff(rows[0], Date.parse(twoHours) - 1), true);
  assert.equal(isDishOff(rows[0], Date.parse(twoHours) + 1), false, 'back on sale by itself after two hours');
});

test('when someone edits the dish between read and write, the save reads again and keeps their edit', async () => {
  const rows = [ghe()];
  let once = true;
  const db = menuDb(rows, {
    beforeWrite: all => { if (once) { once = false; all[0].options[0].prices[1] = 120000; } }, // trang Thực đơn vừa đổi giá Ghẹ
  });
  const r = await saveAvailability(db, cleanAvailabilityChanges({
    mode: 'off', choices: [{ id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Răng mực', index: 3, off: true }],
  }), NOW);
  assert.deepEqual(r.saved.map(s => s.id), [id(1)]);
  assert.deepEqual(db.writes, [{ guarded: true, rows: 0 }, { guarded: true, rows: 1 }], 'first write is refused, second one lands');
  assert.equal(rows[0].options[0].prices[1], 120000, 'the other edit is kept');
  assert.deepEqual(rows[0].options[0].hiddenChoices, [false, false, false, true]);
});

test('a dish that keeps changing is reported as not saved instead of overwriting', async () => {
  const rows = [ghe()];
  const db = menuDb(rows, { beforeWrite: all => { all[0].options[0].prices[0] += 1000; } });
  const r = await saveAvailability(db, cleanAvailabilityChanges({
    choices: [{ id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Ghẹ', index: 1, off: true }],
  }), NOW);
  assert.deepEqual(r.saved, []);
  assert.deepEqual(r.failed, [{ id: id(1), name: 'Món xào loại' }]);
  assert.deepEqual(rows[0].options[0].hiddenChoices, [false, false, false, false]);
});

test('if the database cannot run the "unchanged" check, it still saves from a fresh read', async () => {
  const rows = [ghe()];
  const db = menuDb(rows, { guardError: true });
  const r = await saveAvailability(db, cleanAvailabilityChanges({
    choices: [{ id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Ghẹ', index: 1, off: true }],
  }), NOW);
  assert.equal(r.saved.length, 1);
  assert.deepEqual(db.writes, [{ guarded: false, rows: 1 }]);
  assert.equal(rows[0].options[0].hiddenChoices[1], TONIGHT);
});

test('deleted dishes and renamed choices are reported back', async () => {
  const rows = [ghe()];
  const r = await saveAvailability(menuDb(rows), cleanAvailabilityChanges({
    dishes: [{ id: id(5), off: true }],
    choices: [{ id: id(1), option: 'LOẠI', optIndex: 0, choice: 'Sò huyết', index: 0, off: true }],
  }), NOW);
  assert.deepEqual(r.missing, [id(5)]);
  assert.deepEqual(r.skipped, [{ id: id(1), name: 'Món xào loại', option: 'LOẠI', choice: 'Sò huyết' }]);
  assert.deepEqual(r.saved, []);
  assert.deepEqual(r.failed, []);
});

const routeSource = readFileSync(new URL('../src/app/api/admin/menu-availability/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
function loadRoute(rows, session = { code: 200, user: { id: id(77), role: 'staff' } }) {
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${routeSource}\n({ POST })`, {
    NextResponse, ...lib, JSON, console: { info() {}, error() {} },
    getStaffSession: async () => session, staffDatabase: () => menuDb(rows),
  });
}
const post = async (api, body) => JSON.parse(JSON.stringify(await api.POST({ json: async () => body })));

test('the route needs a staff login and at least one change', async () => {
  const rows = [ghe()];
  assert.equal((await post(loadRoute(rows, { code: 401 }), { dishes: [{ id: id(1), off: true }] })).status, 401);
  assert.equal((await post(loadRoute(rows), { dishes: [] })).status, 400);
  const r = await post(loadRoute(rows), { mode: 'off', dishes: [{ id: id(1), off: true }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual([rows[0].is_available, rows[0].hidden_until], [false, null]);
  assert.deepEqual(rows[0].options, ghe().options, 'turning a whole dish off leaves its choices alone');
});
