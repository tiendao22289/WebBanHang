-- =============================================
-- Restaurant Ordering System - Database Schema
-- =============================================

-- 1. Categories (Danh mục món ăn)
CREATE TABLE categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Menu Items (Món ăn)
CREATE TABLE menu_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tables (Bàn ăn)
CREATE TABLE tables (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_number INTEGER UNIQUE NOT NULL,
  status TEXT DEFAULT 'available' CHECK (status IN ('available', 'occupied')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Orders (Đơn hàng)
CREATE TABLE orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_id UUID REFERENCES tables(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'preparing', 'completed', 'paid')),
  total_amount INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Order Items (Chi tiết đơn hàng)
CREATE TABLE order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- Indexes
-- =============================================
CREATE INDEX idx_menu_items_category ON menu_items(category_id);
CREATE INDEX idx_orders_table ON orders(table_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- =============================================
-- Enable Realtime
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE tables;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;

-- =============================================
-- Sample Data
-- =============================================

-- Categories
INSERT INTO categories (name, sort_order) VALUES
  ('Khai vị', 1),
  ('Món chính', 2),
  ('Lẩu', 3),
  ('Đồ uống', 4),
  ('Tráng miệng', 5);

-- Tables (10 bàn)
INSERT INTO tables (table_number, status) VALUES
  (1, 'available'), (2, 'available'), (3, 'available'),
  (4, 'available'), (5, 'available'), (6, 'available'),
  (7, 'available'), (8, 'available'), (9, 'available'),
  (10, 'available');

-- Sample Menu Items
INSERT INTO menu_items (category_id, name, description, price, is_available) VALUES
  ((SELECT id FROM categories WHERE name = 'Khai vị'), 'Gỏi cuốn tôm thịt', 'Gỏi cuốn tươi với tôm, thịt heo, bún, rau sống', 45000, true),
  ((SELECT id FROM categories WHERE name = 'Khai vị'), 'Chả giò', 'Chả giò giòn rụm nhân thịt heo, nấm mèo', 50000, true),
  ((SELECT id FROM categories WHERE name = 'Khai vị'), 'Súp cua', 'Súp cua trứng bắc thảo', 55000, true),
  ((SELECT id FROM categories WHERE name = 'Món chính'), 'Cơm tấm sườn bì chả', 'Cơm tấm đặc biệt với sườn nướng, bì, chả trứng', 65000, true),
  ((SELECT id FROM categories WHERE name = 'Món chính'), 'Phở bò tái nạm', 'Phở bò truyền thống với tái, nạm, gầu', 70000, true),
  ((SELECT id FROM categories WHERE name = 'Món chính'), 'Bún bò Huế', 'Bún bò Huế đậm đà hương vị miền Trung', 65000, true),
  ((SELECT id FROM categories WHERE name = 'Món chính'), 'Cá kho tộ', 'Cá basa kho tộ đậm đà, ăn kèm cơm trắng', 85000, true),
  ((SELECT id FROM categories WHERE name = 'Lẩu'), 'Lẩu thái hải sản', 'Lẩu chua cay kiểu Thái với tôm, mực, cá', 250000, true),
  ((SELECT id FROM categories WHERE name = 'Lẩu'), 'Lẩu gà lá é', 'Lẩu gà ta nấu với lá é thơm nồng', 220000, true),
  ((SELECT id FROM categories WHERE name = 'Đồ uống'), 'Trà đá', 'Trà đá tươi mát', 10000, true),
  ((SELECT id FROM categories WHERE name = 'Đồ uống'), 'Nước ngọt', 'Coca, Pepsi, 7Up', 20000, true),
  ((SELECT id FROM categories WHERE name = 'Đồ uống'), 'Sinh tố bơ', 'Sinh tố bơ sánh mịn', 35000, true),
  ((SELECT id FROM categories WHERE name = 'Đồ uống'), 'Cà phê sữa đá', 'Cà phê phin sữa đá', 30000, true),
  ((SELECT id FROM categories WHERE name = 'Tráng miệng'), 'Chè thái', 'Chè thái truyền thống với nhiều topping', 30000, true),
  ((SELECT id FROM categories WHERE name = 'Tráng miệng'), 'Bánh flan', 'Bánh flan caramen mềm mịn', 25000, true);
