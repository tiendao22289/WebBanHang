# WebBanHang Codebase Overview

## Architecture

This is a Next.js 14 App Router (React) based POS (Point of Sale) system for a restaurant, utilizing Supabase (PostgreSQL + Realtime + Storage) for its backend.
There is also a separate `PrintAgent` Node.js local service intended to run locally for printing bills to thermal printers.

## Key Directories

- `src/app/`: Next.js app router containing main pages and layouts.
  - `admin/`: Admin UI for managing tables, menu, orders, customers, payroll, and settings.
    - `tables/`: Main POS interface, shows real-time table status.
    - `menu/`: CRUD for categories and menu items.
    - `orders/`: View and search all orders.
    - `customers/`: CRM, tracks customer visit count and total spent.
    - `notes/`: Staff notes, expenses, repair logs.
    - `payroll/`: Salary calculations, check-ins.
    - `settings/`: Bank accounts for QR payment, location settings.
    - `stats/`: Revenue and order statistics.
  - `order/`: Customer-facing web page (accessed via QR code scan) for placing orders.
  - `checkin/`: Employee check-in page.
  - `api/`: API routes (e.g., payment confirmation).
- `src/components/`: Reusable React components.
- `src/lib/`: Core utilities and database setup.
  - `supabase.js`: Supabase client instance.
  - `print.js` / `print.jsx`: Functions for sending print jobs to Supabase `print_jobs` table.
  - `database.sql`, `migration_*.sql`: Database schema and migrations.

## Key Database Tables

1. **Menu & Orders**: `categories`, `menu_items`, `tables`, `orders`, `order_items`, `customers`.
2. **Printing**: `print_jobs` (consumed by PrintAgent).
3. **Settings & Bank**: `settings`, `bank_accounts`, `bank_daily_totals`.
4. **Staff & HR**: `staff`, `payroll_config`, `payroll_requests`, `payroll_violations`, `attendance_sessions`, `attendance_logs`, `staff_notes`.

## Key Features

1. **Ordering via QR**: Customers scan a QR code mapped to a table, access the menu, and place orders. Geolocation validation ensures they are at the restaurant.
2. **Real-time POS**: The admin page updates table statuses and incoming orders in real-time.
3. **Dual Printing System**: The app inserts print jobs into the DB for both Cashier (`cashier`) and Kitchen (`kitchen`) targets, which the local PrintAgent processes and prints.
4. **Payments**: Generates VietQR codes for dynamic bank transfers based on limits and priority rules.
5. **Promotions**: Supports "Buy N Get 1 Free" logic.
6. **HR Management**: Includes multi-session attendance check-ins, advance salary requests, and violation tracking.
