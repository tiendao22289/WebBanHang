// Đơn chờ chủ quán duyệt ở Lương → Yêu cầu: một định nghĩa cho cả tab Yêu cầu (nút "Chờ duyệt", số trên nút tab) và số trên
// biểu tượng ví ở thanh menu admin (GET /api/admin/workforce?pending=1). Đổi gì ở đây thì hai chỗ đổi theo, không lệch nhau.

/** Loại đơn ở tab Yêu cầu, đúng thứ tự nút lọc. */
export const PENDING_KINDS = ['advance', 'absent', 'claim', 'peer', 'fix', 'extra', 'face'];

/**
 * Một dòng còn chờ duyệt không. Giờ ngoài ca chưa duyệt (extra) và ca sai mặt 3 lần (face): máy chủ chỉ gửi những ca còn chờ,
 * nên luôn là chờ duyệt. Các loại khác: status 'pending'.
 */
export const isPendingRequest = (kind, row) => kind === 'extra' || kind === 'face' || row?.status === 'pending';

/** Loại của một đơn ứng lương / báo nghỉ (bảng payroll_requests). */
export const requestKind = row => (row?.request_type === 'advance' ? 'advance' : 'absent');

/**
 * Đếm đơn chờ duyệt theo loại từ đúng các danh sách tab Yêu cầu đang hiện:
 * requests = payroll_requests (ứng lương / báo nghỉ), claims = chi hộ quán, peers = báo lỗi đồng nghiệp, fixes = xin sửa giờ,
 * extras = giờ ngoài ca chưa duyệt, faceReviews = ca sai mặt 3 lần (chỉ ca còn tìm thấy).
 * @returns {{ advance: number, absent: number, claim: number, peer: number, fix: number, extra: number, face: number, total: number }}
 */
export function pendingRequestCounts({ requests = [], claims = [], peers = [], fixes = [], extras = [], faceReviews = [] } = {}) {
  const counts = Object.fromEntries(PENDING_KINDS.map(k => [k, 0]));
  const add = (kind, row) => { if (isPendingRequest(kind, row)) counts[kind] += 1; };
  for (const r of requests || []) add(requestKind(r), r);
  for (const r of claims || []) add('claim', r);
  for (const r of peers || []) add('peer', r);
  for (const r of fixes || []) add('fix', r);
  for (const r of extras || []) add('extra', r);
  for (const r of faceReviews || []) add('face', r);
  counts.total = PENDING_KINDS.reduce((a, k) => a + counts[k], 0);
  return counts;
}

/** Số hiện trên biểu tượng ví: 0 / lỗi → không hiện, quá 99 → "99+". */
export const pendingBadgeText = n => {
  const v = Math.floor(Number(n) || 0);
  return v <= 0 ? '' : v > 99 ? '99+' : String(v);
};

/** Bấm biểu tượng ví: còn đơn chờ duyệt → mở thẳng Lương → Yêu cầu; hết thì vào Lương như thường. */
export const PAYROLL_REQUESTS_HREF = '/admin/payroll?tab=requests';
export const walletHref = n => (Number(n) > 0 ? PAYROLL_REQUESTS_HREF : '/admin/payroll');

/** Đường dẫn trang Lương có xin mở tab Yêu cầu không (?tab=requests). */
export const wantsRequestsTab = search => new URLSearchParams(String(search || '')).get('tab') === 'requests';

// Sự kiện trên window giữa thanh menu và trang Lương.
// PENDING_REFRESH: trang Lương vừa đổi số đơn chờ (duyệt / từ chối / tải lại) → thanh menu hỏi máy chủ lại ngay.
// PENDING_COUNT: thanh menu vừa có số mới từ máy chủ (detail = số) → trang Lương đang mở mà số khác thì tải lại đơn.
// OPEN_REQUESTS: bấm biểu tượng ví khi đang ở trang Lương → chuyển sang tab Yêu cầu (trang không dựng lại).
export const PENDING_REFRESH_EVENT = 'payroll-pending-refresh';
export const PENDING_COUNT_EVENT = 'payroll-pending-count';
export const OPEN_REQUESTS_EVENT = 'payroll-open-requests';

// Bấm ví lúc trang Lương chưa dựng (đang chờ nhập mã PIN): nhớ 2 phút, trang Lương mở lên thì vào thẳng tab Yêu cầu.
export const OPEN_REQUESTS_KEEP_MS = 2 * 60 * 1000;
let openAskedAt = 0;
/** Thanh menu: xin mở tab Yêu cầu (trang Lương đang mở thì nhận sự kiện ngay). */
export function askOpenRequests(now = Date.now()) {
  openAskedAt = now;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_REQUESTS_EVENT));
}
/** Trang Lương: có lời xin mở tab Yêu cầu còn hạn không (lấy một lần rồi xoá). */
export function takeOpenRequests(now = Date.now()) {
  const asked = openAskedAt > 0 && now - openAskedAt >= 0 && now - openAskedAt < OPEN_REQUESTS_KEEP_MS;
  openAskedAt = 0;
  return asked;
}
