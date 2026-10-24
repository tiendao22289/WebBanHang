import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBlock, lossBlock, staffBlock } from '../src/lib/dailyInsights.mjs';

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
