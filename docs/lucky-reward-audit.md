# Kiểm tra nhận quà vòng xoay — 2026-09-07

## Luồng sau thay đổi

1. Khách quay; mã yêu cầu được lưu trước khi gửi. Gửi lại cùng mã trả lại phần quà ban đầu.
2. Khi yêu cầu Zalo đang bật: khách quan tâm và nhắn đúng SĐT đã quay vào chat OA.
3. Webhook lưu tài khoản đã nhận diện vào lượt quay trước khi áp quà. Không suy đoán người nhận theo thời điểm follow.
4. Khách quay về hoặc mở lại web: khôi phục phần quà của phiên bàn còn mở. Không bỏ quà chỉ vì qua nửa đêm.
5. Quà món/nước: lưu lựa chọn đầu tiên, kiểm tra món còn bán và lựa chọn đầy đủ; ghi đúng số lượng bằng mã dòng cố định; gửi một lệnh in; cuối cùng lưu xác nhận.
6. Quà giảm tiền: ghi dòng giảm bằng mã cố định; tính lại tổng; chỉ lưu xác nhận sau khi cập nhật tổng thành công.
7. Khi một bước lỗi, giữ lượt quay và tiếp tục cùng dòng quà lúc thử lại. Khách chủ động chọn Để sau thì ngừng tự mở lời mời.

## Đã kiểm tra tự động

`node --test tests/lucky-reward-flow.test.mjs tests/lucky-reward-server.test.mjs`

34 trường hợp kiểm tra luồng và server đã qua, gồm:

- Khôi phục chờ Zalo, chọn món và thành công chưa được khách xác nhận.
- Để sau, mở lại thủ công, mất mạng, bill đóng và phiên bàn mới.
- 20 yêu cầu quà đồng thời: một dòng, đủ 3 suất, một lệnh in.
- 20 yêu cầu giảm giá đồng thời: một dòng giảm, tổng không bị trừ hai lần.
- Lỗi ghi xác nhận, cập nhật tổng, đọc bill hoặc gửi lệnh in: không báo hoàn tất sớm; thử lại không ghi thêm quà.
- Đối chiếu dòng quà và lệnh in từ phiên bản cũ trước khi tạo mới.
- Món hết bán, thiếu loại/khẩu vị, RPC lỗi, bill qua nửa đêm.
- Người quan tâm không được gán cho một lượt quay chỉ vì trùng thời gian.
- Mã quay lặp sau khi mất phản hồi vẫn trả phần quà ban đầu.

Các kiểm thử server sử dụng mô hình database có ràng buộc khóa chính và chèn lỗi có chủ đích, không phải kiểm thử đồng thời trên Supabase thật.

`tests/lucky-reward-browser.cjs` kiểm tra giao diện ở 390 × 844 với API giả lập và chặn mọi truy cập nghiệp vụ thật. Nó không xác minh callback từ ứng dụng Zalo thật.

## Phải hoàn tất trước khi xác nhận vận hành

- Chưa triển khai code này lên web đang chạy.
- Chưa áp `supabase/migrations/lucky_wheel_service_role_only.sql`: hàm giữ suất quà phải chỉ cho service_role gọi, không cho khóa trình duyệt sửa trạng thái/số tiền.
- Chưa có quyền đọc lịch sử lượt quay và log webhook đầy đủ để kết luận khách thật nào đã nhận thiếu trước đây.
- Cần thử Android và iPhone, gồm mở từ cửa sổ Zalo, khách đã quan tâm trước đây và webhook gửi lại/chậm.
- Cần xác nhận cấu hình kiểm chữ ký webhook và bằng chứng follow cho tài khoản cũ. Luồng Zalo dùng chung hiện có nhánh coi tài khoản nhắn tin chưa có trong bảng là follower; đây chưa phải đối chiếu độc lập với API Zalo.
- Cần thử nhận quà cùng lúc nhân viên thêm/sửa món hoặc thanh toán. Ghi dòng, cập nhật tổng và ghi xác nhận vẫn là nhiều thao tác database; các mã cố định giúp thử lại nhưng không thay thế một giao dịch database chung với thao tác thanh toán.
- Một lệnh in được tạo không chứng minh máy in đã in hay nhân viên đã giao đủ món. Phải kiểm tra hàng đợi lỗi và đối chiếu số lượng thực tế tại quán.

Không dùng kết quả mô phỏng này để khẳng định quy trình thực tế hoàn toàn không thể lỗi.

## Giảm phần trăm theo tổng bill — cập nhật cùng ngày

- `npm run test:lucky` chạy cả kiểm thử trên PostgreSQL WASM (PGlite), không ghi Supabase thật.
- Migration `supabase/migrations/lucky_wheel_dynamic_percent.sql` giữ phần trăm đã trúng, chốt mức trần khi nhận quà, cập nhật một dòng giảm khi thêm/sửa/xoá món trên các đơn đang mở cùng lượt khách. Takeaway tách theo SĐT.
- Tính trên tiền món trước giảm, không cộng quà tặng; làm tròn xuống bội 1.000đ như trước, giới hạn trần và số tiền còn có thể giảm. 150.000đ × 2% = 3.000đ; gửi thêm 100.000đ thì giảm 5.000đ, còn trả 245.000đ.
- Trigger sửa cả tổng tiền cũ do tab khách/nhân viên ghi lại; bill đã thanh toán giữ nguyên. Gộp bill giữ mã dòng quà và liên kết lượt quay.
- API phần trăm gọi RPC để ghi dòng, số tiền và xác nhận trong một giao dịch. Không dùng lại mức tiền cố định từ lượt quay cũ khi thử lại. Phần quà món/số tiền cố định vẫn dùng luồng cũ.
- Cần áp migration database trước khi deploy code mới. Bản này CHƯA được áp lên Supabase hay triển khai web. Cần kiểm tra schema/trigger thực tế và thử đồng thời nhiều kết nối với thanh toán trên môi trường staging trước vận hành; PGlite không chứng minh khả năng đồng thời đa kết nối của Supabase.

## Nút mở Zalo và quay lại nhiệm vụ trên điện thoại

- Bỏ bong bóng lớn, ẩn thống kê sau khi quay, đặt CTA trước hướng dẫn. Modal cuộn trong chiều cao nhìn thấy và nút đã kiểm tra nằm trong viewport 375 × 640 mà không cần cuộn.
- Riêng nút Zalo của vòng xoay luôn yêu cầu mở cửa sổ mới, lưu pending và dấu rời sang Zalo trước khi điều hướng. Nếu WebView dùng chung cửa sổ, Back đầu tiên sau bước này khôi phục nhiệm vụ thay vì gọi `dismissWheel`. Khách vẫn có thể chủ động chọn Để sau.
- Bỏ hướng dẫn bấm ✕ đóng WebView. Khi trang nhận focus/pageshow/visibilitychange, kiểm tra tiếp quà. Nếu khách đóng cửa sổ, cần mở lại cùng trang trong cùng trình duyệt để dùng trạng thái đã lưu.
- 11 kiểm tra giao diện đạt trên mỗi cấu hình WebKit/iPhone và Chromium/Android với UA Zalo, gồm điều hướng sang trang giả lập rồi Back, khôi phục, bỏ qua, retry nhận quà và giảm %. API được giả lập; không gọi Zalo thật.
- Đây là kiểm thử trình duyệt trên Windows, KHÔNG phải kiểm chứng nút native Back/✕ của ứng dụng Zalo trên điện thoại thật. Cần thử app thực tế sau triển khai. Tài liệu tham khảo về quyền điều hướng của trình chứa: https://developer.android.com/develop/ui/views/layout/webapps/webview và https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content .
