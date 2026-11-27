// Ngày nghỉ trong bảng lương: quán mở mà không chấm công (có đơn hay không) — để chủ thấy ngày nào không có lương.
import test from 'node:test';
import assert from 'node:assert/strict';
import { offDays } from '../src/lib/payroll.mjs';

test('open days without any clocking are days off; closed days, today and later are not', () => {
  const worked = ['2026-11-01', '2026-11-02', '2026-11-04'];
  assert.deepEqual(offDays({ key: '2026-11', worked, closedDays: ['2026-11-03'], until: '2026-11-07' }), ['2026-11-05', '2026-11-06'],
    'the 3rd is a shop closed day (paid, not a day off); the 7th is today, still running');
  assert.deepEqual(offDays({ key: '2026-11', worked, closedDays: [{ day: '2026-11-03' }], until: '2026-11-04' }), [], 'closed days may come as rows');
});

test('only days the person was employed count', () => {
  const employed = { from: '2026-11-10', to: '2026-11-20', away: [['2026-11-12', '2026-11-15']] };
  assert.deepEqual(offDays({ key: '2026-11', worked: ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-15'], employed, until: '2026-11-30' }),
    ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'], 'before hire, the left-and-came-back gap and after the last day are not days off');
});

test('a past month counts every open day', () => {
  const all = offDays({ key: '2026-02', worked: [], closedDays: ['2026-02-14'] });
  assert.equal(all.length, 27);
  assert.ok(!all.includes('2026-02-14'));
});
