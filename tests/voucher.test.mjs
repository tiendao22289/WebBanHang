import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newVoucherCode, normalizeVoucherCode, VOUCHER_ALPHABET, nextVisitWindow, giftWindow, lastUseDay, firstUseDay,
  calcVoucherDiscount, voucherState, voucherValueText, redeemFailText, parseNextVoucherConfig, checkNextVoucherConfig,
  pickVoucherPhone, fillVoucherMessage, GIFT_MESSAGE_TEMPLATE, normalizePhone, isVoucherSwitchOn,
  runInBatches, canAutoSendVoucher, SEND_BATCH, SEND_MAX_IDS, canCancelVoucher, CANCEL_BATCH, CANCEL_MAX_IDS,
} from '../src/lib/voucher.mjs';

// Giờ VN → mốc ms (UTC+7).
const vn = s => Date.parse(`${s}+07:00`);

test('mã mới: BK- + 6 ký tự dễ đọc, không có 0/O/1/I/L', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const code = newVoucherCode();
    assert.match(code, /^BK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 1990, 'mã ngẫu nhiên gần như không trùng');
  assert.ok(!/[01OIL]/.test(VOUCHER_ALPHABET));
  assert.equal(newVoucherCode(() => 0), 'BK-222222');
  assert.equal(newVoucherCode(() => 0.9999), 'BK-ZZZZZZ');
});

test('nhân viên gõ mã kiểu gì cũng ra đúng mã, gõ sai thì báo', () => {
  assert.equal(normalizeVoucherCode('bk-7k3p9x'), 'BK-7K3P9X');
  assert.equal(normalizeVoucherCode(' BK 7K3P 9X '), 'BK-7K3P9X');
  assert.equal(normalizeVoucherCode('7k3p9x'), 'BK-7K3P9X');
  assert.equal(normalizeVoucherCode('BK7K3P9X'), 'BK-7K3P9X');
  for (const bad of ['', null, 'BK-7K3P9', 'BK-7K3P9XX', 'BK-0K3P9X', 'BK-OK3P9X', 'BK-1K3P9X', "BK-7K3P9X'; drop table", '7K3P9X7K']) {
    assert.equal(normalizeVoucherCode(bad), null, String(bad));
  }
});

test('SĐT: chuẩn hoá về 0xxxxxxxxx', () => {
  assert.equal(normalizePhone('+84 909 123 456'), '0909123456');
  assert.equal(normalizePhone('0909.123.456'), '0909123456');
  assert.equal(normalizePhone('BAO_BEP'), null);
  assert.equal(normalizePhone('12345'), null);
});

test('mã lần sau: dùng từ 5h sáng hôm sau, hết hạn sau N ngày (ca bán qua nửa đêm)', () => {
  // Thanh toán 22:00 ngày 29/10 → dùng từ 05:00 30/10 đến 05:00 13/11 (hết ngày 12/11).
  const w = nextVisitWindow(14, vn('2026-10-29T22:00:00'));
  assert.equal(w.validFrom, new Date(vn('2026-10-30T05:00:00')).toISOString());
  assert.equal(w.validUntil, new Date(vn('2026-11-13T05:00:00')).toISOString());
  assert.equal(firstUseDay(w.validFrom), '2026-10-30');
  assert.equal(lastUseDay(w.validUntil), '2026-11-12');
  // Thanh toán 01:30 sáng 30/10 (vẫn ca tối 29/10) → dùng từ 05:00 30/10, không phải 31/10.
  const late = nextVisitWindow(14, vn('2026-10-30T01:30:00'));
  assert.equal(late.validFrom, new Date(vn('2026-10-30T05:00:00')).toISOString());
  // Số ngày sai → ít nhất 1 ngày.
  const w0 = nextVisitWindow(0, vn('2026-10-29T22:00:00'));
  assert.equal(lastUseDay(w0.validUntil), '2026-10-30');
});

test('mã chủ quán tặng: từ hôm nay dùng được ngay, đến hết ngày cuối', () => {
  const now = vn('2026-10-29T15:00:00');
  const w = giftWindow('2026-10-29', '2026-11-12', now);
  assert.equal(w.validFrom, new Date(vn('2026-10-29T05:00:00')).toISOString());
  assert.equal(voucherState({ status: 'active', ...{ valid_from: w.validFrom, valid_until: w.validUntil } }, now), 'active');
  assert.equal(w.validUntil, new Date(vn('2026-11-13T05:00:00')).toISOString());
  // 2h sáng 30/10 vẫn là ca 29/10: chọn "từ 29/10" vẫn dùng ngay.
  const night = vn('2026-10-30T02:00:00');
  const n = giftWindow('2026-10-29', '2026-10-29', night);
  assert.equal(voucherState({ status: 'active', valid_from: n.validFrom, valid_until: n.validUntil }, night), 'active');
  // 0h40 sáng 30/10, chủ quán chọn 'từ 30/10' (hôm nay theo lịch) → dùng được ngay, không đợi 5h.
  const early = vn('2026-10-30T00:40:00');
  const e = giftWindow('2026-10-30', '2026-11-13', early);
  assert.equal(e.validFrom, new Date(early).toISOString());
  assert.equal(voucherState({ status: 'active', valid_from: e.validFrom, valid_until: e.validUntil }, early), 'active');
  // Bắt đầu ngày mai → từ 5h sáng mai.
  assert.equal(giftWindow('2026-10-31', '2026-11-05', now).validFrom, new Date(vn('2026-10-31T05:00:00')).toISOString());
  // Ngày hết hạn đã qua / sai dạng → null.
  assert.equal(giftWindow('2026-10-01', '2026-10-10', now), null);
  assert.equal(giftWindow('2026-10-29', 'abc', now), null);
});

test('xem trước tiền giảm: cùng công thức với SQL redeem_voucher', () => {
  const amount = { discount_type: 'amount', discount_value: 30000 };
  assert.equal(calcVoucherDiscount(250000, amount), 30000);
  assert.equal(calcVoucherDiscount(20000, amount), 20000, 'không giảm quá tiền món');
  assert.equal(calcVoucherDiscount(0, amount), 0);
  const pct = { discount_type: 'percent', discount_value: 10, max_discount: 50000 };
  assert.equal(calcVoucherDiscount(345000, pct), 34000, 'làm tròn xuống 1.000đ');
  assert.equal(calcVoucherDiscount(900000, pct), 50000, 'chặn trần');
  assert.equal(calcVoucherDiscount(900000, { ...pct, max_discount: 0 }), 90000);
});

test('trạng thái mã theo giờ', () => {
  const v = { status: 'active', valid_from: '2026-10-30T05:00:00+07:00', valid_until: '2026-11-13T05:00:00+07:00' };
  assert.equal(voucherState(v, vn('2026-10-29T23:00:00')), 'not_yet');
  assert.equal(voucherState(v, vn('2026-11-12T23:59:00')), 'active');
  assert.equal(voucherState(v, vn('2026-11-13T04:59:00')), 'active', 'ca tối 12/11 kéo qua nửa đêm vẫn dùng được');
  assert.equal(voucherState(v, vn('2026-11-13T05:00:00')), 'expired');
  assert.equal(voucherState({ ...v, status: 'used' }, vn('2026-11-01T12:00:00')), 'used');
});

test('chữ hiển thị mức giảm + lý do từ chối cho nhân viên', () => {
  assert.equal(voucherValueText({ discount_type: 'amount', discount_value: 30000 }), '30.000đ');
  assert.equal(voucherValueText({ discount_type: 'percent', discount_value: 10, max_discount: 50000 }), '10% (tối đa 50.000đ)');
  assert.match(redeemFailText({ reason: 'used', table_number: 5, used_at: '2026-10-29T12:40:00Z' }), /đã dùng rồi ở bàn 5 lúc 19:40 29\/10/);
  assert.match(redeemFailText({ reason: 'expired', valid_until: '2026-11-13T05:00:00+07:00' }), /hết hạn.*12\/11/);
  assert.match(redeemFailText({ reason: 'not_yet', valid_from: '2026-10-30T05:00:00+07:00' }), /từ 30\/10/);
  assert.match(redeemFailText({ reason: 'min_bill', min_bill: 200000, base: 150000 }), /200\.000đ.*150\.000đ/);
  assert.match(redeemFailText({ reason: 'bill_has_voucher' }), /1 voucher/);
  assert.ok(redeemFailText({ reason: 'không biết' }).length > 0);
});

test('cài đặt "Hẹn lần sau": mặc định tắt, đọc số an toàn, kiểm lỗi trước khi lưu', () => {
  const d = parseNextVoucherConfig([]);
  assert.deepEqual(d, { on: false, enabled: false, minBill: 300000, type: 'amount', value: 30000, max: 0, useMinBill: 200000, days: 14, repeat: true });
  assert.equal(parseNextVoucherConfig([{ key: 'voucher_enabled', value: 'true' }]).on, true, 'công tắc chung');
  assert.equal(isVoucherSwitchOn([{ key: 'voucher_enabled', value: 'false' }]), false);
  assert.equal(isVoucherSwitchOn([{ key: 'voucher_enabled', value: 'true' }]), true);
  assert.equal(isVoucherSwitchOn(null), false);
  const c = parseNextVoucherConfig([{ key: 'voucher_next_enabled', value: 'true' }, { key: 'voucher_next_type', value: 'percent' },
    { key: 'voucher_next_value', value: '10' }, { key: 'voucher_next_days', value: '-5' }, { key: 'voucher_next_repeat', value: 'false' }]);
  assert.equal(c.enabled, true); assert.equal(c.type, 'percent'); assert.equal(c.days, 1); assert.equal(c.repeat, false);
  assert.equal(checkNextVoucherConfig(c), null);
  assert.ok(checkNextVoucherConfig({ ...c, value: 150 }));
  assert.ok(checkNextVoucherConfig({ ...c, type: 'amount', value: 500 }));
  assert.ok(checkNextVoucherConfig({ ...c, days: 400 }));
});

test('tặng mã lần sau cho SĐT gọi nhiều nhất trên bàn; bỏ qua đơn hệ thống / SĐT sai', () => {
  const who = pickVoucherPhone([
    { customer_phone: 'BAO_BEP', total_amount: 0 },
    { customer_phone: '0901111111', customer_name: 'An', total_amount: 120000, created_at: '2026-10-29T12:00:00Z' },
    { customer_phone: '0902222222', customer_name: 'Bình', total_amount: 300000, created_at: '2026-10-29T12:10:00Z' },
    { customer_phone: '0901111111', customer_name: 'An', total_amount: 100000, created_at: '2026-10-29T12:20:00Z' },
    { customer_phone: '', customer_name: 'Admin', total_amount: 900000 },
  ]);
  assert.deepEqual([who.phone, who.name, who.total], ['0902222222', 'Bình', 300000]);
  assert.equal(pickVoucherPhone([{ customer_phone: null, total_amount: 500000 }]), null);
  assert.equal(pickVoucherPhone([{ customer_phone: '0903333333', customer_name: 'Admin', total_amount: 1 }]).name, null);
});

test('lời nhắn Zalo điền đủ thông tin', () => {
  const text = fillVoucherMessage(GIFT_MESSAGE_TEMPLATE, { code: 'BK-7K3P9X', customer_name: 'Lan', discount_type: 'amount',
    discount_value: 30000, min_bill: 200000, valid_from: '2026-10-29T15:00:00+07:00', valid_until: '2026-11-13T05:00:00+07:00' });
  assert.match(text, /tặng Lan voucher giảm 30\.000đ/);
  assert.match(text, /Mã: BK-7K3P9X/);
  assert.match(text, /Dùng từ 29\/10 đến hết 12\/11, cho bill từ 200\.000đ\./);
  assert.ok(!/\{\w+\}/.test(text), 'không sót chỗ trống');
  assert.match(fillVoucherMessage('{ten}', { customer_name: '' }), /^bạn$/);
});

test('lời cho khách: chỉ cách tự nhập mã, không lộ bàn / giờ người khác đã dùng', async () => {
  const { customerRedeemText, HOW_TO_USE, NEXT_VISIT_MESSAGE_TEMPLATE } = await import('../src/lib/voucher.mjs');
  assert.match(HOW_TO_USE, /📋 Đã gọi.*nhập mã/);
  assert.ok(NEXT_VISIT_MESSAGE_TEMPLATE.includes(HOW_TO_USE));
  const used = customerRedeemText({ reason: 'used', table_number: 5, used_at: '2026-10-29T12:40:00Z' });
  assert.equal(used, 'Mã này đã được dùng rồi ạ.');
  assert.match(customerRedeemText({ reason: 'min_bill', min_bill: 200000, base: 120000 }), /200\.000đ.*120\.000đ/);
  assert.match(customerRedeemText({ reason: 'not_yet', valid_from: '2026-10-31T05:00:00+07:00' }), /31\/10/);
  assert.match(customerRedeemText({ reason: 'too_many' }), /nhân viên/);
  assert.match(customerRedeemText({ reason: 'bill_changed' }), /gọi món trước/);
});

test('xem trước ở trang Bàn khớp SQL: bill luôn còn ít nhất 1.000đ', () => {
  const v = { discount_type: 'amount', discount_value: 50000 };
  assert.equal(calcVoucherDiscount(100000, v, 20000), 19000, 'bill 100k đã giảm tay 80k');
  assert.equal(calcVoucherDiscount(100000, v, 1000), 0);
  assert.equal(calcVoucherDiscount(100000, v), 50000, 'không truyền tổng bill → như cũ');
});

test('gửi Zalo nhiều mã: chia đợt nhỏ đủ hết 487 mã, hiện tiến độ, đợt lỗi mạng thử lại 1 lần rồi mới dừng', async () => {
  assert.ok(SEND_BATCH < SEND_MAX_IDS);
  const ids = Array.from({ length: 487 }, (_, i) => `v${i}`);
  const calls = [];
  const progress = [];
  const all = await runInBatches(ids, async batch => { calls.push(batch.length); return batch.map(id => ({ id, ok: true })); },
    { onProgress: (done, total) => progress.push(`${done}/${total}`) });
  assert.equal(all.error, null);
  assert.equal(all.results.length, 487);
  assert.deepEqual(new Set(all.results.map(r => r.id)).size, 487, 'mỗi mã đúng 1 lần');
  assert.ok(calls.every(n => n <= SEND_BATCH));
  assert.equal(calls.length, Math.ceil(487 / SEND_BATCH));
  assert.equal(progress.at(-1), '487/487');

  // Đợt 2 lỗi mạng 1 lần → thử lại được, vẫn đủ.
  let flaky = 0;
  const retried = await runInBatches(ids.slice(0, 60), async batch => {
    if (batch[0] === 'v20' && flaky++ === 0) throw new Error('mạng chập chờn');
    return batch.map(id => ({ id, ok: true }));
  });
  assert.deepEqual([retried.error, retried.results.length], [null, 60]);

  // Đợt 3 lỗi mãi → dừng, trả phần đã xong (2 đợt đầu) để bấm lại gửi tiếp.
  const stopped = await runInBatches(ids.slice(0, 100), async batch => {
    if (batch[0] === 'v40') throw new Error('máy chủ lỗi');
    return batch.map(id => ({ id, ok: true }));
  });
  assert.equal(stopped.results.length, 40);
  assert.match(stopped.error.message, /máy chủ lỗi/);
});

test('"Gửi tất cả" chỉ lấy mã còn dùng, có SĐT, chưa nhắn, chưa báo lỗi', () => {
  const at = ms => new Date(Date.now() + ms).toISOString();
  const base = { status: 'active', customer_phone: '0900000001', sent_at: null, send_error: null, valid_from: at(-3600000), valid_until: at(86400000) };
  assert.equal(canAutoSendVoucher(base), true);
  assert.equal(canAutoSendVoucher({ ...base, valid_from: at(3600000) }), true, 'mã lần sau chưa tới ngày vẫn nhắn trước được');
  assert.equal(canAutoSendVoucher({ ...base, customer_phone: null }), false);
  assert.equal(canAutoSendVoucher({ ...base, sent_at: at(-1000) }), false);
  assert.equal(canAutoSendVoucher({ ...base, send_error: 'Khách chưa nối Zalo' }), false);
  assert.equal(canAutoSendVoucher({ ...base, status: 'used' }), false);
  assert.equal(canAutoSendVoucher({ ...base, valid_until: at(-1000) }), false);
});

test('huỷ hàng loạt chỉ lấy mã còn dùng / chưa tới ngày; đợt huỷ nhỏ hơn giới hạn máy chủ', () => {
  const at = ms => new Date(Date.now() + ms).toISOString();
  const base = { status: 'active', valid_from: at(-3600000), valid_until: at(86400000) };
  assert.ok(CANCEL_BATCH <= CANCEL_MAX_IDS);
  assert.equal(canCancelVoucher(base), true);
  assert.equal(canCancelVoucher({ ...base, sent_at: at(-1000) }), true, 'mã đã nhắn khách vẫn huỷ được (có hỏi lại)');
  assert.equal(canCancelVoucher({ ...base, valid_from: at(3600000) }), true);
  assert.equal(canCancelVoucher({ ...base, status: 'used' }), false);
  assert.equal(canCancelVoucher({ ...base, status: 'cancelled' }), false);
  assert.equal(canCancelVoucher({ ...base, valid_until: at(-1000) }), false);
});
