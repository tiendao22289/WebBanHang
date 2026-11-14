import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dishesDone, dishesLeft, promoHintText, promoStripState, promoStripText } from '../src/lib/promoStrip.mjs';

// Thanh "8 tặng 1" ở đáy trang gọi món, thay nút tròn nổi (nút đó đè lên dấu "+" của món và khách
// không nhận ra là nút bấm). Số vào là số trang đã tính: qualifyingQty, giftCount, availableGiftSlots.
const say = (qualifyingQty, giftCount, availableGiftSlots, threshold = 8) => {
  const state = promoStripState({ qualifyingQty, threshold, giftCount, availableGiftSlots });
  const t = promoStripText(state, threshold);
  return { kind: state.kind, text: `${t.lead}${t.strong}${t.tail}`, action: t.action, open: t.open, progress: state.progress };
};

test('before the first gift the strip says how many more dishes and fills a bar', () => {
  assert.deepEqual(say(0, 0, 0), { kind: 'progress', text: 'Gọi đủ 8 món được tặng 1 món', action: 'Xem quà', open: 'preview', progress: 0 });
  assert.deepEqual(say(5, 0, 0), { kind: 'progress', text: 'Gọi thêm 3 món được tặng 1 món', action: 'Xem quà', open: 'preview', progress: 5 / 8 });
  assert.equal(say(7.5, 0, 0).text, 'Gọi thêm 1 món được tặng 1 món', 'half a dish left (half-portion dish) → 1 more dish, never "0,5"');
  assert.equal(say(4, 0, 0, 10).text, 'Gọi thêm 6 món được tặng 1 món', 'the shop threshold, not a fixed 8');
});

test('an earned gift turns the strip into a "Chọn quà" button that opens the gift picker', () => {
  assert.deepEqual(say(8, 1, 1), { kind: 'ready', text: 'Quý khách được tặng 1 món', action: 'Chọn quà', open: 'gift', progress: 1 });
  assert.equal(say(17, 2, 2).text, 'Quý khách được tặng 2 món');
  assert.equal(say(19, 2, 1).text, 'Quý khách được tặng 1 món', 'one of two gifts already chosen');
});

test('after every gift is chosen the strip counts toward the next one', () => {
  assert.deepEqual(say(8, 1, 0), { kind: 'chosen', text: 'Đã chọn 1 quà · gọi thêm 8 món được tặng tiếp', action: 'Xem quà', open: 'preview', progress: 0 });
  const two = say(19, 2, 0);
  assert.equal(two.text, 'Đã chọn 2 quà · gọi thêm 5 món được tặng tiếp');
  assert.equal(two.progress, 3 / 8);
});

test('odd inputs never show a negative or broken number', () => {
  assert.equal(dishesLeft(1 / 3), 1);
  assert.equal(dishesLeft(3), 3);
  assert.equal(dishesLeft(-2), 0);
  assert.equal(dishesLeft(undefined), 0);
  assert.equal(dishesDone(7.5), 7);
  assert.equal(dishesDone(0.9999999), 1, 'float noise is not a missing dish');
  assert.equal(say(0, 0, 0, 0).text, 'Gọi đủ 8 món được tặng 1 món', 'threshold missing → 8');
});

// Chủ quán: ghi "món" cho khách dễ hiểu, không ghi "điểm".
test('the hint after adding a dish counts dishes, never points', () => {
  assert.equal(promoHintText({ left: 3, nextGift: 1 }), 'Còn thiếu 3 món nữa là được tặng 1 món! 🔥');
  assert.equal(promoHintText({ left: 2.5, nextGift: 1 }), 'Còn thiếu 3 món nữa là được tặng 1 món! 🔥');
  assert.equal(promoHintText({ left: 5, nextGift: 2 }), 'Còn thiếu 5 món nữa là được tặng thêm 1 món! 🔥');
  assert.equal(promoHintText({ left: 0.5, nextGift: 1, partial: { name: 'Sò điệp', needed: 1 } }),
    'Thêm 1 Sò điệp nữa cho đủ món, hoặc gọi món khác tuỳ ý nhé! 🔥');
  assert.equal(promoHintText({ left: 2.5, nextGift: 1, partial: { name: 'Sò điệp', needed: 1 } }), 'Còn thiếu 3 món nữa là được tặng 1 món! 🔥',
    'the half-portion tip only when less than 1 dish is missing');
});

// ── Trang gọi món dùng thanh này ở đáy, không còn nút tròn nổi ──
const page = readFileSync(new URL('../src/app/order/page.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/app/order/order.css', import.meta.url), 'utf8');

test('the order page shows the strip in the bottom dock above the Send button, even with an empty cart', () => {
  assert.doesNotMatch(page, /DraggablePromoBubble/, 'the floating bubble is gone');
  const dock = page.slice(page.indexOf('Đáy trang: thanh "8 tặng 1"'), page.indexOf('─── Reset Confirm Modal ───'));
  assert.match(dock, /\{\(totalItems > 0 \|\| promoConfig\.enabled\) && \(/, 'shown with an empty cart while the promotion is on');
  assert.ok(dock.indexOf('<PromoStrip') > 0 && dock.indexOf('<PromoStrip') < dock.indexOf('Nút Chọn Lại'), 'strip sits above the cart buttons');
  assert.match(dock, /onOpenGift=\{\(\) => setShowGiftModal\(true\)\}/);
  assert.match(dock, /callout=\{cartReminder && !showCart \? null : promoCallout\}/, 'the "chưa gửi món" reminder wins');
  assert.match(css, /\.co-content \{[^}]*padding: 0 0 calc\(170px/, 'the last dish is not hidden behind the dock');
  // Đáy trang có pointer-events: none + z-index 90: bảng "Xem quà" để trong đó thì bấm xuyên qua và bị thanh trên đè.
  const strip = page.slice(page.indexOf('const PromoStrip = ('), page.indexOf('const DraggableFeedbackBubble = ('));
  assert.match(strip, /\{showPreview && createPortal\(/);
  assert.match(strip, /<\/div>,\s*document\.body\s*\)\}/);
});
