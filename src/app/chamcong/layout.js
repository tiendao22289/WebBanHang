// Máy quầy chấm công là một app web riêng: "Thêm vào màn hình chính" từ trang này tạo biểu tượng
// "Chấm công" mở thẳng /chamcong toàn màn hình (không thanh trình duyệt), thay vì app "Nhà Hàng"
// của manifest chung (mở /admin/tables).
export const metadata = {
  title: 'Máy quầy chấm công',
  robots: { index: false, follow: false },
  manifest: '/chamcong-manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Chấm công' },
};

export const viewport = { themeColor: '#0f172a' };

export default function ChamCongLayout({ children }) {
  return children;
}
