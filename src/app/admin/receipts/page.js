import { redirect } from 'next/navigation';

// Trang Bill giấy cũ: giờ là tab "Bill giấy" trong trang Mã QR.
export default function ReceiptsPage() {
  redirect('/admin/qr?tab=bill');
}
