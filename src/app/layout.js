import './globals.css';

export const metadata = {
  title: 'Nhà Hàng - Hệ thống đặt món',
  description: 'Hệ thống đặt món ăn qua QR Code cho nhà hàng',
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
