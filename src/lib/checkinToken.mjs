/**
 * Mã QR chấm công: đổi mỗi 5 phút và có chữ ký của máy chủ, nên không ai tự
 * tính ra được để chấm công khi không ở quán (mã cũ chỉ là số phút chia 5).
 */
import { createHmac } from 'node:crypto';

export const CHECKIN_WINDOW_MS = 5 * 60 * 1000;
const sign = (window, secret) => createHmac('sha256', secret).update(`checkin:${window}`).digest('hex').slice(0, 16);

export function checkinToken(secret, now = Date.now()) {
  const window = Math.floor(now / CHECKIN_WINDOW_MS);
  return { token: `${window}.${sign(window, secret)}`, expiresInMs: (window + 1) * CHECKIN_WINDOW_MS - now };
}

/** Mã của 5 phút hiện tại hoặc 5 phút trước (đang quét đúng lúc đổi mã). */
export function checkinTokenValid(token, secret, now = Date.now()) {
  const [w, sig] = String(token || '').split('.');
  const window = Number(w);
  const current = Math.floor(now / CHECKIN_WINDOW_MS);
  return Number.isInteger(window) && (window === current || window === current - 1) && !!sig && sig === sign(window, secret);
}
