import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCategories, noteOtherCosts, otherCostRows, OTHER_ID } from '../src/lib/noteCategories.mjs';
import { dailyReportText, noteLineCost, shoppingParts, summarizeItems, summarizeMonth } from '../src/lib/ownerFinance.mjs';

const cats = [{ id: 'xang', name: 'Xăng xe' }, { id: 'sua', name: 'Sửa chữa' }];
const note = (items, at = '2026-10-24T03:00:00Z') => ({
  note_type: 'expense', created_at: at, amount: items.reduce((s, i) => s + noteLineCost(i), 0), debt: 0,
  content: JSON.stringify({ type: 'structured_expense', items }),
});

test('kinds: clean names, keep ids, "Khác" is built in; costs of a note by kind never exceed the note', () => {
  let n = 0;
  const out = cleanCategories([{ id: 'xang', name: 'Xăng xe' }, { name: 'xăng  xe' }, { name: 'khác' }, { name: 'In ấn' }, { id: 'bad id', name: 'Đồ dùng' }], () => `c${++n}`);
  assert.deepEqual(out, [{ id: 'xang', name: 'Xăng xe' }, { id: 'c1', name: 'In ấn' }, { id: 'c2', name: 'Đồ dùng' }]);
  const items = [{ name: 'Ốc', price: '300k' }, { name: 'Đổ xăng', price: '50k', category: 'xang' }, { name: 'Vòi nước', price: '80k', category: 'gone' }];
  assert.deepEqual(noteOtherCosts(items, 430000, noteLineCost), { xang: 50000, gone: 80000 });
  assert.deepEqual(noteOtherCosts(items, 100000, noteLineCost), { xang: 50000, gone: 50000 }, 'capped by the saved total');
  assert.deepEqual(otherCostRows({ xang: 50000, gone: 80000 }, cats), [{ id: 'xang', name: 'Xăng xe', amount: 50000 }, { id: OTHER_ID, name: 'Khác', amount: 80000 }],
    'a deleted kind counts as "Khác"');
});

test('the finance book keeps the same total but shows Sổ tay "Khác" lines apart from shopping for the dishes', () => {
  const notes = [note([{ name: 'Ốc hương', qty: '2', price: '200k' }, { name: 'Đổ xăng', price: '50k', category: 'xang' }]),
    note([{ name: 'Sửa máy bơm', price: '150k', category: 'sua' }, { name: 'Hàu', qty: '3', price: '50k' }])];
  const s = summarizeMonth({ month: '2026-10', notes, today: '2026-10-24', startDate: '2026-10-01' });
  const day = s.days.find(d => d.date === '2026-10-24');
  assert.equal(day.purchases, 750000, 'profit still counts every line');
  assert.deepEqual(day.notesOther, { xang: 50000, sua: 150000 });
  assert.deepEqual(s.totals.notesOther, { xang: 50000, sua: 150000 });
  assert.deepEqual(shoppingParts(day, cats).map(p => [p.name, p.amount]), [['Đi chợ', 550000], ['Xăng xe', 50000], ['Sửa chữa', 150000]]);

  const text = dailyReportText({ day, noteCategories: cats });
  assert.match(text, /Chi: 750\.000đ \(đi chợ 550\.000đ, xăng xe 50\.000đ, sửa chữa 150\.000đ/);

  const items = summarizeItems({ notes, noteCategories: cats, groups: [{ id: 'g', name: 'Ốc hương' }] });
  assert.deepEqual(items.bought.map(b => b.name), ['Ốc hương', 'Hàu'], '"Khác" lines are not goods for dishes');
  assert.deepEqual(items.other.map(g => [g.name, g.amount, g.items.map(i => i.name)]), [['Sửa chữa', 150000, ['Sửa máy bơm']], ['Xăng xe', 50000, ['Đổ xăng']]]);
  assert.equal(items.totals.otherCost, 200000);
  assert.equal(items.totals.cost, 750000);
  assert.equal(items.totals.ungroupedCost, 150000, 'only Hàu is shopping without a group');
});
