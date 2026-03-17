'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell,
} from 'recharts';
import {
  TrendingUp,
  DollarSign,
  ShoppingBag,
  Award,
  Calendar,
} from 'lucide-react';
import './stats.css';

const CHART_COLORS = ['#D4A574', '#C4453C', '#2DB67C', '#3B82F6', '#F5A623', '#8B5CF6', '#EC4899', '#14B8A6'];

export default function StatsPage() {
  const [period, setPeriod] = useState('week'); // week | month
  const [stats, setStats] = useState({
    totalRevenue: 0,
    totalOrders: 0,
    totalItemsSold: 0,
    avgOrderValue: 0,
    revenueByDay: [],
    topItems: [],
    categoryBreakdown: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, [period]);

  async function fetchStats() {
    setLoading(true);
    const now = new Date();
    const startDate = new Date();

    if (period === 'week') {
      startDate.setDate(now.getDate() - 7);
    } else {
      startDate.setDate(now.getDate() - 30);
    }

    // Fetch orders in period
    const { data: ordersData } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (
          *,
          menu_item:menu_items(name, category_id, category:categories(name))
        )
      `)
      .gte('created_at', startDate.toISOString())
      .in('status', ['completed', 'paid']);

    if (!ordersData) {
      setLoading(false);
      return;
    }

    // Total stats
    const totalRevenue = ordersData.reduce((sum, o) => sum + (o.total_amount || 0), 0);
    const totalOrders = ordersData.length;
    const totalItemsSold = ordersData.reduce((sum, o) =>
      sum + (o.order_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0
    );
    const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

    // Revenue by day
    const revenueMap = {};
    const days = period === 'week' ? 7 : 30;
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(now.getDate() - (days - 1 - i));
      const key = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
      revenueMap[key] = 0;
    }

    ordersData.forEach(order => {
      const key = new Date(order.created_at).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
      if (revenueMap[key] !== undefined) {
        revenueMap[key] += order.total_amount || 0;
      }
    });

    const revenueByDay = Object.entries(revenueMap).map(([date, revenue]) => ({
      date,
      revenue,
    }));

    // Top selling items
    const itemMap = {};
    ordersData.forEach(order => {
      order.order_items?.forEach(oi => {
        const name = oi.menu_item?.name || 'Unknown';
        if (!itemMap[name]) itemMap[name] = { name, quantity: 0, revenue: 0 };
        itemMap[name].quantity += oi.quantity;
        itemMap[name].revenue += oi.unit_price * oi.quantity;
      });
    });

    const topItems = Object.values(itemMap)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 8);

    // Category breakdown
    const catMap = {};
    ordersData.forEach(order => {
      order.order_items?.forEach(oi => {
        const catName = oi.menu_item?.category?.name || 'Khác';
        if (!catMap[catName]) catMap[catName] = 0;
        catMap[catName] += oi.unit_price * oi.quantity;
      });
    });

    const categoryBreakdown = Object.entries(catMap).map(([name, value]) => ({
      name, value,
    }));

    setStats({
      totalRevenue,
      totalOrders,
      totalItemsSold,
      avgOrderValue,
      revenueByDay,
      topItems,
      categoryBreakdown,
    });
    setLoading(false);
  }

  function formatPrice(price) {
    if (price >= 1_000_000) return (price / 1_000_000).toFixed(1) + 'tr';
    if (price >= 1_000) return (price / 1_000).toFixed(0) + 'k';
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  function formatFullPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="chart-tooltip">
          <p className="chart-tooltip-label">{label}</p>
          <p className="chart-tooltip-value">{formatFullPrice(payload[0].value)}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Thống kê</h1>
          <p className="page-subtitle">Báo cáo doanh thu và hiệu suất</p>
        </div>
        <div className="period-toggle">
          <button
            className={`period-btn ${period === 'week' ? 'active' : ''}`}
            onClick={() => setPeriod('week')}
          >
            7 ngày
          </button>
          <button
            className={`period-btn ${period === 'month' ? 'active' : ''}`}
            onClick={() => setPeriod('month')}
          >
            30 ngày
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><p>Đang tải thống kê...</p></div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="summary-cards">
            <div className="summary-card">
              <div className="icon-wrapper" style={{ background: '#FEF3D9', color: '#F5A623' }}>
                <DollarSign size={22} />
              </div>
              <div>
                <div className="value">{formatPrice(stats.totalRevenue)}</div>
                <div className="label">Doanh thu</div>
              </div>
            </div>
            <div className="summary-card">
              <div className="icon-wrapper" style={{ background: '#DBEAFE', color: '#3B82F6' }}>
                <ShoppingBag size={22} />
              </div>
              <div>
                <div className="value">{stats.totalOrders}</div>
                <div className="label">Đơn hàng</div>
              </div>
            </div>
            <div className="summary-card">
              <div className="icon-wrapper" style={{ background: 'var(--color-success-light)', color: 'var(--color-success)' }}>
                <TrendingUp size={22} />
              </div>
              <div>
                <div className="value">{stats.totalItemsSold}</div>
                <div className="label">Món đã bán</div>
              </div>
            </div>
            <div className="summary-card">
              <div className="icon-wrapper" style={{ background: 'var(--color-primary-bg)', color: 'var(--color-primary)' }}>
                <Award size={22} />
              </div>
              <div>
                <div className="value">{formatPrice(stats.avgOrderValue)}</div>
                <div className="label">TB / đơn</div>
              </div>
            </div>
          </div>

          {/* Revenue Chart */}
          <div className="stats-grid">
            <div className="card stats-chart-card">
              <div className="card-body">
                <h3 className="chart-title">Doanh thu theo ngày</h3>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={stats.revenueByDay}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" fontSize={12} tick={{ fill: '#9CA3AF' }} />
                      <YAxis fontSize={12} tick={{ fill: '#9CA3AF' }} tickFormatter={(v) => formatPrice(v)} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="revenue" fill="url(#barGradient)" radius={[6, 6, 0, 0]} />
                      <defs>
                        <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#D4A574" />
                          <stop offset="100%" stopColor="#B8894D" />
                        </linearGradient>
                      </defs>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="card stats-chart-card">
              <div className="card-body">
                <h3 className="chart-title">Doanh thu theo danh mục</h3>
                <div className="chart-container">
                  {stats.categoryBreakdown.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={stats.categoryBreakdown}
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          innerRadius={50}
                          dataKey="value"
                          label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                          labelLine={false}
                        >
                          {stats.categoryBreakdown.map((entry, i) => (
                            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value) => formatFullPrice(value)} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="empty-state"><p>Chưa có dữ liệu</p></div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Top Items */}
          <div className="card mt-6">
            <div className="card-body">
              <h3 className="chart-title">
                <Award size={18} /> Món bán chạy nhất
              </h3>
              {stats.topItems.length > 0 ? (
                <div className="top-items-list">
                  {stats.topItems.map((item, i) => (
                    <div key={item.name} className="top-item-row">
                      <span className="top-item-rank">#{i + 1}</span>
                      <span className="top-item-name">{item.name}</span>
                      <div className="top-item-bar-wrapper">
                        <div
                          className="top-item-bar"
                          style={{
                            width: `${(item.quantity / stats.topItems[0].quantity) * 100}%`,
                            background: CHART_COLORS[i % CHART_COLORS.length],
                          }}
                        />
                      </div>
                      <span className="top-item-qty">{item.quantity} phần</span>
                      <span className="top-item-revenue">{formatPrice(item.revenue)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state"><p>Chưa có dữ liệu</p></div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
