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
7. ✅ **Deployment & Network** - Tích hợp Cloudflare Tunnel để truy cập từ xa, QR code tự động cập nhật link theo domain đang chạy.

## Lưu ý quan trọng
- **QR Code**: Sử dụng `window.location.origin` giúp mã QR luôn đúng dù chạy ở localhost hay link tunnel.
- **Đồng bộ đơn hàng**: Nếu 2 khách cùng quét 1 bàn, họ sẽ thấy các "đơn hàng đang chờ" (pending/preparing) của nhau để tránh gọi trùng món, nhưng lịch sử "đã hoàn thành" là riêng tư theo phone khách.
- **Admin POS**: Admin có quyền can thiệp vào bill (thêm món, xoá món) trực tiếp từ giao diện quản lý bàn.
- **Hệ thống Font**: `globals.css` hỗ trợ nhiều font, Admin ưu tiên dùng DM Sans.

## Quy tắc Workspace (User Rules)
- **Lệnh "kết thúc"**: Mỗi khi người dùng nói "kết thúc", AI phải:
    1. Lưu lại toàn bộ diễn biến, thay đổi và logic trong phiên làm việc.
    2. Cập nhật chi tiết vào `.agent/memory.md`.
    3. Tóm tắt các thay đổi quan trọng nhất và các file đã chỉnh sửa.

## Việc cần làm tiếp
- [ ] Tối ưu hóa hiệu suất load ảnh (WebP).
- [ ] Thêm tính năng sửa số lượng món trực tiếp trong bill Admin (hiện mới có thêm/xoá).
- [ ] Setup CI/CD tự động deploy khi push master.

## Ghi chú phiên làm việc
### 2026-03-18
- **Session 1**: Khởi tạo project, build skeleton, setup base UI/UX.
- **Session 2**: 
    - Fix logic session `localStorage` cho khách hàng.
    - Live-syncing hoá đơn: Khách ngồi chung bàn thấy đơn active của nhau.
    - Tính năng Admin: Thêm/xoá món trực tiếp trong bill tại `admin/tables`.
    - Tích hợp Cloudflare Tunnel và dynamic QR code.
    - **Refactor UI Admin**: Chuyển toàn bộ quản lý sang theme Premium (Red/Gold/Warm), font DM Sans.
    - Setup Git repository: [tiendao22289/WebBanHang](https://github.com/tiendao22289/WebBanHang) (Latest commit: `491554e`).
    - Cập nhật quy tắc: Tự động update memory khi nhận lệnh "kết thúc".
    - **Trạng thái**: Phiên làm việc kết thúc thành công.
