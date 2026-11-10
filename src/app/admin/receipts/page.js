import { redirect } from 'next/navigation';

// Trang Bill giấy cũ: bỏ từ 2026-11-10 — tên bàn + ảnh bill ghi ngay trong khung Tạo mã QR (trang Mã QR).
// Bill giấy đã lưu xem ở Sổ thu chi / Tra cứu.
export default function ReceiptsPage() {
  redirect('/admin/qr');
}
