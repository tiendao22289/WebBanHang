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
1. ✅ **Trang View Bàn** (`/admin/tables`) - Grid bàn, QR code, chi tiết đơn, hoàn thành bàn, realtime
2. ✅ **Trang Thực đơn** (`/admin/menu`) - CRUD danh mục + món ăn, toggle hiển thị
3. ✅ **Trang Khách đặt món** (`/order?table=XX`) - 4 bước: nhập thông tin → chọn món → giỏ hàng → in hoá đơn
4. ✅ **Trang Hoá đơn** (`/admin/orders`) - Filter ngày/trạng thái/tìm kiếm, quản lý trạng thái đơn
5. ✅ **Trang Thống kê** (`/admin/stats`) - Biểu đồ doanh thu, pie chart danh mục, top món bán chạy
6. ✅ **Auto-print invoice** cho bếp khi có đơn mới
7. ✅ **Realtime** cập nhật trạng thái bàn

## Lưu ý quan trọng
- **KHÔNG** có hệ thống phân quyền/đăng nhập (theo yêu cầu)
- QR code encode URL dạng: `{BASE_URL}/order?table={table_number}`
- Trang khách đặt món: mobile-first design
- Supabase cần được setup riêng (URL + Anon Key trong `.env.local`)
- Có thể mở rộng cho Zalo Mini App sau này

## Global Skill
- **Đường dẫn**: `E:\AntigravitySkill`
- Đây là thư mục **global skill** dùng chung cho tất cả workspace
- Khi nhắc tới "global skill" tức là đang nhắc tới folder này
- Luôn kiểm tra thư mục này để tìm skill có thể dùng được
- **⚠️ Quan trọng**: Mỗi khi cần kiểm tra skill phù hợp, **đọc file `E:\AntigravitySkill\skill-details.md` và `E:\AntigravitySkill\CATALOG.md` trước** rồi tìm skill phù hợp để copy vào workspace

## Database Schema
- `categories` - Danh mục món ăn
- `menu_items` - Các món ăn (FK → categories)
- `tables` - Bàn ăn (status: available/occupied)
- `orders` - Đơn hàng (FK → tables, status: pending/preparing/completed/paid)
- `order_items` - Chi tiết đơn hàng (FK → orders, menu_items)

## Việc cần làm tiếp
- [ ] Setup Supabase project (tạo project, lấy URL + Anon Key)
- [ ] Chạy `database.sql` trên Supabase SQL Editor
- [ ] Cập nhật `.env.local` với credentials thật
- [ ] Test toàn bộ flow end-to-end
- [ ] Deploy lên Vercel

## Ghi chú phiên làm việc
### 2026-03-18
- Đã lên kế hoạch chi tiết toàn bộ ứng dụng
- User đã approve implementation plan
- Khởi tạo Next.js project, cài dependencies
- Tạo design system (Playfair Display + Be Vietnam Pro, warm earth tones)
- Build hoàn thành tất cả 6 trang: tables, menu, orders, stats, order (customer)
- Build verification: ✅ thành công, tất cả 7 routes compile OK
- Fix: useSearchParams Suspense boundary cho /order page
