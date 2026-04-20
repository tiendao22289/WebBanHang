# Kế hoạch Thêm Tính Năng "Tạo Mã QR Tùy Chỉnh"

Tính năng này cho phép nhân viên/quản lý tạo nhanh một mã QR thanh toán với số tiền tùy chỉnh trên giao diện chính mà không cần gắn với một bàn cụ thể nào. 

## 1. Phân tích yêu cầu (Đã cập nhật)
- **Vị trí hiển thị:** Trên thanh menu chính (navbar) dưới dạng một nút/mục mới có icon QR Code.
- **Tính năng chính:**
  - Mở ra một trang hoặc giao diện để tạo QR.
  - **Số tiền (Amount):** Mặc định là `0`, cho phép người dùng tự nhập số tiền cần thu.
  - **Nội dung thanh toán (Info / Transaction Code):** Không cho phép tự gõ tay nữa. Hệ thống sẽ **tự động sinh mã ngẫu nhiên** (ví dụ: `HD8A2B9C`) giống hệt như cách mã cũ hoạt động ở phần thanh toán bàn.
  - Giữ nguyên toàn bộ các thuật toán tạo QR và lưu trữ như phần "Chuyển khoản" (xoay vòng tài khoản, hiển thị QR code chuẩn VietQR, bắt sự kiện SePay).

## 2. Chi tiết thực hiện

### A. Giao diện (UI)
1. **Thêm mục vào Menu Chính:**
   - Cập nhật `src/app/admin/layout.js`: Thêm `{ href: '/admin/qr', label: 'Tạo mã QR', icon: QrCode }` vào mảng `ALL_NAV`.
2. **Tạo trang `/admin/qr/page.jsx`:**
   - Giao diện gồm:
     - Input **Số tiền** (nhập số, hiển thị định dạng VND).
     - Text hiển thị **Nội dung thanh toán**: Chỉ hiển thị mã tự động sinh (được tạo khi mới mở trang hoặc khi bấm tạo lại).
   - Nút **"Cập nhật mã QR"** (để tải lại ảnh QR sau khi nhập số tiền mới).
   - Vùng hiển thị ảnh QR (sử dụng hàm `buildQrUrl`).
   - Giao diện trạng thái realtime: Hiển thị "Đang chờ thanh toán..." và báo "✅ Thanh toán thành công" giống hệt màn hình thanh toán.

### B. Logic (Thuật toán)
1. Lấy thông tin tài khoản ngân hàng hoạt động hiện tại (hàm `getActiveAccount()`).
2. Sinh `transaction_code` (mã ngẫu nhiên 8 ký tự `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`) và dùng nó làm nội dung chuyển khoản.
3. Khi quét mã QR hoặc khi tạo, lưu thông tin vào bảng `payment_transactions` với `status: 'pending'`, `total_amount: <số_tiền_đã_nhập>`, `transaction_code: <mã_sinh_tự_động>`, `order_ids: 'custom_qr'`.
4. Subscription: Lắng nghe sự thay đổi của bảng `payment_transactions` thông qua Supabase Realtime để biết khi nào dòng đó chuyển thành `status: 'completed'`.

## Các file dự kiến thay đổi
- `src/app/admin/layout.js` (Thêm icon QR vào menu)
- `src/app/admin/qr/page.jsx` (Giao diện và logic tạo mã QR)
