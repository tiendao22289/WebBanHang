-- =============================================
-- Migration: Add Customers Table + Table Auto-Expire
-- Run this AFTER the initial database.sql
-- =============================================

-- 1. Customers table (Khách hàng)
CREATE TABLE IF NOT EXISTS customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  total_spent INTEGER DEFAULT 0,
  visit_count INTEGER DEFAULT 0,
  last_visit_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Add customer_id to orders (link order to customer)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- 3. Add occupied_at to tables (track when table became occupied, for auto-expire)
ALTER TABLE tables ADD COLUMN IF NOT EXISTS occupied_at TIMESTAMPTZ;

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_tables_occupied_at ON tables(occupied_at);

-- 5. Enable Realtime for customers
ALTER PUBLICATION supabase_realtime ADD TABLE customers;
