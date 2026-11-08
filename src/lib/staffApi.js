import { fetchWithTimeout } from './compressImage';

// Gọi các API ghi dữ liệu nhân viên (cookie đăng nhập tự gửi kèm).
async function call(path, action, body = {}) {
  return readResult(await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ action, ...body }) }));
}

async function readResult(response) {
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw new Error(result.error || 'Không lưu được, thử lại.');
  return result;
}

export const workforce = (action, body) => call('/api/admin/workforce', action, body);
export const notesApi = (action, body) => call('/api/admin/notes', action, body);

/** Sổ tay kèm ảnh (phiếu đi chợ): multipart payload = JSON, photo = ảnh. Mạng yếu thì báo lỗi sau 45 giây. */
export async function notesApiWithPhotos(action, body, photos) {
  const form = new FormData();
  form.append('payload', JSON.stringify({ action, ...body }));
  photos.forEach((photo, i) => form.append('photo', photo, `phieu-${i + 1}.jpg`));
  return readResult(await fetchWithTimeout('/api/admin/notes', { method: 'POST', body: form, cache: 'no-store' }));
}
