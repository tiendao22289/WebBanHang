// Các tab của chủ quán cần mã PIN (dùng được cả ở trang web lẫn máy chủ — không có thư viện mã hoá).
export const LOCKED_PATHS = ['/admin/payroll', '/admin/stats', '/admin/customers', '/admin/settings', '/admin/finance'];

export const isLockedPath = pathname => LOCKED_PATHS.some(p => pathname === p || pathname?.startsWith(`${p}/`));
/** Tên khu vực từ đường dẫn: '/admin/payroll' → 'payroll'. */
export const lockedSection = pathname => LOCKED_PATHS.find(p => pathname === p || pathname?.startsWith(`${p}/`))?.slice('/admin/'.length) || null;
