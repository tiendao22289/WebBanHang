'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import {
  LayoutGrid,
  UtensilsCrossed,
  Receipt,
  BarChart3,
  ChefHat,
  UsersRound,
  Wallet,
  LogOut,
  Lock,
  Settings,
} from 'lucide-react';
import './admin.css';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const ALL_NAV = [
  { href: '/admin/tables',    label: 'Quản lý bàn', icon: LayoutGrid },
  { href: '/admin/menu',      label: 'Thực đơn',    icon: UtensilsCrossed },
  { href: '/admin/orders',    label: 'Hoá đơn',     icon: Receipt },
  { href: '/admin/customers', label: 'Khách hàng',  icon: UsersRound },
  { href: '/admin/notes',     label: 'Sổ tay',      icon: ChefHat },
  { href: '/admin/payroll',   label: 'Tính Lương',  icon: Wallet },
  { href: '/admin/stats',     label: 'Thống kê',    icon: BarChart3 },
  { href: '/admin/settings',  label: 'Cài đặt',     icon: Settings, adminOnly: true },
];

// Pages staff are allowed to visit
const STAFF_ALLOWED_HREFS = ['/admin/tables', '/admin/orders', '/admin/payroll'];

const STAFF_NAV = ALL_NAV.filter(n => STAFF_ALLOWED_HREFS.some(a => n.href.startsWith(a)));

export default function AdminLayout({ children }) {
  const pathname = usePathname();
  const router   = useRouter();

  const [user,    setUser]    = useState(null);
  const [mounted, setMounted] = useState(false);

  // Login form state
  const [phone,   setPhone]   = useState('');
  const [pin,     setPin]     = useState('');
  const [err,     setErr]     = useState('');
  const [loading, setLoading] = useState(false);

  // Restore session on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('staffUser');
      if (saved) setUser(JSON.parse(saved));
    } catch {}
    setMounted(true);
  }, []);

  // Redirect staff away from restricted pages
  useEffect(() => {
    if (!mounted || !user) return;
    if (user.role !== 'admin') {
      const allowed = STAFF_ALLOWED_HREFS.some(a => pathname.startsWith(a));
      if (!allowed) router.replace('/admin/notes');
    }
  }, [user, pathname, mounted, router]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    const { data, error } = await supabase
      .from('staff')
      .select('id, full_name, phone, role')
      .eq('phone', phone.trim())
      .eq('pin', pin.trim())
      .single();

    if (error || !data) {
      setErr('Sai số điện thoại hoặc mã PIN!');
      setLoading(false);
      return;
    }

    const u = { id: data.id, full_name: data.full_name, phone: data.phone, role: data.role };
    localStorage.setItem('staffUser', JSON.stringify(u));
    setUser(u);
    setLoading(false);

    // Update last_login silently
    supabase.from('staff').update({ last_login: new Date().toISOString() }).eq('id', data.id);
  };

  const handleLogout = () => {
    localStorage.removeItem('staffUser');
    setUser(null);
    setPhone('');
    setPin('');
  };

  // Prevent SSR flash
  if (!mounted) return null;

  // ── Login screen ──────────────────────────────────────────────────────────
  if (!user) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #fef2f2 0%, #fff 60%, #fef9c3 100%)',
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{
          background: 'white', borderRadius: 20, padding: '36px 32px', width: '100%', maxWidth: 380,
          boxShadow: '0 20px 60px rgba(220,38,38,0.1), 0 4px 16px rgba(0,0,0,0.06)',
        }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6 }}>
              <ChefHat size={32} color="#dc2626" />
              <span style={{ fontSize: '1.5rem', fontWeight: 800, color: '#dc2626', letterSpacing: '-0.02em' }}>Nhà Hàng V1</span>
            </div>
            <p style={{ fontSize: '0.85rem', color: '#9ca3af', margin: 0 }}>Đăng nhập để tiếp tục</p>
          </div>

          {err && (
            <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem', fontWeight: 600 }}>
              {err}
            </div>
          )}

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#374151', display: 'block', marginBottom: 6 }}>
                Số điện thoại
              </label>
              <input
                type="tel" required value={phone} placeholder="0909 123 456"
                onChange={e => setPhone(e.target.value)}
                style={{ width: '100%', padding: '12px 16px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '0.95rem', outline: 'none', boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = '#dc2626'}
                onBlur={e => e.target.style.borderColor = '#e5e7eb'}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.8rem', fontWeight: 700, color: '#374151', display: 'block', marginBottom: 6 }}>
                Mã PIN
              </label>
              <input
                type="password" required value={pin} placeholder="••••••"
                onChange={e => setPin(e.target.value)}
                style={{ width: '100%', padding: '12px 16px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '0.95rem', letterSpacing: 4, outline: 'none', boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = '#dc2626'}
                onBlur={e => e.target.style.borderColor = '#e5e7eb'}
              />
            </div>
            <button
              type="submit" disabled={loading}
              style={{ background: '#dc2626', color: 'white', border: 'none', borderRadius: 12, padding: '14px', fontWeight: 800, fontSize: '1rem', cursor: 'pointer', marginTop: 4, opacity: loading ? 0.7 : 1, transition: 'all 0.2s' }}
            >
              {loading ? 'Đang kiểm tra...' : '🔓 Đăng nhập'}
            </button>
          </form>

          <p style={{ textAlign: 'center', fontSize: '0.75rem', color: '#d1d5db', marginTop: 20, marginBottom: 0 }}>
            Liên hệ quản lý nếu quên PIN
          </p>
        </div>
      </div>
    );
  }

  // ── Logged in — render layout ─────────────────────────────────────────────
  const navItems = user.role === 'admin' ? ALL_NAV : STAFF_NAV;

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
              <Link key={item.href} href={item.href} className={`nav-item ${isActive ? 'active' : ''}`}>
                <Icon size={20} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          {/* User info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '8px 10px', background: '#fef2f2', borderRadius: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#dc2626', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14, flexShrink: 0 }}>
              {user.full_name?.charAt(0) || '?'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.full_name}</div>
              <div style={{ fontSize: '0.7rem', color: user.role === 'admin' ? '#92400e' : '#0369a1', fontWeight: 600 }}>
                {user.role === 'admin' ? '👑 Admin' : '👤 Nhân viên'}
              </div>
            </div>
            <button onClick={handleLogout} title="Đăng xuất"
              style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
              <LogOut size={16} />
            </button>
          </div>
          <div className="sidebar-version">v1.0.0</div>
        </div>
      </aside>

      <main className="admin-main">
        {children}
      </main>
    </div>
  );
}
