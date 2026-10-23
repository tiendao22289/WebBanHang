import test from 'node:test';
import assert from 'node:assert/strict';
import { lineWarnings, noteTotals, normalizePriceInput, parsePrice, parseQty } from '../src/lib/notesMath.mjs';

test('prices are read the way the shop writes them', () => {
  for (const [text, value] of [
    ['250k', 250000], ['250K', 250000], ['250.000', 250000], ['250000', 250000], ['1.200k', 1200000], ['1,5k', 1500],
    ['1tr2', 1200000], ['1tr', 1000000], ['1,5tr', 1500000], ['2tr250', 2250000], ['85k/kg', 85000], ['250', 250],
    ['250000k', 250000], ['', 0], ['abc', 0], ['1.250.000', 1250000],
  ]) assert.equal(parsePrice(text), value, text);
});

test('quantity takes the first number only and accepts a decimal comma', () => {
  for (const [text, value] of [
    ['2kg', 2], ['2,5kg', 2.5], ['2.5 ký', 2.5], ['0,5', 0.5], ['1/2', 0.5], ['1 thùng 24 lon', 1], ['10 bao (5kg)', 10],
    ['', 1], ['k', 1], ['0', 1], ['3 ký', 3],
  ]) assert.equal(parseQty(text), value, text);
});

test('the price box only adds "k" to small numbers', () => {
  assert.equal(normalizePriceInput('250'), '250k');
  assert.equal(normalizePriceInput('250000'), '250000');
  assert.equal(normalizePriceInput('250k'), '250k');
  assert.equal(normalizePriceInput('250.000'), '250.000');
});

test('suspicious lines are flagged instead of silently mis-counted', () => {
  assert.match(lineWarnings({ qty: '1 thùng 24 lon', price: '340k' })[0], /nhiều số/);
  assert.match(lineWarnings({ qty: '1', price: '250' })[0], /thiếu chữ "k"/);
  assert.deepEqual(lineWarnings({ qty: '2kg', price: '220k' }), []);
});

test('note totals: paid now, bought on credit, and later debt payments', () => {
  const items = [
    { name: 'Ốc hương', qty: '2kg', price: '220k', paymentStatus: 'full' },
    { name: 'Sò điệp', qty: '3kg', price: '90k', paymentStatus: 'debt', creditor: 'Chị Lan', debtAmount: '' },
    { name: 'Mực', qty: '2,5kg', price: '200k', paymentStatus: 'debt', debtAmount: '300.000' },
    { name: 'Tiền rau', qty: '', price: '60k', paymentStatus: 'full' },
    { name: '', qty: '9', price: '999k' },
    { name: 'Gia vị', qty: '', price: '' },
  ];
  assert.deepEqual(
    (({ total, paid, debt, debtLeft }) => ({ total, paid, debt, debtLeft }))(noteTotals(items)),
    { total: 440000 + 270000 + 500000 + 60000, paid: 440000 + 200000 + 60000, debt: 270000 + 300000, debtLeft: 570000 });

  // Sò điệp trả xong: vẫn là hàng mua nợ lúc mua, chỉ còn nợ giảm.
  items[1] = { ...items[1], paymentStatus: 'full', paid_amount: 270000 };
  const after = noteTotals(items);
  assert.equal(after.debt, 570000, 'paying a debt later does not change what was owed at purchase');
  assert.equal(after.debtLeft, 300000);
  assert.equal(after.paid, 700000);
});
