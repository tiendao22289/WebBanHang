'use client';
/**
 * Số đơn chờ duyệt ở Lương → Yêu cầu cho biểu tượng ví trên thanh menu admin (chỉ chủ quán).
 * Hỏi máy chủ (GET /api/admin/workforce?pending=1) khi mở, mỗi phút khi tab đang hiện, khi quay lại tab, và ngay khi trang Lương
 * báo số đơn vừa đổi (duyệt / từ chối xong). Lỗi mạng thì giữ số cũ.
 */
import { usePolledCount } from './usePolledCount';
import { PENDING_COUNT_EVENT, PENDING_REFRESH_EVENT } from './payrollPending.mjs';

const pickTotal = j => j?.total;

export function usePayrollPending(enabled) {
  return usePolledCount('/api/admin/workforce?pending=1', enabled, { pick: pickTotal, refreshEvent: PENDING_REFRESH_EVENT, countEvent: PENDING_COUNT_EVENT });
}
