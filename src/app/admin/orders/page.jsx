'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import {
  Search,
  Calendar,
  Eye,
  X,
  Clock,
  Filter,
  Receipt,
  CheckCircle,
  AlertCircle,
  ChefHat,
} from 'lucide-react';
import './orders.css';

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [dateFilter, setDateFilter] = useState(new Date().toISOString().split('T')[0]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (selectedOrder) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [selectedOrder]);

  useEffect(() => {
    fetchOrders();
  }, [dateFilter, statusFilter]);

  async function fetchOrders() {
    setLoading(true);
    let query = supabase
      .from('orders')
      .select(`
        *,
        table:tables(table_number),
        order_items (
          *,
          menu_item:menu_items(name, price)
        )
      `)
      .order('created_at', { ascending: false });

    // Date filter
    if (dateFilter) {
      const start = new Date(dateFilter);
      start.setHours(0, 0, 0, 0);
      const end = new Date(dateFilter);
      end.setHours(23, 59, 59, 999);
      query = query.gte('created_at', start.toISOString()).lte('created_at', end.toISOString());
    }

    // Status filter
    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    const { data } = await query;
    setOrders(data || []);
    setLoading(false);
  }

  async function updateStatus(orderId, newStatus) {
    await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
    fetchOrders();
    if (selectedOrder?.id === orderId) {
      setSelectedOrder(prev => ({ ...prev, status: newStatus }));
    }
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  function formatTime(dateStr) {
    return new Date(dateStr).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('vi-VN');
  }

  const statusLabels = {
    pending: 'Chờ xác nhận',
    preparing: 'Đang làm',
    completed: 'Hoàn thành',
    paid: 'Đã thanh toán',
  };

  const statusIcons = {
    pending: <AlertCircle size={14} />,
    preparing: <ChefHat size={14} />,
    completed: <CheckCircle size={14} />,
    paid: <Receipt size={14} />,
  };

  const filteredOrders = orders.filter(o => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      o.customer_name?.toLowerCase().includes(term) ||
      o.customer_phone?.includes(term) ||
      o.table?.table_number?.toString().includes(term)
    );
  });

  const totalRevenue = filteredOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Hoá đơn</h1>
          <p className="page-subtitle">Quản lý đơn hàng và lịch sử</p>
        </div>
      </div>

      {/* Filters */}
      <div className="orders-filters">
        <div className="filter-group">
          <Calendar size={16} />
          <input
            type="date"
            className="input"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <Filter size={16} />
          <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">Tất cả</option>
            <option value="pending">Chờ xác nhận</option>
            <option value="preparing">Đang làm</option>
            <option value="completed">Hoàn thành</option>
            <option value="paid">Đã thanh toán</option>
          </select>
        </div>
        <div className="filter-group">
          <Search size={16} />
          <input
            className="input"
            placeholder="Tìm theo tên, SĐT, bàn..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* Summary */}
      <div className="orders-summary">
        <span>{filteredOrders.length} đơn hàng</span>
        <span className="orders-summary-total">Tổng: <strong>{formatPrice(totalRevenue)}</strong></span>
      </div>

      {/* Orders Table */}
      {loading ? (
        <div className="empty-state"><p>Đang tải...</p></div>
      ) : filteredOrders.length > 0 ? (
        <div className="card">
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Bàn</th>
                  <th>Khách hàng</th>
                  <th>Số món</th>
                  <th>Tổng tiền</th>
                  <th>Trạng thái</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-muted" />
                        {formatTime(order.created_at)}
                      </div>
                    </td>
                    <td><strong>Bàn {order.table?.table_number || '?'}</strong></td>
                    <td>
                      <div>{order.customer_name}</div>
                      <div className="text-xs text-muted">{order.customer_phone}</div>
                    </td>
                    <td>{order.order_items?.length || 0} món</td>
                    <td><strong className="text-accent">{formatPrice(order.total_amount)}</strong></td>
                    <td>
                      <span className={`badge badge-${order.status}`}>
                        {statusIcons[order.status]} {statusLabels[order.status]}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <button className="btn btn-ghost btn-sm" onClick={() => setSelectedOrder(order)}>
                          <Eye size={14} />
                        </button>
                        {order.status === 'pending' && (
                          <button className="btn btn-sm btn-primary" onClick={() => updateStatus(order.id, 'preparing')}>
                            Nhận đơn
                          </button>
                        )}
                        {order.status === 'preparing' && (
                          <button className="btn btn-sm btn-success" onClick={() => updateStatus(order.id, 'completed')}>
                            Xong
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <Receipt size={48} />
          <p>Không có đơn hàng nào</p>
        </div>
      )}

      {/* Order Detail Modal */}
      {selectedOrder && (
        <div className="modal-overlay" onClick={() => setSelectedOrder(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3>Chi tiết đơn hàng</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setSelectedOrder(null)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <div className="order-detail-info">
                <div className="detail-row">
                  <span className="detail-label">Bàn</span>
                  <strong>Bàn {selectedOrder.table?.table_number || '?'}</strong>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Khách hàng</span>
                  <span>{selectedOrder.customer_name}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">SĐT</span>
                  <span>{selectedOrder.customer_phone}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Thời gian</span>
                  <span>{formatDate(selectedOrder.created_at)} {formatTime(selectedOrder.created_at)}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Trạng thái</span>
                  <span className={`badge badge-${selectedOrder.status}`}>
                    {statusLabels[selectedOrder.status]}
                  </span>
                </div>
              </div>

              <h4 className="mt-4 mb-2">Danh sách món</h4>
              <div className="order-items-list">
                {selectedOrder.order_items?.map((item) => (
                  <div key={item.id} className="order-item-row">
                    <span className="item-qty">{item.quantity}x</span>
                    <span className="item-name">{item.menu_item?.name || 'Món đã xoá'}</span>
                    {item.note && <span className="item-note">({item.note})</span>}
                    <span className="item-price">{formatPrice(item.unit_price * item.quantity)}</span>
                  </div>
                ))}
              </div>

              <div className="order-total mt-4">
                <span>Tổng cộng:</span>
                <strong>{formatPrice(selectedOrder.total_amount)}</strong>
              </div>
            </div>
            <div className="modal-footer">
              {selectedOrder.status === 'pending' && (
                <button className="btn btn-primary" onClick={() => updateStatus(selectedOrder.id, 'preparing')}>
                  <ChefHat size={16} /> Bắt đầu làm
                </button>
              )}
              {selectedOrder.status === 'preparing' && (
                <button className="btn btn-success" onClick={() => updateStatus(selectedOrder.id, 'completed')}>
                  <CheckCircle size={16} /> Hoàn thành
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
