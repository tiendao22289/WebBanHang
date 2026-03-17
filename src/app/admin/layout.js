'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  UtensilsCrossed,
  Receipt,
  BarChart3,
  ChefHat,
  UsersRound,
} from 'lucide-react';
import './admin.css';

const navItems = [
  { href: '/admin/tables', label: 'Quản lý bàn', icon: LayoutGrid },
  { href: '/admin/menu', label: 'Thực đơn', icon: UtensilsCrossed },
  { href: '/admin/orders', label: 'Hoá đơn', icon: Receipt },
  { href: '/admin/customers', label: 'Khách hàng', icon: UsersRound },
  { href: '/admin/stats', label: 'Thống kê', icon: BarChart3 },
];

export default function AdminLayout({ children }) {
  const pathname = usePathname();

  return (
    <div className="admin-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <ChefHat size={28} />
            <div>
              <h1 className="sidebar-title">Nhà Hàng</h1>
              <span className="sidebar-subtitle">Quản lý đặt món</span>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${isActive ? 'active' : ''}`}
              >
                <Icon size={20} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-version">v1.0.0</div>
        </div>
      </aside>

      <main className="admin-main">
        {children}
      </main>
    </div>
  );
}
