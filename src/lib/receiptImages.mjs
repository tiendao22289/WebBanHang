// Ảnh bill giấy / ảnh chuyển khoản cho Sổ thu chi. Chỉ dùng phía server
// (service role). Ảnh nằm trong bucket RIÊNG TƯ trên máy chủ quán; xem qua
// đường dẫn ký tạm (hết hạn sau 1 giờ). Ảnh cũ hơn RECEIPT_IMAGE_DAYS tự xoá.
import { RECEIPT_BUCKET, RECEIPT_IMAGE_DAYS, RECEIPT_IMAGE_MAX_BYTES } from './ownerFinance.mjs';

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Đường dẫn do uploadReceiptImage đặt: YYYY-MM/<loại>-<uuid>.<đuôi>
const RECEIPT_PATH = /^\d{4}-\d{2}\/[a-z]+-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(jpg|png|webp)$/;
const SIGN_TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;
export const RECEIPT_IMAGE_ROUTE = '/api/admin/receipts/image';
let bucketReady = false;

export async function ensureReceiptBucket(db) {
  if (bucketReady) return;
  const { error } = await db.storage.getBucket(RECEIPT_BUCKET);
  if (error) {
    const created = await db.storage.createBucket(RECEIPT_BUCKET, {
      public: false, fileSizeLimit: RECEIPT_IMAGE_MAX_BYTES, allowedMimeTypes: Object.keys(TYPES),
    });
    if (created.error && !/exist/i.test(created.error.message || '')) throw created.error;
  }
  bucketReady = true;
}

/** Kiểm tra file ảnh từ form; trả lỗi tiếng Việt hoặc null. */
export function receiptImageProblem(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size) return 'Thiếu ảnh.';
  if (!TYPES[file.type]) return 'Ảnh phải là JPG, PNG hoặc WebP.';
  if (file.size > RECEIPT_IMAGE_MAX_BYTES) return 'Ảnh quá lớn (tối đa 2MB).';
  return null;
}

/** Lưu ảnh, trả đường dẫn trong bucket: YYYY-MM/<loại>-<uuid>.jpg */
export async function uploadReceiptImage(db, file, kind) {
  await ensureReceiptBucket(db);
  const path = `${new Date().toISOString().slice(0, 7)}/${kind}-${crypto.randomUUID()}.${TYPES[file.type]}`;
  const { error } = await db.storage.from(RECEIPT_BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), {
    contentType: file.type, upsert: false,
  });
  if (error) throw error;
  return path;
}

export async function removeReceiptImages(db, paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  const { error } = await db.storage.from(RECEIPT_BUCKET).remove(list);
  if (error) console.error('[receipt images] remove', error);
}

/**
 * Link ký của Supabase mang địa chỉ nội bộ của máy quán (prod: http://localhost:8000)
 * — điện thoại mở ocbaokhang.online không vào được, ảnh trắng. Nên trả link cùng tên
 * miền với web: RECEIPT_IMAGE_ROUTE lấy hộ ảnh từ Supabase. Mã ký giữ nguyên (1 ảnh, 1 giờ).
 */
export function receiptImageLink(path, signedUrl) {
  let token = null;
  try { token = new URL(signedUrl).searchParams.get('token'); } catch {}
  if (!RECEIPT_PATH.test(path || '') || !SIGN_TOKEN.test(token || '')) return null;
  return `${RECEIPT_IMAGE_ROUTE}?p=${encodeURIComponent(path)}&token=${token}`;
}

/** Địa chỉ ảnh trong Supabase cho RECEIPT_IMAGE_ROUTE; null nếu đường dẫn / mã ký lạ. */
export function receiptImageSource(path, token, supabaseUrl) {
  if (!RECEIPT_PATH.test(path || '') || !SIGN_TOKEN.test(token || '') || !supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/sign/${RECEIPT_BUCKET}/${path}?token=${token}`;
}

/** { path: link xem ảnh } cho các ảnh còn giữ. */
export async function signReceiptImages(db, paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return {};
  const { data, error } = await db.storage.from(RECEIPT_BUCKET).createSignedUrls(list, 3600);
  if (error) { console.error('[receipt images] sign', error); return {}; }
  return Object.fromEntries((data || []).filter(d => d.signedUrl && !d.error)
    .map(d => [d.path, receiptImageLink(d.path, d.signedUrl)]).filter(([, link]) => link));
}

/**
 * Xoá ảnh quá hạn (mỗi lần tối đa 100 dòng để không chậm trang). Số tiền và
 * dòng sổ vẫn giữ, chỉ bỏ ảnh.
 */
export async function purgeOldReceiptImages(db) {
  const cutoff = new Date(Date.now() - RECEIPT_IMAGE_DAYS * 86400000).toISOString();
  const paper = await db.from('finance_manual_receipts').select('id, image_path, transfer_image_path')
    .lt('received_at', cutoff).is('images_purged_at', null).limit(100);
  if (!paper.error && paper.data?.length) {
    await removeReceiptImages(db, paper.data.flatMap(r => [r.image_path, r.transfer_image_path]));
    await db.from('finance_manual_receipts').update({ image_path: null, transfer_image_path: null, images_purged_at: new Date().toISOString() })
      .in('id', paper.data.map(r => r.id));
  }
  const bills = await db.from('finance_revenue_ledger').select('order_id, transfer_image_path, cash_image_path')
    .lt('paid_at', cutoff).or('transfer_image_path.not.is.null,cash_image_path.not.is.null').limit(100);
  if (!bills.error && bills.data?.length) {
    await removeReceiptImages(db, bills.data.flatMap(r => [r.transfer_image_path, r.cash_image_path]));
    await db.from('finance_revenue_ledger').update({ transfer_image_path: null, cash_image_path: null }).in('order_id', bills.data.map(r => r.order_id));
  }
}
