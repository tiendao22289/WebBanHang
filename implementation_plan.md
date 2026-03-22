# Tính Năng Khuyến Mại Tặng Món (Buy X Get 1 Free)

Cho phép quán cấu hình chương trình "đặt đủ N món được tặng 1 món". Admin cấu hình which items count toward goal và which items are giftable.

## ❓ Giả định cần bạn xác nhận

> [!NOTE]
> **Cách đếm số lượng:** Đếm theo **số lượng** — "Ốc Hương x3" = **3 món** ✅
>
> **Stacking:** Đủ 16 món (=2x threshold=8) → tặng **2 món** ✅ (stacking được hỗ trợ)
> Công thức: `giftCount = Math.floor(qualifyingQty / threshold)`

---

## Database Migration

### 1. Thêm 2 cột vào `menu_items`

```sql
ALTER TABLE menu_items
  ADD COLUMN counts_for_promotion BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN is_gift_item         BOOLEAN NOT NULL DEFAULT FALSE;
```

### 2. Thêm cấu hình khuyến mại vào `settings`

Dùng bảng `settings` đang có (key/value):

| key | value (example) |
|-----|-----------------|
| `promotion_enabled` | `"true"` |
| `promotion_threshold` | `"8"` |

Không cần tạo bảng mới — lưu 2 key này.

### 3. Thêm cột `is_gift` vào `order_items`

```sql
ALTER TABLE order_items
  ADD COLUMN is_gift BOOLEAN NOT NULL DEFAULT FALSE;
```

Khi `is_gift = true` → `unit_price` lưu là `0`, hiển thị màu đỏ đậm trên hóa đơn.

---

## Proposed Changes

### Admin — Trang Thêm/Sửa Món Ăn

#### [MODIFY] [page.jsx](file:///e:/Workspace/WebBanHang/src/app/admin/menu/page.jsx)

- Thêm 2 checkbox vào form:
  - ☑ **Tính vào khuyến mại** (`counts_for_promotion`) — chọn món này sẽ được đếm
  - ☑ **Là món tặng** (`is_gift_item`) — món này nằm trong danh sách tặng
- Thêm nút **"⚙️ Cấu hình khuyến mại"** mở modal phụ:
  - Toggle bật/tắt chương trình
  - Input số lượng threshold (vd: 8)
  - Lưu vào `settings` table

---

### Customer Order Page

#### [MODIFY] [page.jsx](file:///e:/Workspace/WebBanHang/src/app/order/page.jsx)

- **Load thêm** `promotion_enabled`, `promotion_threshold` từ `settings` và danh sách `is_gift_item`
- **Badge trên card món**: Món có `counts_for_promotion = true` hiển thị nhãn nhỏ `🎯 Tính KM` bên dưới tên
- **Progress bar / counter**: Khi promotion bật, hiện thanh tiến trình `"X/8 món đã chọn"` ở phía trên danh sách hoặc trong FAB giỏ hàng
- **Nút "🎁 Chọn món tặng"**: Xuất hiện khi đủ threshold → click mở modal chọn 1 trong các món `is_gift_item`
- **Stacking**: Nếu `qualifyingQty >= 2 × threshold`, khách được chọn **2 món tặng** (công thức: `Math.floor(qualifyingQty / threshold)`)
- **Gift item trong giỏ**: Đánh dấu `is_gift: true`, price hiển thị `0đ` (màu xanh), số lượng gift items được giới hạn theo `giftCount`
- **Khi gửi đơn**: Truyền field `is_gift: true` và `unit_price: 0` cho từng món quà

#### [MODIFY] [order.css](file:///e:/Workspace/WebBanHang/src/app/order/order.css)

- Style cho badge `🎯 Tính KM`
- Style cho progress bar khuyến mại
- Style cho nút "Chọn món tặng"
- Style cho `is_gift` item trong cart/bill (text `0đ` màu xanh, badge "Tặng")

---

### Admin — Trang Quản Lý Đơn Hàng (Hóa Đơn)

#### [MODIFY] [orders/page.jsx](file:///e:/Workspace/WebBanHang/src/app/admin/orders/page.jsx)

- Trong chi tiết order_items, nếu `is_gift = true` → giá hiển thị **`0đ`** màu đỏ đậm + nhãn **"🎁 Tặng"**

---

## Verification Plan

### Automated Tests
- Chạy `npm run dev`, vào trang order
- Thêm 8 món có `counts_for_promotion = true` → nút "Chọn món tặng" xuất hiện
- Chọn 1 món tặng → giá = 0đ trong giỏ
- Thêm đủ 16 món → chọn được **2 món tặng** (stacking)
- Gửi đơn → admin xem hóa đơn, món tặng hiện 0đ màu đỏ

### Manual Verification
- Admin vào menu → sửa món → tick checkbox → lưu
- Admin click "Cấu hình khuyến mại" → bật → threshold 8 → lưu
- Khách quét QR → thêm đủ 8 món counting → nút tặng xuất hiện
