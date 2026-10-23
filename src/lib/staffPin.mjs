/**
 * Mã PIN nhân viên lưu dạng băm có khoá bí mật của máy chủ (khoá service role,
 * không có trong trang web), nên ai đọc được bảng staff cũng không dò ra PIN.
 * PIN cũ còn lưu chữ thường vẫn đăng nhập được và được băm ngay lần đó.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'h1$';
export const isHashedPin = value => String(value || '').startsWith(PREFIX);

export function hashPin(staffId, pin, secret) {
  if (!secret || secret.length < 20) throw new Error('Thiếu khoá bí mật để băm PIN.');
  return PREFIX + createHmac('sha256', secret).update(`staff-pin:${staffId}:${String(pin).trim()}`).digest('hex');
}

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function pinMatches(stored, staffId, pin, secret) {
  if (!stored || !String(pin || '').trim()) return false;
  return isHashedPin(stored) ? same(stored, hashPin(staffId, pin, secret)) : same(stored, String(pin).trim());
}

export const validPin = pin => /^\d{4,8}$/.test(String(pin || ''));
