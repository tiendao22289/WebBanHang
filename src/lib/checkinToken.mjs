/**
 * Mã QR chấm công hiện trên máy quầy. Mỗi mã có chữ ký của máy chủ, ghi máy
 * quầy nào tạo ra và một số ngẫu nhiên riêng (để mỗi mã chỉ dùng được một
 * lần). Máy quầy đổi mã mỗi 30 giây hoặc ngay khi có người vừa dùng; máy chủ
 * nhận mã tới 2 phút (đủ để nhân viên đăng nhập lần đầu).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CHECKIN_SHOW_MS = 30 * 1000;
export const CHECKIN_MAX_AGE_MS = 2 * 60 * 1000;
export const KIOSK_COOKIE = process.env.APP_ENV === 'dev' ? 'dev_checkin_kiosk' : 'checkin_kiosk';
export const DEVICE_COOKIE = process.env.APP_ENV === 'dev' ? 'dev_checkin_device' : 'checkin_device';
export const KIOSK_COOKIE_SECONDS = 2 * 365 * 24 * 60 * 60;
export const DEVICE_COOKIE_SECONDS = 400 * 24 * 60 * 60;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const sign = (purpose, text, secret) => createHmac('sha256', secret).update(`${purpose}:${text}`).digest('base64url');
const sameSig = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function kioskQrToken(secret, kioskId, now = Date.now()) {
  const body = `${Math.floor(now / 1000).toString(36)}.${kioskId.replace(/-/g, '')}.${randomBytes(9).toString('base64url')}`;
  return `${body}.${sign('checkin', body, secret).slice(0, 22)}`;
}

/** { kioskId, nonce, issuedAt, ageMs } nếu mã đúng chữ ký và chưa quá 2 phút, không thì null. */
export function readKioskQrToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || String(token).length > 200) return null;
  const [t, hex, nonce, sig] = parts;
  if (!/^[\da-f]{32}$/i.test(hex) || !/^[\w-]{12}$/.test(nonce) || !sameSig(sig, sign('checkin', `${t}.${hex}.${nonce}`, secret).slice(0, 22))) return null;
  const issuedAt = parseInt(t, 36) * 1000;
  const ageMs = now - issuedAt;
  if (!Number.isSafeInteger(issuedAt) || ageMs > CHECKIN_MAX_AGE_MS || ageMs < -30000) return null;
  const kioskId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
  return { kioskId, nonce, issuedAt, ageMs };
}

/** Cookie của máy quầy: chỉ cho xem mã QR, không vào được trang quản lý. */
export function signKioskCookie(kioskId, secret, now = Date.now()) {
  const body = `${kioskId}.${Math.floor(now / 1000) + KIOSK_COOKIE_SECONDS}`;
  return `${body}.${sign('kiosk', body, secret)}`;
}

export function readKioskCookie(value, secret, now = Date.now()) {
  const [kioskId, exp, sig, extra] = String(value || '').split('.');
  if (extra !== undefined || !UUID.test(kioskId || '') || !sig || !sameSig(sig, sign('kiosk', `${kioskId}.${exp}`, secret))) return null;
  return Number(exp) > now / 1000 ? kioskId.toLowerCase() : null;
}

export const newDeviceId = () => randomBytes(18).toString('base64url');
export const validDeviceId = id => /^[\w-]{24}$/.test(String(id || ''));
