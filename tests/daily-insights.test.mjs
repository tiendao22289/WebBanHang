import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBlock, compareData, isDrinkItem, lossBlock, staffBlock } from '../src/lib/dailyInsights.mjs';

const opt = choice => [{ name: 'LOẠI', choice }];

test('items printed for the kitchen but missing at payment are reported, moved items are not', () => {
  const bill = { order_id: 'o1', table_number: '12', paid_at: '2026-10-23T13:40:00Z', amount: 130000, items: [
    { name: 'Tôm', quantity: 1, unit_price: 80000, options: opt('Nướng') },
    { name: 'Mì Xào', quantity: 1, unit_price: 50000, options: opt('Ốc móng tay') },
    { name: 'Vòng xoay may mắn: giảm 10.000đ', quantity: 1, unit_price: -10000 },
    { name: 'Nước suối', quantity: 1, unit_price: 0, is_gift: true },
  ] };
  const printed = new Map([['o1', [
    [{ id: 'a', name: 'Tôm', quantity: 1, unit_price: 80000, item_options: opt('Nướng') }, { id: 'b', name: 'Mì Xào', quantity: 1, unit_price: 50000, item_options: opt('Ốc móng tay') }],
    // In lần 2 (gọi thêm): Tôm lên 2, thêm Râu mực và Ốc hương; sau đó Tôm bớt 1, Râu mực bị xoá, Ốc hương được chuyển sang bàn khác.
    [{ id: 'a', name: 'Tôm', quantity: 2, unit_price: 80000, item_options: opt('Nướng') }, { id: 'c', name: 'Râu mực', quantity: 1, unit_price: 80000 }, { id: 'd', name: 'Ốc hương', quantity: 1, unit_price: 150000 }],
  ]]]);
  const text = lossBlock({ ledgerDay: [bill], printed, movedIds: new Set(['d']), cancelled: [
    { id: 'x', table_number: 7, cancelled_at: '2026-10-23T14:05:00Z', cancelled_by_name: 'Lan', total_amount: 0 },
  ], menuPrice: new Map([['nước suối', 10000]]) });
  assert.match(text, /Món bị bớt sau khi in bếp: 2 món — 160\.000đ/);
  assert.match(text, /• Bàn 12 \(thu 20:40\): Tôm \(Nướng\) ×1 \(80\.000đ\)/);
  assert.match(text, /• Bàn 12 \(thu 20:40\): Râu mực ×1 \(80\.000đ\)/);
  assert.doesNotMatch(text, /Ốc hương/, 'moved to another bill, not removed');
  assert.match(text, /Bill huỷ: 1 — 0đ\n• 21:05 Bàn 7 · 0đ · huỷ bởi Lan/);
  assert.match(text, /Giảm giá: 1 lần — 10\.000đ \(Vòng xoay 1 lần 10\.000đ\)/);
  assert.match(text, /Món tặng: 1 món ~ 10\.000đ \(Nước suối ×1\)/);
});

test('a cancelled bill shows what had already gone to the kitchen', () => {
  const printed = new Map([['x', [[{ id: 'p', name: 'Tôm', quantity: 2, unit_price: 80000 }]]]]);
  const text = lossBlock({ printed, cancelled: [{ id: 'x', table_number: 7, cancelled_at: '2026-10-23T14:05:00Z', cancelled_by_name: 'Lan', total_amount: 160000 }] });
  assert.match(text, /Bill huỷ: 1 — 160\.000đ\n• 21:05 Bàn 7 · 2 món đã in bếp \(160\.000đ\) · huỷ bởi Lan/);
  assert.match(lossBlock({}), /không có bill huỷ/);
});

test('bills merged into another bill are not reported as cancelled', () => {
  // Gộp bill: bill phụ thành "cancelled" 0đ (không người huỷ), món đã in bếp chuyển sang bill chính.
  const printed = new Map([['merged', [[{ id: 'm1', name: 'Tôm', quantity: 1, unit_price: 80000 }, { id: 'm2', name: 'Mực', quantity: 2, unit_price: 50000 }]]],
    ['x', [[{ id: 'p', name: 'Tôm', quantity: 2, unit_price: 80000 }, { id: 'q', name: 'Sò', quantity: 1, unit_price: 60000 }]]]]);
  // m1, m2 không nằm trong movedIds: bill chính ngoài thống kê đã bị dọn nên không còn món để đối chiếu.
  const text = lossBlock({ printed, movedIds: new Set(['q']), cancelled: [
    { id: 'merged', table_number: 58, cancelled_at: null, cancelled_by_name: null, total_amount: 0 },
    // Bill huỷ thật, 1 món đã chuyển sang bàn khác trước khi huỷ: chỉ tính món còn lại.
    { id: 'x', table_number: 7, cancelled_at: '2026-10-23T14:05:00Z', cancelled_by_name: 'Lan', total_amount: 220000 },
  ] });
  assert.match(text, /Bill huỷ: 1 — 160\.000đ\n• 21:05 Bàn 7 · 2 món đã in bếp \(160\.000đ\) · huỷ bởi Lan/);
  assert.doesNotMatch(text, /Bàn 58/);
});

test('staff hours, forgotten clock-outs and pending requests', () => {
  const text = staffBlock({ staffNames: { a: 'Phát', b: 'Lan' }, sessions: [
    { staff_id: 'a', clock_in: '2026-10-23T09:00:00Z', clock_out: '2026-10-23T12:00:00Z' },
    { staff_id: 'a', clock_in: '2026-10-23T13:00:00Z', clock_out: '2026-10-23T16:30:00Z' },
    { staff_id: 'b', clock_in: '2026-10-23T10:00:00Z', clock_out: null },
  ], pending: [{ staff_id: 'b', request_type: 'advance', amount: 500000, reason: 'đóng học' }, { staff_id: 'a', request_type: 'absent', days: 1 }] });
  assert.match(text, /• Phát: 16:00–19:00, 20:00–23:30 \(6,5 giờ\)/);
  assert.match(text, /• Lan: 17:00–… \(0 giờ\) ⚠ chưa bấm ra ca/);
  assert.match(text, /Chờ bạn duyệt \(2\):\n• Lan xin ứng 500\.000đ — đóng học\n• Phát báo nghỉ 1 ngày/);
});

test('comparison with yesterday and the same weekday last week, busiest hour and best sellers', () => {
  const ledgerDay = [
    { paid_at: '2026-10-23T12:10:00Z', amount: 300000, items: [{ name: 'Ốc hương', quantity: 2, unit_price: 150000 }] },
    { paid_at: '2026-10-23T12:40:00Z', amount: 200000, items: [{ name: 'Tôm', quantity: 1, unit_price: 80000 }, { name: 'Ốc hương', quantity: 1, unit_price: 120000 }] },
    { paid_at: '2026-10-23T15:00:00Z', amount: 100000, items: [{ name: 'Bia', quantity: 5, unit_price: 20000 }] },
  ];
  const text = compareBlock({ day: { revenue: 600000, bills: 3 }, prev: { revenue: 500000, bills: 2 }, week: null, weekdayLabel: 'T6', ledgerDay });
  assert.match(text, /Doanh thu 600\.000đ · hôm qua 500\.000đ \(\+20%\) · T6 tuần trước chưa có số/);
  assert.match(text, /3 bill · trung bình 200\.000đ\/bill/);
  assert.match(text, /Đông nhất 19h–20h: 2 bill, 500\.000đ/);
  assert.match(text, /Bán chạy: Bia 5, Ốc hương 3, Tôm 1/);
});

test('staff block shows forgotten clock-outs, check-in warnings and hour fix requests', () => {
  const text = staffBlock({ staffNames: { a: 'Phát', b: 'Lan' },
    sessions: [{ staff_id: 'a', clock_in: '2026-10-23T09:00:00Z', clock_out: '2026-10-23T16:00:00Z', auto_closed: true }],
    alerts: [{ staff_id: 'b', action: 'in', warnings: ['other_network'] }, { staff_id: 'b', action: 'blocked', warnings: ['other_network'] }],
    fixes: [{ staff_id: 'a', reason: 'về lúc 23:45' }] });
  assert.match(text, /• Phát: 16:00–23:00 \(7 giờ\) ⚠ quên ra ca, máy tự tính giờ ra/);
  assert.match(text, /⚠ Cảnh báo chấm công:\n• Lan: không dùng wifi quán ×2; bị chặn không cho chấm/);
  assert.match(text, /Chờ bạn duyệt \(1\):\n• Phát xin sửa giờ chấm công — về lúc 23:45/);
});

test('staff block shows late / early by each shift and outside time waiting for the owner', () => {
  const text = staffBlock({ staffNames: { a: 'Phát', b: 'Lan' },
    settings: { hours_from: '2026-10-25' }, hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }],
    shifts: [{ staff_id: 'b', valid_from: '2000-01-01', start_time: '17:00', end_time: '23:00' }],
    sessions: [
      { id: 's1', staff_id: 'a', date: '2026-10-25', clock_in: '2026-10-25T07:25:00Z', clock_out: '2026-10-25T16:45:00Z' },
      { id: 's2', staff_id: 'b', date: '2026-10-25', clock_in: '2026-10-25T09:30:00Z', clock_out: '2026-10-25T16:00:00Z' },
    ],
    reviews: [{ attendance_id: 's2', status: 'rejected', minutes: 0 }] });
  assert.match(text, /• Phát: 14:25–23:45 \(8,6 giờ\) ⚠ trễ 25 phút, ở lại 45 phút/);
  assert.match(text, /• Lan: 16:30–23:00 \(6 giờ\) ⚠ vào sớm 30 phút/);
  assert.match(text, /Chờ bạn duyệt \(1\):\n• Phát có 45 phút ngoài ca chưa tính lương/);
});

test('from November the daily report says an early leave of 30 minutes or more is cut from pay', () => {
  const settings = { hours_from: '2026-10-25' }, hours = [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }];
  const block = (date, out) => staffBlock({ date, settings, hours, staffNames: { a: 'Mai' },
    sessions: [{ id: 's', staff_id: 'a', date, clock_in: `${date}T07:00:00Z`, clock_out: `${date}T${out}:00Z` }] });
  assert.match(block('2026-11-04', '13:00'), /Mai: .*⚠ về sớm 3 giờ \(trừ lương\)/);
  assert.doesNotMatch(block('2026-11-04', '15:40'), /trừ lương/, '20 minutes early: flagged, not cut');
  assert.doesNotMatch(block('2026-10-27', '13:00'), /trừ lương/, 'October keeps the old formula');
});

test('losses, staff of a day and staff of a week come as data for the stats page', async () => {
  const { lossData, staffData, staffRangeData } = await import('../src/lib/dailyInsights.mjs');
  const printed = new Map([['x', [[{ id: 'p', name: 'Tôm', quantity: 2, unit_price: 80000 }]]]]);
  const bill = { order_id: 'o1', table_number: '3', paid_at: '2026-10-23T13:00:00Z', items: [{ name: 'Giảm giá: khách quen', quantity: 1, unit_price: -20000 }, { name: 'Nước suối', quantity: 2, unit_price: 0, is_gift: true }] };
  const d = lossData({ ledgerDay: [bill], printed, cancelled: [{ id: 'x', table_number: 7, cancelled_at: '2026-10-23T14:05:00Z', cancelled_by_name: 'Lan', total_amount: 0 }], menuPrice: new Map([['nước suối', 10000]]) });
  assert.deepEqual([d.cancelled.count, d.cancelled.total, d.cancelled.rows[0].printedCount, d.cancelled.rows[0].by], [1, 160000, 2, 'Lan']);
  assert.deepEqual([d.discounts.count, d.discounts.amount, d.discounts.kinds[0].kind], [1, 20000, 'Giảm giá']);
  assert.deepEqual([d.gifts.qty, d.gifts.value], [2, 20000]);
  assert.equal(d.total, 200000);
  assert.equal(lossData({}).total, 0);

  const settings = { hours_from: '2026-10-01' };
  const hours = [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '23:00', grace_minutes: 10 }];
  const s = staffData({ staffNames: { a: 'Phát' }, settings, hours, date: '2026-10-23', sessions: [{ id: 's1', staff_id: 'a', date: '2026-10-23', clock_in: '2026-10-23T07:30:00Z', clock_out: null }],
    alerts: [{ staff_id: 'a', warnings: ['other_network'] }], pending: [{ staff_id: 'a', request_type: 'advance', amount: 200000 }] });
  assert.deepEqual([s.people[0].name, s.people[0].flags.late, s.people[0].open], ['Phát', 30, true]);
  assert.deepEqual(s.alerts[0].items, [{ text: 'không dùng wifi quán', count: 1 }]);
  assert.equal(s.pending[0].kind, 'advance');

  const w = staffRangeData({ staffNames: { a: 'Phát' }, settings, hours, from: '2026-10-19', to: '2026-10-25', sessions: [
    { id: 'x1', staff_id: 'a', date: '2026-10-20', clock_in: '2026-10-20T07:20:00Z', clock_out: '2026-10-20T16:00:00Z' },
    { id: 'x2', staff_id: 'a', date: '2026-10-21', clock_in: '2026-10-21T07:00:00Z', clock_out: '2026-10-21T15:00:00Z', auto_closed: true },
    { id: 'x3', staff_id: 'a', date: '2026-10-27', clock_in: '2026-10-27T07:00:00Z', clock_out: '2026-10-27T16:00:00Z' },
  ], alerts: [{ staff_id: 'a', action: 'blocked' }] });
  assert.deepEqual([w.people[0].days, w.people[0].late.count, w.people[0].late.minutes, w.people[0].forgot, w.people[0].blocked], [2, 1, 20, 1, 1]);
  assert.equal(w.totals.people, 1);

  // Ngày quán nghỉ chủ gọi vào làm: không báo trễ / về sớm ở thẻ ngày lẫn thẻ cả tuần.
  const off = staffData({ staffNames: { a: 'Phát' }, settings, hours, date: '2026-10-23', closedDays: ['2026-10-23'],
    sessions: [{ id: 's1', staff_id: 'a', date: '2026-10-23', clock_in: '2026-10-23T09:00:00Z', clock_out: '2026-10-23T11:00:00Z' }] });
  assert.deepEqual([off.people[0].flags.late, off.people[0].flags.leftEarly, off.people[0].cut], [0, 0, false]);
  const offWeek = staffRangeData({ staffNames: { a: 'Phát' }, settings, hours, from: '2026-10-19', to: '2026-10-25', closedDays: ['2026-10-20'], sessions: [
    { id: 'x1', staff_id: 'a', date: '2026-10-20', clock_in: '2026-10-20T07:20:00Z', clock_out: '2026-10-20T12:00:00Z' },
    { id: 'x4', staff_id: 'a', date: '2026-10-22', clock_in: '2026-10-22T07:20:00Z', clock_out: '2026-10-22T16:00:00Z' },
  ] });
  assert.deepEqual([offWeek.people[0].days, offWeek.people[0].late.count, offWeek.people[0].late.minutes, offWeek.people[0].leftEarly.count], [2, 1, 20, 0]);
});

test('báo cáo ngày gom mọi dòng "Voucher BK-…" thành một nhóm Voucher', async () => {
  const { lossData } = await import('../src/lib/dailyInsights.mjs');
  const bill = (code, amount) => ({ order_id: code, items: [{ name: `Voucher ${code}`, quantity: 1, unit_price: -amount }] });
  const d = lossData({ ledgerDay: [bill('BK-AAAAAA', 30000), bill('BK-BBBBBB', 50000)], printed: new Map(), cancelled: [], menuPrice: new Map() });
  assert.deepEqual(d.discounts.kinds, [{ kind: 'Voucher', count: 2, amount: 80000 }]);
});

test('Thống kê nhanh ranks only dishes: beer, drinks, towels and gifts are left out; every dish is listed with its money', () => {
  for (const name of ['Bia Heineken lun', 'Bia sài gòn', 'Coca', '7 UP', 'Siting', 'Ôlong', 'O long', 'Trà đá', 'Trà chanh xã', 'Khăn', 'Nước suối', 'Xá xị', 'C 2', '0 độ'])
    assert.equal(isDrinkItem(name), true, name);
  for (const name of ['Ốc Hương', 'Sò Sữa', 'Hàu nướng', 'Mì Xào', 'Đậu hũ chiên', 'Bánh mì', 'Tu Hài', 'Sò Điệp'])
    assert.equal(isDrinkItem(name), false, name);
  const ledgerDay = [{ paid_at: '2026-11-06T12:00:00Z', amount: 0, items: [
    { name: 'Bia Heineken lun', quantity: 10, unit_price: 20000 }, { name: 'Ốc Hương', quantity: 3, unit_price: 90000 },
    { name: 'Khăn', quantity: 4, unit_price: 2000 }, { name: 'Mì Xào', quantity: 3, unit_price: 60000 }, { name: 'Ốc Hương', quantity: 1, unit_price: 90000, is_gift: true },
    { name: 'Vòng xoay may mắn: giảm 2%', quantity: 1, unit_price: -7000 }, { name: 'Giảm giá', quantity: 1, unit_price: -20000 },
  ] }, { paid_at: '2026-11-06T13:00:00Z', amount: 0, items: [{ name: 'Ốc Hương', quantity: 2, unit_price: 90000 }] }];
  const c = compareData({ day: { revenue: 0, bills: 2 }, ledgerDay });
  assert.deepEqual(c.foods, [{ name: 'Ốc Hương', qty: 5, amount: 450000 }, { name: 'Mì Xào', qty: 3, amount: 180000 }]);
  assert.equal(c.top[0].name, 'Bia Heineken lun', 'the Zalo report list stays as before');
});

test('Thống kê nhanh splits every promotion: wheel prizes, Google and other channels, vouchers, gifts at the menu price', async () => {
  const { lossData } = await import('../src/lib/dailyInsights.mjs');
  const menuItems = [
    { name: 'ỐC Gai', price: 0, options: [{ name: 'LOẠI', choices: ['Xào tỏi', 'Nướng mỡ hành'], prices: [50000, 55000] }] },
    { name: 'Nước suối', price: 10000, options: [] },
    { name: 'Coca', price: 15000 },
  ];
  const at = '2026-11-06T13:00:00Z';
  const ledgerDay = [
    { table_number: '5', paid_at: at, items: [
      { name: 'Vòng xoay may mắn: giảm 10%', quantity: 1, unit_price: -42000 },
      { name: 'Coca', quantity: 1, unit_price: 0, is_gift: true, wheel_gift: true },
      { name: 'Giảm giá đánh giá Google', quantity: 1, unit_price: -20000 },
      { name: 'ỐC Gai', quantity: 10, unit_price: 0, is_gift: true, options: [{ name: 'LOẠI', choice: 'Xào tỏi' }] },
    ] },
    { table_number: '9', paid_at: at, items: [
      { name: 'Giảm giá đánh giá Google', quantity: 1, unit_price: -30000 },
      { name: 'Giảm giá kết bạn Zalo', quantity: 1, unit_price: -10000 },
      { name: 'Voucher BK-ABCDEF', quantity: 1, unit_price: -50000 },
      { name: 'Giảm giá: khách quen', quantity: 1, unit_price: -5000 },
      { name: 'Nước suối', quantity: 3, unit_price: 0, is_gift: true },
      { name: 'Món lạ', quantity: 1, unit_price: 0, is_gift: true },
    ] },
  ];
  const { promos, gifts } = lossData({ ledgerDay, menuItems, menuPrice: new Map([['món lạ', 7000]]) });
  const g = Object.fromEntries(promos.groups.map(x => [x.key, x]));
  assert.deepEqual(promos.groups.map(x => x.key), ['wheel', 'google', 'zalo', 'voucher', 'other'], 'empty kinds (TikTok, Facebook) are left out');
  assert.deepEqual([g.wheel.count, g.wheel.giftQty, g.wheel.amount], [2, 1, 42000 + 15000], 'a wheel gift counts at its menu price');
  assert.deepEqual(g.wheel.rows.map(r => [r.table, r.kind, r.name]), [['5', 'discount', 'Vòng xoay may mắn: giảm 10%'], ['5', 'gift', 'Coca']]);
  assert.deepEqual([g.google.count, g.google.amount, g.google.rows.map(r => r.table)], [2, 50000, ['5', '9']]);
  assert.deepEqual([g.zalo.amount, g.voucher.amount, g.other.amount], [10000, 50000, 5000]);
  // Món tặng (không phải vòng xoay): 10 phần Ốc gai Xào tỏi 50.000đ = 500.000đ, nước tính chai riêng.
  assert.deepEqual([promos.gifts.foods.qty, promos.gifts.foods.amount], [11, 500000 + 7000]);
  assert.deepEqual(promos.gifts.foods.items[0], { name: 'ỐC Gai (Xào tỏi)', qty: 10, unit: 50000, amount: 500000 });
  assert.deepEqual([promos.gifts.drinks.qty, promos.gifts.drinks.amount], [3, 30000]);
  assert.equal(promos.total, 57000 + 50000 + 10000 + 50000 + 5000 + 537000);
  assert.equal(gifts.value, 15000 + 500000 + 30000 + 7000, 'the loss card values gifts at the menu price too');
});
