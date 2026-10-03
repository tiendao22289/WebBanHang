import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = async file => import(`data:text/javascript;base64,${Buffer.from(readFileSync(new URL(file, import.meta.url), 'utf8')).toString('base64')}`);
const { isPaidTableCheckout } = await load('../src/lib/tableCheckout.js');
const { statsQuotaProgress } = await load('../src/lib/statsQuotaDisplay.js');
const source = readFileSync(new URL('../src/lib/tableStatsQuota.js', import.meta.url), 'utf8');

function qrHarness(result, account = { id: 'B', is_active: true }) {
  const calls = [];
  const query = { select: () => query, eq: (column, value) => { calls.push(['account', value]); return query; },
    single: async () => ({ data: account, error: null }) };
  const run = vm.runInNewContext(`${source.replace(/^import .*$/gm, '').replace('export async function', 'async function')}; prepareTableStatsPayment`, {
    supabase: { rpc: async (name, args) => { calls.push([name, args]); return result; }, from: () => query },
    getActiveAccount: async amount => { calls.push(['legacy', amount]); return { account: { id: 'legacy' } }; },
  });
  return { run: () => run({ hostId: 'host', total: 300000, bills: [{ id: 'order' }] }), calls };
}

test('QR uses the server-selected B account before displaying the code', async () => {
  const h = qrHarness({ data: { enabled: true, success: true, selected: false, account_id: 'B' }, error: null });
  const result = await h.run();
  assert.equal(result.account.id, 'B'); assert.equal(result.shouldHideStats, true);
  assert.equal(h.calls[0][0], 'prepare_stats_payment');
  assert.equal(h.calls[0][1].p_table_id, 'host');
  assert.equal(h.calls[0][1].p_payment_method, 'transfer');
  assert.equal(h.calls.some(call => call[0] === 'legacy'), false);
});

test('uninstalled or disabled feature retains legacy routing', async () => {
  for (const result of [{ error: { code: 'PGRST202' } }, { data: { enabled: false }, error: null }]) {
    const h = qrHarness(result);
    assert.equal((await h.run()).account.id, 'legacy');
    assert.equal(h.calls.at(-1)[0], 'legacy');
  }
});

test('network errors, changed bills and inactive accounts stop QR creation', async () => {
  const network = qrHarness({ error: { code: 'NETWORK', message: 'offline' } });
  await assert.rejects(network.run());
  assert.equal(network.calls.some(call => call[0] === 'legacy'), false);
  await assert.rejects(qrHarness({ data: { enabled: true, success: false, reason: 'bill_changed' } }).run());
  await assert.rejects(qrHarness({ data: { enabled: true, success: true, selected: true, account_id: 'A' } },
    { id: 'A', is_active: false }).run());
});

test('a deleted paid bill displays payment, while an old table marker never turns cancellation into payment', () => {
  const session = { orderId: 'order', lastActive: Date.parse('2026-10-03T17:00:00+07:00') };
  assert.equal(isPaidTableCheckout({ status: 'available', last_payment_at: '2026-10-03T18:00:00+07:00' }, session), true);
  assert.equal(isPaidTableCheckout({ status: 'available', last_payment_at: '2026-10-02T22:00:00+07:00' }, session), false);
  assert.equal(isPaidTableCheckout({ status: 'available' }, session), false);
  assert.equal(isPaidTableCheckout({ status: 'occupied', last_payment_at: '2026-10-03T18:00:00+07:00' }, session), false);
  assert.equal(isPaidTableCheckout({ status: 'available', last_payment_at: '2026-10-03T18:00:00+07:00' }, {}), false);
});

test('account A displays combined cash/transfer against the saved random target, B stays bank-only', () => {
  const a = { id: 'A', daily_limit: 5000000, bank_daily_totals: [{ date: '2026-10-03', total_amount: 200000 }] };
  const b = { ...a, id: 'B' };
  const summary = { enabled: true, date: '2026-10-03', account_id: 'A', target_amount: 6200000,
    cash_amount: 300000, transfer_amount: 200000 };
  assert.deepEqual(statsQuotaProgress(a, summary, '2026-10-03'), { combined: true, receivedToday: 500000, limit: 6200000 });
  assert.deepEqual(statsQuotaProgress(b, summary, '2026-10-03'), { combined: false, receivedToday: 200000, limit: 5000000 });
  assert.equal(statsQuotaProgress(a, { ...summary, enabled: false }, '2026-10-03').receivedToday, 200000);
  assert.equal(statsQuotaProgress(a, summary, '2026-10-04').combined, false);
});

test('feedback on a deleted receipt is saved as a general review without bill details', async () => {
  const page = readFileSync(new URL('../src/app/order/page.jsx', import.meta.url), 'utf8');
  const feedback = page.slice(page.indexOf('  async function submitFeedback(order)'), page.indexOf('  async function submitGeneralFeedback()'));
  const calls = [];
  const query = { update: () => query, eq: () => query, select: async () => ({ data: [], error: null }) };
  const submit = vm.runInNewContext(`(${feedback.trim()})`, {
    feedbackForms: { order: { rating: 5, note: 'Good' } }, activeTableId: 'table', customerName: 'Guest', customerPhone: '',
    setFeedbackSaving: () => {}, setPreviousOrders: () => {}, showFeedbackToast: (...args) => calls.push(['toast', ...args]),
    supabase: { from: name => name === 'orders' ? query : { insert: async row => { calls.push(['review', row]); return { error: null }; } } },
  });
  assert.equal(await submit({ id: 'order' }), true);
  const review = calls.find(call => call[0] === 'review')[1];
  assert.equal(review.rating, 5); assert.equal(review.feedback, 'Good');
  assert.equal('order_id' in review, false); assert.equal('total_amount' in review, false);
});
