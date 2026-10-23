'use client';
// Thu nhỏ ảnh chụp từ điện thoại trước khi gửi (3–5MB → ~100–200KB): cạnh
// dài tối đa 1280px, JPEG chất lượng 0.7 — chữ trên bill / màn hình chuyển
// khoản vẫn đọc rõ. Lỗi thì gửi ảnh gốc nếu đủ nhỏ.
//
// iPhone: Safari tự đổi ảnh HEIC sang JPEG khi chọn qua ô chọn ảnh.
// Android (Samsung bật "ảnh HEIF"): Chrome không đọc được HEIF → báo rõ để
// chụp lại bằng nút Chụp ảnh (luôn ra JPEG).
const MAX_SIDE = 1280;
const QUALITY = 0.7;
const MAX_BYTES = 2 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* thử cách dưới */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh.')); };
    img.src = url;
  });
}

export async function compressImage(file) {
  const heif = /hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
  try {
    const img = await loadImage(file);
    const width = img.width || img.naturalWidth;
    const height = img.height || img.naturalHeight;
    if (!width || !height) throw new Error('empty');
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (blob && blob.size <= MAX_BYTES) return blob;
  } catch { /* dùng ảnh gốc bên dưới */ }
  if (file.size <= MAX_BYTES && OK_TYPES.includes(file.type)) return file;
  if (heif) throw new Error('Máy đang lưu ảnh dạng HEIF nên web không đọc được. Bấm "Chụp ảnh" để chụp trực tiếp, hoặc tắt ảnh HEIF trong cài đặt camera.');
  throw new Error('Ảnh quá lớn hoặc không đọc được, chụp lại giúp nhé.');
}

/** fetch có giới hạn thời gian — mạng 4G yếu thì báo lỗi thay vì treo. */
export async function fetchWithTimeout(url, options = {}, ms = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Mạng yếu, gửi ảnh quá lâu. Kiểm tra mạng rồi bấm lưu lại.');
    throw new Error('Không gửi được, kiểm tra mạng rồi thử lại.');
  } finally { clearTimeout(timer); }
}
