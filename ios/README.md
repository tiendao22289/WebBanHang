# App iPhone "Chấm công" (máy quầy)

App mở sẵn trang https://ocbaokhang.online/chamcong toàn màn hình (chỉ hiện mã QR cho nhân viên quét) và
thêm phần trang web không làm được:

- **Đọc to** kết quả quét bằng giọng tiếng Việt của máy, kể cả khi gạt nút im lặng.
- **Tự khoá màn hình** sau thời gian chủ quán chọn (30 giây … 10 phút, hoặc không khoá) khi không ai dùng.
  Bấm nút Home mở khoá là app chạy tiếp ngay. Cần đặt Cài đặt → Màn hình & Độ sáng → Tự động khoá → 30 giây.
- **Nút ☰** ở góc trên: chủ quán nhập số điện thoại + PIN admin (kiểm tra bằng trang đăng nhập của quán,
  xong đăng xuất ngay) để tạm dừng / chạy lại máy quầy, chọn thời gian tự khoá, tải lại trang.

Không cho thoát app: dùng chế độ có sẵn của iPhone — Cài đặt → Trợ năng → Truy cập được hướng dẫn → Bật,
đặt mã riêng; mở app, bấm Home 3 lần → Bắt đầu. Thoát: bấm Home 3 lần, nhập mã.

Cài: tải file `ChamCong.ipa` (artifact "ChamCong-ipa" của workflow "iOS kiosk app") → mở bằng
TrollStore → Install. Lần đầu mở app: chủ quán đăng nhập bật máy quầy như trên web.

Mã nguồn: `ChamCong/` (app), `project.yml` (XcodeGen).

## Trang web ↔ app

- App gắn `window.ChamCongApp = { version, face: false }` trước khi trang chạy; user agent có thêm
  `ChamCongApp/<version>`.
- Trang gửi `window.webkit.messageHandlers.kiosk.postMessage(msg)`: `speak {text}`, `wake` (có người dùng:
  đếm lại giờ khoá), `busy {on}` (đang báo kết quả: chưa khoá).
- Vừa mở khoá / mở lại app: app gọi `window.ChamCongApp.onWake()` để trang lấy mã mới ngay.
