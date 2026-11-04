import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeDb } from './helpers/fakeSupabase.mjs';

// Quán bán qua nửa đêm: bill chưa thu của bàn tính hết dù gọi trước 00:00; chỗ nào cần "hôm nay"
// thì ngày bắt đầu 05:00 giờ Việt Nam. Ví dụ của người kiểm tra: 00:20 sáng 5/11, bàn có bill 600k
// gọi lúc 22:00 và 50k lúc 00:05 → ưu đãi 10% phải là 65.000đ, không phải 5.000đ.
const source = readFileSync(new URL('../src/lib/tableGroupOrders.js', import.meta.url), 'utf8');
const { shopDayStartISO, shopDayKey, fetchOpenGroupTotal } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const AT_0020 = Date.parse('2026-11-04T17:20:00Z'); // 00:20 giờ VN ngày 5/11
const bill = (id, table, createdAt, total, extra = {}) => ({
  id, table_id: table, status: 'pending', customer_phone: '0901234567', created_at: createdAt, total_amount: total,
  order_items: [{ unit_price: total, quantity: 1 }], ...extra,
});
const state = () => ({
  orders: [
    bill('a', 't4', '2026-11-04T15:00:00Z', 600000), // 22:00 VN 4/11
    bill('b', 't4', '2026-11-04T17:05:00Z', 50000), // 00:05 VN 5/11
    bill('call', 't4', '2026-11-04T17:10:00Z', 0, { customer_phone: 'BAO_BEP', status: 'completed' }),
    bill('paid', 't4', '2026-11-04T14:00:00Z', 300000, { status: 'paid' }),
    bill('tw-old', 'tw', '2026-11-03T12:00:00Z', 300000, { status: 'completed' }), // mang về tuần trước đã giao
    bill('tw-today', 'tw', '2026-11-04T16:00:00Z', 80000), // 23:00 VN 4/11
  ],
});

test('the shop day runs 05:00 to 05:00 Vietnam time', () => {
  assert.equal(shopDayStartISO(AT_0020), '2026-11-03T22:00:00.000Z', '00:20 on 5/11 still belongs to 4/11');
  assert.equal(shopDayKey(AT_0020), '2026-11-04');
  assert.equal(shopDayStartISO(Date.parse('2026-11-04T22:30:00Z')), '2026-11-04T22:00:00.000Z', '05:30 starts the new day');
  assert.equal(shopDayKey(Date.parse('2026-11-04T21:59:00Z')), '2026-11-04');
});

test('open bills of a table count whatever their calendar day; a takeaway phone counts only today since 05:00', async () => {
  const db = fakeDb(state());
  assert.equal(await fetchOpenGroupTotal(db, ['t4'], null, AT_0020), 650000);
  assert.equal(await fetchOpenGroupTotal(db, ['tw'], '0901234567', AT_0020), 80000);
});

test('the order page shows (and counts promotions on) a dine-in bill from before midnight', async () => {
  const page = readFileSync(new URL('../src/app/order/page.jsx', import.meta.url), 'utf8');
  const load = page.slice(page.indexOf('  async function loadPreviousOrders('), page.indexOf('  async function callKitchen()'));
  const group = page.slice(page.indexOf('  async function fetchGroupOrders('), page.indexOf('  function reorderBill('));
  const run = async takeaway => {
    const seen = {};
    const ctx = {
      supabase: fakeDb(state()), activeTableId: takeaway ? 'tw' : 't4', customerPhoneRef: { current: '0901234567' },
      mergeGroupIdsRef: { current: [takeaway ? 'tw' : 't4'] }, isTakeawayRef: { current: takeaway },
      getSavedSession: () => ({ orderId: takeaway ? 'tw-today' : 'b' }), hasOrderSession: () => true,
      verifyTableSession: () => { seen.verified = true; }, shopDayStartISO: () => shopDayStartISO(AT_0020),
      setPreviousOrders: v => { seen.bills = v.map(o => o.id); }, setGroupOrders: v => { seen.group = v.map(o => o.id); },
    };
    ctx.fetchGroupOrders = vm.runInNewContext(`(${group.trim()})`, ctx);
    await vm.runInNewContext(`(${load.trim()})`, ctx)();
    return seen;
  };
  assert.deepEqual(await run(false), { bills: ['b', 'a'], group: ['a', 'b'] }); // mới nhất trước
  assert.deepEqual(await run(true), { bills: ['tw-today'], group: ['tw-today'] });
});

test('staff approval computes the review discount on every open bill of the table, and the queue keeps last night\'s requests', async () => {
  const page = readFileSync(new URL('../src/app/admin/tables/page.js', import.meta.url), 'utf8');
  const modal = page.slice(page.indexOf('  function reviewBillsQuery('), page.indexOf('  async function approveReviewReward('));
  let preview = null;
  const ctx = {
    supabase: fakeDb(state()), tables: [{ id: 't4', table_type: 'normal' }, { id: 'tw', table_type: 'takeaway' }],
    groupTableIds: hostId => [hostId], shopDayStartISO: () => shopDayStartISO(AT_0020),
    fetchChannelConfig: async () => ({ percent: 10, max: 0 }),
    calcReviewDiscount: (total, cfg) => Math.floor((total * cfg.percent) / 100 / 1000) * 1000,
    sumOrderItems: list => list.reduce((s, o) => s + o.order_items.reduce((t, i) => t + i.unit_price * i.quantity, 0), 0),
    setReviewModal() {}, setReviewPreview: v => { preview = v; },
  };
  const openReviewModal = vm.runInNewContext(`${modal}\nopenReviewModal`, ctx);
  await openReviewModal({ host_table_id: 't4', channel: 'google' });
  assert.deepEqual([preview?.total, preview?.discount], [650000, 65000]);
  await openReviewModal({ host_table_id: 'tw', channel: 'google' });
  assert.equal(preview.total, 80000, 'takeaway: delivered bills from last week are not counted');
  const queue = page.slice(page.indexOf('  const fetchReviewRequests = useCallback('), page.indexOf('  // Cấu hình KM "mua N tặng 1"'));
  assert.match(queue, /\.gte\('created_at', shopDayStartISO\(\)\)/);
  assert.doesNotMatch(page, /startOfTodayISO|now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\)/, 'no 00:00 cut-off left on the tables page');
});

test('the order page keeps no 00:00 cut-off: session day, bills, gifts, review total and takeaway codes use the shop day', () => {
  const page = readFileSync(new URL('../src/app/order/page.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /startOfTodayISO|fetchGroupBillTotal|now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\)/);
  assert.match(page, /function getTodayStr\(\) \{\s*return shopDayKey\(\);/);
});
