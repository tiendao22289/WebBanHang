'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import { QRCodeSVG } from 'qrcode.react';
import { useReactToPrint } from 'react-to-print';
import {
  Bell,
  ChevronRight,
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
  const [addedItemAlert, setAddedItemAlert] = useState(null);
  
  // States for Item Options
  const [optionModalItem, setOptionModalItem] = useState(null);
  const [selectedOptions, setSelectedOptions] = useState({});
  const [optionQuantity, setOptionQuantity] = useState(1);
  const [optionNote, setOptionNote] = useState('');

  const invoiceRef = useRef(null);
  const isFirstLoad = useRef(true);

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // Body scroll lock effect
  useEffect(() => {
    const isModalOpen = selectedTable || showQR || showAddModal || optionModalItem;
    if (isModalOpen) {
      // Calculate scrollbar width to prevent jumping
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => {
      document.body.classList.remove('modal-open');
    };
  }, [selectedTable, showQR, showAddModal, optionModalItem]);

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

  async function updateItemQuantity(orderId, itemId, currentQuantity, change) {
    const newQuantity = currentQuantity + change;
    if (newQuantity <= 0) {
      return removeItemFromOrder(orderId, itemId);
    }
    
    // Update quantity
    await supabase
      .from('order_items')
      .update({ quantity: newQuantity })
      .eq('id', itemId);
      
    // Recalculate order total
    const { data: allItems } = await supabase
      .from('order_items')
      .select('unit_price, quantity')
      .eq('order_id', orderId);
    const newTotal = (allItems || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);
    
    fetchTables();
  }

  async function addItemToOrder(orderId, menuItem, optionsData = [], qty = 1, note = '') {
    // If the item has options and we haven't selected them yet, show the modal
    if (menuItem.options && menuItem.options.length > 0 && optionsData.length === 0) {
      setOptionModalItem(menuItem);
      // Pre-select the first choice for each option
      const initialOptions = {};
      menuItem.options.forEach(opt => {
        if (opt.choices && opt.choices.length > 0) {
          initialOptions[opt.name] = opt.choices[0];
        }
      });
      setSelectedOptions(initialOptions);
      setOptionQuantity(1);
      setOptionNote('');
      return;
    }

    let targetOrderId = orderId;

    if (orderId === 'admin') {
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
        
        if (selectedTable.status === 'available') {
          await supabase
            .from('tables')
            .update({ status: 'occupied', occupied_at: new Date().toISOString() })
            .eq('id', selectedTable.id);
        }
      }
    }

    // Convert options data to JSONB array or keep it easy to query
    const optionsJsonb = optionsData.length > 0 ? optionsData : [];

    // Check if item already exists in the target order WITH THE SAME EXACT OPTIONS & NOTE
    const { data: existingItems } = await supabase
      .from('order_items')
      .select('*')
      .eq('order_id', targetOrderId)
      .eq('menu_item_id', menuItem.id);

    let existing = null;
    if (existingItems && existingItems.length > 0) {
      existing = existingItems.find(item => {
        const itemOpts = item.item_options || [];
        const sameOptions = JSON.stringify(itemOpts) === JSON.stringify(optionsJsonb);
        const sameNote = (item.note || '') === note;
        return sameOptions && sameNote;
      });
    }

    if (existing) {
      await supabase
        .from('order_items')
        .update({ quantity: existing.quantity + qty })
        .eq('id', existing.id);
    } else {
      await supabase.from('order_items').insert({
        order_id: targetOrderId,
        menu_item_id: menuItem.id,
        quantity: qty,
        unit_price: menuItem.price,
        item_options: optionsJsonb,
        note: note
      });
    }

    const { data: allItems } = await supabase
      .from('order_items')
      .select('unit_price, quantity')
      .eq('order_id', targetOrderId);
      
    const newTotal = (allItems || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', targetOrderId);
    
    // Reset option modal state if it was open
    setOptionModalItem(null);
    setSelectedOptions({});
    setOptionQuantity(1);
    setOptionNote('');
    
    setAddedItemAlert(menuItem.name);
    setTimeout(() => setAddedItemAlert(null), 2000);
    
    fetchTables();
  }

  function handleConfirmOptions() {
    if (!optionModalItem) return;
    
    // Format selected options into array
    const optionsData = Object.keys(selectedOptions).map(key => ({
      name: key,
      choice: selectedOptions[key]
    }));
    
    // The target order ID is always 'admin' for the POS modal
    addItemToOrder('admin', optionModalItem, optionsData, optionQuantity, optionNote);
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

      {/* Added item notification toast */}
      {addedItemAlert && (
        <div className="notification-toast animate-slide-up" style={{ bottom: '80px', background: 'var(--color-success)', color: 'white' }}>
          <Check size={20} />
          <span>Đã thêm <strong>{addedItemAlert}</strong> vào bill</span>
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

      {/* Action Notification Banners (KiotViet style) */}
      <div className="table-notifications" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#FEF0E5', color: '#D97706', padding: '12px 16px', borderRadius: '12px', cursor: 'pointer', border: '1px solid #FCD34D' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600' }}>
            <Bell size={18} />
            <span>0 lượt gọi món qua QR</span>
          </div>
          <ChevronRight size={18} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#EFF6FF', color: '#2563EB', padding: '12px 16px', borderRadius: '12px', cursor: 'pointer', border: '1px solid #BFDBFE' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600' }}>
            <Bell size={18} />
            <span>0 đơn tự đặt món tại bàn</span>
          </div>
          <ChevronRight size={18} />
        </div>
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
              onClick={() => {
                setSelectedTable(table);
                if (!isOccupied) {
                  setAddingToOrder('admin');
                }
              }}
            >
              {/* Table Name */}
              <div className="table-name" style={{ flex: 1 }}>
                B{table.table_number}
              </div>

              {/* Status Area */}
              <div className="table-status-area">
                <span className="table-status-text">
                  {isOccupied ? 'Có khách' : ''}
                </span>
                {isOccupied && tableBills.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                    <Receipt size={12} />
                    <span>{tableBills.length} đơn</span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="table-card-actions" onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 'var(--space-2)', right: 'var(--space-2)' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: '4px', height: 'auto' }}
                  onClick={() => setShowQR(table)}
                  title="Xem QR Code"
                >
                  <QrCode size={14} />
                </button>
                {!isOccupied && (
                  <button
                    className="btn btn-ghost btn-sm text-danger"
                    style={{ padding: '4px', height: 'auto' }}
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
      {selectedTable && !addingToOrder && (
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
                        <div key={item.id} className="order-item-row" style={{ display: 'flex', flexDirection: 'column' }}>
                          <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                            <div className="item-qty-controls">
                              <button
                                className="btn-qty-adj"
                                onClick={() => updateItemQuantity(order.id, item.id, item.quantity, -1)}
                              >
                                <Minus size={12} />
                              </button>
                              <span className="item-qty">{item.quantity}</span>
                              <button
                                className="btn-qty-adj"
                                onClick={() => updateItemQuantity(order.id, item.id, item.quantity, 1)}
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                            <span className="item-name">{item.menu_item?.name || 'Món đã xoá'}</span>
                            {item.note && <span className="item-note">({item.note})</span>}
                            <span className="item-price" style={{ marginLeft: 'auto', marginRight: '8px' }}>{formatPrice(item.unit_price * item.quantity)}</span>
                            <button
                              className="btn-item-remove"
                              title="Xóa món"
                              onClick={() => removeItemFromOrder(order.id, item.id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          
                          {/* Display selected options */}
                          {item.item_options && item.item_options.length > 0 && (
                            <div className="item-options-text" style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px', paddingLeft: '80px', width: '100%' }}>
                              {item.item_options.map((o, i) => (
                                <span key={i} style={{ display: 'inline-block', backgroundColor: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '4px', marginRight: '4px', border: '1px solid var(--border-color)' }}>
                                  {o.name}: {o.choice}
                                </span>
                              ))}
                            </div>
                          )}
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
                  <ChefHat size={48} className="text-muted" />
                  <p className="mt-4">Bàn này chưa có đơn hàng nào.</p>
                  <button className="btn btn-primary mt-4" onClick={() => setAddingToOrder('admin')}>
                    <Plus size={16} /> Bắt đầu gọi món
                  </button>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <div className="footer-actions-left">
                {orders[selectedTable.id]?.length > 0 && (
                  <button className="btn btn-primary btn-outline" onClick={() => setAddingToOrder('admin')}>
                    <Plus size={16} /> THÊM MÓN
                  </button>
                )}
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
                {orders[selectedTable.id]?.length > 0 && (
                  <button className="btn btn-success" onClick={() => completeTable(selectedTable.id)}>
                    <Check size={16} /> Hoàn thành
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Menu Modal (Full Menu View) */}
      {addingToOrder && (
        <div className="modal-overlay" onClick={() => { 
          setAddingToOrder(null); 
          setAddItemSearch('');
          if (selectedTable && (!orders[selectedTable.id] || orders[selectedTable.id].length === 0)) {
            setSelectedTable(null);
          }
        }}>
          <div className="modal-content menu-pos-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pos-sf-topbar">
              <div className="flex items-center gap-2">
                <ChefHat size={18} className="text-accent" />
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Thêm món (Bàn {selectedTable?.table_number})</h3>
              </div>
              <button className="btn btn-ghost btn-icon" onClick={() => { 
                setAddingToOrder(null); 
                setAddItemSearch('');
                if (selectedTable && (!orders[selectedTable.id] || orders[selectedTable.id].length === 0)) {
                  setSelectedTable(null);
                }
              }}>
                <X size={20} />
              </button>
            </div>
            
            <div className="pos-sf-search-wrap">
              <Search size={16} className="search-icon" />
              <input 
                placeholder="Tìm món ăn..." 
                value={addItemSearch}
                onChange={(e) => setAddItemSearch(e.target.value)}
                className="pos-sf-search-input"
              />
              {addItemSearch && (
                <button className="pos-sf-search-clear" onClick={() => setAddItemSearch('')}>
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="pos-sf-body">
              {/* Left sidebar: Categories */}
              <div className="pos-sf-sidebar">
                <button 
                  className={`pos-sf-cat ${activeMenuCategory === 'all' ? 'active' : ''}`}
                  onClick={() => setActiveMenuCategory('all')}
                >
                  <div className="cat-name">Tất cả</div>
                </button>
                {categories.map(cat => (
                  <button 
                    key={cat.id}
                    className={`pos-sf-cat ${activeMenuCategory === cat.id ? 'active' : ''}`}
                    onClick={() => setActiveMenuCategory(cat.id)}
                  >
                    <div className="cat-name">{cat.name}</div>
                  </button>
                ))}
              </div>

              {/* Right main: Item List */}
              <div className="pos-sf-main">
                <div className="pos-sf-list">
                  {menuItems
                    .filter(item => {
                      const matchesCat = activeMenuCategory === 'all' || item.category_id === activeMenuCategory;
                      const matchesSearch = item.name.toLowerCase().includes(addItemSearch.toLowerCase());
                      return matchesCat && matchesSearch;
                    })
                    .map(item => {
                      return (
                        <div key={item.id} className="pos-sf-item" onClick={() => addItemToOrder('admin', item)}>
                          <div className="pos-sf-item-img">
                            {item.image_url ? (
                              <Image src={item.image_url} alt={item.name} fill sizes="80px" style={{ objectFit: 'cover' }} />
                            ) : (
                              <div className="pos-item-placeholder" style={{ background: '#fdf2f2', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fca5a5' }}>
                                <ChefHat size={20} />
                              </div>
                            )}
                          </div>
                          
                          <div className="pos-sf-item-info">
                            <h4 className="pos-sf-item-name" title={item.name}>{item.name}</h4>
                            <span className="pos-sf-item-price">{formatPrice(item.price)}</span>
                          </div>

                          <button className="pos-sf-item-add" onClick={(e) => { e.stopPropagation(); addItemToOrder('admin', item); }}>
                            <Plus size={16} />
                          </button>
                        </div>
                      );
                    })}
                </div>
                
                {menuItems.filter(item => {
                  const matchesCat = activeMenuCategory === 'all' || item.category_id === activeMenuCategory;
                  const matchesSearch = item.name.toLowerCase().includes(addItemSearch.toLowerCase());
                  return matchesCat && matchesSearch;
                }).length === 0 && (
                  <div className="empty-state" style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                    <p>Không tìm thấy món ăn nào</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Item Options Modal */}
      {optionModalItem && (
        <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={() => setOptionModalItem(null)}>
          <div className="options-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="options-modal-header">
              <h3>Tuỳ chọn món</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setOptionModalItem(null)}>
                <X size={20} />
              </button>
            </div>
            
            <div className="options-modal-body">
              <div className="options-item-info">
                {optionModalItem.image_url ? (
                  <img src={optionModalItem.image_url} alt={optionModalItem.name} />
                ) : (
                  <div className="flex justify-center items-center rounded-xl bg-gray-100 text-gray-400" style={{ width: '80px', height: '80px' }}>
                    <ChefHat size={32} />
                  </div>
                )}
                <div className="options-item-info-text">
                  <div className="name">{optionModalItem.name}</div>
                  <div className="price">{formatPrice(optionModalItem.price)}</div>
                </div>
              </div>

              {optionModalItem.options && optionModalItem.options.map((opt, idx) => (
                <div key={idx}>
                  <div className="options-group-title">{opt.name}</div>
                  <div className="options-chip-container">
                    {opt.choices.map((choice, cIdx) => (
                      <button 
                        key={cIdx}
                        className={`options-chip ${selectedOptions[opt.name] === choice ? 'active' : ''}`}
                        onClick={() => setSelectedOptions({ ...selectedOptions, [opt.name]: choice })}
                      >
                        {choice}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <div>
                <div className="options-group-title">Ghi chú</div>
                <input 
                  type="text" 
                  className="options-note-input" 
                  placeholder="Thêm ghi chú cho nhà bếp..."
                  value={optionNote}
                  onChange={(e) => setOptionNote(e.target.value)}
                />
              </div>

              <div className="options-qty-control">
                <button className="options-qty-btn" onClick={() => setOptionQuantity(Math.max(1, optionQuantity - 1))}>
                  <Minus size={20} />
                </button>
                <div className="options-qty-value">{optionQuantity}</div>
                <button className="options-qty-btn" onClick={() => setOptionQuantity(optionQuantity + 1)}>
                  <Plus size={20} />
                </button>
              </div>
            </div>
            
            <div className="options-bottom-bar">
              <button className="btn-add-to-order" onClick={handleConfirmOptions}>
                Thêm vào đơn • {formatPrice(optionModalItem.price * optionQuantity)}
              </button>
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
