# Kế hoạch Thêm Nút "Nhận Tiền Mặt"

## 1. Phân tích yêu cầu
- **Vị trí hiển thị:** Nằm ngay bên dưới hoặc bên cạnh nút "Tạo mã QR" hiện tại trên trang `/admin/qr`.
- **Điều kiện bắt buộc:** Người dùng phải nhập số tiền (> 0) thì mới cho phép bấm nút "Nhận tiền mặt" (giống như điều kiện tạo QR).
- **Tính năng và cơ chế hoạt động (Giống 100% thanh toán Tiền mặt ở mục Quản lý bàn):**
  - Khi bấm vào "Nhận tiền mặt", hệ thống sẽ lấy tài khoản ngân hàng đang hoạt động hiện tại (thông qua hàm `getActiveAccount`).
  - Cộng trực tiếp số tiền vừa nhập vào định mức trong ngày của tài khoản đó (`bank_daily_totals`).
  - Lưu ý: Không cần tạo mã QR hay lưu vào `payment_transactions` chờ webhook, mà hệ thống sẽ xử lý cộng tiền trực tiếp và báo thành công luôn.
  - Hiển thị thông báo "✅ Nhận tiền mặt thành công!" và xóa trắng form để sẵn sàng cho lần tiếp theo.

## 2. Chi tiết thực hiện

### A. Giao diện (UI) tại `src/app/admin/qr/page.jsx`
- Thêm một nút **"💵 Nhận tiền mặt"** (màu xanh lá cây) bên cạnh hoặc bên dưới nút "Tạo mã QR" (màu xanh dương).
- Trạng thái của nút (Bật/Tắt) sẽ phụ thuộc vào ô nhập số tiền (Nếu chưa nhập tiền sẽ bị mờ và không bấm được).

### B. Logic xử lý (Hàm `handleCashPayment`)
1. Kiểm tra số tiền nhập vào có hợp lệ (> 0) không.
2. Gọi hàm `getActiveAccount()` để lấy tài khoản đang nhận tiền (kèm `shouldHideStats`).
3. Thực hiện logic cộng định mức (Giống `recordBankPayment`):
   - Tìm bản ghi `bank_daily_totals` của tài khoản hiện tại trong ngày hôm nay.
   - Nếu có, cộng thêm `amount`.
   - Nếu chưa, tạo mới với `total_amount = amount`.
4. Hiển thị thông báo (SweetAlert2) "💵 Nhận tiền mặt thành công!" với số tiền tương ứng (Màu xanh lá).
5. Xóa trắng ô số tiền, mã giao dịch và trạng thái thanh toán để làm mới giao diện.

## User Review Required
> [!IMPORTANT]
> **Xác nhận luồng hoạt động:**
> - Bấm **"Nhận tiền mặt"** -> Cộng ngay số tiền vào định mức của tài khoản đang xoay vòng hiện tại -> Báo thành công -> Xóa trắng form.
> - Không lưu vào lịch sử hóa đơn bàn (vì đây là mục nhập số rời).
>
> Bạn xem qua mô tả trên, nếu thấy "OK" thì phản hồi lại để mình viết code nhé!
