'use client';
// Thu nhỏ ảnh chụp từ điện thoại trước khi gửi (3–5MB → ~100–200KB): cạnh
// dài tối đa 1280px, JPEG chất lượng 0.7 — chữ trên bill / màn hình chuyển
// khoản vẫn đọc rõ. Lỗi thì gửi ảnh gốc nếu đủ nhỏ.
const MAX_SIDE = 1280;
const QUALITY = 0.7;
const MAX_BYTES = 2 * 1024 * 1024;

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
  try {
    const img = await loadImage(file);
    const width = img.width || img.naturalWidth;
    const height = img.height || img.naturalHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (blob && blob.size <= MAX_BYTES) return blob;
  } catch { /* dùng ảnh gốc bên dưới */ }
  if (file.size <= MAX_BYTES && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
  throw new Error('Ảnh quá lớn hoặc không đọc được, chụp lại giúp nhé.');
}
