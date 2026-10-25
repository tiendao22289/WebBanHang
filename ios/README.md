# App iPhone "Chấm công" (máy quầy)

App mở sẵn trang https://ocbaokhang.online/chamcong toàn màn hình và thêm phần trang web không làm được:

- **So khuôn mặt**: khi trang yêu cầu, app mở camera trước, bắt chớp mắt, rồi gửi cho trang "dấu mặt"
  (128 con số). Ảnh không được lưu, không gửi đi.
- **Đọc to** kết quả bằng giọng tiếng Việt của máy, kể cả khi gạt nút im lặng.
- **Tự tối màn hình** sau 10 giây không ai chạm; chạm một cái là sáng lại (cú chạm đó chỉ để đánh thức).

Cài: tải file `ChamCong.ipa` (artifact "ChamCong-ipa" của workflow "iOS kiosk app") → mở bằng
TrollStore → Install. Lần đầu mở app: cho phép Camera; chủ quán đăng nhập bật máy quầy như trên web.
Khoá máy chỉ còn app này: Cài đặt → Trợ năng → Truy cập được hướng dẫn.

Mã nguồn: `ChamCong/` (app), `FaceKit/` (nhận diện khuôn mặt, có test), `tools/` (tạo mẫu nhận diện,
ảnh test), `project.yml` (XcodeGen). Bên thứ ba: `NOTICE.md`.

## Trang web ↔ app

- App gắn `window.ChamCongApp = { version, face: true, model: 'sface-2021dec' }` trước khi trang chạy;
  user agent có thêm `ChamCongApp/<version>`.
- Trang gửi `window.webkit.messageHandlers.kiosk.postMessage(msg)`:
  `speak {text}`, `wake`, `busy {on}`, `face {id, mode: 'verify'|'enroll', name, prompt?}`, `cancelFace {id}`.
- Kết quả so mặt: app gọi `window.ChamCongApp.onFace(id, result)` với
  `{ok: true, live: true, embeddings: number[][]}` (verify 1–2 vector, enroll 3 vector, mỗi vector 128 số đã
  chuẩn hoá L2) hoặc `{ok: false, reason: 'no_face'|'no_blink'|'camera'|'busy'|'cancelled'|'error', message?}`.
  Hết giờ: verify 20 giây, enroll 30 giây.
- Màn hình sáng lại sau khi tối: app gọi `window.ChamCongApp.onWake()`.
