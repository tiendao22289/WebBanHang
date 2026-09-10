// A reserved reward is not delivered until its bill item has been recorded.
export function luckyRewardState(spin) {
  if (!spin) return 'checking';
  if (spin.status === 'blocked') return 'blocked';
  if (spin.status !== 'applied') return 'waiting_follow';
  if (spin.applied_item_id) return 'done';
  if (['gift', 'gift_drink', 'gift_dish'].includes(spin.prize_type)) {
    return 'choose_gift';
  }
  return 'saving';
}

// Cổng điều phối 2 bước quà nước/món trên popup vòng xoay: CHỌN MÓN TRƯỚC rồi
// mới QUAN TÂM ZALO. Trước đây ép quan tâm Zalo trước → khách iOS back từ app
// Zalo hay bị văng trang, chưa kịp chọn món nên quà không vào bill. Chọn món
// trước thì pick-gift lưu gift_menu_item_id ngay (không cần đã follow); khi
// khách quan tâm + nhắn SĐT, webhook server tự ghi quà — không cần app còn mở.
// Tách hàm thuần để test được mọi nhánh mà không phải render component.
export function wheelGiftGate({ spin, prizeType, hasPrize, requireFollow }) {
  const state = luckyRewardState(spin);
  // Cùng danh sách loại quà cần chọn món như luckyRewardState — giữ inline để
  // module này không phụ thuộc file khác (test nạp qua data: URL, không resolve
  // được import tương đối).
  const isGift = ['gift', 'gift_drink', 'gift_dish'].includes(prizeType);
  const giftChosen = !!spin?.gift_menu_item_id;
  const done = state === 'done';
  // Hiện bước chọn món khi trúng quà nước/món + khách CHƯA chọn + chưa xong +
  // chưa bị chặn. spin=null ngay sau khi quay cũng coi là chưa chọn → picker
  // hiện luôn, trước cả bước Quan tâm Zalo.
  const needsGiftPick = isGift && !giftChosen && !done && spin?.status !== 'blocked';
  // Bước Quan tâm Zalo còn treo khi cần follow + lượt quay chưa applied/blocked
  // — NHƯNG với quà nước/món phải chọn xong món đã (needsGiftPick=false). Quà
  // %/tiền không có bước chọn nên hiện Quan tâm Zalo ngay.
  const followPending = !!hasPrize && !!requireFollow && !needsGiftPick
    && (state === 'waiting_follow' || state === 'checking');
  return { needsGiftPick, followPending, isGift, giftChosen };
}

export function luckyPrizeTitle(prize) {
  const type = prize?.prize_type ?? prize?.prizeType;
  const value = Number(prize?.prize_value ?? prize?.prizeValue);
  if (type === 'percent' && value > 0) return `Giảm ${value}% hoá đơn`;
  if (type === 'gift_drink' && value > 0) return `Tặng ${value} nước tuỳ chọn`;
  return prize?.prize_label || prize?.prizeLabel || 'Phần quà của Quý khách';
}

export function shouldResumeLucky(spin, pendingId, dismissedId) {
  if (!spin || dismissedId === spin.id) return false;
  if (pendingId === spin.id) return true; // Include success not yet acknowledged.
  return false; // An old cached spin alone is not permission to reopen a popup.
}

export function hasPendingLuckySpin(storedId, pendingId) {
  return Boolean(storedId && storedId === pendingId);
}

export async function fetchLuckyNudgeConfig(supabase) {
  const { data, error } = await supabase.from('settings').select('key, value')
    .in('key', ['lucky_wheel_enabled', 'lucky_wheel_auto_nudge', 'lucky_wheel_min_bill']);
  if (error || !data) return null;
  const values = Object.fromEntries(data.map(row => [row.key, row.value]));
  return { enabled: values.lucky_wheel_enabled === 'true',
    autoNudge: values.lucky_wheel_auto_nudge === 'true',
    minBill: Number(values.lucky_wheel_min_bill) || 0 };
}

export function newLuckyRequestId(cryptoApi = globalThis.crypto) {
  if (cryptoApi.randomUUID) return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
