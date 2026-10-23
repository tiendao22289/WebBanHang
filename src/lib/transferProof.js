'use client';
import { fetchWithTimeout } from './compressImage';

// Lưu ảnh màn hình chuyển khoản của khách cho các bill vừa thanh toán (cả bàn
// gộp dùng chung một ảnh) vào Sổ thu chi. Không đụng tới việc thanh toán.
export async function saveTransferProof(orderIds, blob) {
  const form = new FormData();
  form.set('action', 'attach_transfer');
  form.set('order_ids', orderIds.join(','));
  form.set('image', blob, 'ck.jpg');
  const response = await fetchWithTimeout('/api/admin/receipts', { method: 'POST', body: form, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Không lưu được ảnh chuyển khoản.');
  return result;
}
