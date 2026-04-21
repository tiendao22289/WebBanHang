'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import {
  DollarSign,
  Award,
  Download,
  Wallet,
  Landmark,
  Receipt
} from 'lucide-react';
import { 
  startOfDay, endOfDay, subDays, startOfMonth, endOfMonth, 
  startOfQuarter, endOfQuarter, format 
} from 'date-fns';
import * as XLSX from 'xlsx';
import './stats.css';

const CHART_COLORS = ['#D4A574', '#C4453C', '#2DB67C', '#3B82F6', '#F5A623', '#8B5CF6', '#EC4899', '#14B8A6'];
const PAYMENT_COLORS = ['#3B82F6', '#2DB67C']; // CK, Tiền mặt
const VAT_RATE = 0.08; // 8% thuế suất F&B

export default function StatsPage() {
  const [period, setPeriod] = useState('today'); // today, yesterday, 7days, month, quarter, custom
  const [customStart, setCustomStart] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [customEnd, setCustomEnd] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [stats, setStats] = useState({
    totalRevenue: 0,
    netRevenue: 0,
    vatAmount: 0,
    cashRevenue: 0,
    transferRevenue: 0,
    totalOrders: 0,
    totalItemsSold: 0,
    avgOrderValue: 0,
    revenueByDay: [],
    topItems: [],
    categoryBreakdown: [],
    paymentBreakdown: [],
    allRawItems: [], // for export
    validOrders: [], // for export & table
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, [period]);

  async function fetchStats() {
    setLoading(true);
    const now = new Date();
    let startDate, endDate;

    switch (period) {
      case 'today':
        startDate = startOfDay(now);
        endDate = endOfDay(now);
        break;
      case 'yesterday':
        startDate = startOfDay(subDays(now, 1));
        endDate = endOfDay(subDays(now, 1));
        break;
      case '7days':
        startDate = startOfDay(subDays(now, 6));
        endDate = endOfDay(now);
        break;
      case 'month':
        startDate = startOfMonth(now);
        endDate = endOfMonth(now);
        break;
      case 'quarter':
        startDate = startOfQuarter(now);
        endDate = endOfQuarter(now);
        break;
      case 'custom':
        startDate = startOfDay(new Date(customStart));
        endDate = endOfDay(new Date(customEnd));
        break;
      default:
        startDate = startOfDay(now);
        endDate = endOfDay(now);
    }

    // 1. Fetch ALL orders in period that are NOT hidden (is_hidden_from_stats = false)
    // Sổ chính thức, giới hạn định mức đã được xử lý bởi is_hidden_from_stats lúc tạo bill
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
      .lte('created_at', endDate.toISOString())
      .is('is_hidden_from_stats', false); 

    if (!ordersData) {
      setLoading(false);
      return;
    }

    // 2. Lọc CỰC KỲ KHẮT KHE cho Thuế: 
    // - Chỉ lấy bill Thành Công / Đã thanh toán (Bỏ qua Hủy)
    // - Chỉ lấy Tiền mặt HOẶC Chuyển khoản (Bỏ qua thẻ, công nợ, khác...)
    const validOrders = ordersData.filter(o => 
      (o.status === 'completed' || o.status === 'paid') &&
      (o.payment_method === 'cash' || o.payment_method === 'transfer')
    );

    // 3. Tính toán DOANH THU ĐẢM BẢO KHỚP 100%
    let cashRevenue = 0;
    let transferRevenue = 0;

    validOrders.forEach(o => {
      const amount = o.total_amount || 0;
      if (o.payment_method === 'cash') cashRevenue += amount;
      if (o.payment_method === 'transfer') transferRevenue += amount;
    });

    // Công thức tuyệt đối: Gross = Cash + Transfer
    const totalRevenue = cashRevenue + transferRevenue; 
    
    // Công thức tuyệt đối: Net = Gross / 1.08, VAT = Gross - Net
    const netRevenue = Math.round(totalRevenue / (1 + VAT_RATE));
    const vatAmount = totalRevenue - netRevenue;

    const totalOrders = validOrders.length;
    const totalItemsSold = validOrders.reduce((sum, o) =>
      sum + (o.order_items?.reduce((s, i) => s + i.quantity, 0) || 0), 0
    );
    const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

    // 4. Bảng kê hàng hóa xuất bán (Sẽ có thể chênh lệch giá trị vài đồng nếu có giảm giá trên tổng bill, nhưng quantity là chuẩn xác xuất kho)
    const itemMap = {};
    validOrders.forEach(order => {
      order.order_items?.forEach(oi => {
        const name = oi.menu_item?.name || 'Món đã xóa';
        if (!itemMap[name]) itemMap[name] = { name, quantity: 0, revenue: 0, price: oi.unit_price };
        itemMap[name].quantity += oi.quantity;
        itemMap[name].revenue += oi.unit_price * oi.quantity;
      });
    });

    const allRawItems = Object.values(itemMap).sort((a, b) => b.quantity - a.quantity);
    const topItems = allRawItems.slice(0, 8); // UI top 8

    // 5. Doanh thu theo ngày (Biểu đồ)
    const revenueMap = {};
    validOrders.forEach(order => {
      const key = format(new Date(order.created_at), 'dd/MM');
      if (revenueMap[key] === undefined) revenueMap[key] = 0;
      revenueMap[key] += order.total_amount || 0;
    });

    const revenueByDay = Object.entries(revenueMap).map(([date, revenue]) => ({ date, revenue }));
    revenueByDay.sort((a,b) => a.date.localeCompare(b.date));

    // 6. Category breakdown
    const catMap = {};
    validOrders.forEach(order => {
      order.order_items?.forEach(oi => {
        const catName = oi.menu_item?.category?.name || 'Khác';
        if (!catMap[catName]) catMap[catName] = 0;
        catMap[catName] += oi.unit_price * oi.quantity;
      });
    });
    const categoryBreakdown = Object.entries(catMap).map(([name, value]) => ({ name, value }));

    // 7. Payment breakdown
    const paymentBreakdown = [
      { name: 'Chuyển khoản', value: transferRevenue },
      { name: 'Tiền mặt', value: cashRevenue }
    ].filter(item => item.value > 0);

    setStats({
      totalRevenue, netRevenue, vatAmount, cashRevenue, transferRevenue,
      totalOrders, totalItemsSold, avgOrderValue,
      revenueByDay, topItems, categoryBreakdown, paymentBreakdown,
      allRawItems, validOrders, // <-- Mảng validOrders sạch 100%
    });
    setLoading(false);
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  // === XUẤT EXCEL CHUẨN KẾ TOÁN ===
  const handleExportExcel = () => {
    let periodLabel = 'Khác';
    if (period === 'today') periodLabel = 'Hôm nay';
    else if (period === 'yesterday') periodLabel = 'Hôm qua';
    else if (period === '7days') periodLabel = '7 ngày gần nhất';
    else if (period === 'month') periodLabel = 'Tháng này';
    else if (period === 'quarter') periodLabel = 'Quý này';
    else if (period === 'custom') periodLabel = `Từ ${format(new Date(customStart), 'dd/MM/yyyy')} đến ${format(new Date(customEnd), 'dd/MM/yyyy')}`;

    // 1. Sheet THÔNG TIN HỘ KINH DOANH
    const infoData = [
      ['BÁO CÁO DOANH THU CHUẨN MẪU THUẾ'],
      [],
      ['THÔNG TIN HỘ KINH DOANH'],
      ['Tên quán:', 'Ốc Bảo Khang'],
      ['Mã Số Thuế (MST):', ''],
      ['Địa chỉ:', '167B Nguyễn Văn Luông, Phường Bình Phú, Quận 6, TP.HCM'],
      ['Loại hình:', 'Hộ kinh doanh'],
      [],
      ['THÔNG TIN KỲ BÁO CÁO'],
      ['Kỳ báo cáo:', periodLabel],
      ['Ngày xuất báo cáo:', format(new Date(), 'dd/MM/yyyy HH:mm')]
    ];
    const wsInfo = XLSX.utils.aoa_to_sheet(infoData);
    wsInfo['!cols'] = [{wch: 30}, {wch: 50}];

    // 2. Sheet Tổng Hợp
    const summaryData = [
      ['TỔNG QUAN KẾT QUẢ KINH DOANH (Đã lọc bill hợp lệ)'],
      [],
      ['CHỈ SỐ', 'GIÁ TRỊ (VNĐ)'],
      ['1. Tổng Doanh Thu (Gross)', stats.totalRevenue],
      ['2. Doanh thu Trước Thuế (Net)', stats.netRevenue],
      ['3. Tiền Thuế GTGT (VAT 8%)', stats.vatAmount],
      ['4. Thanh toán Chuyển khoản', stats.transferRevenue],
      ['5. Thanh toán Tiền mặt', stats.cashRevenue],
      ['6. Tổng số lượng Bill', stats.totalOrders],
      [],
      ['BẢNG TỔNG THEO NGÀY'],
      ['Ngày', 'Doanh thu (VNĐ)']
    ];
    
    stats.revenueByDay.forEach(day => {
      summaryData.push([day.date, day.revenue]);
    });

    summaryData.push([]);
    summaryData.push(['BẢNG TỔNG THEO THÁNG']);
    summaryData.push(['Tháng', 'Doanh thu (VNĐ)']);

    const monthMap = {};
    stats.validOrders.forEach(order => {
      const monthKey = format(new Date(order.created_at), 'MM/yyyy');
      if (monthMap[monthKey] === undefined) monthMap[monthKey] = 0;
      monthMap[monthKey] += order.total_amount || 0;
    });
    Object.entries(monthMap).sort((a,b) => a[0].localeCompare(b[0])).forEach(([month, revenue]) => {
      summaryData.push([month, revenue]);
    });

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [{wch: 35}, {wch: 20}];

    // 3. Sheet Bảng kê Chi tiết Hóa đơn
    const detailedInvoiceData = [];
    stats.validOrders.forEach(order => {
      const dateStr = format(new Date(order.created_at), 'dd/MM/yyyy');
      const timeStr = format(new Date(order.created_at), 'HH:mm:ss');
      const billId = `#${order.id.slice(0, 8).toUpperCase()}`;
      const payment = order.payment_method === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
      const totalBill = order.total_amount || 0;

      if (!order.order_items || order.order_items.length === 0) {
        detailedInvoiceData.push({
          'Ngày lập': dateStr,
          'Giờ lập': timeStr,
          'Mã Bill': billId,
          'Tên Món Ăn': '(Bill không có món)',
          'SL Món': 0,
          'Đơn Giá': 0,
          'Thành Tiền Món': 0,
          'Tổng Bill': totalBill,
          'PTTT': payment
        });
      } else {
        order.order_items.forEach((item) => {
          detailedInvoiceData.push({
            'Ngày lập': dateStr,
            'Giờ lập': timeStr,
            'Mã Bill': billId,
            'Tên Món Ăn': item.menu_item?.name || 'Món đã xóa',
            'SL Món': item.quantity,
            'Đơn Giá': item.unit_price,
            'Thành Tiền Món': item.quantity * item.unit_price,
            'Tổng Bill': totalBill,
            'PTTT': payment
          });
        });
      }
    });
    const wsInvoices = XLSX.utils.json_to_sheet(detailedInvoiceData);

    // 3. Sheet Bảng kê Hàng hóa Xuất bán (Gom nhóm tổng hợp)
    const itemsData = stats.allRawItems.map((item, index) => ({
      'STT': index + 1,
      'Tên Hàng Hóa / Dịch Vụ': item.name,
      'ĐVT': 'Phần',
      'Số Lượng': item.quantity,
      'Đơn Giá (VNĐ)': item.price,
      'Thành Tiền (VNĐ)': item.revenue
    }));
    const wsItems = XLSX.utils.json_to_sheet(itemsData);

    // Build Workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsInfo, "Thông Tin Doanh Nghiệp");
    XLSX.utils.book_append_sheet(wb, wsSummary, "Tổng Hợp Doanh Thu");
    XLSX.utils.book_append_sheet(wb, wsInvoices, "Chi Tiết Hóa Đơn");
    XLSX.utils.book_append_sheet(wb, wsItems, "Hàng Hóa Xuất Bán");

    // Format columns for wsInvoices
    wsInvoices['!cols'] = [{wch: 12}, {wch: 10}, {wch: 15}, {wch: 30}, {wch: 10}, {wch: 15}, {wch: 15}, {wch: 15}, {wch: 15}];

    XLSX.writeFile(wb, `Bao_Cao_Thu Doanh_Thu_Chuan_${format(new Date(), 'ddMMyyyy_HHmm')}.xlsx`);
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="chart-tooltip">
          <p className="chart-tooltip-label">{label}</p>
          <p className="chart-tooltip-value">{formatPrice(payload[0].value)}</p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="page-content">
      <div className="page-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Thống kê & Kế toán</h1>
          <p className="page-subtitle">Báo cáo chuẩn Thuế & Hiệu suất kinh doanh</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {period === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'white', padding: '4px 8px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ border: 'none', outline: 'none', color: '#475569', fontSize: '0.85rem' }} />
                <span style={{ color: '#94a3b8' }}>-</span>
                <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ border: 'none', outline: 'none', color: '#475569', fontSize: '0.85rem' }} />
                <button onClick={fetchStats} style={{ padding: '4px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
                  Lọc
                </button>
              </div>
            )}
            <button 
              onClick={handleExportExcel}
              style={{ 
                display: 'flex', alignItems: 'center', gap: '8px', 
                background: '#2DB67C', color: 'white', border: 'none', 
                padding: '8px 16px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer',
                boxShadow: '0 4px 6px -1px rgba(45, 182, 124, 0.2)'
              }}
            >
              <Download size={18} /> Xuất Báo Cáo
            </button>
          </div>
          <div className="period-toggle">
            {['today', 'yesterday', '7days', 'month', 'quarter', 'custom'].map(p => (
              <button
                key={p}
                className={`period-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {p === 'today' ? 'Hôm nay' : p === 'yesterday' ? 'Hôm qua' : p === '7days' ? '7 ngày' : p === 'month' ? 'Tháng' : p === 'quarter' ? 'Quý' : 'Tùy chọn'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><p>Đang tải dữ liệu báo cáo...</p></div>
      ) : (
        <>
          {/* Summary Cards - Đã loại bỏ card Hủy */}
          <div className="summary-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <div className="summary-card" style={{ borderLeft: '4px solid #D4A574' }}>
              <div className="icon-wrapper" style={{ background: '#FEF3D9', color: '#F5A623' }}>
                <DollarSign size={22} />
              </div>
              <div>
                <div className="value">{formatPrice(stats.totalRevenue)}</div>
                <div className="label">Tổng Doanh thu (Gross)</div>
              </div>
            </div>

            <div className="summary-card" style={{ borderLeft: '4px solid #3B82F6' }}>
              <div className="icon-wrapper" style={{ background: '#DBEAFE', color: '#3B82F6' }}>
                <Landmark size={22} />
              </div>
              <div>
                <div className="value">{formatPrice(stats.transferRevenue)}</div>
                <div className="label">Chuyển khoản Ngân hàng</div>
              </div>
            </div>

            <div className="summary-card" style={{ borderLeft: '4px solid #2DB67C' }}>
              <div className="icon-wrapper" style={{ background: '#D1FAE5', color: '#10B981' }}>
                <Wallet size={22} />
              </div>
              <div>
                <div className="value">{formatPrice(stats.cashRevenue)}</div>
                <div className="label">Tiền mặt</div>
              </div>
            </div>

            <div className="summary-card" style={{ borderLeft: '4px solid #8B5CF6' }}>
              <div className="icon-wrapper" style={{ background: '#EDE9FE', color: '#8B5CF6' }}>
                <Receipt size={22} />
              </div>
              <div>
                <div className="value" style={{ fontSize: '1.2rem' }}>
                  {formatPrice(stats.netRevenue)} <span style={{ fontSize: '0.8rem', color: '#6B7280', fontWeight: 'normal' }}>+ {formatPrice(stats.vatAmount)} VAT</span>
                </div>
                <div className="label">Doanh thu Net & Thuế GTGT</div>
              </div>
            </div>
          </div>

          {/* Charts Row 1 */}
          <div className="stats-grid" style={{ marginTop: '24px' }}>
            <div className="card stats-chart-card">
              <div className="card-body">
                <h3 className="chart-title">Biến động Doanh Thu Hợp Lệ</h3>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={stats.revenueByDay}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" fontSize={12} tick={{ fill: '#9CA3AF' }} />
                      <YAxis fontSize={12} tick={{ fill: '#9CA3AF' }} tickFormatter={(v) => formatPrice(v)} width={80} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="revenue" fill="url(#barGradient)" radius={[4, 4, 0, 0]} maxBarSize={50} />
                      <defs>
                        <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#3B82F6" />
                          <stop offset="100%" stopColor="#1E3A8A" />
                        </linearGradient>
                      </defs>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="card stats-chart-card">
              <div className="card-body">
                <h3 className="chart-title">Tỷ trọng Thanh toán</h3>
                <div className="chart-container">
                  {stats.paymentBreakdown.length > 0 ? (
                    <ResponsiveContainer width="100%" height={250}>
                      <PieChart>
                        <Pie
                          data={stats.paymentBreakdown}
                          cx="50%" cy="50%"
                          outerRadius={80} innerRadius={50}
                          dataKey="value"
                          labelLine={false}
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        >
                          {stats.paymentBreakdown.map((entry, i) => (
                            <Cell key={i} fill={PAYMENT_COLORS[i % PAYMENT_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value) => formatPrice(value)} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="empty-state"><p>Chưa có giao dịch hợp lệ</p></div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Danh sách Hóa đơn SẠCH */}
          <div className="card" style={{ marginTop: '24px' }}>
            <div className="card-body">
              <h3 className="chart-title"><Receipt size={18} /> Danh sách Hóa đơn (Chỉ bao gồm CK và Tiền mặt)</h3>
              <div className="invoice-table-wrapper" style={{ overflowX: 'auto', maxHeight: '500px', overflowY: 'auto' }}>
                <table className="invoice-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
                    <tr style={{ borderBottom: '2px solid #e2e8f0', textAlign: 'left', color: '#64748b' }}>
                      <th style={{ padding: '12px 8px', whiteSpace: 'nowrap' }}>Mã Bill</th>
                      <th style={{ padding: '12px 8px', whiteSpace: 'nowrap' }}>Thời Gian</th>
                      <th style={{ padding: '12px 8px', whiteSpace: 'nowrap' }}>PTTT</th>
                      <th style={{ padding: '12px 8px', whiteSpace: 'nowrap', textAlign: 'right' }}>Tổng Tiền</th>
                      <th style={{ padding: '12px 8px', whiteSpace: 'nowrap', textAlign: 'center' }}>SL Món</th>
                      <th style={{ padding: '12px 8px' }}>Chi tiết Món</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.validOrders.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).map(order => {
                      const totalItems = order.order_items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
                      const itemNames = order.order_items?.map(item => `${item.menu_item?.name || 'Món xóa'} (x${item.quantity})`).join(', ');
                      return (
                        <tr key={order.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '12px 8px', fontWeight: 600, color: '#3b82f6' }}>#{order.id.slice(0, 6).toUpperCase()}</td>
                          <td style={{ padding: '12px 8px' }}>{format(new Date(order.created_at), 'dd/MM/yyyy HH:mm')}</td>
                          <td style={{ padding: '12px 8px' }}>
                            <span style={{ 
                              padding: '4px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600,
                              background: order.payment_method === 'transfer' ? '#dbeafe' : '#d1fae5',
                              color: order.payment_method === 'transfer' ? '#2563eb' : '#10b981'
                            }}>
                              {order.payment_method === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt'}
                            </span>
                          </td>
                          <td style={{ padding: '12px 8px', fontWeight: 600, color: '#0f172a', textAlign: 'right' }}>{formatPrice(order.total_amount)}</td>
                          <td style={{ padding: '12px 8px', textAlign: 'center' }}>{totalItems}</td>
                          <td style={{ padding: '12px 8px', maxWidth: '300px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#475569' }} title={itemNames}>
                            {itemNames}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {stats.validOrders.length === 0 && (
                  <div className="empty-state"><p>Không có hóa đơn hợp lệ nào trong kỳ</p></div>
                )}
              </div>
            </div>
          </div>

        </>
      )}
    </div>
  );
}
