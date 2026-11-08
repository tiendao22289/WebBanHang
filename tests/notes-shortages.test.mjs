import test from 'node:test';
import assert from 'node:assert/strict';
import { noteMoney, openLeftovers, openShortages, planOffsets } from '../src/lib/notesDebts.mjs';

// Phiếu đi chợ: tiền chủ giao, tiền đã chi (amount), các sổ tiền dư / bù trong content.
const note = (id, staff, at, given, spent, extra = {}) => ({ id, staff_id: staff, note_type: 'expense', created_at: at, amount: spent, debt: 0,
  staff: { full_name: staff }, content: JSON.stringify({ type: 'structured_expense', items: [], input_amount: given, ...extra }) });

test('a note that went over the money given shows what the buyer added; money kept back from a later leftover settles it', () => {
  const pays = [{ paid_from_note_id: 'n6', amount: 2006000 }, { paid_from_note_id: 'n8', amount: 763000 }];
  const short = note('n6', 'thuy', '2026-11-06T15:40:00Z', 7000000, 5310000); // bỏ thêm 316k
  const left = note('n8', 'thuy', '2026-11-08T16:10:00Z', 7600000, 5895000); // thừa 942k
  assert.deepEqual([noteMoney(short, pays).short, noteMoney(left, pays).left], [316000, 942000]);
  assert.deepEqual(openShortages([short, left], pays, '2026-11-01').map(s => [s.note_id, s.short]), [['n6', 316000]]);

  const settledShort = note('n6', 'thuy', '2026-11-06T15:40:00Z', 7000000, 5310000, { short_settled: [{ amount: 316000, from_note_id: 'n8' }] });
  const keptLeft = note('n8', 'thuy', '2026-11-08T16:10:00Z', 7600000, 5895000, { offset_out: [{ amount: 316000, to_note_id: 'n6' }], returned_logs: [{ amount: 626000 }] });
  assert.deepEqual([noteMoney(settledShort, pays).short, noteMoney(keptLeft, pays).left], [0, 0], 'both settled: nothing left to hand over');
  assert.deepEqual(openShortages([settledShort], pays, '2026-11-01'), []);
  assert.deepEqual(openLeftovers([keptLeft], pays, '2026-10-01'), []);
  assert.deepEqual(openShortages([short], pays, '2026-11-07'), [], 'shortages before the start date are not tracked');
});

test('handing back leftovers keeps back only the same buyer\'s top-ups, oldest first', () => {
  const shortages = [
    { note_id: 's1', staff_id: 'thuy', short: 100000 },
    { note_id: 's2', staff_id: 'thuy', short: 300000 },
    { note_id: 's3', staff_id: 'lan', short: 50000 },
  ];
  const { offsets, returns } = planOffsets([{ id: 'a', staff_id: 'thuy', amount: 250000 }, { id: null, staff_id: 'thuy', amount: 500000 }], shortages);
  assert.deepEqual(offsets, [
    { from_note_id: 'a', to_note_id: 's1', amount: 100000 },
    { from_note_id: 'a', to_note_id: 's2', amount: 150000 },
    { from_note_id: null, to_note_id: 's2', amount: 150000 },
  ]);
  assert.deepEqual(returns.map(r => [r.id, r.amount]), [['a', 0], [null, 350000]], 'Lan\'s top-up is not paid out of Thuỳ\'s leftover');
});
