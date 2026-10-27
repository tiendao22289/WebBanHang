import test from 'node:test';
import assert from 'node:assert/strict';
import { promoGiftStatus, WHEEL_GIFT_NOTE } from '../src/lib/promoGifts.mjs';

// Món thường tính 1, món có divisor 2 tính nửa món, nước không tính.
const divisorOf = (oi) => ({ oc: 1, half: 2 })[oi.menu_item_id] ?? null;
const dish = (qty, id = 'oc') => ({ menu_item_id: id, quantity: qty, is_gift: false });
const gift = (qty = 1, note = null) => ({ menu_item_id: 'oc', quantity: qty, is_gift: true, note });

test('8 món chưa chọn quà → còn 1 suất, không thiếu', () => {
  const s = promoGiftStatus([dish(8)], 8, divisorOf);
  assert.equal(s.giftCount, 1);
  assert.equal(s.availableGiftSlots, 1);
  assert.equal(s.shortGifts, 0);
  assert.equal(s.missingItems, 0);
  assert.equal(s.hasGiftInBill, false);
});

test('khách bớt 1 món sau khi đã chọn quà → giữ quà, báo thiếu 1 món', () => {
  const s = promoGiftStatus([dish(7), gift()], 8, divisorOf);
  assert.equal(s.availableGiftSlots, 0);
  assert.equal(s.usedGiftSlots, 1);
  assert.equal(s.shortGifts, 1);
  assert.equal(s.missingItems, 1);
  assert.equal(s.hasGiftInBill, true);
});

test('gọi thêm cho đủ lại → hết cảnh báo', () => {
  const s = promoGiftStatus([dish(7), dish(1), gift()], 8, divisorOf);
  assert.equal(s.shortGifts, 0);
  assert.equal(s.missingItems, 0);
  assert.equal(s.availableGiftSlots, 0);
});

test('2 quà mà chỉ còn 13 món → thiếu 1 quà, 3 món', () => {
  const s = promoGiftStatus([dish(13), gift(2)], 8, divisorOf);
  assert.equal(s.giftCount, 1);
  assert.equal(s.shortGifts, 1);
  assert.equal(s.missingItems, 3);
});

test('món nửa suất: thiếu nửa món vẫn báo thiếu 1 món', () => {
  const s = promoGiftStatus([dish(7), dish(1, 'half'), gift()], 8, divisorOf);
  assert.equal(s.qualifyingQty, 7.5);
  assert.equal(s.shortGifts, 1);
  assert.equal(s.missingItems, 1);
});

test('món không tính khuyến mãi không làm đủ quà', () => {
  const s = promoGiftStatus([dish(7), dish(5, 'nuoc'), gift()], 8, divisorOf);
  assert.equal(s.qualifyingQty, 7);
  assert.equal(s.missingItems, 1);
});

test('quà vòng xoay không phải quà 8 tặng 1 — không bị báo thiếu', () => {
  const s = promoGiftStatus([dish(3), gift(2, WHEEL_GIFT_NOTE)], 8, divisorOf);
  assert.equal(s.usedGiftSlots, 0);
  assert.equal(s.hasGiftInBill, false);
  assert.equal(s.shortGifts, 0);
});

test('chưa có số món mỗi suất (threshold 0) → không tính quà', () => {
  const s = promoGiftStatus([dish(20)], 0, divisorOf);
  assert.equal(s.giftCount, 0);
  assert.equal(s.availableGiftSlots, 0);
});
