# 🧠 Project Memory - WebBanHang (Restaurant Ordering App)

## Thông tin dự án
- **Tên**: Hệ thống đặt món nhà hàng qua QR Code
- **Workspace**: `e:\Workspace\WebBanHang`
- **Ngày bắt đầu**: 2026-03-18
- **Trạng thái hiện tại**: ✅ Build thành công - Sẵn sàng kết nối Supabase

## Tech Stack
| Layer | Technology |
|---|---|
| Framework | Next.js 16+ (App Router) |
| UI | Vanilla CSS (warm earth tone theme, custom fonts) |
| Database | Supabase (PostgreSQL + Realtime + Storage) |
| QR Code | `qrcode.react` |
| Charts | `recharts` |
| Print | `react-to-print` |
| Icons | `lucide-react` |
| Deploy | Vercel (dự kiến) |

## Cấu trúc thư mục
```
src/
├── app/
│   ├── layout.js          # Root layout
│   ├── page.js            # Redirect → /admin/tables
│   ├── globals.css        # Design system
│   ├── admin/
│   │   ├── layout.js      # Sidebar navigation
│   │   ├── admin.css
│   │   ├── tables/        # Quản lý bàn (QR, trạng thái)
│   │   ├── menu/          # Quản lý thực đơn (CRUD)
│   │   ├── orders/        # Hoá đơn, lịch sử đơn
│   │   └── stats/         # Thống kê, biểu đồ
│   └── order/             # Trang khách đặt món (mobile-first)
└── lib/
    ├── supabase.js        # Supabase client
    └── database.sql       # SQL schema + sample data
```

## Tính năng đã hoàn thành
1. ✅ **Trang View Bàn** (`/admin/tables`) - Grid bàn, QR code (dynamic URL), chi tiết đơn, quản lý chi tiết món (admin có thể thêm/xoá món ngay tại chỗ), realtime.
2. ✅ **Trang Thực đơn** (`/admin/menu`) - CRUD danh mục + món ăn, toggle hiển thị.
3. ✅ **Trang Khách đặt món** (`/order`) - Đồng bộ session qua `localStorage`, hiển thị bill đang active của bàn (tất cả khách ngồi chung bàn thấy đơn của nhau), xem lại lịch sử đơn cá nhân và nút "Đặt lại" (Reorder).
4. ✅ **Trang Hoá đơn** (`/admin/orders`) - Filter ngày/trạng thái/tìm kiếm, quản lý trạng thái đơn.
5. ✅ **Trang Thống kê** (`/admin/stats`) - Biểu đồ doanh thu, pie chart danh mục, top món bán chạy.
6. ✅ **Thiết kế UI Admin** - Refactor sang phong cách **"Modern - Vibrant - Warm"** (Premium Red/Gold theme, DM Sans font, bo góc lớn 1.5rem, glassmorphism), giữ nguyên giao diện khách hàng.
### Mới cập nhật (2026-03-18)
8. ✅ **Giao diện Menu App-Style (POS Mới)**: Chuyển đổi toàn bộ màn hình Gọi Món trong Admin sang dạng toàn màn hình, thanh danh mục bên trái, cuộn danh sách món gọn gàng tỉ lệ 1:1 giống ShopeeFood/GrabFood.
9. ✅ **Tuỳ chọn món (Product Options)**: Hỗ trợ chọn biến thể (xào, hấp, rang muối...) và khẩu vị (cay, mặn, không hành...). Cho phép tuỳ chỉnh số lượng (- 1 +) trực tiếp khi click món. Có chức năng gộp chung các món giống hệt Tuỳ chọn & Ghi chú vào chung 1 dòng trong bill.
10. ✅ **Hệ thống Ghi Chú & Báo cáo Nội bộ (`/admin/notes`)**:
    - **Đăng nhập bằng SĐT + PIN**: Tự động lưu `localStorage` vĩnh viễn không cần đăng nhập lại.
    - **Phân loại**: Đi chợ (Nhập tiền mặt / Tiền thiếu nợ), Báo thiếu hàng, Sửa chữa.
    - **Phân quyền**: Admin xem được toàn bộ báo cáo, phân nhóm theo nhân viên, xoá báo cáo, phản hồi Đồng Ý / Từ Chối. Nhân viên chỉ xem báo cáo cá nhân, gõ chữ tự động gạch đầu dòng.
    - **Debt tracking per-item**: Mỗi item trong báo cáo chi phí có thể ghi nợ một phần (debtAmount < total), theo dõi trả dần, lưu payment_logs trong JSON content.
    - **Mobile card view**: Xem chi tiết báo cáo chi phí dạng card từng item trên mobile. Màu đỏ khi còn nợ, xanh khi đã trả đủ.
    - **Toggle lịch sử trả nợ**: Icon 🕐 để ẩn/hiện lịch sử trong detail view.
    - **Preview nội dung**: Các loại stock/repair/other hiện preview 3 dòng ngay trên card ngoài.
    - **Nhãn loại báo cáo**: Label flush-top trên mỗi card với màu theo loại.
    - **Format ngày**: dd/MM/yyyy HH:mm.
    - **Tổng đã chi & tổng nợ**: Hiện ra ngoài card footer.

## Việc cần làm tiếp
- [ ] Tối ưu hóa hiệu suất load ảnh (WebP).
- [ ] Xây dựng màn hình Nhà bếp (Kitchen View) để xem các món cần làm theo thời gian thực.
- [ ] Quản lý Khách hàng thân thiết (Tích điểm, Giảm giá).
- [ ] Thống kê Ca làm việc / Tách doanh thu theo ngày/ca.

## Ghi chú phiên làm việc
### 2026-03-18
- Hoàn thiện tính năng Quản lý Bàn, Gộp Bill, In Hoá đơn.
- Tái cấu trúc Giao diện POS Gọi món (App-Style).
- Bổ sung Cấu hình Tuỳ chọn Món ăn & Khẩu vị (Options Modal).
- Thiết kế hệ thống Xác thực Staff (Auth Guard) và Báo cáo nội bộ (Staff Notes).
- **Trạng thái**: Tất cả các workflow và yêu cầu tính năng đến hiện tại đều ổn định và hoàn tất.

### 2026-03-19
- **Notes page nâng cấp toàn diện** (`src/app/admin/notes/page.js` + `notes.css`):
  - Debt tracking: `debtAmount` per-item, so sánh `debtBase` (không phải `itemTotal`) khi flip status
  - Mobile detail view: từng item là 1 card riêng, màu đỏ/xanh theo `remaining`
  - Form tạo mới: live total per item, debt amount input có format & cap
  - Toggle 🕐 lịch sử trả nợ ẩn/hiện theo từng item (state `expandedHistory`)
  - Card outer: nhãn loại flush-top, preview 3 dòng cho non-expense, format ngày dd/MM/yyyy HH:mm
  - Bug fixes: `parseVal(debtAmount)` cần `.replace(/\./g, '')` vì Vi format dùng dấu chấm nghìn
  - `debtBase` KHÔNG dùng `isDebt` flag (flag flip sau khi pay xong), dùng `item.debtAmount` trực tiếp
  - DB: bảng `staff_notes` — `content` (JSON), `paid_debt` (tổng đã trả), không có bảng `notes` riêng
- **Commit**: `feat(notes): enhance notes UI` → push master
