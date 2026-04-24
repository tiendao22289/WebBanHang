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
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
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
  const [selectedBill, setSelectedBill] = useState(null);

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
    revenueByDay.sort((a, b) => a.date.localeCompare(b.date));

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

  // === XUẤT EXCEL CHUẨN MẪU S2a-HKD VỚI EXCELJS ===
  const handleExportExcel = async () => {
    let periodLabel = 'Khác';
    if (period === 'today') periodLabel = 'Hôm nay';
    else if (period === 'yesterday') periodLabel = 'Hôm qua';
    else if (period === '7days') periodLabel = '7 ngày gần nhất';
    else if (period === 'month') periodLabel = 'Tháng này';
    else if (period === 'quarter') periodLabel = 'Quý này';
    else if (period === 'custom') periodLabel = `Từ ${format(new Date(customStart), 'dd/MM/yyyy')} đến ${format(new Date(customEnd), 'dd/MM/yyyy')}`;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('So S2a HKD', {
      views: [{ showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'portrait' }
    });

    // Cài đặt độ rộng cột chuẩn giống mẫu
    sheet.columns = [
      { key: 'A', width: 18 }, // Số hiệu
      { key: 'B', width: 22 }, // Ngày tháng
      { key: 'C', width: 60 }, // Diễn giải
      { key: 'D', width: 25 }, // Số tiền
    ];

    // Tạo các dòng Header (từ 1 đến 8)
    // Dòng 1
    sheet.getCell('A1').value = 'HỘ KINH DOANH ỐC BẢO KHANG';
    sheet.getCell('A1').font = { name: 'Times New Roman', size: 12, bold: true };
    sheet.getCell('D1').value = 'Mẫu số S2a-HKD';
    sheet.getCell('D1').font = { name: 'Times New Roman', size: 12, bold: true };
    sheet.getCell('D1').alignment = { horizontal: 'center', vertical: 'middle' };

    // Dòng 2
    sheet.getCell('A2').value = 'Địa chỉ: 167B Nguyễn Văn Luông, Phường Bình Phú, Quận 6, TP.HCM';
    sheet.getCell('A2').font = { name: 'Times New Roman', size: 12 };
    sheet.getCell('D2').value = '(Kèm theo Thông tư số 152/2025/TT-BTC ngày 31 tháng 12 năm 2025 của Bộ trưởng Bộ Tài chính)';
    sheet.getCell('D2').font = { name: 'Times New Roman', size: 11, italic: true };
    sheet.getCell('D2').alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    sheet.mergeCells('D2:D5');

    // Dòng 3
    sheet.getCell('A3').value = 'Mã số thuế: ';
    sheet.getCell('A3').font = { name: 'Times New Roman', size: 12 };

    // Dòng 6: Tiêu đề chính
    sheet.getCell('A6').value = 'SỔ DOANH THU BÁN HÀNG HOÁ, DỊCH VỤ';
    sheet.getCell('A6').font = { name: 'Times New Roman', size: 14, bold: true };
    sheet.getCell('A6').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.mergeCells('A6:D6');

    // Dòng 7
    sheet.getCell('A7').value = 'Địa điểm kinh doanh: 167B Nguyễn Văn Luông, Phường Bình Phú, Quận 6, TP.HCM';
    sheet.getCell('A7').font = { name: 'Times New Roman', size: 12 };
    sheet.getCell('A7').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.mergeCells('A7:D7');

    // Dòng 8
    sheet.getCell('A8').value = `Kỳ kê khai: ${periodLabel}`;
    sheet.getCell('A8').font = { name: 'Times New Roman', size: 12 };
    sheet.getCell('A8').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.mergeCells('A8:D8');

    // Headers của Bảng (Dòng 9 - 11)
    sheet.getCell('A9').value = 'Chứng từ';
    sheet.mergeCells('A9:B9');

    sheet.getCell('A10').value = 'Số hiệu';
    sheet.getCell('B10').value = 'Ngày, tháng';

    sheet.getCell('C9').value = 'Diễn giải';
    sheet.mergeCells('C9:C10');

    sheet.getCell('D9').value = 'Số tiền';
    sheet.mergeCells('D9:D10');

    sheet.getCell('A11').value = 'A';
    sheet.getCell('B11').value = 'B';
    sheet.getCell('C11').value = 'C';
    sheet.getCell('D11').value = '1';

    // Format style cho Header Bảng (Viền, In đậm, Căn giữa)
    for (let r = 9; r <= 11; r++) {
      const row = sheet.getRow(r);
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (colNum <= 4) {
          cell.font = { name: 'Times New Roman', size: 12, bold: (r < 11), italic: (r === 11) };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = {
            top: { style: 'thin' }, left: { style: 'thin' },
            bottom: { style: 'thin' }, right: { style: 'thin' }
          };
        }
      });
    }
    // Khắc phục border cho các ô merge bị mất viền phải
    sheet.getCell('B9').border = { top: { style: 'thin' }, right: { style: 'thin' }, bottom: { style: 'thin' } };
    sheet.getCell('D9').border = { top: { style: 'thin' }, right: { style: 'thin' }, left: { style: 'thin' } };
    sheet.getCell('D10').border = { bottom: { style: 'thin' }, right: { style: 'thin' }, left: { style: 'thin' } };

    // Dòng 12: Ngành nghề
    const r12 = sheet.addRow([null, null, '1. Ngành nghề: Bán đồ ăn uống', null]);
    r12.getCell(3).font = { name: 'Times New Roman', size: 12, bold: true };
    r12.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber <= 4) {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      }
    });

    // Đổ dữ liệu Data (Sắp xếp tăng dần theo thời gian)
    const sortedOrders = [...stats.validOrders].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    sortedOrders.forEach(order => {
      const dateStr = format(new Date(order.created_at), 'dd/MM/yyyy HH:mm');
      const billId = `#${order.id.slice(0, 6).toUpperCase()}`;
      const payment = order.payment_method === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
      const totalBill = order.total_amount || 0;

      // 1. Dòng tổng của Bill
      const rowBill = sheet.addRow([null, dateStr, `${billId} - Doanh thu bán hàng (${payment})`, totalBill]);
      rowBill.getCell(4).numFmt = '#,##0 "VND"';

      rowBill.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber <= 4) {
          cell.font = { name: 'Times New Roman', size: 12, bold: true };
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

          if (colNumber <= 2) cell.alignment = { vertical: 'middle', horizontal: 'center' };
          else if (colNumber === 3) cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
          else cell.alignment = { vertical: 'middle', horizontal: 'right' };
        }
      });

      // 2. Dòng chi tiết các món ăn trong Bill
      if (order.order_items && order.order_items.length > 0) {
        order.order_items.forEach((item) => {
          const itemTotal = item.quantity * item.unit_price;
          const priceStr = new Intl.NumberFormat('vi-VN').format(item.unit_price) + 'đ';

          const rowItem = sheet.addRow([
            null,
            null,
            `- ${item.menu_item?.name || 'Món đã xóa'} (số lượng: ${item.quantity}, đơn giá: ${priceStr})`,
            itemTotal
          ]);
          rowItem.getCell(4).numFmt = '#,##0 "VND"';

          rowItem.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            if (colNumber <= 4) {
              cell.font = { name: 'Times New Roman', size: 12 };
              cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

              if (colNumber === 3) cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
              if (colNumber === 4) cell.alignment = { vertical: 'middle', horizontal: 'right' };
            }
          });
        });
      }
    });

    // --- THÊM PHẦN TỔNG KẾT VÀ CHỮ KÝ Ở CUỐI BẢNG ---
    const totalRow = sheet.addRow([null, null, 'Tổng cộng doanh thu:', stats.totalRevenue]);
    totalRow.getCell(4).numFmt = '#,##0 "VND"';
    totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber <= 4) {
        cell.font = { name: 'Times New Roman', size: 12, bold: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        if (colNumber === 3) cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (colNumber === 4) cell.alignment = { horizontal: 'right', vertical: 'middle' };
      }
    });

    const taxGtgtRow = sheet.addRow([null, null, 'Tổng số thuế GTGT phải nộp', null]);
    taxGtgtRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber <= 4) {
        cell.font = { name: 'Times New Roman', size: 12, bold: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        if (colNumber === 3) cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    });

    const taxTncnRow = sheet.addRow([null, null, 'Tổng số thuế TNCN phải nộp', null]);
    taxTncnRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber <= 4) {
        cell.font = { name: 'Times New Roman', size: 12, bold: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        if (colNumber === 3) cell.alignment = { horizontal: 'center', vertical: 'middle' };
      }
    });

    // Phần chữ ký (Gộp ô C và D cho căn giữa đẹp mắt)
    const today = new Date();
    const dateStr = `Ngày ${today.getDate().toString().padStart(2, '0')} tháng ${today.getMonth() + 1} năm ${today.getFullYear()}`;

    const sigDateRow = sheet.addRow([null, null, dateStr, null]);
    sheet.mergeCells(`C${sigDateRow.number}:D${sigDateRow.number}`);
    sigDateRow.getCell(3).font = { name: 'Times New Roman', size: 12, italic: true };
    sigDateRow.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };

    const sigTitleRow1 = sheet.addRow([null, null, 'NGƯỜI ĐẠI DIỆN HỘ KINH DOANH/', null]);
    sheet.mergeCells(`C${sigTitleRow1.number}:D${sigTitleRow1.number}`);
    sigTitleRow1.getCell(3).font = { name: 'Times New Roman', size: 12, bold: true };
    sigTitleRow1.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };

    const sigTitleRow2 = sheet.addRow([null, null, 'CÁ NHÂN KINH DOANH', null]);
    sheet.mergeCells(`C${sigTitleRow2.number}:D${sigTitleRow2.number}`);
    sigTitleRow2.getCell(3).font = { name: 'Times New Roman', size: 12, bold: true };
    sigTitleRow2.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };

    const sigDescRow = sheet.addRow([null, null, '(Ký, họ tên và đóng dấu (nếu có))', null]);
    sheet.mergeCells(`C${sigDescRow.number}:D${sigDescRow.number}`);
    sigDescRow.getCell(3).font = { name: 'Times New Roman', size: 12, italic: true };
    sigDescRow.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };

    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer]), `So_S2a_HKD_BaoKhang_${format(new Date(), 'ddMMyyyy_HHmm')}.xlsx`);
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
                    {stats.validOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map(order => {
                      const totalItems = order.order_items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
                      const itemNames = order.order_items?.map(item => `${item.menu_item?.name || 'Món xóa'} (x${item.quantity})`).join(', ');
                      return (
                        <tr
                          key={order.id}
                          style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }}
                          onClick={() => setSelectedBill(order)}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8fafc'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                        >
                          <td style={{ padding: '12px 8px', fontWeight: 600, color: '#3b82f6', textDecoration: 'underline' }}>#{order.id.slice(0, 6).toUpperCase()}</td>
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

      {/* Chi tiết Hóa đơn Modal */}
      {selectedBill && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setSelectedBill(null)}
        >
          <div
            style={{ background: 'white', padding: '24px', borderRadius: '12px', width: '90%', maxWidth: '600px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', color: '#0f172a' }}>Chi tiết Hóa đơn <span style={{ color: '#3b82f6' }}>#{selectedBill.id.slice(0, 6).toUpperCase()}</span></h3>
              <button onClick={() => setSelectedBill(null)} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '50%' }}>&times;</button>
            </div>

            <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: '#475569', backgroundColor: '#f8fafc', padding: '12px', borderRadius: '8px' }}>
              <div>
                <p style={{ margin: '4px 0' }}><strong>Thời gian:</strong> {format(new Date(selectedBill.created_at), 'dd/MM/yyyy HH:mm')}</p>
                <p style={{ margin: '4px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <strong>PTTT:</strong>
                  <span style={{
                    padding: '2px 6px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
                    background: selectedBill.payment_method === 'transfer' ? '#dbeafe' : '#d1fae5',
                    color: selectedBill.payment_method === 'transfer' ? '#2563eb' : '#10b981'
                  }}>
                    {selectedBill.payment_method === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt'}
                  </span>
                </p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ margin: '4px 0' }}><strong>Tổng số món:</strong> {selectedBill.order_items?.reduce((sum, item) => sum + item.quantity, 0) || 0}</p>
                <p style={{ margin: '4px 0', fontSize: '1.1rem' }}><strong>Tổng tiền:</strong> <span style={{ color: '#ef4444', fontWeight: 'bold' }}>{formatPrice(selectedBill.total_amount)}</span></p>
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, border: '1px solid #e2e8f0', borderRadius: '8px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#f1f5f9', zIndex: 1 }}>
                  <tr>
                    <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Tên món</th>
                    <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>SL</th>
                    <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Đơn giá</th>
                    <th style={{ padding: '12px', textAlign: 'right', borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: 600 }}>Thành tiền</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedBill.order_items?.map((item, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '12px', color: '#0f172a', fontWeight: 500 }}>{item.menu_item?.name || 'Món đã xóa'}</td>
                      <td style={{ padding: '12px', textAlign: 'center', color: '#475569' }}>{item.quantity}</td>
                      <td style={{ padding: '12px', textAlign: 'right', color: '#475569' }}>{formatPrice(item.unit_price)}</td>
                      <td style={{ padding: '12px', textAlign: 'right', color: '#0f172a', fontWeight: 600 }}>{formatPrice(item.quantity * item.unit_price)}</td>
                    </tr>
                  ))}
                  {(!selectedBill.order_items || selectedBill.order_items.length === 0) && (
                    <tr>
                      <td colSpan="4" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>Không có món nào trong bill này.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: '20px', textAlign: 'right' }}>
              <button
                onClick={() => setSelectedBill(null)}
                style={{ padding: '10px 20px', background: '#e2e8f0', color: '#475569', border: 'none', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}
              >
                Đóng lại
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
