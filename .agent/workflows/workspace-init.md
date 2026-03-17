---
description: Quy trình bắt buộc trước khi bắt đầu bất kỳ workspace nào - đọc memory và kiểm tra skills
---

# Quy trình khởi đầu workspace

Trước khi bắt đầu BẤT KỲ công việc nào trong workspace, phải thực hiện các bước sau:

## Bước 1: Kiểm tra và đọc Memory
// turbo
1. Kiểm tra xem file `.agent/memory.md` có tồn tại trong workspace hiện tại không
2. Nếu **có**: Đọc toàn bộ nội dung file `memory.md` để hiểu:
   - Dự án đang làm gì
   - Tech stack sử dụng
   - Tiến độ hiện tại (đang làm tới đâu)
   - Các ghi chú quan trọng
3. Nếu **không có**: Tạo file `.agent/memory.md` với cấu trúc:
   - Thông tin dự án
   - Tech Stack
   - Tính năng chính
   - Lưu ý quan trọng
   - Tiến độ thực hiện
   - Ghi chú phiên làm việc

## Bước 2: Kiểm tra Skills
// turbo
1. Kiểm tra thư mục `.agent/skills/` trong workspace
2. Liệt kê các skill có sẵn
3. Đọc các skill file liên quan đến công việc hiện tại

## Bước 3: Cập nhật Memory khi làm việc
- Sau mỗi milestone quan trọng, cập nhật file `memory.md`:
  - Đánh dấu task đã hoàn thành `[x]`
  - Thêm ghi chú phiên làm việc mới
  - Cập nhật trạng thái dự án
- Khi kết thúc phiên làm việc, CẬP NHẬT memory với tất cả tiến độ đã đạt được
