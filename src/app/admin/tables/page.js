'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { QRCodeSVG } from 'qrcode.react';
import { useReactToPrint } from 'react-to-print';
import {
  Plus,
  Minus,
  QrCode,
  X,
  Check,
  Users,
  Hash,
  Download,
  Trash2,
  ShoppingBag,
  Clock,
  Printer,
  BellRing,
  Receipt,
  Search,
  ChefHat,
} from 'lucide-react';
import './tables.css';

// Notification sound using Web Audio API
function playNotificationSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // Play two tones (ding-dong)
    [0, 0.2].forEach((delay, i) => {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.frequency.value = i === 0 ? 880 : 660;
      oscillator.type = 'sine';
      gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime + delay);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.5);
      oscillator.start(audioCtx.currentTime + delay);
      oscillator.stop(audioCtx.currentTime + delay + 0.5);
    });
  } catch (e) {
    console.log('Audio not supported');
  }
}

export default function TablesPage() {
  const [tables, setTables] = useState([]);
  const [orders, setOrders] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedTable, setSelectedTable] = useState(null);
  const [showQR, setShowQR] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTableNumber, setNewTableNumber] = useState('');
  const [newOrderAlert, setNewOrderAlert] = useState(null);
  const [columnsPerRow, setColumnsPerRow] = useState(5);
  const [menuItems, setMenuItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [addingToOrder, setAddingToOrder] = useState(null); // order id being added to
  const [activeMenuCategory, setActiveMenuCategory] = useState('all');
  const [addItemSearch, setAddItemSearch] = useState('');

  const invoiceRef = useRef(null);
  const isFirstLoad = useRef(true);

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // Body scroll lock effect
  useEffect(() => {
    const isModalOpen = selectedTable || showQR || showAddModal;
    if (isModalOpen) {
      // Calculate scrollbar width to prevent jumping
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [selectedTable, showQR, showAddModal]);

  const handlePrintInvoice = useReactToPrint({ contentRef: invoiceRef });

  const fetchTables = useCallback(async () => {
    const [{ data: tablesData }, { data: menuData }, { data: catsData }] = await Promise.all([
      supabase.from('tables').select('*').order('table_number'),
      supabase.from('menu_items').select('*, category:categories(name)').eq('is_available', true).order('name'),
      supabase.from('categories').select('*').order('sort_order'),
    ]);

    if (tablesData) {
      setTables(tablesData);
      const occupiedIds = tablesData.filter(t => t.status === 'occupied').map(t => t.id);
      if (occupiedIds.length > 0) {
        const { data: ordersData } = await supabase
          .from('orders')
          .select(`
            *,
            order_items (
              *,
              menu_item:menu_items (name, price)
            )
          `)
          .in('table_id', occupiedIds)
          .in('status', ['pending', 'preparing'])
          .order('created_at', { ascending: false });

        const ordersByTable = {};
        ordersData?.forEach(order => {
          if (!ordersByTable[order.table_id]) {
            ordersByTable[order.table_id] = [];
          }
          ordersByTable[order.table_id].push(order);
        });
        setOrders(ordersByTable);
      } else {
        setOrders({});
      }
    }
    setMenuItems(menuData || []);
    setCategories(catsData || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchTables();
    const channel = supabase
      .channel('tables-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, () => {
        fetchTables();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (payload) => {
        // Play sound for new orders (skip on first load)
        if (!isFirstLoad.current) {
          playNotificationSound();
          setNewOrderAlert(payload.new);
          setTimeout(() => setNewOrderAlert(null), 5000);
        }
        fetchTables();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, () => {
        fetchTables();
      })
      .subscribe();

    // Mark first load complete after a short delay
    setTimeout(() => { isFirstLoad.current = false; }, 2000);

    // Auto-expire tables after 5 hours
    const autoExpireInterval = setInterval(async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const { data: expiredTables } = await supabase
        .from('tables')
        .select('id')
        .eq('status', 'occupied')
        .not('occupied_at', 'is', null)
        .lt('occupied_at', fiveHoursAgo);

      if (expiredTables && expiredTables.length > 0) {
        const expiredIds = expiredTables.map(t => t.id);
        // Mark all active orders as paid (history preserved)
        await supabase
          .from('orders')
          .update({ status: 'paid' })
          .in('table_id', expiredIds)
          .in('status', ['pending', 'preparing', 'completed']);
        // Reset tables
        await supabase
          .from('tables')
          .update({ status: 'available', occupied_at: null })
          .in('id', expiredIds);
        fetchTables();
      }
    }, 60000); // Check every 60 seconds

    return () => {
      supabase.removeChannel(channel);
      clearInterval(autoExpireInterval);
    };
  }, [fetchTables]);

  async function addTable() {
    const num = parseInt(newTableNumber);
    if (!num || num <= 0) return;

    await supabase.from('tables').insert({ table_number: num });
    setNewTableNumber('');
    setShowAddModal(false);
    fetchTables();
  }

  async function deleteTable(id) {
    if (!confirm('Bạn có chắc muốn xoá bàn này?')) return;
    await supabase.from('tables').delete().eq('id', id);
    fetchTables();
  }

  async function completeTable(tableId) {
    await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('table_id', tableId)
      .in('status', ['pending', 'preparing', 'completed']);

    await supabase
      .from('tables')
      .update({ status: 'available', occupied_at: null })
      .eq('id', tableId);

    setSelectedTable(null);
    fetchTables();
  }

  function downloadQR(table) {
    const svg = document.getElementById(`qr-${table.id}`);
    if (!svg) return;

    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const link = document.createElement('a');
      link.download = `QR-Ban-${table.table_number}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    };

    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  }

  async function removeItemFromOrder(orderId, itemId) {
    if (!confirm('Xóa món này khỏi bill?')) return;
    // Delete the order item
    const { data: deletedItem } = await supabase
      .from('order_items')
      .delete()
      .eq('id', itemId)
      .select()
      .single();
    if (!deletedItem) return;
    // Recalculate order total
    const { data: remaining } = await supabase
      .from('order_items')
      .select('unit_price, quantity')
      .eq('order_id', orderId);
    const newTotal = (remaining || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);
    fetchTables();
  }

  async function addItemToOrder(orderId, menuItem) {
    let targetOrderId = orderId;

    // Special case: Admin adding a new item via the footer "+ THÊM MÓN" button
    if (orderId === 'admin') {
      // Find or create an 'Admin' bill for this table
      const { data: adminOrder } = await supabase
        .from('orders')
        .select('id')
        .eq('table_id', selectedTable.id)
        .eq('customer_name', 'Admin')
        .in('status', ['pending', 'preparing', 'completed'])
        .maybeSingle();

      if (adminOrder) {
        targetOrderId = adminOrder.id;
      } else {
        // Create new Admin bill
        const { data: newOrder, error } = await supabase
          .from('orders')
          .insert({
            table_id: selectedTable.id,
            customer_name: 'Admin',
            customer_phone: 'Quản lý',
            status: 'pending',
            total_amount: 0
          })
          .select()
          .single();
        
        if (error || !newOrder) return;
        targetOrderId = newOrder.id;
        
        // Mark table as occupied if it was available
        if (selectedTable.status === 'available') {
          await supabase
            .from('tables')
            .update({ status: 'occupied', occupied_at: new Date().toISOString() })
            .eq('id', selectedTable.id);
        }
      }
    }

    // Check if item already exists in the target order
    const { data: existing } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', targetOrderId)
      .eq('menu_item_id', menuItem.id)
      .maybeSingle();

    if (existing) {
      // Increase quantity
      await supabase
        .from('order_items')
        .update({ quantity: existing.quantity + 1 })
        .eq('id', existing.id);
    } else {
      // Add new item
      await supabase.from('order_items').insert({
        order_id: targetOrderId,
        menu_item_id: menuItem.id,
        quantity: 1,
        unit_price: menuItem.price,
      });
    }

    // Recalculate order total
    const { data: allItems } = await supabase
      .from('order_items')
      .select('unit_price, quantity')
      .eq('order_id', targetOrderId);
    const newTotal = (allItems || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', targetOrderId);
    
    setAddingToOrder(null);
    setAddItemSearch('');
    fetchTables();
  }

  async function mergeBills() {
    if (!selectedTable) return;
    const tableBills = orders[selectedTable.id] || [];
    if (tableBills.length <= 1) {
      alert('Không có đủ bill để gộp!');
      return;
    }

    if (!confirm(`Bạn có chắc muốn gộp ${tableBills.length} bill của bàn ${selectedTable.table_number} thành 1 bill duy nhất?`)) return;

    // Use the oldest bill as the main one
    const sortedBills = [...tableBills].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const mainBill = sortedBills[0];
    const otherBills = sortedBills.slice(1);
    const otherIds = otherBills.map(b => b.id);

    // 1. Move all items to the main bill
    // We update order_id for all items in the other bills
    const { error: moveError } = await supabase
      .from('order_items')
      .update({ order_id: mainBill.id })
      .in('order_id', otherIds);

    if (moveError) {
      alert('Lỗi khi chuyển món ăn: ' + moveError.message);
      return;
    }

    // 2. Delete the empty orders
    await supabase.from('orders').delete().in('id', otherIds);

    // 3. Recalculate main bill total
    const { data: allItems } = await supabase
      .from('order_items')
      .select('unit_price, quantity')
      .eq('order_id', mainBill.id);
    
    // Group items of same ID if needed? 
    // Actually, SQL allows multiple rows of same menu_item_id. 
    // For simplicity, we just recalculate total. 
    // Optional: Merge duplicate item rows? -> For now just update total.
    
    const newTotal = (allItems || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', mainBill.id);

    fetchTables();
    alert('Đã gộp đơn thành công!');
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  function formatTime(dateStr) {
    return new Date(dateStr).toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // Get the table object for printing invoice
  function getSelectedTableOrders() {
    if (!selectedTable) return [];
    return orders[selectedTable.id] || [];
  }

  const availableCount = tables.filter(t => t.status === 'available').length;
  const occupiedCount = tables.filter(t => t.status === 'occupied').length;

  if (loading) {
    return (
      <div className="page-content">
        <div className="empty-state">
          <p>Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content">
      {/* New order notification toast */}
      {newOrderAlert && (
        <div className="notification-toast animate-slide-up">
          <BellRing size={20} />
          <span>🔔 Đơn hàng mới từ khách <strong>{newOrderAlert.customer_name}</strong>!</span>
        </div>
      )}

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Quản lý bàn</h1>
          <p className="page-subtitle">Theo dõi trạng thái và quản lý bàn ăn</p>
        </div>
        <div className="header-actions">
          <select
            className="columns-select"
            value={columnsPerRow}
            onChange={(e) => setColumnsPerRow(Number(e.target.value))}
            title="Số bàn / hàng"
          >
            <option value={3}>3 / hàng</option>
            <option value={4}>4 / hàng</option>
            <option value={5}>5 / hàng</option>
            <option value={6}>6 / hàng</option>
          </select>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            <Plus size={18} /> Thêm bàn
          </button>
        </div>
      </div>

      {/* Summary - Desktop */}
      <div className="summary-cards desktop-only">
        <div className="summary-card">
          <div className="icon-wrapper" style={{ background: 'var(--color-primary-bg)', color: 'var(--color-primary)' }}>
            <Hash size={22} />
          </div>
          <div>
            <div className="value">{tables.length}</div>
            <div className="label">Tổng số bàn</div>
          </div>
        </div>
        <div className="summary-card">
          <div className="icon-wrapper" style={{ background: 'var(--color-success-light)', color: 'var(--color-success)' }}>
            <Users size={22} />
          </div>
          <div>
            <div className="value">{occupiedCount}</div>
            <div className="label">Đang có khách</div>
          </div>
        </div>
        <div className="summary-card">
          <div className="icon-wrapper" style={{ background: '#E8EDE7', color: 'var(--color-table-available)' }}>
            <Check size={22} />
          </div>
          <div>
            <div className="value">{availableCount}</div>
            <div className="label">Bàn trống</div>
          </div>
        </div>
      </div>

      {/* Summary - Mobile compact */}
      <div className="mobile-summary-bar mobile-only">
        <div className="mobile-stat"><Hash size={14} /> <span>{tables.length} bàn</span></div>
        <div className="mobile-stat text-success"><Users size={14} /> <span>{occupiedCount} có khách</span></div>
        <div className="mobile-stat"><Check size={14} /> <span>{availableCount} trống</span></div>
      </div>

      {/* Tables Grid */}
      <div className="tables-grid" style={{ '--cols': columnsPerRow }}>
        {tables.map((table) => {
          const tableBills = orders[table.id] || [];
          const totalItems = tableBills.reduce((acc, o) => acc + (o.order_items?.length || 0), 0);
          const isOccupied = table.status === 'occupied';

          return (
            <div
              key={table.id}
              className={`table-card ${table.status}`}
              onClick={() => isOccupied && setSelectedTable(table)}
            >
              {/* Dining table visual */}
              <div className="table-visual">
                {/* Chair dots */}
                <div className="chair chair-top" />
                <div className="chair chair-right" />
                <div className="chair chair-bottom" />
                <div className="chair chair-left" />

                {/* Table surface */}
                <div className="table-surface">
                  <span className="table-num">{table.table_number}</span>
                  {isOccupied && <div className="table-pulse" />}
                </div>
              </div>

              {/* Status & Info */}
              <div className="table-info">
                <span className="table-label">Bàn {table.table_number}</span>
                <span className={`table-status-dot ${table.status}`}>
                  {isOccupied ? 'Có khách' : 'Trống'}
                </span>
              </div>

              {/* Bill preview */}
              {isOccupied && tableBills.length > 0 && (
                <div className="table-bills-preview">
                  <div className="table-bill-count">
                    <Receipt size={12} />
                    <span>{tableBills.length} bill</span>
                  </div>
                  <div className="table-items-count">
                    {totalItems} món
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="table-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowQR(table)}
                  title="Xem QR Code"
                >
                  <QrCode size={14} />
                </button>
                {!isOccupied && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => deleteTable(table.id)}
                    title="Xoá bàn"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* QR Code Modal - uses table UUID in URL */}
      {showQR && (
        <div className="modal-overlay" onClick={() => setShowQR(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>QR Code - Bàn {showQR.table_number}</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowQR(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center' }}>
              <div className="qr-container">
                <QRCodeSVG
                  id={`qr-${showQR.id}`}
                  value={`${baseUrl}/order?table=${showQR.id}`}
                  size={250}
                  level="H"
                  includeMargin
                  style={{ borderRadius: '12px' }}
                />
              </div>
              <p className="text-muted text-sm mt-4">
                Quét mã QR này để đặt món tại Bàn {showQR.table_number}
              </p>
              <button
                className="btn btn-primary mt-4"
                onClick={() => downloadQR(showQR)}
              >
                <Download size={16} /> Tải QR Code
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table Detail Modal with Print Invoice */}
      {selectedTable && (
        <div className="modal-overlay" onClick={() => setSelectedTable(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
            <div className="modal-header">
              <h3>Bàn {selectedTable.table_number}</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setSelectedTable(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              {/* Bill count summary */}
              {orders[selectedTable.id]?.length > 0 && (
                <div className="bill-summary-bar">
                  <div className="bill-summary-left">
                    <Receipt size={16} />
                    <strong>{orders[selectedTable.id].length} bill</strong>
                  </div>
                  <div className="bill-summary-right">
                    Tổng cộng: <strong>{formatPrice(orders[selectedTable.id].reduce((sum, o) => sum + (o.total_amount || 0), 0))}</strong>
                  </div>
                </div>
              )}

              {/* Printable Invoice (hidden on screen, shown on print) */}
              <div style={{ display: 'none' }}>
                <div ref={invoiceRef}>
                  <div className="invoice">
                    <div className="invoice-header">
                      <h3>🍽️ NHÀ HÀNG</h3>
                      <p>HOÁ ĐƠN - BÀN {selectedTable.table_number}</p>
                    </div>
                    <div className="invoice-info">
                      <div><strong>Thời gian:</strong> {new Date().toLocaleString('vi-VN')}</div>
                      <div><strong>Số bill:</strong> {getSelectedTableOrders().length}</div>
                    </div>
                    {getSelectedTableOrders().map((order, idx) => (
                      <div key={order.id} style={{ marginBottom: '16px' }}>
                        <p style={{ fontWeight: 'bold', borderBottom: '1px solid #ccc', paddingBottom: '4px' }}>
                          Bill #{idx + 1} — {order.customer_name} ({order.customer_phone})
                        </p>
                        <table className="invoice-table">
                          <thead>
                            <tr><th>Món</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr>
                          </thead>
                          <tbody>
                            {order.order_items?.map((item) => (
                              <tr key={item.id}>
                                <td>
                                  {item.menu_item?.name || 'Món đã xoá'}
                                  {item.note && <div style={{ fontSize: '0.75rem', fontStyle: 'italic' }}>* {item.note}</div>}
                                </td>
                                <td>{item.quantity}</td>
                                <td>{formatPrice(item.unit_price)}</td>
                                <td>{formatPrice(item.unit_price * item.quantity)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div style={{ textAlign: 'right', fontWeight: 'bold', marginTop: '8px' }}>
                          Tổng bill #{idx + 1}: {formatPrice(order.total_amount)}
                        </div>
                      </div>
                    ))}
                    <div style={{ textAlign: 'right', fontSize: '1.1rem', fontWeight: 'bold', borderTop: '2px solid #333', paddingTop: '8px' }}>
                      TỔNG CỘNG: {formatPrice(getSelectedTableOrders().reduce((s, o) => s + (o.total_amount || 0), 0))}
                    </div>
                    <div className="invoice-footer">
                      <p>Cảm ơn quý khách! 🙏</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* On-screen bills display */}
              {orders[selectedTable.id]?.length > 0 ? (
                orders[selectedTable.id].map((order, idx) => (
                  <div key={order.id} className="order-detail-card">
                    <div className="bill-number-badge">Bill #{idx + 1}</div>
                    <div className="order-detail-header">
                      <div>
                        <strong>{order.customer_name}</strong>
                        <span className="text-muted text-sm"> • {order.customer_phone}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock size={14} className="text-muted" />
                        <span className="text-sm text-muted">{formatTime(order.created_at)}</span>
                        <span className={`badge badge-${order.status}`}>
                          {order.status === 'pending' ? 'Chờ' :
                           order.status === 'preparing' ? 'Đang làm' :
                           order.status === 'completed' ? 'Xong' : 'Đã thanh toán'}
                        </span>
                      </div>
                    </div>
                    <div className="order-items-list">
                      {order.order_items?.map((item) => (
                        <div key={item.id} className="order-item-row">
                          <span className="item-qty">{item.quantity}x</span>
                          <span className="item-name">{item.menu_item?.name || 'Món đã xoá'}</span>
                          {item.note && <span className="item-note">({item.note})</span>}
                          <span className="item-price">{formatPrice(item.unit_price * item.quantity)}</span>
                          <button
                            className="btn-item-remove"
                            title="Xóa món"
                            onClick={() => removeItemFromOrder(order.id, item.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="order-total">
                      <span>Tổng bill:</span>
                      <strong>{formatPrice(order.total_amount)}</strong>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state" style={{ padding: 'var(--space-8)' }}>
                  <p>Chưa có đơn hàng nào</p>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <div className="footer-actions-left">
                <button className="btn btn-primary btn-outline" onClick={() => setAddingToOrder('admin')}>
                  <Plus size={16} /> THÊM MÓN
                </button>
                {orders[selectedTable.id]?.length > 1 && (
                  <button className="btn btn-accent btn-outline" onClick={mergeBills}>
                    <ShoppingBag size={16} /> GỘP ĐƠN
                  </button>
                )}
              </div>
              <div className="footer-actions-right">
                <button className="btn btn-outline" onClick={() => setSelectedTable(null)}>
                  Đóng
                </button>
                {orders[selectedTable.id]?.length > 0 && (
                  <button className="btn btn-primary" onClick={handlePrintInvoice}>
                    <Printer size={16} /> In hoá đơn
                  </button>
                )}
                <button className="btn btn-success" onClick={() => completeTable(selectedTable.id)}>
                  <Check size={16} /> Hoàn thành
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Menu Modal (Full Menu View) */}
      {addingToOrder && (
        <div className="modal-overlay" onClick={() => { setAddingToOrder(null); setAddItemSearch(''); }}>
          <div className="modal-content menu-pos-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="flex items-center gap-3">
                <ChefHat size={20} className="text-accent" />
                <h3>Thêm món vào Bill</h3>
              </div>
              <button className="btn btn-ghost btn-icon" onClick={() => { setAddingToOrder(null); setAddItemSearch(''); }}>
                <X size={20} />
              </button>
            </div>
            
            <div className="menu-pos-container">
              {/* Search & Categories */}
              <div className="menu-pos-sidebar">
                <div className="menu-pos-search">
                  <Search size={18} />
                  <input 
                    placeholder="Tìm tên món ăn..." 
                    value={addItemSearch}
                    onChange={(e) => setAddItemSearch(e.target.value)}
                  />
                  {addItemSearch && (
                    <button className="clear-search" onClick={() => setAddItemSearch('')}>
                      <X size={14} />
                    </button>
                  )}
                </div>
                
                <div className="menu-pos-categories">
                  <button 
                    className={`pos-cat-item ${activeMenuCategory === 'all' ? 'active' : ''}`}
                    onClick={() => setActiveMenuCategory('all')}
                  >
                    Tất cả ({menuItems.length})
                  </button>
                  {categories.map(cat => (
                    <button 
                      key={cat.id}
                      className={`pos-cat-item ${activeMenuCategory === cat.id ? 'active' : ''}`}
                      onClick={() => setActiveMenuCategory(cat.id)}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Items Grid */}
              <div className="menu-pos-main">
                <div className="menu-pos-grid">
                  {menuItems
                    .filter(item => {
                      const matchesCat = activeMenuCategory === 'all' || item.category_id === activeMenuCategory;
                      const matchesSearch = item.name.toLowerCase().includes(addItemSearch.toLowerCase());
                      return matchesCat && matchesSearch;
                    })
                    .map(item => (
                      <div key={item.id} className="pos-item-card" onClick={() => addItemToOrder(addingToOrder, item)}>
                        <div className="pos-item-img">
                          {item.image_url ? (
                            <img src={item.image_url} alt={item.name} />
                          ) : (
                            <div className="pos-item-placeholder">
                              <ChefHat size={32} />
                            </div>
                          )}
                        </div>
                        <div className="pos-item-details">
                          <span className="pos-item-category">{item.category?.name}</span>
                          <h4 className="pos-item-name">{item.name}</h4>
                          <span className="pos-item-price">{formatPrice(item.price)}</span>
                        </div>
                        <div className="pos-item-add">
                          <Plus size={18} />
                        </div>
                      </div>
                    ))}
                </div>
                
                {menuItems.filter(item => {
                  const matchesCat = activeMenuCategory === 'all' || item.category_id === activeMenuCategory;
                  const matchesSearch = item.name.toLowerCase().includes(addItemSearch.toLowerCase());
                  return matchesCat && matchesSearch;
                }).length === 0 && (
                  <div className="empty-state">
                    <p>Không tìm thấy món ăn nào</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Table Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h3>Thêm bàn mới</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowAddModal(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Số bàn</label>
                <input
                  type="number"
                  className="input"
                  value={newTableNumber}
                  onChange={(e) => setNewTableNumber(e.target.value)}
                  placeholder="Nhập số bàn..."
                  min="1"
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowAddModal(false)}>Huỷ</button>
              <button className="btn btn-primary" onClick={addTable}>
                <Plus size={16} /> Thêm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
