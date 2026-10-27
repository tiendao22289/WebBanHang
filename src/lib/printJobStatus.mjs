/**
 * Phiếu in bếp nào đang lỗi thật — để thẻ bàn báo đỏ và dòng món hiện "🖨️ chưa in".
 */

// Job còn 'pending' quá 60s coi như treo (PrintAgent tắt / rớt mạng) — job dạng
// này không bao giờ tự chuyển 'failed'. Job 'printing' quá 3 phút: máy in /
// PrintAgent khởi động lại giữa chừng, phiếu kẹt ở đó mãi mà trước đây không báo.
export const STALE_PRINT_JOB_MS = 60000;
export const STALE_PRINTING_JOB_MS = 180000;

export function isPrintJobBad(pj, now = Date.now()) {
  if (pj.status === 'failed') return true;
  const age = pj.created_at ? now - new Date(pj.created_at).getTime() : 0;
  if (pj.status === 'pending') return age > STALE_PRINT_JOB_MS;
  if (pj.status === 'printing') return age > STALE_PRINTING_JOB_MS;
  return false;
}

const sameSet = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every(v => y.has(v));
};

// Kẹt hàng đợi thường tự in lại được (hoặc nhân viên bấm "In Bếp" lần nữa) nhưng
// dòng 'failed' cũ vẫn nằm nguyên → thẻ bàn đỏ mãi. Coi lệnh lỗi là ĐÃ XỬ LÝ chỉ khi
// CÙNG máy in đã in xong 1 phiếu tạo SAU nó với ĐÚNG những món đó (cùng danh mục /
// cùng dòng món). Trước đây phiếu in xong TRƯỚC đó 10 phút, hay phiếu tạm tính /
// phiếu quà cùng máy, cũng che mất phiếu lỗi → bếp không nhận mà không ai biết.
export function isJobResolvedByReprint(job, allJobs) {
  if (!job || !job.printer_id) return false;
  const t = new Date(job.created_at || 0).getTime();
  return (allJobs || []).some(j =>
    j.status === 'done' && j.printer_id === job.printer_id && j.id !== job.id
    && new Date(j.created_at || 0).getTime() >= t
    && sameSet(j.order_ids, job.order_ids)
    && (job.only_item_ids
      ? (j.only_item_ids || []).length > 0 && job.only_item_ids.every(id => j.only_item_ids.includes(id))
      : j.only_item_ids == null && sameSet(j.filter_category_ids, job.filter_category_ids))
  );
}

// Lệnh in CÒN LỖI THẬT của 1 đơn (lỗi / treo VÀ chưa được in lại thành công).
export function isUnresolvedBadJob(job, order, now = Date.now()) {
  return isPrintJobBad(job, now) && !isJobResolvedByReprint(job, order?.print_jobs || []);
}
