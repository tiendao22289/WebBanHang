/**
 * Mã PIN khoá các tab nhạy cảm của chủ quán (Lương nhân viên, Thống kê & Kế toán, Khách hàng, Cài đặt,
 * Sổ thu chi): đăng nhập rồi vẫn phải nhập PIN mới mở được — người khác cầm máy chủ quán cũng không xem được.
 * Mỗi lần mở tab là mỗi lần nhập PIN (chủ quán muốn vậy, 2026-10-27): không nhớ lần mở trước.
 *
 * Lưu ở finance_settings['admin_pin'] = { salt, hash, len, fails, lockedUntil, updatedAt } — chỉ có bản băm (scrypt),
 * không lưu PIN. Sai 5 lần liền → khoá 5 phút.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PIN_KEY = 'admin_pin';
export const MAX_FAILS = 5;
export const LOCK_MINUTES = 5;
export { LOCKED_PATHS, isLockedPath } from './adminLockPaths.mjs';
export const pinValid = pin => /^\d{4,6}$/.test(String(pin ?? ''));

const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/** Bản lưu mới cho một PIN (muối ngẫu nhiên). */
export function newPinRecord(pin, secret, now = Date.now()) {
  const salt = randomBytes(16).toString('hex');
  // len: số chữ số (màn nhập PIN tự mở khi đủ số, khỏi bấm ✓).
  return { salt, hash: scryptSync(`${pin}`, `${salt}:${secret}`, 32).toString('hex'), len: String(pin).length, fails: 0, lockedUntil: null, updatedAt: new Date(now).toISOString() };
}

export function pinMatchesRecord(record, pin, secret) {
  if (!record?.salt || !record?.hash || !pinValid(pin)) return false;
  return same(Buffer.from(record.hash, 'hex'), scryptSync(`${pin}`, `${record.salt}:${secret}`, 32));
}

/** Đang bị khoá vì nhập sai nhiều lần: số giây còn phải chờ, 0 = nhập được. */
export function lockWait(record, now = Date.now()) {
  const until = Date.parse(record?.lockedUntil || '');
  return Number.isFinite(until) && until > now ? Math.ceil((until - now) / 1000) : 0;
}

/** Ghi nhận một lần nhập sai: tới MAX_FAILS lần thì khoá LOCK_MINUTES phút và đếm lại. */
export function afterFail(record, now = Date.now()) {
  const fails = (Number(record?.fails) || 0) + 1;
  return fails >= MAX_FAILS
    ? { ...record, fails: 0, lockedUntil: new Date(now + LOCK_MINUTES * 60000).toISOString() }
    : { ...record, fails, lockedUntil: null };
}
