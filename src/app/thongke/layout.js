import './thongke.css';

// "Thêm vào màn hình chính" từ trang này tạo biểu tượng "Thống kê" mở thẳng /thongke, thay vì app
// "Nhà Hàng" của manifest chung (mở /admin/tables). Link sang /admin/... nằm ngoài scope nên mở
// trong khung trình duyệt có nút Xong/X, bấm là quay lại trang thống kê.
export const metadata = {
  title: 'Thống kê doanh thu',
  robots: { index: false, follow: false },
  manifest: '/thongke-manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Thống kê' },
};

export default function ThongKeLayout({ children }) {
  return children;
}
