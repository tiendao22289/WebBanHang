-- Nhãn NEW / HOT cho món ăn (bật/tắt trong Admin > Quản lý món).
-- Chạy 1 lần trong Supabase > SQL Editor TRƯỚC khi dùng tính năng.
-- An toàn, không ảnh hưởng dữ liệu cũ (mặc định false = không có nhãn).
alter table menu_items add column if not exists is_new boolean not null default false;
alter table menu_items add column if not exists is_hot boolean not null default false;
