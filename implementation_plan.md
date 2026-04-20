# Kế hoạch tính năng: Mã Bill cố định cho Thanh toán

Dưới đây là ý hiểu của mình về yêu cầu của bạn:

## 1. Phân tích yêu cầu (Ý hiểu)
- **Vấn đề hiện tại:** Hiện giờ khi bấm "Thanh toán" trên máy tính, cửa sổ đầu tiên (chọn Tiền mặt / Chuyển khoản) chưa có mã bill. Chỉ khi bấm tiếp vào "Chuyển khoản" thì hệ thống mới sinh ra một mã giao dịch (`transactionCode`) ngẫu nhiên và lưu vào database. Mỗi lần tắt mở lại "Chuyển khoản" nó lại sinh mã mới (nếu code cũ xoá state).
- **Yêu cầu mới:**
  1. Ngay khi thu ngân bấm nút "Thanh toán" (ở giao diện chính), hệ thống sẽ hiển thị một **Mã Bill** trên cửa sổ popup đầu tiên.
  2. Mã Bill này sẽ được sử dụng làm nội dung chuyển khoản nếu khách chọn trả bằng QR/Chuyển khoản.
  3. Mã Bill này là **Cố định cho đơn hàng hiện tại**: Nếu thu ngân lỡ tay bấm tắt popup thanh toán đi, rồi bấm mở lại (cho cùng bàn đó, đơn đó) thì hệ thống vẫn lấy lại Mã Bill cũ đã tạo lúc nãy chứ không đẻ ra mã mới. Chỉ khi nào chưa có mã thì mới tạo mới.

## 2. Câu hỏi xác nhận
> [!IMPORTANT]
> **Q: Về việc lưu trữ Mã Bill để dùng lại:**
> Hiện tại khi tạo mã QR, hệ thống đã tự động lưu mã giao dịch này vào bảng `payment_transactions` (với trạng thái `pending`). 
> Để đáp ứng yêu cầu "tắt đi mở lại vẫn giữ nguyên mã", mình sẽ làm theo logic sau:
> - Khi bấm "Thanh toán", hệ thống sẽ query bảng `payment_transactions` xem có mã nào đang `pending` cho bàn/đơn hàng này chưa. 
> - Nếu CÓ -> Tái sử dụng hiển thị mã đó.
> - Nếu KHÔNG -> Sinh mã mới (ví dụ `A8F3K9`) và lưu vào bảng.
> 
> Nhờ cách này, dù thu ngân có **F5 tải lại trang web** thì lúc bấm thanh toán lại nó vẫn giữ nguyên mã cũ. Bạn thấy logic này đã chuẩn 100% ý bạn chưa?

## 3. Cách thức triển khai (Sau khi bạn OK)
1. **Sửa Desktop & Mobile UI:** Tách đoạn code sinh `transactionCode` và insert vào bảng `payment_transactions` ra thành một hàm dùng chung `getOrGenerateBillCode(orders)`.
2. **Gọi hàm khi mở Popup:** Khi bấm nút "Thanh toán" (cả trên PC và Điện thoại), gọi hàm trên để lấy được `mã bill`.
3. **Hiển thị lên UI:** Bổ sung dòng "Mã Bill: #ABCXYZ" trên màn hình Popup chọn phương thức thanh toán. Đưa thẳng mã này vào QR code ở màn hình tiếp theo.
4. **Dọn dẹp State:** Đảm bảo khi bấm nút "Quay lại" hoặc "Tắt", state vẫn không làm loạn database mà chỉ đóng giao diện.

Bạn đọc lại phần ý hiểu và câu hỏi xem đã khớp với thiết kế trong đầu bạn chưa nhé! Phản hồi "OK" hoặc chỉnh sửa thêm nếu cần.
