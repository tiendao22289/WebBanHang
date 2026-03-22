# 📖 Introduction — WebBanHang (Nhà Hàng V1)

> **Đọc file này TRƯỚC khi làm bất kỳ việc gì liên quan đến dự án.**  
> File này ghi lại toàn bộ hiểu biết về logic, nghiệp vụ, và kiến trúc của hệ thống.  
> Cập nhật lần cuối: 2026-03-23

---

## 1. Tổng quan hệ thống

**WebBanHang** là hệ thống POS (Point of Sale) cho nhà hàng, gồm 2 phần chính:

| Phần | Công nghệ | Mô tả |
|------|-----------|-------|
| **Web App** | Next.js 14 App Router (React) | Trang web đặt món & quản lý |
| **PrintAgent** | Node.js local service | Dịch vụ in hóa đơn tại chỗ |

**Backend**: Supabase (PostgreSQL + Realtime + Storage)  
**Deploy**: Web App trên Vercel; PrintAgent chạy local tại nhà hàng  
**Theme màu**: Đỏ (`#dc2626`) + trắng — font **DM Sans**

---

## 2. Cấu trúc thư mục

```
e:\Workspace\WebBanHang\
├── src/
│   ├── app/
│   │   ├── layout.js           ← Root layout (PWA metadata, safe-area)
│   │   ├── page.js             ← Redirect về /admin/tables
│   │   ├── globals.css         ← Global styles
│   │   ├── admin/
│   │   │   ├── layout.js       ← Admin shell + đăng nhập staff 🔑
│   │   │   ├── admin.css
│   │   │   ├── tables/         ← Quản lý bàn (trang chính POS) 🏠
│   │   │   ├── menu/           ← Thực đơn CRUD
│   │   │   ├── orders/         ← Xem tất cả đơn hàng
│   │   │   ├── customers/      ← CRM khách hàng
│   │   │   ├── notes/          ← Sổ tay nhân viên (chi phí, kho, báo cáo)
│   │   │   ├── payroll/        ← Tính lương + chấm công
│   │   │   ├── stats/          ← Thống kê doanh thu
│   │   │   └── settings/       ← Tài khoản ngân hàng + vị trí nhà hàng
│   │   ├── order/              ← Trang đặt món của khách (qua QR)
│   │   └── checkin/            ← QR checkin cho nhân viên
│   └── lib/
│       ├── supabase.js         ← Supabase client (singleton)
│       ├── print.js            ← Re-export từ print.jsx
│       ├── print.jsx           ← Hàm sendPrintJob / sendPrintJobs 🖨️
│       ├── database.sql        ← Schema gốc
│       ├── migration_customers.sql
│       └── migration_notes.sql

e:\Workspace\PrintAgent\
├── index.js       ← Main: lắng nghe Supabase Realtime + polling fallback + health check
├── printer.js     ← Logic in: thermal ESC/POS / Windows / file mode, routing cashier/kitchen
├── formatter.js   ← Format text hóa đơn (cashier bill + kitchen ticket) cho Windows/file
├── WORKFLOW.md    ← Tài liệu kiến trúc chi tiết của PrintAgent
├── stats.json     ← [AUTO] Persist số lần in + 10 job gần nhất qua restart
└── logs/          ← [AUTO] Log file hàng ngày YYYY-MM-DD.log
```

---

## 3. Database Schema (thực tế từ Supabase)

> Cập nhật 2026-03-23 — truy vấn trực tiếp từ project `wglhqlrumieujmugpxel`

### 3.1 Nhóm: Thực đơn & Đặt món

#### `categories` (5 rows)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | gen_random_uuid() |
| `name` | text | Tên danh mục |
| `sort_order` | int4 | Thứ tự hiển thị, default 0 |
| `created_at` | timestamptz | |

#### `menu_items` (RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `category_id` | uuid FK→categories | |
| `name` | text | |
| `description` | text | nullable |
| `price` | int4 | Giá cơ bản (VNĐ), default 0 |
| `image_url` | text | nullable |
| `is_available` | bool | default true — ẩn/hiện trên menu |
| `options` | jsonb | `[{name, choices[], prices[]}]`, default `[]` |
| `counts_for_promotion` | bool | default false — đếm để tặng KM |
| `is_gift_item` | bool | default false — món được tặng |
| `created_at` | timestamptz | |

#### `tables` (14 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `table_number` | int4 UNIQUE | 0 = Mang về |
| `status` | text | CHECK: `available` \| `occupied`, default `available` |
| `table_type` | text | default `dine_in` |
| `table_name` | text | nullable — tên tuỳ chỉnh |
| `occupied_at` | timestamptz | nullable |
| `created_at` | timestamptz | |

#### `orders` (148 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `table_id` | uuid FK→tables | nullable |
| `customer_id` | uuid FK→customers | nullable |
| `customer_name` | text | |
| `customer_phone` | text | |
| `status` | text | CHECK: `pending`\|`preparing`\|`completed`\|`paid`\|`cancelled` |
| `total_amount` | int4 | VNĐ, default 0 |
| `kitchen_completed` | bool | default false — bếp đã xong |
| `payment_method` | text | nullable — tiền mặt / chuyển khoản |
| `delivery_address` | text | nullable |
| `created_at` | timestamptz | |

#### `order_items` (681 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `order_id` | uuid FK→orders | |
| `menu_item_id` | uuid FK→menu_items | |
| `quantity` | int4 | default 1 |
| `unit_price` | int4 | Giá tại thời điểm đặt (VNĐ) |
| `note` | text | nullable — ghi chú của khách |
| `item_options` | jsonb | `[{name, choice, price}]`, default `[]` |
| `is_gift` | bool | default false — món tặng KM |
| `created_at` | timestamptz | |

#### `customers` (16 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `phone` | text UNIQUE | |
| `name` | text | |
| `total_spent` | int4 | Tổng chi tiêu (VNĐ), default 0 |
| `visit_count` | int4 | Số lần ghé, default 0 |
| `last_visit_at` | timestamptz | nullable |
| `created_at` | timestamptz | |

---

### 3.2 Nhóm: In hóa đơn

#### `print_jobs` (27 rows, RLS: on)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | bigint PK | BIGSERIAL — auto-increment |
| `order_id` | uuid FK→orders | |
| `printer_target` | text | CHECK: `cashier`\|`kitchen`, default `cashier` |
| `status` | text | CHECK: `pending`\|`printing`\|`done`\|`failed`, default `pending` |
| `error_message` | text | nullable — lý do thất bại |
| `created_at` | timestamptz | |

> **Lưu ý**: mỗi đơn cần insert **2 rows** — 1 cho `cashier`, 1 cho `kitchen`

---

### 3.3 Nhóm: Cài đặt & Ngân hàng

#### `settings` (3 rows, RLS: on)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `key` | text PK | |
| `value` | text | JSON string |
| `updated_at` | timestamptz | |

Keys đang dùng:
- `promotion_enabled` → `"true"/"false"`
- `promotion_threshold` → `"3"` (số món để tặng)
- `restaurant_location` → `{"lat":..., "lng":..., "radius":300}`

#### `bank_accounts` (4 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `account_name` | text | Tên chủ tài khoản |
| `bank_name` | text | Tên ngân hàng |
| `account_number` | text | Số tài khoản |
| `daily_limit` | int8 | Hạn mức/ngày (VNĐ), default 5.000.000 |
| `sort_order` | int4 | Ưu tiên, default 0 (nhỏ hơn = ưu tiên hơn) |
| `is_active` | bool | default true |
| `created_at` | timestamptz | |

#### `bank_daily_totals` (8 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `account_id` | uuid FK→bank_accounts | |
| `date` | date | default CURRENT_DATE |
| `total_amount` | int8 | Tổng đã thu trong ngày |

---

### 3.4 Nhóm: Nhân viên & HR

#### `staff` (5 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `phone` | text UNIQUE | Dùng để đăng nhập |
| `pin` | text | Mã PIN đăng nhập |
| `full_name` | text | |
| `role` | text | CHECK: `admin`\|`staff`, default `staff` |
| `last_login` | timestamptz | nullable |
| `created_at` | timestamptz | |

#### `payroll_config` (4 rows, RLS: off) — 1 row/nhân viên
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `staff_id` | uuid UNIQUE FK→staff | |
| `base_salary` | int4 | Lương cơ bản/tháng (VNĐ), default 0 |
| `overtime_rate` | int4 | VNĐ/giờ tăng ca, default 25.000 |
| `pay_day` | int4 | Ngày trả lương trong tháng, default 5 |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

#### `payroll_requests` (7 rows, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `staff_id` | uuid FK→staff | |
| `request_type` | text | CHECK: `advance`\|`absent` |
| `amount` | int4 | Số tiền ứng (cho advance), default 0 |
| `days` | numeric | Số ngày nghỉ (cho absent), default 0 |
| `reason` | text | nullable |
| `status` | text | CHECK: `pending`\|`approved`\|`rejected`, default `pending` |
| `admin_note` | text | nullable |
| `month` | int4 | Tháng áp dụng |
| `year` | int4 | Năm áp dụng |
| `created_at` / `updated_at` | timestamptz | |

#### `payroll_violations` (1 row, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `staff_id` | uuid FK→staff | |
| `amount` | int4 | Số tiền phạt (VNĐ) |
| `reason` | text | |
| `month` | int4 | |
| `year` | int4 | |
| `created_at` | timestamptz | |

#### `attendance_sessions` (23 rows, RLS: on) — **Chấm công mới (multi-session)**
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `staff_id` | uuid FK→staff | |
| `date` | date | default CURRENT_DATE |
| `clock_in` | timestamptz | Giờ vào ca |
| `clock_out` | timestamptz | nullable — Giờ ra ca |
| `created_at` | timestamptz | |

> Mỗi ngày có thể có **nhiều rows** cho cùng 1 nhân viên (ra vào nhiều lần). Dùng trong `payroll/page.js`.

#### `attendance_logs` (2 rows, RLS: off) — **Legacy (single session)**
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `staff_id` | uuid FK→staff | |
| `date` | date | |
| `clock_in` | timestamptz | |
| `clock_out` | timestamptz | nullable |
| `work_hours` | numeric | Tổng giờ tính sẵn |
| `overtime_hours` | numeric | Giờ OT, default 0 |
| `note` | text | nullable |
| `created_at` | timestamptz | |

> Dùng trong `notes/page.js` (trang Sổ tay). Cả 2 bảng tồn tại song song.

#### `attendance_edit_log` (18 rows, RLS: off) — Audit log khi admin sửa chấm công
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `attendance_id` | uuid FK→attendance_logs | |
| `staff_id` | uuid FK→staff | |
| `field_name` | text | Tên cột bị sửa |
| `old_value` | text | nullable |
| `new_value` | text | nullable |
| `changed_at` | timestamptz | default now() |
| `changed_by` | text | default `'admin'` |
| `note` | text | nullable |

#### `staff_notes` (1 row, RLS: off)
| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| `id` | uuid PK | |
| `staff_id` | uuid FK→staff | |
| `note_type` | text | CHECK: `expense`\|`stock`\|`repair`\|`other`, default `other` |
| `content` | text | JSON hoặc plain text (xem mục 12) |
| `amount` | int4 | Tổng tiền đã trả, default 0 |
| `debt` | int4 | Tổng tiền còn nợ, default 0 |
| `paid_debt` | int4 | Đã trả nợ, default 0 |
| `status` | text | CHECK: `pending`\|`approved`\|`rejected`, default `pending` |
| `admin_reply` | text | nullable |
| `created_at` / `updated_at` | timestamptz | |

---

### 3.5 Realtime Enabled
| Bảng | Dùng ở |
|------|--------|
| `tables` | `admin/tables` — cập nhật trạng thái bàn |
| `orders` | `admin/tables` — đơn mới, đổi trạng thái |
| `customers` | (subscribe ready) |
| `staff_notes` | `admin/notes` — note mới theo thời gian thực |
| `print_jobs` | PrintAgent — nhận lệnh in |

---

## 4. Luồng nghiệp vụ (Business Flows)

### 4.1 Khách đặt món (`/order`)
1. Khách quét QR → mở `?table=<tableId>`
2. Nhập tên + SĐT → kiểm tra geolocation với tọa độ nhà hàng (settings `restaurant_location`)  
3. Xem thực đơn → chọn món, chọn **options** (khẩu vị/size → mỗi choice có giá riêng)
4. Hệ thống kiểm tra **khuyến mại** (settings `promotion_enabled`, `promotion_threshold`):
   - Đếm quantity của món `counts_for_promotion = true`  
   - Cứ N món → tặng 1 món `is_gift_item = true` (stacking: 2N → tặng 2)
5. Submit → tạo `orders` + `order_items` → update `tables.status = 'occupied'`
6. Upsert `customers` (tên + SĐT) → tăng `visit_count`, `total_spent`
7. **Gửi lệnh in**: `sendPrintJob(supabase, order.id)` → insert vào `print_jobs`

### 4.2 Admin quản lý bàn (`/admin/tables`) — Trang chính POS
- Hiển thị grid bàn, Realtime sub listen `tables` + `orders`
- Click bàn → xem danh sách orders của bàn
- Đổi trạng thái order: `pending → preparing → completed → paid`
- **Thanh toán**: sinh QR VietQR động cho tài khoản ngân hàng ưu tiên (active, chưa đạt daily_limit)
- **In hóa đơn**: `sendPrintJobs(supabase, orderIds[])` — in tất cả đơn của bàn
- **Huỷ đơn**: soft delete / update status, table auto về `available` nếu không còn đơn active
- Tính tổng tiền của bàn (tổng `total_amount` các order active)
- QR Code bàn → in QR để dán lên bàn thực tế

### 4.3 Admin xem đơn hàng (`/admin/orders`)
- Lọc theo trạng thái, tìm kiếm
- Xem chi tiết từng đơn trong modal
- **In hóa đơn**: `sendPrintJob(supabase, orderId)` — in 1 đơn cụ thể

### 4.4 In hóa đơn (`PrintAgent`) — Dual Printer
**Luồng**: `print_jobs (status=pending)` → PrintAgent → `print_jobs (status=done)`

PrintAgent hỗ trợ **2 máy in song song**: Quầy (cashier bill) + Bếp (kitchen ticket)

**Khi web insert print job:**
```js
// Mỗi đơn tạo 2 rows trong print_jobs
{ order_id, printer_target: 'cashier', status: 'pending' }  // → máy in quầy
{ order_id, printer_target: 'kitchen', status: 'pending' }  // → máy in bếp
```

**Luồng xử lý trong PrintAgent:**
1. Nhận job qua Supabase Realtime (INSERT event) hoặc polling fallback 15s
2. **Atomic claim**: `UPDATE status='printing' WHERE id=? AND status='pending'` → tránh in trùng
3. Fetch order data từ Supabase (orders + order_items + menu_items + tables)
4. Route theo `printer_target`:
   - `cashier` → in **hóa đơn đầy đủ** (header, tên món, giá, tổng, footer "Cảm ơn quý khách")
   - `kitchen` → in **phiếu bếp** (bàn số, tên món, options, ghi chú — **KHÔNG có giá**)
5. In theo mode cấu hình: `thermal` (ESC/POS TCP/IP) / `windows` (Notepad /p) / `file` (test)
6. Retry tối đa 3 lần (delay 2s mỗi lần) nếu lỗi
7. Update `status = 'done'` hoặc `failed + error_message`

**Hardware thực tế:**
- Quầy: Xprinter Q838L — `tcp://192.168.1.212:9100`
- Bếp: Xprinter tương thích — `tcp://192.168.1.223:9100`

**Cấu hình PrintAgent** (`.env`):
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
PORT=3003
PAPER_CUT_LINES=4
# Máy in quầy (cashier)
CASHIER_PRINTER_TYPE=thermal
CASHIER_PRINTER_INTERFACE=tcp://192.168.1.212:9100
# Máy in bếp (kitchen)
KITCHEN_PRINTER_TYPE=thermal
KITCHEN_PRINTER_INTERFACE=tcp://192.168.1.223:9100
# Fallback nếu chưa config prefix mới
PRINTER_TYPE=thermal|windows|file
PRINTER_INTERFACE=...
```

**Cơ chế bảo vệ:**
- Polling fallback 15s khi Realtime mất kết nối
- Health check mỗi 5 phút (force reconnect nếu WebSocket silent disconnect)
- Auto-cleanup job done/failed cũ hơn 7 ngày (chạy mỗi 6h)
- Stats persist vào `stats.json` (không mất khi restart)
- Log file hàng ngày: `logs/YYYY-MM-DD.log`
- Status page: `http://localhost:3003` (tự refresh 5s, hiển thị 10 job gần nhất)

---

## 5. Các trang Admin chi tiết

### 5.1 Thực đơn (`/admin/menu`)
- CRUD `categories` (tên, sort_order)
- CRUD `menu_items`:
  - Thêm **options** (tuỳ chọn): `[{ name, choices[], prices[] }]` — mỗi choice có price riêng
  - Price auto: `min(allChoicePrices)` hoặc nhập thủ công
  - Toggle `is_available` (ẩn/hiện trên menu khách)
  - Đánh dấu `counts_for_promotion` + `is_gift_item`
- Cấu hình **khuyến mại**: bật/tắt, threshold (đặt N món tặng 1)
- Filter: theo category, hiện/ẩn, tìm kiếm

### 5.2 Thống kê (`/admin/stats`)
- Dữ liệu: orders status `completed|paid` trong 7 hoặc 30 ngày
- Charts (recharts): doanh thu theo ngày (BarChart), danh mục (PieChart)
- Top 8 món bán chạy (BarChart ngang)
- KPIs: tổng doanh thu, số đơn, món đã bán, trung bình/đơn

### 5.3 Khách hàng (`/admin/customers`)
- Danh sách khách, sắp xếp theo `last_visit_at`  
- Tìm theo tên / SĐT
- Click → modal lịch sử đặt món (timeline)
- KPIs tổng: tổng khách, tổng doanh thu

### 5.4 Sổ tay (`/admin/notes`) — ⚠️ File lớn nhất ~1857 dòng
- **Auth riêng**: login bằng staff phone+PIN, lưu `localStorage.staffUser`
- Nhân viên thường: xem notes của mình, chấm công (`attendance_logs`)
- Admin: xem tất cả notes của mọi người, duyệt yêu cầu
- **Note types**: `expense` (chi phí chợ — structured JSON với items), `stock`, `repair`, `other`
- Expense note: danh sách items `{name, price, qty, paymentStatus: full|debt, creditor, debtAmount}`
  - Auto tính tổng tiền đã trả + còn nợ
  - Ghi log history mỗi lần sửa
  - Thanh toán nợ theo từng item hoặc theo note
- Realtime subscribe `staff_notes`
- FAB button (drag-to-reposition) để thêm note nhanh

### 5.5 Tính lương (`/admin/payroll`) — ~1178 dòng
- **Admin view**: bảng lương tất cả nhân viên theo tháng/năm
  - Tính lương = `base_salary + overtime - advance - absence_penalty - violations`
  - Chấm công: `attendance_sessions` (multi-session/ngày, hỗ trợ ra vào nhiều lần)
  - Tăng ca: >8h/ngày → tính theo `overtime_rate`
  - Tabs: Bảng lương, Yêu cầu, Vi phạm, Chấm công, QR Chấm công, Tài khoản, Cấu hình
- **QR Chấm công**: sinh QR động đổi 5 phút → `http://host/checkin?t=<token>`
- **Staff view**: chấm công vào/ra (multi-session), xin ứng lương, báo nghỉ

### 5.6 Cài đặt (`/admin/settings`) — Admin only
- **Tài khoản ngân hàng**: thêm/sửa/xóa, bật/tắt, daily_limit
  - Hệ thống tự chọn tài khoản active ưu tiên thấp nhất, chưa đạt hạn mức ngày
  - QR VietQR trong trang tables tự sinh từ tài khoản được chọn
- **Vị trí nhà hàng**: lat/lng/radius cho geolocation check khi khách đặt món

---

## 6. Authentication & Phân quyền

| Role | Quyền |
|------|-------|
| **admin** | Tất cả trang: tables, orders, menu, customers, notes, payroll, stats, settings |
| **staff** | Chỉ: tables, orders, payroll (self-service) + notes (chỉ xem note mình, chấm công) |

- Đăng nhập: `phone + PIN` → query bảng `staff`  
- Session lưu ở `localStorage` key `staffUser` (JSON `{id, full_name, phone, role}`)
- Redirect: staff vào trang không được phép → tự nhảy về `/admin/notes`

---

## 7. Thư viện Print dùng chung

**File**: `src/lib/print.jsx`  
**Re-export**: `src/lib/print.js` → `export * from './print.jsx'`

```js
import { sendPrintJob, sendPrintJobs } from '@/lib/print';

// In 1 đơn → tạo 2 rows (cashier + kitchen)
await sendPrintJob(supabase, orderId);
// Returns: { success: boolean, error?: string }

// In nhiều đơn (toàn bàn) → mỗi order tạo 2 rows
await sendPrintJobs(supabase, [orderId1, orderId2]);
// Returns: { success: boolean, error?: string }
```

> ⚠️ **Cần cập nhật**: `print.jsx` hiện insert thiếu `printer_target`. Phải insert 2 rows mỗi đơn:
> ```js
> // Cần sửa thành:
> { order_id: orderId, printer_target: 'cashier', status: 'pending' }
> { order_id: orderId, printer_target: 'kitchen', status: 'pending' }
> ```

**Dùng ở**:
- `order/page.jsx` → `submitOrder()` (khách đặt xong)
- `admin/orders/page.jsx` → nút "In hóa đơn" trong modal order
- `admin/tables/page.js` → `handlePrintInvoice()` (in tất cả bill bàn, filter orders pending/preparing/completed)

---

## 8. Realtime Subscriptions

| Trang | Subscribe |
|-------|-----------|
| `admin/tables` | `tables` (UPDATE), `orders` (INSERT/UPDATE/DELETE) |
| `admin/notes` | `staff_notes` (ALL) |

---

## 9. Luồng thanh toán QR

1. Admin click "Thanh toán" cho bàn
2. Hệ thống lấy `bank_accounts` còn active, chưa đạt `daily_limit`
3. Tài khoản ưu tiên: `sort_order` nhỏ nhất
4. Sinh QR VietQR: `https://img.vietqr.io/image/{bank}-{account}-qr_only.png?amount={amount}&addInfo={info}`
5. Khách chuyển khoản → nhân viên xác nhận → đổi order thành `paid`

---

## 10. Trang khách hàng (`/order`)

- URL: `/order?table=<tableId>`
- **Geolocation check**: so sánh khoảng cách với `restaurant_location` trong settings
- Nhập tên + SĐT → lookup `customers` để pre-fill
- Hiển thị thực đơn theo category, filter, search
- **Order item options**: hiển thị modal chọn khẩu vị/size, price thay đổi theo choice
- **Giỏ hàng**: cart local state, ghi chú từng món
- **Khuyến mại**: đếm SL món eligible → hiển thị ô chọn món tặng nếu đủ điều kiện
- Submit → `orders` + `order_items` + `customers` upsert + `print_jobs`

---

## 11. PWA & Mobile

- `manifest.json` + `icon-192.png` + `icon-512.png`
- `apple-mobile-web-app-capable` → cài lên màn hình iPhone
- `viewport-fit=cover` + `safe-area-inset` → notch support
- `theme-color: #2563eb`

---

## 12. Các điểm cần chú ý khi phát triển

1. **DB Integer cho tiền**: tất cả số tiền lưu dạng `INTEGER` (VNĐ), không dùng float
2. **Options trong menu_items**: column `options` là `JSONB` → `[{name, choices[], prices[]}]`
3. **item_options trong order_items**: column `item_options` là `JSONB` → `[{name, choice, price}]`
4. **print_jobs**: insert **2 rows mỗi đơn** `{order_id, printer_target:'cashier'|'kitchen', status:'pending'}` → PrintAgent routing tự động theo `printer_target`. Nếu interface của máy in chưa config → PrintAgent skip (không báo lỗi). PrintAgent atomic claim `WHERE status='pending'` tránh in trùng.
5. **Khuyến mại stacking**: mỗi N món được tặng 1 món (floor(total/N) món tặng)
6. **QR Chấm công**: token = `Math.floor(Date.now() / (5*60*1000))` đổi mỗi 5 phút
7. **Bank routing**: `daily_limit` theo ngày, `bank_daily_totals` track tổng theo ngày
8. **Geolocation**: radius mặc định 300m, lưu JSON `{lat, lng, radius}` trong settings
9. **attendance_sessions** vs **attendance_logs**: sessions mới hơn (multi-session), logs là cũ (single session) — cả 2 tồn tại song song
10. **Staff notes** format expense: lưu JSON `{type:'structured_expense', items:[], note, history:[]}` trong column `content`
