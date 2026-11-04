import test from 'node:test';
import assert from 'node:assert/strict';
import { lunarDaysBetween, toLunar } from '../src/lib/lunar.mjs';
import { shopClosedDays } from '../src/lib/payroll.mjs';

test('Vietnamese lunar dates match the known calendar: Tết, Trung thu, leap months', () => {
  const l = d => { const x = toLunar(d); return `${x.day}/${x.month}${x.leap ? 'N' : ''}/${x.year}`; };
  assert.equal(l('2024-02-10'), '1/1/2024', 'Tết Giáp Thìn');
  assert.equal(l('2025-01-29'), '1/1/2025', 'Tết Ất Tỵ');
  assert.equal(l('2026-02-17'), '1/1/2026', 'Tết Bính Ngọ');
  assert.equal(l('2027-02-06'), '1/1/2027', 'Tết Đinh Mùi');
  assert.equal(l('2025-10-06'), '15/8/2025', 'Trung thu 2025');
  assert.equal(l('2026-09-25'), '15/8/2026', 'Trung thu 2026');
  assert.equal(l('2023-03-22'), '1/2N/2023', 'tháng 2 nhuận 2023');
  assert.equal(l('2025-07-25'), '1/6N/2025', 'tháng 6 nhuận 2025');
  assert.equal(l('2026-02-16'), '29/12/2025', 'giao thừa');
});

test('mùng 1 and rằm each month from November 2026, leap months included', () => {
  assert.deepEqual(lunarDaysBetween('2026-11-01', '2027-01-31', [1, 15]).map(x => x.date),
    ['2026-11-09', '2026-11-23', '2026-12-09', '2026-12-23', '2027-01-08', '2027-01-22']);
  assert.deepEqual(lunarDaysBetween('2025-07-20', '2025-08-25', [1, 15]).map(x => `${x.date} ${x.lunar.day}/${x.lunar.month}${x.lunar.leap ? 'N' : ''}`),
    ['2025-07-25 1/6N', '2025-08-08 15/6N', '2025-08-23 1/7'], 'the leap 6th month also closes');
  assert.deepEqual(lunarDaysBetween('2026-11-01', '2026-11-30', []), []);
});

test('shop closed days: the lunar schedule by period, days added by hand, and open days the owner marks', () => {
  const rules = [{ valid_from: '2026-11-01', lunar_days: [1, 15] }, { valid_from: '2026-12-15', lunar_days: [2] }];
  const rows = [{ day: '2026-11-30', note: 'sửa bếp', skip: false }, { day: '2026-11-23', skip: true }, { day: '2027-03-01', skip: false }];
  const days = shopClosedDays({ rules, rows, from: '2026-11-01', to: '2027-01-31' });
  assert.deepEqual(days.map(d => [d.day, d.source]), [
    ['2026-11-09', 'lunar'], ['2026-11-30', 'manual'], ['2026-12-09', 'lunar'], ['2027-01-09', 'lunar'],
  ], 'rằm 23/11 marked open; from 15/12 only mùng 2 (9/1 = 2/12 âm; 2/11 âm = 10/12 is before the change); a day outside the range is ignored');
  assert.equal(days.find(d => d.day === '2026-11-30').note, 'sửa bếp');
  const all = shopClosedDays({ rules, rows, from: '2026-11-01', to: '2026-11-30', withSkipped: true });
  assert.deepEqual(all.map(d => [d.day, !!d.skipped]), [['2026-11-09', false], ['2026-11-23', true], ['2026-11-30', false]]);
  assert.deepEqual(shopClosedDays({ rules: [{ valid_from: '2026-11-01', lunar_days: [1, 15] }, { valid_from: '2026-11-15', lunar_days: [] }], from: '2026-11-01', to: '2026-11-30' }).map(d => d.day),
    ['2026-11-09'], 'stopped from 15/11');
});
