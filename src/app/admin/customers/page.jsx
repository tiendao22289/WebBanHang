'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import {
  Search,
  Eye,
  X,
  Phone,
  User,
  Calendar,
  Receipt,
  TrendingUp,
  Clock,
  DollarSign,
  Download,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import './customers.css';

const PAGE_SIZE = 50;
const SUPABASE_MAX_ROWS = 1000; // PostgREST max_rows mặc định

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerOrders, setCustomerOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);

  useEffect(() => {
    if (selectedCustomer) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [selectedCustomer]);

  // Debounce search input (300ms) để tránh spam query khi gõ
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setCurrentPage(1); // reset về trang 1 khi search thay đổi
    }, 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const fetchCustomers = useCallback(async (page, search) => {
    setLoading(true);
    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .order('last_visit_at', { ascending: false, nullsFirst: false })
      .range(from, to);

    if (search.trim()) {
      const s = search.trim().replace(/[%,]/g, ''); // bỏ ký tự đặc biệt PostgREST
      query = query.or(`name.ilike.%${s}%,phone.ilike.%${s}%`);
    }

    const { data, count } = await query;
    setCustomers(data || []);
    setTotalCount(count || 0);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchCustomers(currentPage, debouncedSearch);
  }, [currentPage, debouncedSearch, fetchCustomers]);

  async function viewCustomerHistory(customer) {
    setSelectedCustomer(customer);
    setLoadingOrders(true);

    const { data } = await supabase
      .from('orders')
      .select(`
        *,
        table:tables(table_number),
        order_items (
          *,
          menu_item:menu_items(name, price)
        )
      `)
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(50);

    setCustomerOrders(data || []);
    setLoadingOrders(false);
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
  }

  function formatDateTime(dateStr) {
    return new Date(dateStr).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'Chưa có';
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return 'Hôm nay';
    if (days === 1) return 'Hôm qua';
    if (days < 30) return `${days} ngày trước`;
    return formatDate(dateStr);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Export TẤT CẢ khách hàng (vượt qua giới hạn 1000 của Supabase bằng range loop)
  const exportToExcel = async () => {
    if (exporting) return;
    setExporting(true);
    setExportProgress(0);
    try {
      const allCustomers = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('customers')
          .select('name, phone, visit_count')
          .order('last_visit_at', { ascending: false, nullsFirst: false })
          .range(from, from + SUPABASE_MAX_ROWS - 1);
        if (error || !data || data.length === 0) break;
        allCustomers.push(...data);
        setExportProgress(allCustomers.length);
        if (data.length < SUPABASE_MAX_ROWS) break;
        from += SUPABASE_MAX_ROWS;
      }

      // BOM UTF-8 để Excel hiển thị đúng tiếng Việt
      let csvContent = '﻿Tên Khách Hàng,Số Điện Thoại,Số Lần Ghé\n';
      allCustomers.forEach(c => {
        const name = (c.name || 'Khách ẩn danh').replace(/,/g, '');
        const phone = c.phone || '';
        const visit = c.visit_count || 0;
        // ="09xx" giữ số 0 đầu khi Excel mở
        csvContent += `"${name}",="${phone}","${visit}"\n`;
      });

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `Danh_sach_khach_hang_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  };

  // Sinh danh sách page numbers hiển thị: [1, ..., curr-1, curr, curr+1, ..., last]
  function getPageNumbers() {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = new Set([1, 2, totalPages - 1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
    return Array.from(pages).filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Khách hàng</h1>
          <p className="page-subtitle">Quản lý thông tin và lịch sử đặt món</p>
        </div>
      </div>

      {/* Summary */}
      <div className="summary-cards">
        <div className="summary-card">
          <div className="icon-wrapper" style={{ background: '#DBEAFE', color: '#3B82F6' }}>
            <User size={22} />
          </div>
          <div>
            <div className="value">{totalCount.toLocaleString('vi-VN')}</div>
            <div className="label">Tổng khách hàng</div>
          </div>
        </div>
      </div>

      {/* Action Bar (Search & Export) */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
        <div className="customer-search" style={{ flex: 1, marginBottom: 0 }}>
          <Search size={16} />
          <input
            className="input"
            placeholder="Tìm theo tên hoặc số điện thoại..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <button
          onClick={exportToExcel}
          disabled={exporting}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '10px 16px',
            background: exporting ? '#94a3b8' : '#10b981', color: 'white',
            border: 'none', borderRadius: '10px', fontSize: '0.9rem',
            fontWeight: 600, cursor: exporting ? 'wait' : 'pointer',
            boxShadow: '0 2px 6px rgba(16, 185, 129, 0.25)',
            minWidth: 140, justifyContent: 'center'
          }}
        >
          <Download size={16} />
          {exporting ? `Đang xuất... ${exportProgress.toLocaleString('vi-VN')}` : 'Xuất Excel'}
        </button>
      </div>

      {/* Customer List */}
      {loading ? (
        <div className="empty-state"><p>Đang tải...</p></div>
      ) : customers.length > 0 ? (
        <>
          <div className="card">
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Khách hàng</th>
                    <th>Số điện thoại</th>
                    <th>Số lần ghé</th>
                    <th>Lần cuối</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((customer) => (
                    <tr key={customer.id}>
                      <td>
                        <div className="customer-name-cell">
                          <div className="customer-avatar">
                            {customer.name?.charAt(0)?.toUpperCase() || '?'}
                          </div>
                          <strong>{customer.name}</strong>
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <Phone size={14} className="text-muted" />
                          {customer.phone}
                        </div>
                      </td>
                      <td>
                        <span className="visit-badge">{customer.visit_count || 0} lần</span>
                      </td>
                      <td>
                        <span className="text-muted text-sm">{timeAgo(customer.last_visit_at)}</span>
                      </td>
                      <td></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, marginTop: 16, flexWrap: 'wrap'
          }}>
            <div style={{ fontSize: '0.85rem', color: '#64748b' }}>
              Hiển thị <strong>{((currentPage - 1) * PAGE_SIZE + 1).toLocaleString('vi-VN')}</strong>
              {' '}–{' '}
              <strong>{Math.min(currentPage * PAGE_SIZE, totalCount).toLocaleString('vi-VN')}</strong>
              {' '} / <strong>{totalCount.toLocaleString('vi-VN')}</strong> khách hàng
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                style={pageBtnStyle(false, currentPage === 1)}
              >
                <ChevronLeft size={16} /> Trước
              </button>
              {getPageNumbers().map((p, idx, arr) => {
                const showEllipsis = idx > 0 && p - arr[idx - 1] > 1;
                return (
                  <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {showEllipsis && <span style={{ color: '#94a3b8', padding: '0 4px' }}>…</span>}
                    <button
                      onClick={() => setCurrentPage(p)}
                      style={pageBtnStyle(p === currentPage, false)}
                    >
                      {p}
                    </button>
                  </span>
                );
              })}
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                style={pageBtnStyle(false, currentPage === totalPages)}
              >
                Sau <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <User size={48} />
          <p>{debouncedSearch ? `Không tìm thấy khách hàng "${debouncedSearch}"` : 'Chưa có khách hàng nào'}</p>
          {!debouncedSearch && <p className="text-sm text-muted">Khách hàng sẽ tự động được lưu khi đặt món</p>}
        </div>
      )}

      {/* Customer History Modal */}
      {selectedCustomer && (
        <div className="modal-overlay" onClick={() => setSelectedCustomer(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
            <div className="modal-header">
              <h3>Lịch sử - {selectedCustomer.name}</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setSelectedCustomer(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              {/* Customer Info Card */}
              <div className="customer-info-card">
                <div className="customer-info-avatar">
                  {selectedCustomer.name?.charAt(0)?.toUpperCase()}
                </div>
                <div className="customer-info-details">
                  <h4>{selectedCustomer.name}</h4>
                  <p><Phone size={14} /> {selectedCustomer.phone}</p>
                </div>
                <div className="customer-info-stats">
                  <div>
                    <span className="stat-value">{selectedCustomer.visit_count || 0}</span>
                    <span className="stat-label">Lần ghé</span>
                  </div>
                  <div>
                    <span className="stat-value">{formatPrice(selectedCustomer.total_spent || 0)}</span>
                    <span className="stat-label">Tổng chi tiêu</span>
                  </div>
                </div>
              </div>

              {/* Order History */}
              <h4 className="mt-4 mb-3" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Receipt size={18} /> Lịch sử gọi món
              </h4>

              {loadingOrders ? (
                <div className="empty-state"><p>Đang tải...</p></div>
              ) : customerOrders.length > 0 ? (
                <div className="customer-orders-timeline">
                  {customerOrders.map((order) => (
                    <div key={order.id} className="timeline-item">
                      <div className="timeline-dot" />
                      <div className="timeline-content">
                        <div className="timeline-header">
                          <span className="timeline-date">{formatDateTime(order.created_at)}</span>
                          <span className="timeline-table">Bàn {order.table?.table_number || '?'}</span>
                          <span className={`badge badge-${order.status}`}>
                            {order.status === 'pending' ? 'Chờ' :
                              order.status === 'preparing' ? 'Đang làm' :
                                order.status === 'completed' ? 'Xong' : 'Đã thanh toán'}
                          </span>
                        </div>
                        <div className="timeline-items">
                          {order.order_items?.map((item) => (
                            <span key={item.id} className="timeline-menu-item">
                              {item.quantity}x {item.menu_item?.name || 'Đã xoá'}
                            </span>
                          ))}
                        </div>
                        <div className="timeline-total">
                          {formatPrice(order.total_amount)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ padding: 'var(--space-6)' }}>
                  <p>Chưa có lịch sử đặt món</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pageBtnStyle(active, disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    minWidth: 36, height: 36, padding: '0 10px',
    background: active ? '#3b82f6' : 'white',
    color: active ? 'white' : (disabled ? '#cbd5e1' : '#475569'),
    border: `1px solid ${active ? '#3b82f6' : '#e2e8f0'}`,
    borderRadius: 8,
    fontSize: '0.85rem',
    fontWeight: active ? 700 : 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s',
    justifyContent: 'center',
  };
}
