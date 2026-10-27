import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrintJobBad, isUnresolvedBadJob } from '../src/lib/printJobStatus.mjs';

const NOW = Date.parse('2026-10-27T14:30:00Z');
const at = min => new Date(NOW + min * 60000).toISOString();
const job = (id, status, min, extra = {}) => ({ id, status, created_at: at(min), printer_id: 'nuong', filter_category_ids: ['oc'], only_item_ids: null, order_ids: null, ...extra });
const unresolved = (bad, jobs) => isUnresolvedBadJob(bad, { print_jobs: jobs }, NOW);

test('phiếu chờ quá 60s, phiếu kẹt "đang in" quá 3 phút là lỗi', () => {
  assert.equal(isPrintJobBad(job(1, 'pending', -0.5), NOW), false);
  assert.equal(isPrintJobBad(job(1, 'pending', -2), NOW), true);
  assert.equal(isPrintJobBad(job(1, 'printing', -2), NOW), false);
  assert.equal(isPrintJobBad(job(1, 'printing', -4), NOW), true);
  assert.equal(isPrintJobBad(job(1, 'done', -60), NOW), false);
});

test('phiếu in xong TRƯỚC phiếu lỗi không che phiếu lỗi (vòng 2 kẹt sau vòng 1 in tốt)', () => {
  const round1 = job(1, 'done', -7);
  const round2 = job(2, 'failed', 0);
  assert.equal(unresolved(round2, [round1, round2]), true);
});

test('in lại cùng món, cùng máy SAU phiếu lỗi thì hết báo', () => {
  const failed = job(2, 'failed', -3);
  const again = job(3, 'done', -1);
  assert.equal(unresolved(failed, [failed, again]), false);
});

test('phiếu khác loại cùng máy (tạm tính, quà, danh mục khác) không che phiếu lỗi', () => {
  const failed = job(2, 'failed', -3);
  const bill = job(3, 'done', -1, { filter_category_ids: null, order_ids: ['a', 'b'] });
  const gift = job(4, 'done', -1, { filter_category_ids: null, only_item_ids: ['qua'] });
  const drinks = job(5, 'done', -1, { filter_category_ids: ['nuoc'] });
  const otherPrinter = job(6, 'done', -1, { printer_id: 'xao' });
  assert.equal(unresolved(failed, [failed, bill, gift, drinks, otherPrinter]), true);
});

test('phiếu quà lỗi chỉ hết báo khi đúng món quà đó được in lại', () => {
  const failed = job(2, 'failed', -3, { filter_category_ids: null, only_item_ids: ['qua1'] });
  assert.equal(unresolved(failed, [failed, job(3, 'done', -1, { filter_category_ids: null, only_item_ids: ['qua2'] })]), true);
  assert.equal(unresolved(failed, [failed, job(4, 'done', -1, { filter_category_ids: null, only_item_ids: ['qua1'] })]), false);
});
