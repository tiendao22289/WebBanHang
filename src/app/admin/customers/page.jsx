'use client';

import { useState, useEffect } from 'react';
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
} from 'lucide-react';
import './customers.css';

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
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

  useEffect(() => {
    fetchCustomers();
  }, []);

  async function fetchCustomers() {
    setLoading(true);
    const { data } = await supabase
      .from('customers')
      .select('*')
      .order('last_visit_at', { ascending: false, nullsFirst: false });
    setCustomers(data || []);
    setLoading(false);
  }

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

  const filteredCustomers = customers.filter(c => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return c.name?.toLowerCase().includes(term) || c.phone?.includes(term);
  });

  const totalCustomers = customers.length;
  const totalRevenue = customers.reduce((sum, c) => sum + (c.total_spent || 0), 0);

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
            <div className="value">{totalCustomers}</div>
            <div className="label">Tổng khách hàng</div>
          </div>
        </div>
        <div className="summary-card">
          <div className="icon-wrapper" style={{ background: '#FEF3D9', color: '#F5A623' }}>
            <DollarSign size={22} />
          </div>
          <div>
            <div className="value">{formatPrice(totalRevenue)}</div>
            <div className="label">Tổng doanh thu từ khách</div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="customer-search">
        <Search size={16} />
        <input
          className="input"
          placeholder="Tìm theo tên hoặc số điện thoại..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Customer List */}
      {loading ? (
        <div className="empty-state"><p>Đang tải...</p></div>
      ) : filteredCustomers.length > 0 ? (
        <div className="card">
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Khách hàng</th>
                  <th>Số điện thoại</th>
                  <th>Số lần ghé</th>
                  <th>Tổng chi tiêu</th>
                  <th>Lần cuối</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((customer) => (
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
                      <strong className="text-accent">{formatPrice(customer.total_spent || 0)}</strong>
                    </td>
                    <td>
                      <span className="text-muted text-sm">{timeAgo(customer.last_visit_at)}</span>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => viewCustomerHistory(customer)}>
                        <Eye size={14} /> Lịch sử
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <User size={48} />
          <p>Chưa có khách hàng nào</p>
          <p className="text-sm text-muted">Khách hàng sẽ tự động được lưu khi đặt món</p>
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
