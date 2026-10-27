import test from 'node:test';
import assert from 'node:assert/strict';
import { KITCHEN_GRACE_MS, resolvePrintCategory, kitchenPrinterFor, isKitchenItem, unsentKitchenItems, nextKitchenCheckIn } from '../src/lib/kitchenTicket.mjs';

// Giống máy in thật của quán: máy quầy (mặc định + hoá đơn) nhận nước/bia, 2 máy bếp.
const PRINTERS = [
  { id: 'xao', is_active: true, is_default: false, is_bill_printer: false, sort_order: 30, printer_categories: [{ category_id: 'cat-xao' }, { category_id: 'cat-chao' }] },
  { id: 'quay', is_active: true, is_default: true, is_bill_printer: true, sort_order: 1, printer_categories: [{ category_id: 'cat-nuoc' }, { category_id: 'cat-bia' }] },
  { id: 'nuong', is_active: true, is_default: false, is_bill_printer: false, sort_order: 2, printer_categories: [{ category_id: 'cat-nuong' }] },
];
const OC_OPTIONS = [{ name: 'Kiểu', choices: ['Hấp', 'Nướng'], choiceCategories: ['cat-xao', 'cat-nuong'] }];
const NOW = Date.parse('2026-10-28T12:00:00Z');
const ago = s => new Date(NOW - s * 1000).toISOString();
const item = (id, category, extra = {}) => ({
  id, menu_item_id: `m-${id}`, menu_item: { category_id: category }, item_options: [], quantity: 1,
  kitchen_sent_at: null, created_at: ago(60), ...extra,
});
const optionsOf = it => (it.menu_item_id === 'm-oc' ? OC_OPTIONS : []);

test('món nướng / xào đi máy bếp; nước, bia, khăn (máy quầy in hoá đơn) không phải món bếp', () => {
  assert.equal(kitchenPrinterFor('cat-nuong', PRINTERS).id, 'nuong');
  assert.equal(kitchenPrinterFor('cat-chao', PRINTERS).id, 'xao');
  assert.equal(kitchenPrinterFor('cat-bia', PRINTERS), null);
  assert.equal(kitchenPrinterFor(null, PRINTERS), null); // khăn: không danh mục → máy mặc định ở quầy
  assert.equal(kitchenPrinterFor('cat-la', PRINTERS), null);
});

test('loại đã chọn quyết định máy: Ốc hấp → máy xào, Ốc nướng → máy nướng', () => {
  const hap = item('oc', null, { menu_item_id: 'm-oc', item_options: [{ name: 'Kiểu', choice: 'Hấp' }] });
  const nuong = { ...hap, item_options: [{ name: 'Kiểu', choice: 'Nướng' }] };
  assert.equal(kitchenPrinterFor(resolvePrintCategory(hap, OC_OPTIONS), PRINTERS).id, 'xao');
  assert.equal(kitchenPrinterFor(resolvePrintCategory(nuong, OC_OPTIONS), PRINTERS).id, 'nuong');
  assert.equal(isKitchenItem(hap, PRINTERS, OC_OPTIONS), true);
  assert.equal(isKitchenItem({ ...hap, item_options: [] }, PRINTERS, OC_OPTIONS), false); // chưa chọn loại
});

test('máy bếp tắt thì món về máy mặc định (quầy) → không đòi báo bếp', () => {
  const off = PRINTERS.map(p => (p.id === 'nuong' ? { ...p, is_active: false } : p));
  assert.equal(kitchenPrinterFor('cat-nuong', off), null);
  assert.equal(kitchenPrinterFor('cat-xao', off).id, 'xao');
});

test('"chưa báo bếp": chỉ món bếp không có dấu, bỏ qua món vừa gọi trong lúc chờ phiếu', () => {
  const items = [
    item('a', 'cat-nuong'),
    item('b', 'cat-nuong', { kitchen_sent_at: ago(30) }),
    item('c', 'cat-bia'),
    item('d', 'cat-xao', { created_at: ago(5) }),
    item('e', null, { menu_item_id: null, unit_price: -20000 }), // dòng giảm giá
  ];
  assert.deepEqual(unsentKitchenItems(items, PRINTERS, optionsOf, NOW).map(i => i.id), ['a']);
  assert.deepEqual(unsentKitchenItems(items, PRINTERS, optionsOf, NOW + KITCHEN_GRACE_MS).map(i => i.id), ['a', 'd']);
  assert.equal(nextKitchenCheckIn(items, NOW), KITCHEN_GRACE_MS - 5000 + 50);
  assert.equal(nextKitchenCheckIn(items, NOW + KITCHEN_GRACE_MS), null);
});

test('DB chưa cài migration (không có cột kitchen_sent_at) thì không báo gì', () => {
  const { kitchen_sent_at, ...old } = item('a', 'cat-nuong');
  assert.deepEqual(unsentKitchenItems([old], PRINTERS, optionsOf, NOW), []);
  assert.equal(nextKitchenCheckIn([old], NOW), null);
});
