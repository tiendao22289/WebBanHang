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
