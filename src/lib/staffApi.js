// Gọi các API ghi dữ liệu nhân viên (cookie đăng nhập tự gửi kèm).
async function call(path, action, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ action, ...body }) });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw new Error(result.error || 'Không lưu được, thử lại.');
  return result;
}

export const workforce = (action, body) => call('/api/admin/workforce', action, body);
export const notesApi = (action, body) => call('/api/admin/notes', action, body);
