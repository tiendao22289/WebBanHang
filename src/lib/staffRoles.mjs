// Vai trò tài khoản (cột staff.role): chủ quán 'admin', quản lý 'manager', nhân viên 'staff'.
// Quản lý chấm công bằng quét mã như nhân viên (không phải admin), được thêm Thực đơn, Sổ tay và
// nút ★ Đánh giá khách hàng ở trang Bàn. Không vào các tab của chủ quán (Thống kê, Khách hàng, Cài đặt…).
export const ROLES = ['staff', 'manager', 'admin'];
export const normalizeRole = role => (ROLES.includes(role) ? role : 'staff');

export const ROLE_LABELS = { admin: '👑 Admin', manager: '🧑‍💼 Quản lý', staff: '👤 Nhân viên' };
export const roleLabel = role => ROLE_LABELS[normalizeRole(role)];

const STAFF_PATHS = ['/admin/tables', '/admin/payroll', '/admin/qr', '/admin/receipts'];
const MANAGER_PATHS = [...STAFF_PATHS, '/admin/menu', '/admin/notes'];

/** Các trang /admin/* tài khoản này được mở; null = admin, mở hết. */
export const allowedPaths = role => (role === 'admin' ? null : role === 'manager' ? MANAGER_PATHS : STAFF_PATHS);
export const canOpenPath = (role, pathname) => {
  const paths = allowedPaths(role);
  return !paths || paths.some(p => pathname === p || pathname?.startsWith(`${p}/`));
};
/** Sổ tay: quản lý và admin xem phiếu của cả quán (xoá phiếu, sửa loại "Khác" vẫn chỉ admin). */
export const seesAllNotes = role => role === 'admin' || role === 'manager';
/** Quản lý và admin xem được Đánh giá khách hàng. */
export const canSeeReviews = role => role === 'admin' || role === 'manager';
