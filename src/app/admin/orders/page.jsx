'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import {
  Search, Calendar, Eye, X, Clock, Filter,
  Receipt, CheckCircle, AlertCircle, ChefHat, Ban,
  Banknote, Smartphone,
} from 'lucide-react';
import './orders.css';

const STATUS_META = {
  pending:   { label: 'Chờ xác nhận', color: '#f59e0b', bg: '#fef9c3', icon: <AlertCircle size={13}/> },
  preparing: { label: 'Đang làm',     color: '#3b82f6', bg: '#dbeafe', icon: <ChefHat size={13}/> },
  completed: { label: 'Hoàn thành',   color: '#10b981', bg: '#d1fae5', icon: <CheckCircle size={13}/> },
  paid:      { label: 'Đã thanh toán',color: '#6366f1', bg: '#ede9fe', icon: <Receipt size={13}/> },
  cancelled: { label: 'Đã huỷ',       color: '#ef4444', bg: '#fee2e2', icon: <Ban size={13}/> },
};

const PAYMENT_META = {
  cash:      { label: 'Tiền mặt',     icon: '💵', color: '#15803d' },
  transfer:  { label: 'Chuyển khoản', icon: '📲', color: '#1d4ed8' },
  cancelled: { label: 'Huỷ đơn',      icon: '🗑️', color: '#dc2626' },
};

export default function OrdersPage() {
  const [orders, setOrders]               = useState([]);
  const [loading, setLoading]             = useState(true); // only true on first load
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [dateFilter, setDateFilter]       = useState(() => new Date().toLocaleDateString('en-CA')); // YYYY-MM-DD in local timezone
  const [statusFilter, setStatusFilter]   = useState('all');
  const [searchTerm, setSearchTerm]       = useState('');

  // Lock body scroll when modal open
  useEffect(() => {
    if (selectedOrder) {
      const w = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${w}px`);
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [selectedOrder]);

  const firstFetchDone = useRef(false);

  const fetchOrders = useCallback(async () => {
    // Only show loading spinner on very first fetch
    const isFirst = !firstFetchDone.current;
    if (isFirst) setLoading(true);

    let query = supabase
      .from('orders')
      .select(`
        *,
        table:tables(table_number, table_type, table_name),
        order_items (*, menu_item:menu_items(name, price))
      `)
      .order('created_at', { ascending: false });

    if (dateFilter) {
      const start = new Date(dateFilter); start.setHours(0, 0, 0, 0);
      const end   = new Date(dateFilter); end.setHours(23, 59, 59, 999);
      query = query.gte('created_at', start.toISOString()).lte('created_at', end.toISOString());
    }

    if (statusFilter === 'active') {
      query = query.in('status', ['pending', 'preparing', 'completed']);
    } else if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    const { data } = await query;
    setOrders(data || []);

    // Keep selected order in sync (silent)
    if (selectedOrder) {
      const fresh = data?.find(o => o.id === selectedOrder.id);
      if (fresh) setSelectedOrder(fresh);
    }

    if (isFirst) {
      setLoading(false);
      firstFetchDone.current = true;
    }
  }, [dateFilter, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch (silent background) when filter changes — reset firstFetchDone so new filter shows loader briefly
  useEffect(() => {
    firstFetchDone.current = false;
    fetchOrders();
  }, [fetchOrders]);

  // ── Realtime subscription only — no polling ──
  useEffect(() => {
    const channel = supabase
      .channel('orders-realtime-' + Date.now())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        fetchOrders(); // silent update
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        fetchOrders();
      })
      .subscribe();

    const onVisible = () => { if (document.visibilityState === 'visible') fetchOrders(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchOrders]);

  async function updateStatus(orderId, newStatus) {
    await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
    fetchOrders();
  }

  const fmt = n => new Intl.NumberFormat('vi-VN').format(n) + 'đ';
  const fmtTime = d => new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const fmtDate = d => new Date(d).toLocaleDateString('vi-VN');

  const filteredOrders = orders.filter(o => {
    if (!searchTerm) return true;
    const t = searchTerm.toLowerCase();
    return (
      o.customer_name?.toLowerCase().includes(t) ||
      o.customer_phone?.includes(t) ||
      o.table?.table_number?.toString().includes(t)
    );
  });

  const totalRevenue = filteredOrders
    .filter(o => o.status === 'paid')
    .reduce((s, o) => s + (o.total_amount || 0), 0);

  const StatusBadge = ({ status }) => {
    const m = STATUS_META[status] || STATUS_META.pending;
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: m.bg, color: m.color,
        borderRadius: 20, padding: '3px 9px',
        fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap',
      }}>
        {m.icon} {m.label}
      </span>
    );
  };

  const PaymentBadge = ({ method }) => {
    if (!method) return null;
    const m = PAYMENT_META[method];
    if (!m) return null;
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: '0.72rem', fontWeight: 600, color: m.color,
        background: 'white', border: `1px solid ${m.color}30`,
        borderRadius: 12, padding: '2px 7px', whiteSpace: 'nowrap',
      }}>
        {m.icon} {m.label}
      </span>
    );
  };

  // ── Compact table styles ──
  const th = { padding: '7px 6px', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700, color: '#6b7280', whiteSpace: 'nowrap' };
  const td = { padding: '7px 6px', verticalAlign: 'middle' };
  const actionBtn = (color) => ({
    padding: '3px 8px', background: color, color: 'white', border: 'none',
    borderRadius: 6, cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap',
  });

  // Tiny status dot+label for table rows
  const MiniStatusBadge = ({ status }) => {
    const m = STATUS_META[status] || STATUS_META.pending;
    const SHORT = { pending: 'Chờ', preparing: 'Làm', completed: 'Xong', paid: 'TT', cancelled: 'Huỷ' };
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: m.bg, color: m.color, borderRadius: 10, padding: '2px 6px', fontSize: '0.68rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {m.icon} {SHORT[status] || status}
      </span>
    );
  };

  // Tiny payment method badge
  const MiniPayBadge = ({ method }) => {
    if (!method) return null;
    const MAP = { cash: { icon: '💵', label: 'TM' }, transfer: { icon: '📲', label: 'CK' }, cancelled: { icon: '🗑️', label: '' } };
    const m = MAP[method];
    if (!m) return null;
    return <span style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{m.icon} {m.label}</span>;
  };

  return (
    <div className="page-content">
      <div className="page-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Hoá đơn</h1>
          <p className="page-subtitle">Tự động cập nhật theo thời gian thực</p>
        </div>
        {/* Legend note */}
        <details style={{ marginLeft: 'auto', fontSize: '0.72rem', lineHeight: 1.7, color: '#374151', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '6px 10px', cursor: 'pointer', minWidth: 140, flexShrink: 0 }}>
          <summary style={{ fontWeight: 700, color: '#0f172a', listStyle: 'none', userSelect: 'none' }}>📖 Chú thích ▾</summary>
          <div style={{ marginTop: 6, borderTop: '1px solid #e2e8f0', paddingTop: 6 }}>
            <div style={{ fontWeight: 700, color: '#6b7280', marginBottom: 2 }}>Trạng thái</div>
            <div>🟡 <b>Chờ</b> — chờ xác nhận</div>
            <div>🔵 <b>Làm</b> — đang chế biến</div>
            <div>🟢 <b>Xong</b> — đã hoàn thành</div>
            <div>🟣 <b>TT</b> — đã thanh toán</div>
            <div>🔴 <b>Huỷ</b> — đơn bị huỷ</div>
            <div style={{ fontWeight: 700, color: '#6b7280', marginTop: 6, marginBottom: 2 }}>Thanh toán</div>
            <div>💵 <b>TM</b> — tiền mặt</div>
            <div>📲 <b>CK</b> — chuyển khoản</div>
            <div>🗑️ — đơn huỷ</div>
          </div>
        </details>
      </div>

      {/* Filters — single compact horizontal row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Date */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'white', border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '6px 10px', flex: '0 0 auto' }}>
          <Calendar size={14} style={{ color: '#9ca3af', flexShrink: 0 }} />
          <input type="date" value={dateFilter}
            onChange={e => setDateFilter(e.target.value)}
            style={{ border: 'none', outline: 'none', fontSize: '0.85rem', fontWeight: 600, color: '#374151', background: 'transparent', cursor: 'pointer', minWidth: 120 }} />
        </div>
        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'white', border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '6px 10px', flex: '0 0 auto' }}>
          <Filter size={14} style={{ color: '#9ca3af', flexShrink: 0 }} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ border: 'none', outline: 'none', fontSize: '0.85rem', fontWeight: 600, color: '#374151', background: 'transparent', cursor: 'pointer' }}>
            <option value="all">Tất cả</option>
            <option value="active">Đang xử lý</option>
            <option value="pending">Chờ xác nhận</option>
            <option value="preparing">Đang làm</option>
            <option value="completed">Hoàn thành</option>
            <option value="paid">Đã thanh toán</option>
            <option value="cancelled">Đã huỷ</option>
          </select>
        </div>
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'white', border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '6px 10px', flex: '1 1 140px', minWidth: 140 }}>
          <Search size={14} style={{ color: '#9ca3af', flexShrink: 0 }} />
          <input placeholder="Tìm tên, SĐT, bàn..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            style={{ border: 'none', outline: 'none', fontSize: '0.85rem', background: 'transparent', width: '100%', color: '#374151' }} />
        </div>
      </div>

      {/* Summary */}
      <div className="orders-summary">
        <span>{filteredOrders.length} đơn hàng</span>
        <span className="orders-summary-total">
          Doanh thu: <strong>{fmt(totalRevenue)}</strong>
        </span>
      </div>

      {/* Orders Table */}
      {loading ? (
        <div className="empty-state"><p>Đang tải...</p></div>
      ) : filteredOrders.length > 0 ? (
        <div className="card" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '1.5px solid #e2e8f0' }}>
                <th style={th}>Giờ</th>
                <th style={th}>Bàn</th>
                <th style={th}>Món</th>
                <th style={th}>Tiền</th>
                <th style={th}>Trạng thái</th>
                <th style={th}>TT</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map(order => (
                <tr key={order.id}
                  style={{ opacity: order.status === 'cancelled' ? 0.5 : 1, borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                  onClick={() => setSelectedOrder(order)}
                >
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#6b7280', whiteSpace: 'nowrap' }}>
                      <Clock size={11} />
                      {fmtTime(order.created_at)}
                    </div>
                  </td>
                  <td style={td}>
                    <strong style={{ fontSize: '0.8rem' }}>
                      {order.table?.table_number === 0 ? '🛵' : `B${order.table?.table_number ?? '?'}`}
                    </strong>
                  </td>
                  <td style={{ ...td, color: '#6b7280' }}>{order.order_items?.length || 0}</td>
                  <td style={td}>
                    <strong style={{ color: '#c53b3b', whiteSpace: 'nowrap' }}>{fmt(order.total_amount)}</strong>
                  </td>
                  <td style={td}><MiniStatusBadge status={order.status} /></td>
                  <td style={td}><MiniPayBadge method={order.payment_method} /></td>
                  <td style={{ ...td, padding: '6px 6px 6px 0' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {order.status === 'pending' && (
                        <button onClick={() => updateStatus(order.id, 'preparing')}
                          style={actionBtn('#2563eb')}>Nhận</button>
                      )}
                      {order.status === 'preparing' && (
                        <button onClick={() => updateStatus(order.id, 'completed')}
                          style={actionBtn('#16a34a')}>Xong</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
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
                  <span>{fmtDate(selectedOrder.created_at)} {fmtTime(selectedOrder.created_at)}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Trạng thái</span>
                  <StatusBadge status={selectedOrder.status} />
                </div>
                {selectedOrder.payment_method && (
                  <div className="detail-row">
                    <span className="detail-label">Thanh toán</span>
                    <PaymentBadge method={selectedOrder.payment_method} />
                  </div>
                )}
              </div>

              <h4 className="mt-4 mb-2">Danh sách món</h4>
              <div className="order-items-list">
                {selectedOrder.order_items?.map(item => (
                  <div key={item.id} className="order-item-row">
                    <span className="item-qty">{item.quantity}x</span>
                    <span className="item-name">{item.menu_item?.name || 'Món đã xoá'}</span>
                    {item.note && <span className="item-note">({item.note})</span>}
                    <span className="item-price">{fmt(item.unit_price * item.quantity)}</span>
                  </div>
                ))}
              </div>

              <div className="order-total mt-4">
                <span>Tổng cộng:</span>
                <strong>{fmt(selectedOrder.total_amount)}</strong>
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
