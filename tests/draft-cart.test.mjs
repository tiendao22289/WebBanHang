import test from 'node:test';
import assert from 'node:assert/strict';
import { addDraftLine, decreaseDraftLine, setDraftItemTotal, removeSentLines, updateDraftOf } from '../src/lib/draftCart.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bia = (qty = 1, extra = {}) => ({ menuItemId: 'bia', qty, options: [], note: '', price: 17000, ...extra });

test('mỗi dòng có line_id dạng uuid; bấm thêm cùng món thì cộng vào dòng đó', () => {
  let lines = addDraftLine([], bia());
  lines = addDraftLine(lines, bia(2));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 3);
  assert.match(lines[0].lineId, UUID);
});

test('khác giá / khác kiểu chế biến thì tách dòng', () => {
  let lines = addDraftLine([], bia());
  lines = addDraftLine(lines, bia(1, { price: 20000 }));
  lines = addDraftLine(lines, bia(1, { options: [{ name: 'Loại', choice: 'Lớn' }] }));
  assert.equal(lines.length, 3);
});

test('dòng đang gửi bị khoá: bấm thêm mở dòng mới, gửi xong chỉ bỏ dòng đã gửi', () => {
  const lines = addDraftLine([], bia(2));
  const sent = lines.map(d => d.lineId);
  const locked = new Set(sent);
  const during = addDraftLine(lines, bia(1), locked);
  assert.deepEqual(during.map(d => d.qty), [2, 1]);
  assert.notEqual(during[1].lineId, during[0].lineId);
  const after = removeSentLines(during, sent);
  assert.deepEqual(after.map(d => d.qty), [1]);
});

test('bớt món không đụng dòng đang gửi', () => {
  const lines = addDraftLine([], bia(2));
  const sending = new Set([lines[0].lineId]);
  assert.equal(decreaseDraftLine(lines, 'bia', sending), lines);
  assert.deepEqual(decreaseDraftLine(lines, 'bia').map(d => d.qty), [1]);
  assert.deepEqual(decreaseDraftLine(decreaseDraftLine(lines, 'bia'), 'bia'), []);
});

test('gõ tổng số lượng cho món có 2 kiểu: chỉ thêm / bớt phần chênh lệch', () => {
  let lines = addDraftLine([], bia(2, { menuItemId: 'oc', options: [{ name: 'Kiểu', choice: 'Hấp' }] }));
  lines = addDraftLine(lines, bia(1, { menuItemId: 'oc', options: [{ name: 'Kiểu', choice: 'Nướng' }] }));
  const down = setDraftItemTotal(lines, 'oc', 2);
  assert.deepEqual(down.map(d => [d.options[0].choice, d.qty]), [['Hấp', 2]]);
  const up = setDraftItemTotal(lines, 'oc', 5);
  assert.deepEqual(up.map(d => [d.options[0].choice, d.qty]), [['Hấp', 2], ['Nướng', 3]]);
  assert.deepEqual(setDraftItemTotal(lines, 'oc', 0), []);
});

test('giỏ nháp giữ riêng từng bàn', () => {
  let drafts = updateDraftOf({}, 'ban5', cur => addDraftLine(cur, bia(2)));
  drafts = updateDraftOf(drafts, 'ban9', cur => addDraftLine(cur, bia(1, { menuItemId: 'coca' })));
  assert.deepEqual(drafts.ban5.map(d => [d.menuItemId, d.qty]), [['bia', 2]]);
  assert.deepEqual(drafts.ban9.map(d => [d.menuItemId, d.qty]), [['coca', 1]]);
  drafts = updateDraftOf(drafts, 'ban9', []);
  assert.deepEqual(Object.keys(drafts), ['ban5']);
  assert.equal(updateDraftOf(drafts, 'ban5', cur => cur), drafts);
});
