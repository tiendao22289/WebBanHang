'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import { QRCodeSVG } from 'qrcode.react';
import { useReactToPrint } from 'react-to-print';
import Swal from 'sweetalert2';
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
  const [filterTab, setFilterTab] = useState('ALL');
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
  const [editingPrice, setEditingPrice] = useState(false);
  const [customPrice, setCustomPrice] = useState(null);
  const [showBillPreview, setShowBillPreview] = useState(false);
  const [tableNote, setTableNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null); // { orderId, itemId, itemName }
  const [editItemPrice, setEditItemPrice] = useState(null); // { orderId, itemId, value } — LEGACY, replaced by showPriceModal
  const [editingOrderItem, setEditingOrderItem] = useState(null); // { orderId, itemId } for editing options
  const [showPriceModal, setShowPriceModal] = useState(null); // { orderId, itemId, originalPrice }
  // Takeaway
  const [showTakeawayOrders, setShowTakeawayOrders] = useState(false);
  const [takeawayOrders, setTakeawayOrders] = useState([]);
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [discountMode, setDiscountMode] = useState('VND'); // 'VND' | 'PCT'
  const [discountValue, setDiscountValue] = useState(0);
  const [customNewPrice, setCustomNewPrice] = useState(null); // null = use calculated
  const [desktopSearch, setDesktopSearch] = useState('');
  const [desktopView, setDesktopView] = useState('tables'); // 'tables' | 'menu'
  const [desktopMenuCat, setDesktopMenuCat] = useState('all');
  const [desktopInlinePriceItem, setDesktopInlinePriceItem] = useState(null); // item.id being edited
  const [desktopInlinePriceVal, setDesktopInlinePriceVal] = useState(''); // temp price string
  const [confirmPayment, setConfirmPayment] = useState(null); // { table, totalAmount }
  const [paymentModal, setPaymentModal]     = useState(null); // { table, total }
  const [bankAccounts, setBankAccounts]     = useState([]);
  const [qrAccount, setQrAccount]           = useState(null); // selected account for QR
  const [showTransfer, setShowTransfer]     = useState(false); // QR sub-screen in payment modal

  const invoiceRef = useRef(null);
  const isFirstLoad = useRef(true);
  const [isMobile, setIsMobile] = useState(true);

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  // Detect mobile vs desktop
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

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
      // ── Fetch ALL pending/preparing orders for ALL tables (not just occupied) ──
      // This avoids the race condition where the order arrives before the table status updates.
      const allTableIds = tablesData.map(t => t.id);
      if (allTableIds.length > 0) {
        try {
          const { data: ordersData, error: ordErr } = await supabase
            .from('orders')
            .select(`
              *,
              order_items (
                *,
                menu_item:menu_items (name, price, image_url)
              )
            `)
            .in('table_id', allTableIds)
            .in('status', ['pending', 'preparing'])
            .order('created_at', { ascending: false });

          if (ordErr) console.error('[fetchTables] orders error:', ordErr.message);

          const ordersByTable = {};
          ordersData?.forEach(order => {
            if (!ordersByTable[order.table_id]) {
              ordersByTable[order.table_id] = [];
            }
            ordersByTable[order.table_id].push(order);
          });
          setOrders(ordersByTable);
        } catch (e) {
          console.error('[fetchTables] unexpected error:', e);
        }
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

    // Use a unique channel name each mount to avoid stale channel on HMR
    const channelName = `tables-realtime-${Date.now()}`;
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, () => {
        fetchTables();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        if (payload.eventType === 'INSERT' && !isFirstLoad.current) {
          playNotificationSound();
          setNewOrderAlert(payload.new);
          setTimeout(() => setNewOrderAlert(null), 5000);
        }
        fetchTables();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        fetchTables();
      })
      .subscribe((status) => {
        console.log('[Realtime] channel status:', status);
      });

    // ── Fallback: poll every 5s in case Supabase Realtime is not enabled ──
    const pollInterval = setInterval(() => {
      fetchTables();
    }, 5000);

    // ── Re-fetch when user switches back to this tab ──
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchTables();
    };
    document.addEventListener('visibilitychange', handleVisibility);

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
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibility);
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

  async function completeTable(tableId, paymentMethod = 'cash') {
    await supabase
      .from('orders')
      .update({ status: 'paid', payment_method: paymentMethod })
      .eq('table_id', tableId)
      .in('status', ['pending', 'preparing', 'completed']);

    await supabase
      .from('tables')
      .update({ status: 'available', occupied_at: null })
      .eq('id', tableId);

    setSelectedTable(null);
    fetchTables();
  }

  // ── Smart bank account rotation ──
  async function openPaymentModal(table, total) {
    // Fetch all active accounts ordered by sort_order
    const { data: accounts } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('is_active', true)
      .order('sort_order');

    if (!accounts || accounts.length === 0) {
      setBankAccounts([]);
      setQrAccount(null);
      setPaymentModal({ table, total });
      return;
    }

    // Fetch today's totals for all accounts
    const today = new Date().toISOString().slice(0, 10);
    const { data: dailyTotals } = await supabase
      .from('bank_daily_totals')
      .select('account_id, total_amount')
      .eq('date', today);

    const totalsMap = {};
    (dailyTotals || []).forEach(d => { totalsMap[d.account_id] = d.total_amount; });

    // Pick the first account whose total_received + bill <= daily_limit + 10% buffer
    // (allow up to 10% over limit to avoid awkward situations)
    const accountsWithTotals = accounts.map(a => ({
      ...a,
      received_today: totalsMap[a.id] || 0,
    }));

    let chosen = null;
    for (const acc of accountsWithTotals) {
      const remaining = acc.daily_limit - acc.received_today;
      // Allow overflow up to 10% of daily_limit (or switch to next)
      if (remaining + acc.daily_limit * 0.1 >= total || remaining > 0) {
        chosen = acc;
        break;
      }
    }
    // If all are full, use the last one as fallback
    if (!chosen) chosen = accountsWithTotals[accountsWithTotals.length - 1];

    setBankAccounts(accountsWithTotals);
    setQrAccount(chosen);
    setPaymentModal({ table, total });
  }

  async function recordBankPayment(accountId, amount) {
    const today = new Date().toISOString().slice(0, 10);
    // Upsert daily total (add to existing)
    const { data: existing } = await supabase
      .from('bank_daily_totals')
      .select('id, total_amount')
      .eq('account_id', accountId)
      .eq('date', today)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('bank_daily_totals')
        .update({ total_amount: existing.total_amount + amount })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('bank_daily_totals')
        .insert({ account_id: accountId, date: today, total_amount: amount });
    }
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

  async function removeItemFromOrder(orderId, itemId, itemName) {
    setConfirmDelete({ orderId, itemId, itemName });
  }

  async function performDeleteItem(orderId, itemId) {
    setConfirmDelete(null);
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

  async function updateItemPrice(orderId, itemId, newPrice) {
    if (!newPrice || newPrice <= 0) return;
    await supabase.from('order_items').update({ unit_price: newPrice }).eq('id', itemId);
    // recalculate order total
    const { data: allItems } = await supabase
      .from('order_items').select('unit_price, quantity').eq('order_id', orderId);
    const newTotal = (allItems || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);
    setEditItemPrice(null);
    setShowPriceModal(null);
    setDiscountValue(0);
    setDiscountMode('VND');
    setCustomNewPrice(null);
    fetchTables();
  }

  async function updateOrderItemOptions(orderId, itemId, newOptions, note) {
    await supabase.from('order_items').update({ item_options: newOptions, note: note || '' }).eq('id', itemId);
    setEditingOrderItem(null);
    setOptionModalItem(null);
    setSelectedOptions({});
    setOptionNote('');
    fetchTables();
  }

  const decreaseItemFromMenu = async (menuItemId) => {
    const activeOrder = selectedTable && orders[selectedTable.id] 
      ? (orders[selectedTable.id].find(o => o.customer_name === 'Admin') || orders[selectedTable.id][0])
      : null;
      
    if (!activeOrder) return;
    
    const existingItems = activeOrder.order_items?.filter(oi => oi.menu_item_id === menuItemId) || [];
    if (existingItems.length === 0) return;
    
    // Pick the last added item variant directly to decrement
    const existing = existingItems[existingItems.length - 1];
    await updateItemQuantity(activeOrder.id, existing.id, existing.quantity, -1);
  };


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
      setEditingPrice(false);
      setCustomPrice(null);
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
    fetchTables();
  }

  function handleConfirmOptions() {
    if (!optionModalItem) return;
    // Format selected options into array
    const optionsData = Object.keys(selectedOptions).map(key => ({
      name: key,
      choice: selectedOptions[key]
    }));
    // Use custom price if set
    const itemWithPrice = customPrice != null
      ? { ...optionModalItem, price: customPrice }
      : optionModalItem;
    setEditingPrice(false);
    setCustomPrice(null);

    if (editingOrderItem) {
      // UPDATE existing order item's options
      updateOrderItemOptions(editingOrderItem.orderId, editingOrderItem.itemId, optionsData, optionNote);
    } else {
      addItemToOrder('admin', itemWithPrice, optionsData, optionQuantity, optionNote);
    }
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

  const availableCount = tables.filter(t => t.status === 'available' && t.table_type !== 'takeaway').length;
  const occupiedCount = tables.filter(t => t.status === 'occupied' && t.table_type !== 'takeaway').length;

  const fetchTakeawayOrders = async () => {
    const takeawayTable = tables.find(t => t.table_type === 'takeaway');
    if (!takeawayTable) return;
    const { data } = await supabase
      .from('orders')
      .select('*, order_items(*, menu_item:menu_items(name, price))')
      .eq('table_id', takeawayTable.id)
      .eq('kitchen_completed', false)
      .in('status', ['pending', 'preparing'])
      .order('created_at', { ascending: false });
    // Wrap each order in the same shape the modal expects (orderIds array)
    setTakeawayOrders((data || []).map(o => ({ ...o, orderIds: [o.id] })));
  };

  const completeKitchenOrder = async (orderIds) => {
    const ids = Array.isArray(orderIds) ? orderIds : [orderIds];
    await supabase.from('orders').update({ kitchen_completed: true, status: 'completed' }).in('id', ids);
    setTakeawayOrders(prev => prev.filter(o => !o.orderIds?.some(id => ids.includes(id))));
  };

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
    <div className="page-content" style={{ background: '#f3f4f6', minHeight: '100vh' }}>
      {/* New order notification toast */}
      {newOrderAlert && (
        <div className="notification-toast animate-slide-up">
          <BellRing size={20} />
          <span>🔔 Đơn hàng mới từ khách <strong>{newOrderAlert.customer_name}</strong>!</span>
        </div>
      )}

      {/* Helper: shared filtered tables + card data */}
      {(() => {
        const takeawayTable = tables.find(t => t.table_type === 'takeaway');
        const filteredTables = tables.filter(t => {
          if (t.table_type === 'takeaway') return false; // always shown as pinned card
          if (filterTab === 'OCCUPIED') return t.status === 'occupied';
          if (filterTab === 'EMPTY') return t.status !== 'occupied';
          return true;
        });

        const tableCard = (table, compact = false) => {
          const tableBills = orders[table.id] || [];
          const isOccupied = table.status === 'occupied';
          const totalAmount = tableBills.reduce((s, o) => s + (o.total_amount || 0), 0);
          const guestCount = tableBills.length;
          let timeElapsed = '';
          if (isOccupied && table.occupied_at) {
            const diffMs = Date.now() - new Date(table.occupied_at).getTime();
            const h = Math.floor(diffMs / 3600000);
            const m = Math.floor((diffMs % 3600000) / 60000);
            timeElapsed = h > 0 ? `${h}g ${m}p` : `${m}p`;
          }
          return (
            <div
              key={table.id}
              onClick={() => { setSelectedTable(table); if (!isOccupied) setAddingToOrder('admin'); }}
              style={{
                background: isOccupied ? '#dbeafe' : 'white',
                border: isOccupied ? '1.5px solid #93c5fd' : '1.5px solid #e5e7eb',
                borderRadius: compact ? 12 : 16,
                padding: compact ? '12px 12px 10px' : '14px 14px 12px',
                cursor: 'pointer',
                minHeight: compact ? 90 : 110,
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: isOccupied ? '0 2px 8px rgba(37,99,235,0.10)' : '0 1px 4px rgba(0,0,0,0.06)',
                position: 'relative', transition: 'transform 0.1s, box-shadow 0.1s',
              }}
            >
              <div style={{ fontSize: compact ? '1rem' : '1.2rem', fontWeight: 800, color: isOccupied ? '#1d4ed8' : '#1f2937' }}>
                B{table.table_number}
              </div>
              {isOccupied ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: '0.75rem', color: '#3b82f6', fontWeight: 500, marginBottom: 2 }}>
                    {timeElapsed} • {guestCount} khách
                  </div>
                  <div style={{ fontSize: compact ? '0.88rem' : '0.95rem', fontWeight: 700, color: '#1d4ed8' }}>
                    {totalAmount.toLocaleString('vi-VN')}đ
                  </div>
                </div>
              ) : <div />}
              <div style={{ position: 'absolute', bottom: 6, right: 6 }}
                onClick={e => { e.stopPropagation(); setShowQR(table); }}>
                <QrCode size={13} style={{ color: isOccupied ? '#93c5fd' : '#d1d5db' }} />
              </div>
            </div>
          );
        };

        if (isMobile) {
          // ── Mobile: KiotViet fullscreen 2-col ──
          return (
            <>
              {/* Underline Tabs */}
              <div style={{ background: 'white', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, zIndex: 10 }}>
                <div style={{ display: 'flex' }}>
                  {[{ key: 'ALL', label: 'Tất cả' }, { key: 'OCCUPIED', label: 'Sử dụng' }, { key: 'EMPTY', label: 'Còn trống' }].map(tab => (
                    <button key={tab.key} onClick={() => setFilterTab(tab.key)} style={{
                      flex: 1, padding: '14px 8px', border: 'none', background: 'none',
                      fontSize: '0.95rem', fontWeight: 600, cursor: 'pointer',
                      color: filterTab === tab.key ? '#2563eb' : '#6b7280',
                      borderBottom: filterTab === tab.key ? '2.5px solid #2563eb' : '2.5px solid transparent',
                    }}>{tab.label}</button>
                  ))}
                </div>
              </div>
              {/* Takeaway pinned card */}
              {takeawayTable && (
                <div style={{ margin: '8px 8px 0', background: '#eff6ff', border: '2px solid #bfdbfe', borderRadius: 16, padding: '14px', gridColumn: '1 / -1' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <span style={{ fontSize: '1.8rem' }}>🛵</span>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#1d4ed8' }}>
                        {takeawayTable.table_name || 'Mang về'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#3b82f6' }}>
                        {takeawayOrders.length > 0 ? `${takeawayOrders.length} đơn đang chờ giao` : 'Chưa có đơn nào'}
                      </div>
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => { fetchTakeawayOrders(); setShowTakeawayOrders(true); }}
                        style={{ padding: '8px 14px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <ShoppingBag size={14} /> Xem đơn
                      </button>
                      <button
                        onClick={() => setShowQR(takeawayTable)}
                        style={{ padding: '8px 12px', background: 'white', color: '#2563eb', border: '1.5px solid #bfdbfe', borderRadius: 8, fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <QrCode size={14} /> QR
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {/* 2-col grid edge-to-edge */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '8px 8px 24px' }}>
                {filteredTables.map(t => tableCard(t, false))}
                <div onClick={() => setShowAddModal(true)} style={{
                  border: '1.5px dashed #d1d5db', borderRadius: 16, minHeight: 110,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: '#9ca3af', gap: 6, background: 'white',
                }}>
                  <Plus size={24} strokeWidth={1.5} />
                  <span style={{ fontSize: '0.82rem', fontWeight: 500 }}>Thêm bàn</span>
                </div>
              </div>
            </>
          );
        }

        // ── Desktop: KiotViet 2-pane POS layout ──
        const desktopOrderDetail = () => {
          if (!selectedTable) return (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', flexDirection: 'column', gap: 10 }}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/><line x1="12" y1="12" x2="12" y2="12"/></svg>
              <p style={{ fontSize: '0.9rem' }}>Chọn bàn để xem đơn hàng</p>
            </div>
          );
          const tableBills = orders[selectedTable.id] || [];
          // ── Collect ALL items from ALL orders (same as mobile) ──
          const allOrderItems = tableBills.flatMap(order =>
            (order.order_items || []).map(item => ({ ...item, _orderId: order.id }))
          );
          // Total = sum of all orders' total_amount (consistent with mobile bill total)
          const totalAmount = tableBills.reduce((s, o) => s + (o.total_amount || 0), 0);
          return (
            <>
              {/* Order header */}
              <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 8, background: 'white', flexShrink: 0 }}>
                <div style={{ background: '#2563eb', color: 'white', borderRadius: 6, padding: '4px 14px', fontSize: '0.9rem', fontWeight: 700 }}>B{selectedTable.table_number}</div>
                <button style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#6b7280' }}>+</button>
                <div style={{ flex: 1, background: '#f9fafb', borderRadius: 6, padding: '6px 12px', fontSize: '0.82rem', color: '#9ca3af', border: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Search size={13} /><span>Tìm khách hàng</span>
                </div>
                <span style={{ background: '#f0fdf4', color: '#16a34a', borderRadius: 100, padding: '4px 10px', fontSize: '0.72rem', fontWeight: 600, border: '1px solid #bbf7d0' }}>giá khuyến mãi</span>
                <button onClick={() => setAddingToOrder('admin')} style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>+ Thêm món</button>
              </div>
              {/* Items */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {allOrderItems.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: '0.9rem' }}>Chưa có món nào</div>
                ) : allOrderItems.map((item, idx) => {
                  const optionText = item.item_options?.map(o => o.choice).join(', ') || '';
                  const isEditingThisPrice = desktopInlinePriceItem === item.id;
                  const subtotal = item.unit_price * item.quantity;
                  return (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', padding: '9px 12px', borderBottom: '1px solid #f3f4f6', gap: 8, background: isEditingThisPrice ? '#fefce8' : 'white', transition: 'background 0.15s' }}>
                      {/* Index */}
                      <span style={{ color: '#9ca3af', fontSize: '0.78rem', minWidth: 16, paddingTop: 3, flexShrink: 0 }}>{idx + 1}.</span>

                      {/* Name + option + note */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#111827' }}>{item.menu_item?.name || item.name}</div>
                        {optionText ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
                            <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{optionText}</span>
                            {item.menu_item && (
                              <div
                                onClick={() => { setOptionModalItem(item.menu_item); setSelectedOptions({}); setOptionQuantity(item.quantity); setOptionNote(''); setEditingPrice(false); setCustomPrice(null); }}
                                style={{ width: 11, height: 11, background: '#ef4444', borderRadius: 2, cursor: 'pointer', flexShrink: 0 }}
                                title="Sửa khẩu vị"
                              />
                            )}
                          </div>
                        ) : item.menu_item ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
                            <span style={{ fontSize: '0.72rem', color: '#d1d5db', fontStyle: 'italic' }}>chưa chọn khẩu vị</span>
                            <div
                              onClick={() => { setOptionModalItem(item.menu_item); setSelectedOptions({}); setOptionQuantity(item.quantity); setOptionNote(''); setEditingPrice(false); setCustomPrice(null); }}
                              style={{ width: 11, height: 11, background: '#d1d5db', borderRadius: 2, cursor: 'pointer', flexShrink: 0 }}
                              title="Chọn khẩu vị"
                            />
                          </div>
                        ) : null}
                        <div style={{ fontSize: '0.72rem', color: '#2563eb', cursor: 'pointer', marginTop: 1 }}>📝 Ghi chú/Món thêm</div>
                      </div>

                      {/* Qty controls */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, paddingTop: 1 }}>
                        <button onClick={() => updateItemQuantity(item._orderId, item.id, item.quantity, -1)} style={{ width: 22, height: 22, border: '1px solid #d1d5db', borderRadius: 4, background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>−</button>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, minWidth: 18, textAlign: 'center' }}>{item.quantity}</span>
                        <button onClick={() => updateItemQuantity(item._orderId, item.id, item.quantity, 1)} style={{ width: 22, height: 22, border: '1px solid #d1d5db', borderRadius: 4, background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>+</button>
                      </div>

                      {/* Unit price — inline editable */}
                      <div style={{ flexShrink: 0, paddingTop: 1 }}>
                        {isEditingThisPrice ? (
                          <input
                            type="text" inputMode="numeric" pattern="[0-9]*" autoFocus
                            value={desktopInlinePriceVal}
                            onChange={e => setDesktopInlinePriceVal(e.target.value.replace(/\D/g, ''))}
                            onBlur={async () => {
                              const newP = parseInt(desktopInlinePriceVal, 10);
                              if (!isNaN(newP) && newP >= 0) await updateItemPrice(item._orderId, item.id, newP);
                              setDesktopInlinePriceItem(null);
                            }}
                            onKeyDown={async e => {
                              if (e.key === 'Enter') {
                                const newP = parseInt(desktopInlinePriceVal, 10);
                                if (!isNaN(newP) && newP >= 0) await updateItemPrice(item._orderId, item.id, newP);
                                setDesktopInlinePriceItem(null);
                              } else if (e.key === 'Escape') setDesktopInlinePriceItem(null);
                            }}
                            style={{ width: 72, textAlign: 'right', border: '1.5px solid #ef4444', borderRadius: 4, padding: '2px 4px', fontSize: '0.82rem', outline: 'none', fontWeight: 600, background: 'white' }}
                          />
                        ) : (
                          <span
                            onClick={() => { setDesktopInlinePriceItem(item.id); setDesktopInlinePriceVal(String(item.unit_price)); }}
                            style={{ display: 'block', minWidth: 65, textAlign: 'right', fontSize: '0.82rem', color: '#374151', cursor: 'text', padding: '2px 4px', borderRadius: 4, border: '1.5px solid transparent' }}
                            title="Click để sửa giá"
                          >{item.unit_price.toLocaleString('vi-VN')}</span>
                        )}
                      </div>

                      {/* Subtotal */}
                      <span style={{ minWidth: 68, textAlign: 'right', fontSize: '0.85rem', fontWeight: 700, color: '#111827', flexShrink: 0, paddingTop: 3 }}>{subtotal.toLocaleString('vi-VN')}</span>

                      {/* Action icons */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, paddingTop: 1 }}>
                        <button title="Thêm ghi chú" style={{ width: 20, height: 20, border: '1px solid #d1d5db', borderRadius: 4, background: 'white', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>+</button>
                        <button title="Yêu thích" style={{ width: 20, height: 20, border: '1px solid #d1d5db', borderRadius: 4, background: 'white', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f59e0b' }}>☆</button>
                        <button
                          title="Xóa món"
                          onClick={() => updateItemQuantity(item._orderId, item.id, item.quantity, -item.quantity)}
                          style={{ width: 20, height: 20, border: '1px solid #fca5a5', borderRadius: 4, background: '#fff5f5', cursor: 'pointer', fontSize: '0.7rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444' }}
                        >🗑</button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Footer total */}
              <div style={{ padding: '8px 14px', background: '#f9fafb', borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: '0.85rem', color: '#374151' }}>Tổng tiền đ:</span>
                <span style={{ fontSize: '1rem', fontWeight: 800, color: '#1d4ed8' }}>{totalAmount.toLocaleString('vi-VN')}</span>
              </div>
              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #e5e7eb', background: 'white', flexShrink: 0 }}>
                <button style={{ flex: 1, padding: '10px', border: '1.5px solid #2563eb', borderRadius: 8, background: 'white', color: '#2563eb', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  🔔 Thông báo
                </button>
                <button onClick={handlePrintInvoice} style={{ flex: 1, padding: '10px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: 'white', color: '#374151', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  📄 In tạm tính
                </button>
                <button
                  onClick={() => {
                    if (!selectedTable) return;
                    setConfirmPayment({ table: selectedTable, totalAmount });
                  }}
                  style={{ flex: 2, padding: '10px', border: 'none', borderRadius: 8, background: '#2563eb', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  💵 Thanh toán
                </button>
              </div>
            </>
          );
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', margin: '-2rem', marginTop: '-2rem' }}>
            {/* Blue top nav bar */}
            <div style={{ background: '#1e3a8a', display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px', flexShrink: 0 }}>
              {[{ label: 'Phòng bàn', view: 'tables' }, { label: 'Thực đơn', view: 'menu' }, { label: 'Đặt gọi món', view: 'tables' }].map((tab, i) => (
                <button key={tab.label}
                  onClick={() => { if (i !== 2) setDesktopView(tab.view); }}
                  style={{ background: desktopView === tab.view && i < 2 ? 'rgba(255,255,255,0.22)' : 'transparent', color: 'white', border: 'none', padding: '7px 16px', borderRadius: 6, cursor: 'pointer', fontSize: '0.88rem', fontWeight: desktopView === tab.view && i < 2 ? 700 : 400, display: 'flex', alignItems: 'center', gap: 5 }}
                >{tab.label}</button>
              ))}
              <div style={{ position: 'relative', flex: 1, maxWidth: 400 }}>
                <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '0', display: 'flex', alignItems: 'center', gap: 8, color: 'white', border: desktopSearch ? '1.5px solid rgba(255,255,255,0.4)' : '1.5px solid transparent' }}>
                  <Search size={13} style={{ opacity: 0.7, marginLeft: 12, flexShrink: 0 }} />
                  <input
                    type="text"
                    value={desktopSearch}
                    onChange={e => setDesktopSearch(e.target.value)}
                    placeholder="Tìm món..."
                    style={{
                      flex: 1, background: 'transparent', border: 'none', outline: 'none',
                      color: 'white', fontSize: '0.85rem', padding: '7px 12px 7px 0',
                    }}
                  />
                  {desktopSearch && (
                    <button onClick={() => setDesktopSearch('')} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: '0 10px', fontSize: '1rem' }}>×</button>
                  )}
                </div>
                {/* Search results dropdown */}
                {desktopSearch.trim() && (() => {
                  const q = desktopSearch.trim().toLowerCase();
                  const results = menuItems.filter(m => m.name?.toLowerCase().includes(q)).slice(0, 8);
                  return results.length > 0 ? (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'white', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', zIndex: 1000, marginTop: 4, overflow: 'hidden' }}>
                      {results.map(item => (
                        <div
                          key={item.id}
                          onClick={() => {
                            setOptionModalItem(item);
                            setSelectedOptions({});
                            setOptionQuantity(1);
                            setOptionNote('');
                            setEditingPrice(false);
                            setCustomPrice(null);
                            setDesktopSearch('');
                          }}
                          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', transition: 'background 0.1s' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#f0f9ff'}
                          onMouseLeave={e => e.currentTarget.style.background = 'white'}
                        >
                          <div style={{ width: 36, height: 36, background: '#dbeafe', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <ChefHat size={18} style={{ color: '#2563eb' }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                            <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                              {item.category?.name || ''} • Giá: <span style={{ color: '#2563eb', fontWeight: 600 }}>{item.price?.toLocaleString('vi-VN')}đ</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'white', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', zIndex: 1000, marginTop: 4, padding: '14px', textAlign: 'center', color: '#9ca3af', fontSize: '0.85rem' }}>
                      Không tìm thấy món nào
                    </div>
                  );
                })()}
              </div>
              <div style={{ width: 8 }} />
              <button onClick={() => setShowAddModal(true)} style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '1.1rem', fontWeight: 700 }}>+</button>
            </div>

            {/* 2-pane content */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              {/* LEFT: Table browser or Menu view */}
              <div style={{ width: '42%', display: 'flex', flexDirection: 'column', background: 'white', borderRight: '1px solid #e5e7eb', overflow: 'hidden' }}>
                {desktopView === 'menu' ? (
                  /* ── Menu Grid View ── */
                  <>
                    {/* Category tabs */}
                    <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', overflowX: 'auto', flexShrink: 0, background: 'white' }}>
                      {[{ id: 'all', name: 'Tất cả' }, ...categories].map(cat => (
                        <button key={cat.id} onClick={() => setDesktopMenuCat(cat.id)}
                          style={{ padding: '8px 14px', border: 'none', background: 'none', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '0.82rem', fontWeight: desktopMenuCat === cat.id ? 700 : 400,
                            color: desktopMenuCat === cat.id ? '#2563eb' : '#374151',
                            borderBottom: desktopMenuCat === cat.id ? '2.5px solid #2563eb' : '2.5px solid transparent' }}
                        >{cat.name}</button>
                      ))}
                    </div>
                    {/* Menu grid 5 columns */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: '10px', background: '#f8fafc' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                        {menuItems
                          .filter(m => desktopMenuCat === 'all' || m.category?.id === desktopMenuCat || m.category_id === desktopMenuCat)
                          .map(item => (
                            <div key={item.id}
                              onClick={() => {
                                setOptionModalItem(item);
                                setSelectedOptions({});
                                setOptionQuantity(1);
                                setOptionNote('');
                                setEditingPrice(false);
                                setCustomPrice(null);
                              }}
                              style={{ background: 'white', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', border: '1px solid #e5e7eb', transition: 'box-shadow 0.15s' }}
                              onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 12px rgba(37,99,235,0.12)'}
                              onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
                            >
                              {/* Image or placeholder */}
                              <div style={{ position: 'relative' }}>
                                {item.image_url ? (
                                  <img src={item.image_url} alt={item.name} style={{ width: '100%', height: 72, objectFit: 'cover', display: 'block' }} />
                                ) : (
                                  <div style={{ width: '100%', height: 72, background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <ChefHat size={28} style={{ color: '#93c5fd' }} />
                                  </div>
                                )}
                                {/* Price badge top */}
                                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(37,99,235,0.85)', color: 'white', textAlign: 'center', fontSize: '0.7rem', fontWeight: 700, padding: '2px 0' }}>
                                  {item.price?.toLocaleString('vi-VN')}
                                </div>
                              </div>
                              {/* Name + option */}
                              <div style={{ padding: '5px 6px 6px' }}>
                                <div style={{ fontSize: '0.73rem', fontWeight: 600, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                                {item.options?.length > 0 && (
                                  <div style={{ fontSize: '0.65rem', color: '#f97316', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.options[0]?.name || ''}</div>
                                )}
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  </>
                ) : (
                  /* ── Table Browser ── */
                  <>
                    {/* Filter bar */}
                    <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap', flexShrink: 0 }}>
                      {[{ key: 'ALL', label: `Tất cả (${tables.length})` }, { key: 'OCCUPIED', label: `Sử dụng (${occupiedCount})` }, { key: 'EMPTY', label: `Còn trống (${availableCount})` }].map(f => (
                        <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} onClick={() => setFilterTab(f.key)}>
                          <div style={{ width: 15, height: 15, borderRadius: '50%', border: '2px solid ' + (filterTab === f.key ? '#2563eb' : '#d1d5db'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {filterTab === f.key && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#2563eb' }} />}
                          </div>
                          <span style={{ fontSize: '0.8rem', color: filterTab === f.key ? '#2563eb' : '#374151', fontWeight: filterTab === f.key ? 600 : 400 }}>{f.label}</span>
                        </div>
                      ))}
                      <div style={{ flex: 1 }} />
                      <button style={{ background: '#fff7ed', color: '#ea580c', border: '1px solid #fed7aa', borderRadius: 100, padding: '3px 10px', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        🔔 Gọi món qua QR
                      </button>
                    </div>
                    {/* Table grid */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: 10, background: '#f8fafc' }}>
                      {/* Takeaway pinned card — desktop */}
                      {takeawayTable && (
                        <div style={{ background: '#eff6ff', border: '2px solid #bfdbfe', borderRadius: 12, padding: '10px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: '1.5rem' }}>🛵</span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 800, fontSize: '0.9rem', color: '#1d4ed8' }}>{takeawayTable.table_name || 'Mang về'}</div>
                            <div style={{ fontSize: '0.72rem', color: '#3b82f6' }}>
                              {takeawayOrders.length > 0 ? `${takeawayOrders.length} đơn đang chờ` : 'Chưa có đơn'}
                            </div>
                          </div>
                          <button
                            onClick={() => { fetchTakeawayOrders(); setShowTakeawayOrders(true); }}
                            style={{ padding: '6px 12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                          >
                            <ShoppingBag size={13} /> Xem đơn
                          </button>
                          <button
                            onClick={() => setShowQR(takeawayTable)}
                            style={{ padding: '6px 10px', background: 'white', color: '#2563eb', border: '1.5px solid #bfdbfe', borderRadius: 8, fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                          >
                            <QrCode size={13} /> QR
                          </button>
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
                        {filteredTables.map(table => {
                          const isOccupied = table.status === 'occupied';
                          const isSelected = selectedTable?.id === table.id;
                          const tableTotal = (orders[table.id] || []).reduce((s, o) => s + (o.total_amount || 0), 0);
                          return (
                            <div key={table.id}
                              onClick={() => { setSelectedTable(table); setDesktopView('menu'); if (!isOccupied && isMobile) setAddingToOrder('admin'); }}
                              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '8px 4px 6px', borderRadius: 8, cursor: 'pointer', minHeight: 72, transition: 'all 0.12s',
                                background: isSelected ? '#2563eb' : isOccupied ? '#dbeafe' : 'white',
                                border: '1.5px solid ' + (isSelected ? '#2563eb' : isOccupied ? '#93c5fd' : '#e5e7eb') }}
                            >
                              <svg width="38" height="30" viewBox="0 0 38 30" fill="none">
                                <rect x="4" y="9" width="30" height="12" rx="3"
                                  fill={isSelected ? 'rgba(255,255,255,0.25)' : '#dbeafe'}
                                  stroke={isSelected ? 'rgba(255,255,255,0.5)' : '#93c5fd'} strokeWidth="1.5"/>
                                <rect x="7" y="1" width="4" height="9" rx="1.5" fill={isSelected ? 'rgba(255,255,255,0.5)' : '#93c5fd'}/>
                                <rect x="27" y="1" width="4" height="9" rx="1.5" fill={isSelected ? 'rgba(255,255,255,0.5)' : '#93c5fd'}/>
                                <rect x="7" y="21" width="4" height="8" rx="1.5" fill={isSelected ? 'rgba(255,255,255,0.5)' : '#93c5fd'}/>
                                <rect x="27" y="21" width="4" height="8" rx="1.5" fill={isSelected ? 'rgba(255,255,255,0.5)' : '#93c5fd'}/>
                              </svg>
                              <span style={{ fontSize: '0.72rem', fontWeight: 700, marginTop: 2, color: isSelected ? 'white' : isOccupied ? '#1d4ed8' : '#374151' }}>B{table.table_number}</span>
                              {tableTotal > 0 && (
                                <span style={{ fontSize: '0.6rem', fontWeight: 600, color: isSelected ? 'rgba(255,255,255,0.85)' : '#2563eb', marginTop: 1, whiteSpace: 'nowrap' }}>
                                  {tableTotal >= 1000 ? (tableTotal / 1000).toFixed(0) + 'k' : tableTotal.toLocaleString('vi-VN')}đ
                                </span>
                              )}
                            </div>
                          );
                        })}
                        <div onClick={() => setShowAddModal(true)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: '1.5px dashed #d1d5db', minHeight: 72, cursor: 'pointer', color: '#9ca3af', gap: 2, background: 'white' }}>
                          <Plus size={16} strokeWidth={1.5} />
                          <span style={{ fontSize: '0.65rem' }}>Thêm bàn</span>
                        </div>
                      </div>
                    </div>
                    {/* Bottom bar */}
                    <div style={{ padding: '8px 12px', background: 'white', borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', cursor: 'pointer', color: '#374151' }}>
                        <input type="checkbox" defaultChecked style={{ accentColor: '#2563eb' }} />
                        Mở thực đơn khi chọn bàn
                      </label>
                      <button onClick={() => setShowAddModal(true)} style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Plus size={13} /> Thêm bàn
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* RIGHT: Order detail */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden', minWidth: 0 }}>
                {desktopOrderDetail()}
              </div>
            </div>
          </div>
        );
      })()}
      {/* ══ PAYMENT MODAL ══ */}
      {paymentModal && (() => {
        const { table, total } = paymentModal;
        const fmt = (n) => new Intl.NumberFormat('vi-VN').format(n) + 'đ';

        const closeModal = () => { setPaymentModal(null); setQrAccount(null); setShowTransfer(false); };

        const doCashPayment = async () => {
          closeModal();
          await completeTable(table.id, 'cash');
        };

        const doTransferPayment = async () => {
          if (qrAccount) await recordBankPayment(qrAccount.id, total);
          closeModal();
          await completeTable(table.id, 'transfer');
        };

        const doCancelOrder = async () => {
          if (!window.confirm('Bạn có chắc muốn huỷ tất cả đơn của bàn này?')) return;
          await supabase.from('orders')
            .update({ status: 'cancelled', payment_method: 'cancelled' })
            .eq('table_id', table.id)
            .in('status', ['pending', 'preparing', 'completed']);
          await supabase.from('tables')
            .update({ status: 'available', occupied_at: null })
            .eq('id', table.id);
          closeModal();
          setSelectedTable(null);
          fetchTables();
        };

        // Vietcombank VietQR string: bank_id|account_number|amount|description
        const buildVietQR = (acc) => {
          if (!acc) return '';
          const bankMap = {
            'vietcombank': '970436', 'vcb': '970436',
            'mb bank': '970422', 'mbbank': '970422',
            'techcombank': '970407', 'tcb': '970407',
            'agribank': '970405',
            'vietinbank': '970415', 'ctg': '970415',
            'bidv': '970418',
            'acb': '970416',
            'vpbank': '970432',
            'tpbank': '970423',
            'sacombank': '970403',
          };
          const bankKey = acc.bank_name.toLowerCase().replace(/\s+/g, '');
          const bin = bankMap[bankKey] || bankMap[acc.bank_name.toLowerCase()] || '970436';
          const desc = encodeURIComponent(`T1 B${table.table_number}`);
          return `https://img.vietqr.io/image/${bin}-${acc.account_number}-compact2.png?amount=${total}&addInfo=${desc}&accountName=${encodeURIComponent(acc.account_name)}`;
        };


        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
            onClick={closeModal}>
            <div style={{ background: 'white', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 480, padding: '20px 16px 28px', boxShadow: '0 -8px 40px rgba(0,0,0,0.18)' }}
              onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#0f172a' }}>💳 Thanh toán</div>
                  <div style={{ fontSize: '0.82rem', color: '#64748b' }}>Bàn {table.table_number}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Tổng cộng</div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#c53b3b' }}>{fmt(total)}</div>
                </div>
              </div>

              {!showTransfer ? (
                /* ── Step 1: Choose payment method ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* In hoá đơn */}
                  <button onClick={() => { handlePrintInvoice(); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 14, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                    <span style={{ fontSize: '1.5rem' }}>🖨️</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#0f172a' }}>In hoá đơn</div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>In tạm tính trước khi thu tiền</div>
                    </div>
                  </button>

                  {/* Tiền mặt */}
                  <button onClick={doCashPayment}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: '#f0fdf4', border: '1.5px solid #bbf7d0', borderRadius: 14, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                    <span style={{ fontSize: '1.5rem' }}>💵</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#15803d' }}>Tiền mặt</div>
                      <div style={{ fontSize: '0.75rem', color: '#16a34a' }}>Nhận tiền mặt — đóng bàn ngay</div>
                    </div>
                    <div style={{ marginLeft: 'auto', background: '#16a34a', color: 'white', borderRadius: 8, padding: '4px 12px', fontSize: '0.8rem', fontWeight: 700 }}>Xác nhận</div>
                  </button>

                  {/* Chuyển khoản */}
                  <button onClick={() => setShowTransfer(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: '#eff6ff', border: '1.5px solid #bfdbfe', borderRadius: 14, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                    <span style={{ fontSize: '1.5rem' }}>📲</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#1d4ed8' }}>Chuyển khoản</div>
                      <div style={{ fontSize: '0.75rem', color: '#3b82f6' }}>Hiện mã QR cho khách quét</div>
                    </div>
                    <div style={{ marginLeft: 'auto', color: '#3b82f6', fontSize: '1.1rem' }}>›</div>
                  </button>

                </div>
              ) : (
                /* ── Step 2: QR Transfer ── */
                <div>
                  <button onClick={() => setShowTransfer(false)} style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600, marginBottom: 10, padding: 0 }}>‹ Quay lại</button>

                  {qrAccount ? (
                    <>
                      {/* VietQR image */}
                      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                        <img
                          src={buildVietQR(qrAccount)}
                          alt="QR chuyển khoản"
                          style={{ width: 220, height: 220, borderRadius: 12, border: '2px solid #bfdbfe', objectFit: 'contain', background: 'white' }}
                          onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }}
                        />
                        <div style={{ width: 220, height: 220, display: 'none', alignItems: 'center', justifyContent: 'center', border: '2px solid #bfdbfe', borderRadius: 12, flexDirection: 'column', gap: 6 }}>
                          <QRCodeSVG value={`${qrAccount.bank_name}|${qrAccount.account_number}|${total}`} size={180} level="H" includeMargin />
                        </div>
                      </div>

                      {/* Account info */}
                      <div style={{ background: '#f8fafc', borderRadius: 12, padding: '10px 14px', marginBottom: 10, fontSize: '0.85rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: '#64748b' }}>Ngân hàng</span>
                          <span style={{ fontWeight: 700, color: '#0f172a' }}>{qrAccount.bank_name}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: '#64748b' }}>Số tài khoản</span>
                          <span style={{ fontWeight: 700, color: '#0f172a', letterSpacing: 1 }}>{qrAccount.account_number}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: '#64748b' }}>Tên tài khoản</span>
                          <span style={{ fontWeight: 700, color: '#0f172a' }}>{qrAccount.account_name}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>Số tiền</span>
                          <span style={{ fontWeight: 800, color: '#c53b3b', fontSize: '1rem' }}>{fmt(total)}</span>
                        </div>
                      </div>

                      {/* Daily limit badge */}
                      {(() => {
                        const pct = Math.round((qrAccount.received_today / qrAccount.daily_limit) * 100);
                        const remaining = qrAccount.daily_limit - qrAccount.received_today;
                        return (
                          <div style={{ fontSize: '0.73rem', color: '#64748b', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ flex: 1, height: 4, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: pct > 90 ? '#f59e0b' : '#3b82f6', transition: 'width 0.3s' }} />
                            </div>
                            <span>Hạn mức: {fmt(Math.max(0, remaining))} còn lại</span>
                          </div>
                        );
                      })()}

                      {/* Switch account (if multiple) */}
                      {bankAccounts.length > 1 && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: '0.73rem', color: '#64748b', marginBottom: 4 }}>Đổi tài khoản nhận:</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {bankAccounts.map(acc => (
                              <button key={acc.id} onClick={() => setQrAccount(acc)}
                                style={{ padding: '4px 10px', borderRadius: 8, border: `1.5px solid ${acc.id === qrAccount.id ? '#2563eb' : '#e2e8f0'}`, background: acc.id === qrAccount.id ? '#eff6ff' : 'white', cursor: 'pointer', fontSize: '0.75rem', fontWeight: acc.id === qrAccount.id ? 700 : 500, color: acc.id === qrAccount.id ? '#1d4ed8' : '#374151' }}>
                                {acc.bank_name} · {acc.account_number.slice(-4)}
                                {acc.received_today >= acc.daily_limit && <span style={{ marginLeft: 4, color: '#f59e0b' }}>⚠️</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ textAlign: 'center', color: '#64748b', padding: 32 }}>Chưa cấu hình tài khoản ngân hàng</div>
                  )}

                  <button onClick={doTransferPayment}
                    style={{ width: '100%', padding: '13px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: '1rem', cursor: 'pointer' }}>
                    ✅ Xác nhận đã nhận tiền — Đóng bàn
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* QR Code Modal - uses table UUID in URL */}
      {showQR && (
        <div className="modal-overlay" onClick={() => setShowQR(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>QR Code - {showQR.table_type === 'takeaway' ? (showQR.table_name || 'Mang về') : `Bàn ${showQR.table_number}`}</h3>
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
                {showQR.table_type === 'takeaway' ? 'Quét mã QR để đặt món Mang về' : `Quét mã QR này để đặt món tại Bàn ${showQR.table_number}`}
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 16 }}>
                <button
                  className="btn btn-primary"
                  onClick={() => downloadQR(showQR)}
                >
                  <Download size={16} /> Tải QR
                </button>
                <button
                  className="btn btn-outline"
                  onClick={() => setShowShareSheet(true)}
                >
                  🔗 Chia sẻ
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Custom Share Sheet ── */}
      {showShareSheet && showQR && (() => {
        const url = `${baseUrl}/order?table=${showQR.id}`;
        const text = encodeURIComponent(`Quét mã để đặt món: ${url}`);
        const encodedUrl = encodeURIComponent(url);
        const shareOptions = [
          { label: 'Zalo', emoji: '💬', href: `https://zalo.me/chat?appid=4445&url=${encodedUrl}`, bg: '#0068FF' },
          { label: 'WhatsApp', emoji: '📱', href: `https://wa.me/?text=${text}`, bg: '#25D366' },
          { label: 'Facebook', emoji: '📘', href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, bg: '#1877F2' },
          { label: 'Messenger', emoji: '💙', href: `fb-messenger://share/?link=${encodedUrl}`, bg: '#0084FF' },
          { label: 'SMS', emoji: '✉️', href: `sms:?body=${text}`, bg: '#34C759' },
        ];
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
            onClick={() => setShowShareSheet(false)}>
            <div style={{ background: 'white', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 480, padding: '20px 20px 32px' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ textAlign: 'center', marginBottom: 4 }}>
                <div style={{ width: 36, height: 4, background: '#e5e7eb', borderRadius: 99, margin: '0 auto 16px' }} />
                <div style={{ fontWeight: 700, fontSize: '1rem', color: '#111827', marginBottom: 4 }}>Chia sẻ mã QR</div>
                <div style={{ fontSize: '0.8rem', color: '#6b7280', background: '#f3f4f6', borderRadius: 8, padding: '6px 12px', display: 'inline-block', wordBreak: 'break-all' }}>{url}</div>
              </div>
              {/* App icons row */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: 20, margin: '20px 0 16px' }}>
                {shareOptions.map(opt => (
                  <a key={opt.label} href={opt.href} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textDecoration: 'none' }}
                    onClick={() => setShowShareSheet(false)}>
                    <div style={{ width: 52, height: 52, borderRadius: 16, background: opt.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
                      {opt.emoji}
                    </div>
                    <span style={{ fontSize: '0.72rem', color: '#374151', fontWeight: 500 }}>{opt.label}</span>
                  </a>
                ))}
              </div>
              {/* Copy link */}
              <button
                onClick={async () => {
                  try { await navigator.clipboard.writeText(url); } catch { window.prompt('Sao chép:', url); }
                  setShowShareSheet(false);
                  alert('Đã sao chép link!');
                }}
                style={{ width: '100%', padding: '13px', border: '1.5px solid #e5e7eb', borderRadius: 12, background: 'white', fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              >
                📋 Sao chép link
              </button>
            </div>
          </div>
        );
      })()}

      {/* Table Detail Modal - mobile only; desktop shows inline in right panel */}
      {isMobile && selectedTable && !addingToOrder && (
        <div className="modal-overlay" onClick={() => setSelectedTable(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
            <div className="modal-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, paddingBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <h3 style={{ fontSize: '1.4rem', fontWeight: 800 }}>Bàn {selectedTable.table_number}</h3>
                <button className="btn btn-ghost btn-icon" onClick={() => setSelectedTable(null)}>
                  <X size={20} />
                </button>
              </div>
              {/* Show first order info (customer name, time, status) */}
              {orders[selectedTable.id]?.[0] && (() => {
                const o = orders[selectedTable.id][0];
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: '#6b7280' }}>
                    <span style={{ fontWeight: 600, color: '#374151' }}>{o.customer_name}</span>
                    <span>·</span>
                    <Clock size={12} />
                    <span>{formatTime(o.created_at)}</span>
                    <span className={`badge badge-${o.status}`} style={{ fontSize: '0.75rem', padding: '2px 8px' }}>
                      {o.status === 'pending' ? 'Chờ' : o.status === 'preparing' ? 'Đang làm' : o.status === 'completed' ? 'Xong' : 'Đã TT'}
                    </span>
                  </div>
                );
              })()}
            </div>
            <div className="modal-body" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

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
                    <div className="order-items-list">
                      {order.order_items?.map((item) => (
                        <div key={item.id} style={{
                          display: 'flex', gap: 12, padding: '10px 0',
                          borderBottom: '1px solid #f3f4f6', alignItems: 'flex-start'
                        }}>
                          {/* Food Image */}
                          <div style={{
                            width: 52, height: 52, borderRadius: 10,
                            flexShrink: 0, overflow: 'hidden',
                            background: '#f3f4f6',
                            border: '1px solid #e5e7eb',
                          }}>
                            {item.menu_item?.image_url ? (
                              <img
                                src={item.menu_item.image_url}
                                alt={item.menu_item.name}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.4rem' }}>🍽️</div>
                            )}
                          </div>

                          {/* Content */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {/* Row 1: Name + delete button */}
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
                              <span style={{ fontSize: '0.97rem', fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
                                {item.menu_item?.name || 'Món đã xoá'}
                              </span>
                              <button
                                title="Xóa món"
                                onClick={() => removeItemFromOrder(order.id, item.id, item.menu_item?.name || 'Món này')}
                                style={{
                                  flexShrink: 0, background: 'none', border: 'none',
                                  color: '#9ca3af', cursor: 'pointer', padding: '0 2px',
                                  fontSize: '1.1rem', lineHeight: 1,
                                }}
                              >
                                ···
                              </button>
                            </div>

                            {/* Row 2: Option/khẩu vị + edit button */}
                            {item.item_options?.length > 0 && (() => {
                              const fullItem = menuItems.find(m => m.id === item.menu_item_id);
                              const hasOptions = fullItem?.options?.length > 0;
                              const openEdit = () => {
                                if (!hasOptions) return;
                                const current = {};
                                item.item_options.forEach(o => { current[o.name] = o.choice; });
                                setSelectedOptions(current);
                                setOptionQuantity(item.quantity);
                                setOptionNote(item.note || '');
                                setEditingOrderItem({ orderId: order.id, itemId: item.id });
                                setOptionModalItem(fullItem);
                                setEditingPrice(false);
                                setCustomPrice(null);
                              };
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                  <span style={{ fontSize: '0.82rem', color: '#9ca3af', fontStyle: 'italic' }}>
                                    {item.item_options.map(o => o.choice).join(', ')}
                                  </span>
                                  {hasOptions && (
                                    <button
                                      onClick={openEdit}
                                      title="Đổi khẩu vị"
                                      style={{
                                        background: '#eff6ff', border: '1px solid #bfdbfe',
                                        borderRadius: 5, padding: '1px 6px',
                                        cursor: 'pointer', color: '#2563eb',
                                        fontSize: '0.72rem', fontWeight: 600,
                                        display: 'flex', alignItems: 'center', gap: 3,
                                        whiteSpace: 'nowrap', flexShrink: 0
                                      }}
                                    >
                                      ✏️ Đổi
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                            {item.note && (
                              <div style={{ fontSize: '0.82rem', color: '#9ca3af', fontStyle: 'italic', marginTop: 2 }}>
                                {item.note}
                              </div>
                            )}

                            {/* Row 3: Price left + qty controls right */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                              {/* Editable price */}
                              {/* Normal price display + edit button */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>
                                  {formatPrice(item.unit_price * item.quantity).replace('đ', '')}
                                </span>
                                <button
                                  onClick={() => {
                                    setDiscountValue(0);
                                    setDiscountMode('VND');
                                    setCustomNewPrice(null);
                                    setShowPriceModal({ orderId: order.id, itemId: item.id, originalPrice: item.unit_price });
                                  }}
                                  title="Sửa giá"
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', padding: 2, display: 'flex', alignItems: 'center' }}
                                >
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                  </svg>
                                </button>
                              </div>
                              {/* Qty controls */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <button
                                  onClick={() => updateItemQuantity(order.id, item.id, item.quantity, -1)}
                                  style={{
                                    width: 28, height: 28, borderRadius: 50,
                                    border: '1.5px solid #d1d5db', background: 'white',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    cursor: 'pointer', color: '#374151'
                                  }}
                                >
                                  <Minus size={13} strokeWidth={2} />
                                </button>
                                <span style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', minWidth: 16, textAlign: 'center' }}>
                                  {item.quantity}
                                </span>
                                <button
                                  onClick={() => updateItemQuantity(order.id, item.id, item.quantity, 1)}
                                  style={{
                                    width: 28, height: 28, borderRadius: 50,
                                    border: '1.5px solid #d1d5db', background: 'white',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    cursor: 'pointer', color: '#374151'
                                  }}
                                >
                                  <Plus size={13} strokeWidth={2} />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
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

            {/* Floating FAB — absolutely positioned on modal, not in scroll area */}
            {orders[selectedTable.id]?.length > 0 && (
              <button
                onClick={() => setAddingToOrder('admin')}
                style={{
                  position: 'absolute',
                  right: 16,
                  bottom: 115,
                  width: 50, height: 50,
                  borderRadius: '50%',
                  background: '#2563eb',
                  border: 'none',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '0 4px 20px rgba(37,99,235,0.45)',
                  zIndex: 20,
                }}
              >
                <Plus size={22} strokeWidth={2.5} />
              </button>
            )}
            <div className="modal-footer" style={{ padding: '8px 12px', gap: 6, flexDirection: 'column', alignItems: 'stretch' }}>
                {/* Total summary row */}
                {orders[selectedTable.id]?.length > 0 && (() => {
                  const total = orders[selectedTable.id].reduce((s, o) => s + (o.total_amount || 0), 0);
                  return (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontSize: '0.88rem', color: '#6b7280', fontWeight: 500 }}>Tổng cộng:</span>
                      <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#c53b3b' }}>{formatPrice(total)}</span>
                    </div>
                  );
                })()}
                {/* Action buttons row — styled like reference image */}
                {orders[selectedTable.id]?.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, width: '100%', alignItems: 'stretch' }}>

                    {/* Tạm tính — small square outlined, icon+text stacked */}
                    <button
                      onClick={() => setShowBillPreview(true)}
                      style={{
                        width: 64, minWidth: 64,
                        padding: '6px 4px',
                        border: '1.5px solid #2563eb',
                        borderRadius: 14,
                        background: 'white',
                        color: '#2563eb',
                        cursor: 'pointer',
                        display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center',
                        gap: 2,
                        fontSize: '0.72rem', fontWeight: 600,
                      }}
                    >
                      <Receipt size={18} strokeWidth={1.8} />
                      Tạm tính
                    </button>

                    {/* Huỷ đơn — small red destructive button */}
                    <button
                      onClick={async () => {
                        if (!window.confirm('Bạn có chắc muốn huỷ toàn bộ đơn của bàn này?')) return;
                        await supabase.from('orders')
                          .update({ status: 'cancelled', payment_method: 'cancelled' })
                          .eq('table_id', selectedTable.id)
                          .in('status', ['pending', 'preparing', 'completed']);
                        await supabase.from('tables')
                          .update({ status: 'available', occupied_at: null })
                          .eq('id', selectedTable.id);
                        setSelectedTable(null);
                        fetchTables();
                      }}
                      style={{
                        width: 64, minWidth: 64,
                        padding: '6px 4px',
                        border: '1.5px solid #fca5a5',
                        borderRadius: 14,
                        background: 'white',
                        color: '#dc2626',
                        cursor: 'pointer',
                        display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center',
                        gap: 2,
                        fontSize: '0.72rem', fontWeight: 600,
                      }}
                    >
                      <Trash2 size={18} strokeWidth={1.8} />
                      Huỷ đơn
                    </button>

                    {/* In hoá đơn — outlined pill */}
                    <button
                      onClick={handlePrintInvoice}
                      style={{
                        flex: 1,
                        padding: '10px 8px',
                        border: '1.5px solid #2563eb',
                        borderRadius: 100,
                        background: 'white',
                        color: '#2563eb',
                        cursor: 'pointer',
                        fontSize: '0.9rem', fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      In hoá đơn
                    </button>

                    {/* Thanh toán — solid blue pill, widest */}
                    <button
                      onClick={() => {
                        const total = orders[selectedTable.id]?.reduce((s, o) => s + (o.total_amount || 0), 0) || 0;
                        openPaymentModal(selectedTable, total);
                      }}
                      style={{
                        flex: 2,
                        padding: '10px 12px',
                        border: 'none',
                        borderRadius: 100,
                        background: '#2563eb',
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: '0.95rem', fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Thanh toán
                    </button>
                  </div>
                )}
              </div>
          </div>
        </div>
      )}

      {/* ── Sửa giá bán bottom-sheet modal ── */}
      {showPriceModal && (() => {
        const orig = showPriceModal.originalPrice;
        const newPrice = discountMode === 'VND'
          ? Math.max(0, orig - (discountValue || 0))
          : Math.max(0, orig - Math.round(orig * (discountValue || 0) / 100));
        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 1200,
              background: 'rgba(0,0,0,0.45)',
              display: 'flex', alignItems: 'flex-end',
            }}
            onClick={() => setShowPriceModal(null)}
          >
            <div
              style={{
                width: '100%', background: 'white',
                borderRadius: '20px 20px 0 0',
                padding: '0 0 32px 0',
                boxShadow: '0 -4px 30px rgba(0,0,0,0.15)',
                animation: 'slideUp 0.25s ease-out',
              }}
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '18px 20px 14px',
                borderBottom: '1px solid #f3f4f6',
              }}>
                <span style={{ fontSize: '1.05rem', fontWeight: 700, color: '#111827' }}>Sửa giá bán</span>
                <button
                  onClick={() => setShowPriceModal(null)}
                  style={{ background: 'none', border: 'none', fontSize: '1.3rem', color: '#6b7280', cursor: 'pointer', lineHeight: 1 }}
                >×</button>
              </div>

              <div style={{ padding: '20px 20px 0' }}>
                {/* Giá bán */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: 6, fontWeight: 500 }}>Giá bán</div>
                  <div style={{
                    background: '#f9fafb', borderRadius: 12, padding: '14px 16px',
                    textAlign: 'right', fontSize: '1.05rem', fontWeight: 700, color: '#111827',
                    border: '1px solid #f3f4f6',
                  }}>
                    {orig.toLocaleString('vi-VN')}
                  </div>
                </div>

                {/* Giảm giá */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: 6, fontWeight: 500 }}>Giảm giá</div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 0,
                    border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden',
                    background: 'white',
                  }}>
                    {/* Toggle VNĐ / % */}
                    <div style={{ display: 'flex', borderRight: '1px solid #e5e7eb', flexShrink: 0 }}>
                      {['VND', '% '].map(m => (
                        <button
                          key={m}
                          onClick={() => { setDiscountMode(m.trim()); setDiscountValue(0); }}
                          style={{
                            padding: '12px 14px', border: 'none', cursor: 'pointer',
                            fontSize: '0.85rem', fontWeight: 700,
                            background: discountMode === m.trim() ? '#eff6ff' : 'white',
                            color: discountMode === m.trim() ? '#2563eb' : '#9ca3af',
                          }}
                        >{m.trim() === 'VND' ? 'VNĐ' : '%'}</button>
                      ))}
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="0"
                      value={discountValue || ''}
                      onChange={e => {
                        const v = Number(e.target.value.replace(/\D/g,'')) || 0;
                        setDiscountValue(v);
                        // recalculate and clear customNewPrice so Giá mới reflects calculation
                        setCustomNewPrice(null);
                      }}
                      style={{
                        flex: 1, border: 'none', outline: 'none',
                        padding: '12px 16px', fontSize: '16px',
                        fontWeight: 600, textAlign: 'right', background: 'white',
                      }}
                    />
                  </div>
                </div>

                {/* Giá mới — editable */}
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: 6, fontWeight: 500 }}>Giá mới</div>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={customNewPrice != null ? customNewPrice : newPrice}
                    onChange={e => setCustomNewPrice(Number(e.target.value.replace(/\D/g,'')) || 0)}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      background: '#f9fafb', borderRadius: 12, padding: '14px 16px',
                      textAlign: 'right', fontSize: '16px', fontWeight: 700,
                      color: (customNewPrice != null ? customNewPrice : newPrice) < orig ? '#2563eb' : '#111827',
                      border: '1.5px solid #2563eb', outline: 'none',
                    }}
                  />
                </div>

                {/* Lưu button */}
                <button
                  onClick={() => updateItemPrice(showPriceModal.orderId, showPriceModal.itemId, customNewPrice != null ? customNewPrice : newPrice)}
                  style={{
                    width: '100%', padding: '15px', borderRadius: 100,
                    background: '#2563eb', border: 'none', color: 'white',
                    fontSize: '1rem', fontWeight: 700, cursor: 'pointer',
                    boxShadow: '0 4px 16px rgba(37,99,235,0.35)',
                  }}
                >
                  Lưu
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Admin Menu Modal */}

      {addingToOrder && (() => {
        const closeModal = () => {
          setAddingToOrder(null);
          setAddItemSearch('');
          if (selectedTable && (!orders[selectedTable.id] || orders[selectedTable.id].length === 0)) {
            setSelectedTable(null);
          }
        };

        const activeOrder = selectedTable && orders[selectedTable.id]
          ? (orders[selectedTable.id].find(o => o.customer_name === 'Admin') || orders[selectedTable.id][0])
          : null;
        const orderItems = activeOrder?.order_items || [];
        const totalCartItems = orderItems.reduce((sum, oi) => sum + oi.quantity, 0);

        const filteredItems = menuItems.filter(item => {
          const matchesCat = activeMenuCategory === 'all' || item.category_id === activeMenuCategory;
          const matchesSearch = item.name.toLowerCase().includes(addItemSearch.toLowerCase());
          return matchesCat && matchesSearch;
        });

        // Group filtered items by category
        const grouped = categories
          .map(cat => ({
            ...cat,
            items: filteredItems.filter(item => item.category_id === cat.id)
          }))
          .filter(cat => cat.items.length > 0);

        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 1050,
              background: 'white',
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden'
            }}
          >
            {/* Top bar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #f3f4f6' }}>
              <span style={{ fontWeight: 700, fontSize: '1rem', color: '#111827' }}>Thêm món — Bàn {selectedTable?.table_number}</span>
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}
                onClick={closeModal}
              >
                <X size={22} />
              </button>
            </div>

            {/* Search */}
            <div style={{ position: 'relative', padding: '8px 16px', borderBottom: '1px solid #f3f4f6' }}>
              <Search size={16} style={{ position: 'absolute', left: 28, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
              <input
                placeholder="Tìm món ăn..."
                value={addItemSearch}
                onChange={e => setAddItemSearch(e.target.value)}
                style={{
                  width: '100%', padding: '9px 32px 9px 38px',
                  borderRadius: 24, border: '1px solid #e5e7eb',
                  background: '#f9fafb', fontSize: '0.9rem', outline: 'none'
                }}
              />
              {addItemSearch && (
                <button
                  onClick={() => setAddItemSearch('')}
                  style={{ position: 'absolute', right: 28, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Category pills */}
            <div style={{ display: 'flex', gap: 8, padding: '10px 16px', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid #f3f4f6' }}>
              {[{ id: 'all', name: 'Tất cả' }, ...categories].map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setActiveMenuCategory(cat.id)}
                  style={{
                    flexShrink: 0,
                    padding: '7px 18px',
                    borderRadius: 24,
                    border: '1.5px solid',
                    borderColor: activeMenuCategory === cat.id ? '#2563eb' : '#e5e7eb',
                    background: activeMenuCategory === cat.id ? '#2563eb' : 'white',
                    color: activeMenuCategory === cat.id ? 'white' : '#374151',
                    fontWeight: activeMenuCategory === cat.id ? 700 : 500,
                    fontSize: '0.88rem',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cat.name}
                </button>
              ))}
            </div>

            {/* Item list */}
            <div style={{ flex: 1, overflowY: 'auto', background: '#fafafa', paddingBottom: totalCartItems > 0 ? 90 : 16 }}>
              {grouped.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Không tìm thấy món ăn nào</div>
              )}
              {grouped.map(cat => (
                <div key={cat.id}>
                  <div style={{ padding: '12px 16px 4px', fontSize: '0.9rem', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {cat.name} ({cat.items.length})
                  </div>
                  {cat.items.map(item => {
                    const itemsInOrder = orderItems.filter(oi => oi.menu_item_id === item.id);
                    const qty = itemsInOrder.reduce((s, oi) => s + oi.quantity, 0);

                    return (
                      <div
                        key={item.id}
                        onClick={() => addItemToOrder('admin', item)}
                        style={{
                          display: 'flex', alignItems: 'center',
                          padding: '12px 16px',
                          background: 'white',
                          borderBottom: '1px solid #f3f4f6',
                          cursor: 'pointer'
                        }}
                      >
                        {/* Thumbnail */}
                        <div style={{
                          width: 64, height: 64, borderRadius: 12,
                          overflow: 'hidden', flexShrink: 0,
                          background: '#eff6ff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          position: 'relative'
                        }}>
                          {item.image_url
                            ? <Image src={item.image_url} alt={item.name} fill sizes="64px" style={{ objectFit: 'cover' }} />
                            : <ChefHat size={24} style={{ color: '#93c5fd' }} />}
                        </div>

                        {/* Info */}
                        <div style={{ flex: 1, marginLeft: 12, paddingRight: 8 }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#111827', marginBottom: 4, lineHeight: 1.3 }}>{item.name}</div>
                          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#6b7280' }}>{formatPrice(item.price)}</div>
                        </div>

                        {/* Qty controls */}
                        {qty > 0 ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} onClick={e => e.stopPropagation()}>
                            <button
                              onClick={() => decreaseItemFromMenu(item.id)}
                              style={{
                                width: 30, height: 30, borderRadius: '50%',
                                border: '1.5px solid #d1d5db', background: 'white',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                cursor: 'pointer', color: '#374151'
                              }}
                            >
                              <Minus size={15} strokeWidth={2.5} />
                            </button>
                            <span style={{ width: 20, textAlign: 'center', fontWeight: 700, fontSize: '1rem', color: '#111827' }}>{qty}</span>
                            <button
                              onClick={() => addItemToOrder('admin', item)}
                              style={{
                                width: 30, height: 30, borderRadius: '50%',
                                border: '1.5px solid #d1d5db', background: 'white',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                cursor: 'pointer', color: '#374151'
                              }}
                            >
                              <Plus size={15} strokeWidth={2.5} />
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); addItemToOrder('admin', item); }}
                            style={{
                              width: 32, height: 32, borderRadius: '50%',
                              background: 'white', border: '1.5px solid #d1d5db',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              cursor: 'pointer', flexShrink: 0, color: '#374151'
                            }}
                          >
                            <Plus size={18} strokeWidth={2} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Floating cart bar */}
            {activeOrder && totalCartItems > 0 && (
              <div
                style={{
                  position: 'absolute', bottom: 0, left: 0, right: 0,
                  padding: '10px 16px 14px',
                  background: 'white',
                  borderTop: '1px solid #f3f4f6'
                }}
              >
                <div style={{ display: 'flex', gap: 10 }}>
                  {/* Chọn lại */}
                  <button
                    onClick={() => { closeModal(); }}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 100,
                      border: '1.5px solid #e5e7eb', background: 'white',
                      fontSize: '0.9rem', fontWeight: 600, color: '#374151',
                      cursor: 'pointer'
                    }}
                  >
                    Chọn lại
                  </button>
                  {/* Xem đơn */}
                  <button
                    onClick={closeModal}
                    style={{
                      flex: 1, padding: '10px 16px', borderRadius: 100,
                      border: 'none', background: '#2563eb',
                      color: 'white', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      boxShadow: '0 4px 14px rgba(37,99,235,0.35)'
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Xem đơn</span>
                    <span style={{
                      background: 'white', color: '#2563eb',
                      borderRadius: 20, padding: '2px 8px',
                      fontSize: '0.82rem', fontWeight: 700
                    }}>{totalCartItems}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {editingPrice ? (
                      <>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          autoFocus
                          value={customPrice ?? optionModalItem.price}
                          onChange={e => setCustomPrice(Number(e.target.value.replace(/\D/g,'')))}
                          style={{
                            width: 100, padding: '5px 10px', borderRadius: 8,
                            border: '1.5px solid #2563eb', fontSize: '16px',
                            fontWeight: 600, outline: 'none'
                          }}
                        />
                        <button
                          onClick={() => setEditingPrice(false)}
                          style={{ background: '#2563eb', border: 'none', borderRadius: 6, color: 'white', padding: '3px 8px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}
                        >✓</button>
                      </>
                    ) : (
                      <>
                        <span className="price">{formatPrice(customPrice ?? optionModalItem.price)}</span>
                        <button
                          onClick={() => { setCustomPrice(customPrice ?? optionModalItem.price); setEditingPrice(true); }}
                          title="Sửa giá"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2, display: 'flex', alignItems: 'center' }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
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
                Thêm vào đơn • {formatPrice((customPrice ?? optionModalItem.price) * optionQuantity)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Takeaway Orders Modal ── */}
      {showTakeawayOrders && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 3500, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
          onClick={() => setShowTakeawayOrders(false)}>
          <div style={{ background: 'white', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: '1.4rem' }}>🛵</span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: '1rem', color: '#1d4ed8' }}>Đơn Mang Về</div>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>{takeawayOrders.length} đơn đang chờ</div>
                </div>
              </div>
              <button onClick={() => setShowTakeawayOrders(false)}
                style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '1rem' }}>
                ✕
              </button>
            </div>
            {/* Orders list */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px 24px' }}>
              {takeawayOrders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#9ca3af' }}>
                  <div style={{ fontSize: '2rem', marginBottom: 8 }}>✅</div>
                  <div>Không có đơn nào đang chờ</div>
                </div>
              ) : takeawayOrders.map(order => (
                <div key={order.orderIds?.join(',') || order.customer_phone} style={{ background: '#f8fafc', border: '1px solid #e0e7ff', borderRadius: 14, padding: '14px', marginBottom: 12 }}>
                  {/* Customer info */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, color: '#111827', fontSize: '0.95rem' }}>{order.customer_name}</div>
                      <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>📞 {order.customer_phone}</div>
                      {order.delivery_address && (
                        <div style={{ fontSize: '0.82rem', color: '#1d4ed8', marginTop: 4, background: '#eff6ff', borderRadius: 6, padding: '4px 8px', display: 'inline-block' }}>
                          📍 {order.delivery_address}
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                      {formatTime(order.created_at)}
                      {order.orderIds?.length > 1 && <span style={{ marginLeft: 6, background: '#e0e7ff', color: '#3730a3', borderRadius: 4, padding: '1px 5px', fontSize: '0.7rem', fontWeight: 600 }}>{order.orderIds.length} lượt đặt</span>}
                    </div>
                  </div>
                  {/* Items */}
                  <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 8, marginBottom: 10 }}>
                    {(order.order_items || []).map((item, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: '#374151', paddingBottom: 4 }}>
                        <span>{item.menu_item?.name || 'Món đã xoá'} × {item.quantity}</span>
                        <span style={{ fontWeight: 600 }}>{(item.unit_price * item.quantity).toLocaleString('vi-VN')}đ</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, paddingTop: 6, borderTop: '1px dashed #d1d5db', color: '#111827' }}>
                      <span>Tổng cộng</span>
                      <span style={{ color: '#1d4ed8' }}>{order.total_amount?.toLocaleString('vi-VN')}đ</span>
                    </div>
                  </div>
                  {/* Complete button */}
                  <button
                    onClick={() => completeKitchenOrder(order.orderIds || [order.id])}
                    style={{ width: '100%', padding: '10px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}
                  >
                    ✓ Đã hoàn thành — Đã giao đi
                  </button>
                </div>
              ))}
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
      {/* Full-screen Bill Preview Modal */}
      {showBillPreview && selectedTable && (() => {
        const tableBills = orders[selectedTable.id] || [];
        const allItems = tableBills.flatMap(b => b.order_items || []);
        const grandTotal = tableBills.reduce((s, b) => s + b.total_amount, 0);
        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 2000,
              background: 'white',
              display: 'flex', flexDirection: 'column',
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
              <button
                onClick={() => setShowBillPreview(false)}
                style={{
                  width: 36, height: 36, borderRadius: '50%',
                  border: '1.5px solid #e5e7eb', background: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: '#374151', fontSize: '1.1rem', flexShrink: 0
                }}
              >✕</button>
              <span style={{ fontSize: '1.1rem', fontWeight: 700, color: '#111827' }}>
                Xem tạm tính
              </span>
              <span style={{ width: 1, height: 18, background: '#d1d5db', flexShrink: 0 }} />
              <span style={{
                fontSize: '0.95rem', fontWeight: 700, color: '#2563eb',
                background: '#eff6ff', borderRadius: 8, padding: '3px 10px',
              }}>
                Bàn {selectedTable.table_number}
              </span>
            </div>

            {/* Items list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px' }}>
              {allItems.map((item, idx) => {
                const optionText = item.item_options?.map(o => o.choice).join(', ') || item.note || '';
                const subtotal = item.unit_price * item.quantity;
                return (
                  <div key={idx} style={{ paddingTop: 16, paddingBottom: 14, borderBottom: '1px solid #f0f0f0' }}>
                    {/* Row 1: Name · option(orange) */}
                    <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', marginBottom: 2 }}>
                      {item.menu_item?.name || 'Món đã xoá'}
                      {optionText && (
                        <span style={{ fontWeight: 400, color: '#f59e0b' }}> · {optionText}</span>
                      )}
                    </div>
                    {/* Row 2: khẩu vị gray italic */}
                    {optionText && (
                      <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginBottom: 6 }}>{optionText}</div>
                    )}
                    {/* Row 3: unit_price × qty (left) | subtotal (right) */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.95rem', color: '#374151' }}>
                        {item.unit_price.toLocaleString('vi-VN')} × {item.quantity}
                      </span>
                      <span style={{ fontSize: '0.95rem', fontWeight: 500, color: '#111827' }}>
                        {subtotal.toLocaleString('vi-VN')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Gray summary section */}
            <div style={{ background: '#f8f8f8', padding: '0 20px', borderTop: '8px solid #f0f0f0' }}>
              {/* Tổng tiền hàng */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #e5e5e5' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: '0.85rem', color: '#374151' }}>Tổng tiền hàng</span>
                  <span style={{ fontSize: '0.72rem', background: '#e5e7eb', color: '#6b7280', borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>
                    {allItems.reduce((s, i) => s + i.quantity, 0)}
                  </span>
                </div>
                <span style={{ fontSize: '0.85rem', color: '#111827', fontWeight: 500 }}>
                  {grandTotal.toLocaleString('vi-VN')}
                </span>
              </div>
              {/* Giảm giá */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #e5e5e5' }}>
                <span style={{ fontSize: '0.85rem', color: '#374151' }}>Giảm giá (0%)</span>
                <span style={{ fontSize: '0.85rem', color: '#111827' }}>0</span>
              </div>
              {/* Thu khác */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #e5e5e5' }}>
                <span style={{ fontSize: '0.85rem', color: '#374151' }}>Thu khác</span>
                <span style={{ fontSize: '0.85rem', color: '#111827' }}>0</span>
              </div>
              {/* Khách cần trả */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0' }}>
                <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#111827' }}>Khách cần trả</span>
                <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#111827' }}>
                  {grandTotal.toLocaleString('vi-VN')}
                </span>
              </div>
            </div>

            {/* Blue print button */}
            <div style={{ padding: '12px 20px 20px', background: 'white' }}>
              <button
                onClick={handlePrintInvoice}
                style={{
                  width: '100%', padding: '16px 0',
                  borderRadius: 100, border: 'none',
                  background: '#2563eb', color: 'white',
                  fontSize: '1rem', fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                In phiếu tạm tính
              </button>
            </div>
          </div>
        );
      })()}
      {/* Custom Delete Confirmation Modal */}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 3000,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'white',
              borderRadius: 20,
              padding: '28px 24px 20px',
              maxWidth: 340,
              width: '100%',
              textAlign: 'center',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            }}
          >
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🗑️</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#111827', marginBottom: 8 }}>
              Xoá món này?
            </div>
            <div style={{ fontSize: '0.9rem', color: '#6b7280', marginBottom: 24 }}>
              <span style={{ fontWeight: 600, color: '#374151' }}>{confirmDelete.itemName}</span> sẽ bị xoá khỏi bill.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  flex: 1, padding: '12px 0', borderRadius: 12,
                  border: '1.5px solid #e5e7eb', background: 'white',
                  fontSize: '0.95rem', fontWeight: 600, color: '#374151',
                  cursor: 'pointer'
                }}
              >
                Huỷ
              </button>
              <button
                onClick={() => performDeleteItem(confirmDelete.orderId, confirmDelete.itemId)}
                style={{
                  flex: 1, padding: '12px 0', borderRadius: 12,
                  border: 'none', background: '#e11d48',
                  fontSize: '0.95rem', fontWeight: 700, color: 'white',
                  cursor: 'pointer'
                }}
              >
                Xoá món
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Custom Payment Confirmation Modal ── */}
      {confirmPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setConfirmPayment(null)}>
          <div style={{ background: 'white', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', minWidth: 340, maxWidth: 420, width: '100%', overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ background: '#2563eb', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1.4rem' }}>💵</span>
              <div>
                <div style={{ color: 'white', fontWeight: 700, fontSize: '1rem' }}>Thanh toán</div>
                <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: '0.82rem' }}>Bàn B{confirmPayment.table.table_number}</div>
              </div>
            </div>
            {/* Item list */}
            <div style={{ padding: '12px 20px', maxHeight: 260, overflowY: 'auto' }}>
              {(orders[confirmPayment.table.id] || []).flatMap(o => o.order_items || []).map((item, idx) => (
                <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <div>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#111827' }}>{item.menu_item?.name || item.name}</span>
                    <span style={{ fontSize: '0.75rem', color: '#9ca3af', marginLeft: 6 }}>x{item.quantity}</span>
                  </div>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#374151' }}>{(item.unit_price * item.quantity).toLocaleString('vi-VN')}đ</span>
                </div>
              ))}
            </div>
            {/* Total */}
            <div style={{ padding: '10px 20px', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #e5e7eb' }}>
              <span style={{ fontWeight: 700, color: '#374151' }}>Tổng cộng</span>
              <span style={{ fontWeight: 800, fontSize: '1.1rem', color: '#1d4ed8' }}>{confirmPayment.totalAmount.toLocaleString('vi-VN')}đ</span>
            </div>
            {/* Buttons */}
            <div style={{ display: 'flex', gap: 10, padding: '14px 20px' }}>
              <button onClick={() => setConfirmPayment(null)}
                style={{ flex: 1, padding: '10px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: 'white', color: '#6b7280', fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem' }}>
                Hủy
              </button>
              <button
                onClick={async () => {
                  await completeTable(confirmPayment.table.id);
                  setConfirmPayment(null);
                  setSelectedTable(null);
                  setDesktopView('tables');
                  Swal.fire({
                    icon: 'success',
                    title: '✅ Thanh toán thành công!',
                    html: `<span style="font-size:1rem">Bàn <b>B${confirmPayment.table.table_number}</b> — Tổng: <b style="color:#ffffff;font-size:1.1rem">${confirmPayment.totalAmount.toLocaleString('vi-VN')}đ</b></span>`,
                    timer: 3000,
                    timerProgressBar: true,
                    showConfirmButton: false,
                    position: 'top-end',
                    toast: true,
                    background: '#16a34a',
                    color: '#ffffff',
                    iconColor: '#ffffff',
                  });
                }}
                style={{ flex: 2, padding: '10px', border: 'none', borderRadius: 8, background: '#2563eb', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}>
                ✅ Xác nhận thanh toán
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
