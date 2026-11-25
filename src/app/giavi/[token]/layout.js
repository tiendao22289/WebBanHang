// Trang của chủ gia vị (mở bằng link riêng quán gửi qua Zalo): không vào danh bạ tìm kiếm.
export const metadata = {
  title: 'Đơn gia vị của quán',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'Đơn gia vị' },
};

export default function SpiceSupplierLayout({ children }) {
  return children;
}
