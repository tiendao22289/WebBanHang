'use client';
import { removeVietnameseTones } from '@/lib/utils';


import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import { getActiveAccount, buildQrUrl } from '@/lib/bankAccount';
import { sendTableSummaryPrintJob } from '@/lib/print';
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
  const [paymentModal, setPaymentModal] = useState(null); // { table, total }
  const [bankAccounts, setBankAccounts] = useState([]);
  const [qrAccount, setQrAccount] = useState(null); // selected account for QR
  const [showTransfer, setShowTransfer] = useState(false); // QR sub-screen in payment modal
  const [cancelConfirm, setCancelConfirm] = useState(null); // tableId to cancel
  const [showTableHistory, setShowTableHistory] = useState(null); // table object
  const [tableHistoryData, setTableHistoryData] = useState([]);
  const [tableHistoryLoading, setTableHistoryLoading] = useState(false);
  const [transactionCode, setTransactionCode] = useState(null);
  const [paymentCountdown, setPaymentCountdown] = useState(0);

  const invoiceRef = useRef(null);
  const isFirstLoad = useRef(true);
  const [isMobile, setIsMobile] = useState(true);
  const [printToast, setPrintToast] = useState(''); // '' | 'sending' | 'ok' | 'err'

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

  // ─── Gửi lệnh in tới PrintAgent — gộp orders của bàn → 1 phiếu → máy mặc định ───
  const handlePrintInvoice = async () => {
    if (!selectedTable) return;
    const tableOrders = (orders[selectedTable.merged_with || selectedTable.id] || [])
      .filter(o => ['pending', 'preparing', 'completed'].includes(o.status));
    if (tableOrders.length === 0) { alert('Không có đơn hàng để in!'); return; }

    const total = tableOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
    const { isConfirmed } = await Swal.fire({
      title: '🖨️ In hoá đơn?',
      html: `In hoá đơn bàn <b>${selectedTable.table_number}</b>?<br/><span style="color:#c53b3b;font-weight:700;font-size:1.05rem">Tổng: ${new Intl.NumberFormat('vi-VN').format(total)}đ</span>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#2563eb',
      cancelButtonColor: '#6b7280',
      confirmButtonText: '🖨️ In ngay',
      cancelButtonText: 'Huỷ',
      reverseButtons: true,
    });
    if (!isConfirmed) return;

    setPrintToast('sending');
    const orderIds = tableOrders.map(o => o.id);
    const { success, error } = await sendTableSummaryPrintJob(supabase, orderIds);
    setPrintToast(success ? 'ok' : 'err');
    if (!success) alert(error || 'Lỗi khi gửi lệnh in!');
    setTimeout(() => setPrintToast(''), 3500);
  };

  // ─── In phiếu tạm tính — cùng logic (gộp + máy mặc định) ──────────────────
  const handlePrintTempBill = async () => {
    if (!selectedTable) return;
    const tableOrders = (orders[selectedTable.merged_with || selectedTable.id] || [])
      .filter(o => ['pending', 'preparing', 'completed'].includes(o.status));
    if (tableOrders.length === 0) { alert('Không có đơn hàng để in!'); return; }

    const total = tableOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
    const { isConfirmed } = await Swal.fire({
      title: '🧾 In tạm tính?',
      html: `In phiếu tạm tính bàn <b>${selectedTable.table_number}</b>?<br/><span style="color:#c53b3b;font-weight:700;font-size:1.05rem">Tổng tạm: ${new Intl.NumberFormat('vi-VN').format(total)}đ</span>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#2563eb',
      cancelButtonColor: '#6b7280',
      confirmButtonText: '🖨️ In ngay',
      cancelButtonText: 'Huỷ',
      reverseButtons: true,
    });
    if (!isConfirmed) return;

    setPrintToast('sending');
    const orderIds = tableOrders.map(o => o.id);
    const { success, error } = await sendTableSummaryPrintJob(supabase, orderIds);
    setPrintToast(success ? 'ok' : 'err');
    if (!success) alert(error || 'Lỗi khi gửi lệnh in!');
    setTimeout(() => setPrintToast(''), 3500);
  };

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
              ),
              print_jobs (id, status)
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
    const finalCats = catsData || [];
    if (menuData?.some(i => !i.category_id)) {
      finalCats.push({ id: null, name: 'Chưa phân loại' });
    }
    setCategories(finalCats);
    setLoading(false);
  }, []);

  // Payment Countdown Timer
  useEffect(() => {
    if (showTransfer && transactionCode && paymentCountdown > 0) {
      const timer = setInterval(() => {
        setPaymentCountdown(prev => prev - 1);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [showTransfer, transactionCode, paymentCountdown]);

  // Realtime subscription for auto-confirm payment
  useEffect(() => {
    if (showTransfer && transactionCode) {
      const channel = supabase
        .channel(`payment_tx_${transactionCode}`)
        .on('postgres_changes', { 
          event: 'UPDATE', 
          schema: 'public', 
          table: 'payment_transactions', 
          filter: `transaction_code=eq.${transactionCode}` 
        }, (payload) => {
           if (payload.new && payload.new.status === 'completed') {
             // Success
             Swal.fire({
                title: 'Thành công',
                text: 'Hệ thống đã nhận được thanh toán!',
                icon: 'success',
                timer: 2000,
                showConfirmButton: false,
                position: 'top-end',
                toast: true
             });
             setPaymentModal(null);
             setQrAccount(null);
             setShowTransfer(false);
             setTransactionCode(null);
             setPaymentCountdown(0);
             setSelectedTable(null);
             setConfirmPayment(null);
             setDesktopView('tables');
             fetchTables();
           }
        })
        .subscribe();
      
      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [showTransfer, transactionCode, fetchTables]);

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
        // Reset tables — xóa cả merged_with để bàn không còn bị đánh dấu màu cam
        await supabase
          .from('tables')
          .update({ status: 'available', occupied_at: null, merged_with: null })
          .in('id', expiredIds);
        // Cũng release các satellite tables tham chiếu đến host đã expire
        await supabase
          .from('tables')
          .update({ status: 'available', occupied_at: null, merged_with: null })
          .in('merged_with', expiredIds);
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

  async function completeTable(tableObj, paymentMethod = 'cash') {
    // Support both tableId (legacy) and tableObj
    const table = typeof tableObj === 'object' ? tableObj : { id: tableObj, merged_with: null };
    const hostId = table.merged_with || table.id;

    await supabase
      .from('orders')
      .update({ status: 'paid', payment_method: paymentMethod })
      .eq('table_id', hostId)
      .in('status', ['pending', 'preparing', 'completed']);

    // Reset toàn bộ nhóm bàn gộp
    await supabase
      .from('tables')
      .update({ status: 'available', occupied_at: null, merged_with: null })
      .or(`id.eq.${hostId},merged_with.eq.${hostId}`);

    setSelectedTable(null);
    fetchTables();
  }

  // ── Smart bank account rotation (strict: no buffer) ──
  async function openPaymentModal(table, total) {
    const { account, overLimit } = await getActiveAccount();
    const finalAcc = account ? { ...account, overLimit } : null;
    setQrAccount(finalAcc);
    
    // Auto-generate transaction code for mobile workflow
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    
    const tableBills = orders[table.merged_with || table.id] || [];
    const orderIdsStr = tableBills.map(o => o.id).join(',');
    
    if (orderIdsStr) {
      await supabase.from('payment_transactions').insert({
        transaction_code: code,
        order_ids: orderIdsStr,
        account_id: finalAcc?.id || null,
        total_amount: total
      });
    }
    setTransactionCode(code);
    setShowTransfer(true);
    setPaymentCountdown(300);

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

  // Sync khuyến mãi trên TOÀN BỘ đơn của bàn (không chỉ 1 order)
  async function syncTablePromotions(tableId) {
    try {
      const { data: settings } = await supabase.from('settings').select('key, value').in('key', ['promotion_enabled', 'promotion_threshold']);
      const promoConfig = { enabled: false, threshold: 8 };
      if (settings) {
        const map = Object.fromEntries(settings.map(r => [r.key, r.value]));
        promoConfig.enabled = map.promotion_enabled === 'true';
        promoConfig.threshold = parseInt(map.promotion_threshold) || 8;
      }
      if (!promoConfig.enabled) return;

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

      // Lấy tất cả orders + items của bàn hôm nay
      const { data: tableOrders } = await supabase
        .from('orders')
        .select(`id, order_items( id, quantity, is_gift, created_at, menu_items( id, counts_for_promotion ) )`)
        .eq('table_id', tableId)
        .gte('created_at', startOfDay)
        .in('status', ['pending', 'preparing', 'completed']);

      if (!tableOrders) return;

      let qualifyingQty = 0;
      let allGiftItems = [];

      for (const ord of tableOrders) {
        for (const it of (ord.order_items || [])) {
          if (it.is_gift) {
            allGiftItems.push(it);
          } else if (it.menu_items?.counts_for_promotion) {
            qualifyingQty += it.quantity;
          }
        }
      }

      const maxGifts = Math.floor(qualifyingQty / promoConfig.threshold);
      let totalGifts = allGiftItems.reduce((acc, g) => acc + g.quantity, 0);
      let excessGifts = totalGifts - maxGifts;

      if (excessGifts > 0) {
        // Xoá gift dư thừa (ưu tiên xoá mới nhất)
        allGiftItems.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        for (const gift of allGiftItems) {
          if (excessGifts <= 0) break;
          if (gift.quantity <= excessGifts) {
            await supabase.from('order_items').delete().eq('id', gift.id);
            excessGifts -= gift.quantity;
          } else {
            await supabase.from('order_items').update({ quantity: gift.quantity - excessGifts }).eq('id', gift.id);
            excessGifts = 0;
          }
        }
        // Recalc totals cho từng order có gift bị xoá
        for (const ord of tableOrders) {
          const { data: remaining } = await supabase.from('order_items').select('unit_price, quantity').eq('order_id', ord.id);
          const newTotal = (remaining || []).reduce((s, i) => s + i.unit_price * i.quantity, 0);
          await supabase.from('orders').update({ total_amount: newTotal }).eq('id', ord.id);
        }
      }

      // Cập nhật promo_gift_unlocked trên bàn → Realtime thông báo cho khách
      await supabase.from('tables').update({ promo_gift_unlocked: maxGifts }).eq('id', tableId);

    } catch (err) {
      console.error('Error syncing table promotions:', err);
    }
  }

  // Helper: lấy tableId từ orderId rồi gọi syncTablePromotions
  async function syncOrderPromotions(orderId) {
    try {
      const { data: orderRow } = await supabase.from('orders').select('table_id').eq('id', orderId).maybeSingle();
      if (orderRow?.table_id) await syncTablePromotions(orderRow.table_id);
    } catch (err) {
      console.error('syncOrderPromotions error:', err);
    }
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

    await syncOrderPromotions(orderId);
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

    await syncOrderPromotions(orderId);
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

  async function updateOrderItemOptions(orderId, itemId, newOptions, note, newPrice = null, newQty = null) {
    const updatePayload = { item_options: newOptions, note: note || '' };
    // Cập nhật giá nếu có
    if (newPrice != null && newPrice > 0) {
      updatePayload.unit_price = newPrice;
    }
    // Cập nhật số lượng nếu có thay đổi
    if (newQty != null && newQty > 0) {
      updatePayload.quantity = newQty;
    }
    await supabase.from('order_items').update(updatePayload).eq('id', itemId);

    // Tính lại tổng tiền — query sau khi update để lấy giá trị mới nhất
    const { data: allItems } = await supabase
      .from('order_items').select('id, unit_price, quantity').eq('order_id', orderId);

    // Nếu DB chưa reflect kịp, tự override item vừa update trong mảng
    const finalItems = (allItems || []).map(i => {
      if (i.id === itemId) {
        return {
          unit_price: newPrice != null && newPrice > 0 ? newPrice : i.unit_price,
          quantity: newQty != null && newQty > 0 ? newQty : i.quantity,
        };
      }
      return i;
    });
    const newTotal = finalItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);

    setEditingOrderItem(null);
    setOptionModalItem(null);
    setSelectedOptions({});
    setOptionNote('');
    fetchTables();
  }

  const decreaseItemFromMenu = async (menuItemId) => {
    const activeOrder = selectedTable && orders[selectedTable.merged_with || selectedTable.id]
      ? (orders[selectedTable.merged_with || selectedTable.id].find(o => o.customer_name === 'Admin') || orders[selectedTable.merged_with || selectedTable.id][0])
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
      let initialPrice = null;
      menuItem.options.forEach(opt => {
        if (opt.choices && opt.choices.length > 0) {
          initialOptions[opt.name] = opt.choices[0];
          if (initialPrice === null && opt.prices?.[0] != null && Number(opt.prices[0]) > 0) {
            initialPrice = Number(opt.prices[0]);
          }
        }
      });
      setSelectedOptions(initialOptions);
      setOptionQuantity(1);
      setOptionNote('');
      setEditingPrice(false);
      setCustomPrice(initialPrice);
      return;
    }

    let targetOrderId = orderId;

    if (orderId === 'admin') {
      const { data: adminOrder } = await supabase
        .from('orders')
        .select('id')
        .eq('table_id', selectedTable.merged_with || selectedTable.id)
        .eq('customer_name', 'Admin')
        .in('status', ['pending', 'preparing', 'completed'])
        .maybeSingle();

      if (adminOrder) {
        targetOrderId = adminOrder.id;
      } else {
        const { data: newOrder, error } = await supabase
          .from('orders')
          .insert({
            table_id: selectedTable.merged_with || selectedTable.id,
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

    // ── Kiểm tra unlock khuyến mãi và thông báo cho khách ──
    try {
      const { data: settingsRows } = await supabase.from('settings').select('key, value').in('key', ['promotion_enabled', 'promotion_threshold']);
      const cfg = { enabled: false, threshold: 8 };
      if (settingsRows) {
        const m = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
        cfg.enabled = m.promotion_enabled === 'true';
        cfg.threshold = parseInt(m.promotion_threshold) || 8;
      }
      if (cfg.enabled) {
        // Lấy order thuộc bàn này
        const { data: orderRow } = await supabase.from('orders').select('table_id').eq('id', targetOrderId).maybeSingle();
        if (orderRow?.table_id) {
          // Lấy toàn bộ order_items của bàn hôm nay
          const now = new Date();
          const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
          const { data: tableOrders } = await supabase
            .from('orders')
            .select(`id, order_items( id, quantity, is_gift, menu_items(counts_for_promotion) )`)
            .eq('table_id', orderRow.table_id)
            .gte('created_at', startOfDay)
            .in('status', ['pending', 'preparing', 'completed']);

          let totalQualifying = 0;
          let totalGifts = 0;
          for (const ord of (tableOrders || [])) {
            for (const it of (ord.order_items || [])) {
              if (it.is_gift) { totalGifts += it.quantity; }
              else if (it.menu_items?.counts_for_promotion) { totalQualifying += it.quantity; }
            }
          }
          const maxGifts = Math.floor(totalQualifying / cfg.threshold);
          const newUnlockedCount = maxGifts; // tổng gift đc hưởng

          // Ghi vào tables.promo_gift_unlocked → Realtime sẽ notify khách
          await supabase.from('tables').update({ promo_gift_unlocked: newUnlockedCount }).eq('id', orderRow.table_id);
        }
      }
    } catch (e) { console.error('promo unlock check error:', e); }

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
    // Lưu customPrice trước khi clear state
    const finalPrice = customPrice;
    setEditingPrice(false);
    setCustomPrice(null);

    if (editingOrderItem) {
      // UPDATE existing order item's options — cập nhật cả giá và số lượng
      updateOrderItemOptions(editingOrderItem.orderId, editingOrderItem.itemId, optionsData, optionNote, finalPrice, optionQuantity);
    } else {
      addItemToOrder('admin', itemWithPrice, optionsData, optionQuantity, optionNote);
    }
  }

  async function handleMergeTable() {
    if (!selectedTable) return;
    const hostId = selectedTable.merged_with || selectedTable.id;

    const otherTables = tables.filter(t =>
      t.id !== selectedTable.id && t.table_type !== 'takeaway'
    );

    if (otherTables.length === 0) {
      Swal.fire('Thông báo', 'Không có bàn nào khác để gộp!', 'info');
      return;
    }

    const checkboxHtml = `
      <div style="text-align:left;margin-top:4px;">
        <p style="font-size:0.82rem;color:#6b7280;margin:0 0 10px">
          Tích chọn các bàn muốn gộp chung với <b style="color:#9333ea">Bàn ${selectedTable.table_number}</b>:
        </p>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-height:260px;overflow-y:auto;padding:2px;">
          ${otherTables.map(t => {
      const occupied = t.status === 'occupied';
      const merged = !!t.merged_with;
      const border = merged ? '#a78bfa' : occupied ? '#93c5fd' : '#e5e7eb';
      const bg = merged ? '#f5f3ff' : occupied ? '#eff6ff' : '#fff';
      const color = merged ? '#7c3aed' : occupied ? '#1d4ed8' : '#374151';
      const sub = merged ? '🔗 Đang gộp' : occupied ? 'Có khách' : 'Trống';
      return `
              <label for="mcb-${t.id}" style="
                display:flex;flex-direction:column;align-items:center;justify-content:center;
                gap:4px;padding:10px 6px;border-radius:10px;cursor:pointer;
                border:2px solid ${border};background:${bg};
                transition:all 0.15s;position:relative;
              ">
                <input type="checkbox" id="mcb-${t.id}" value="${t.id}"
                  style="position:absolute;top:6px;right:6px;width:16px;height:16px;accent-color:#9333ea;cursor:pointer;"/>
                <span style="font-size:1.1rem;">🪑</span>
                <span style="font-weight:700;font-size:0.92rem;color:${color}">B${t.table_number}</span>
                <span style="font-size:0.62rem;color:#9ca3af;">${sub}</span>
              </label>
            `;
    }).join('')}
        </div>
      </div>`;

    const { value: selectedIds } = await Swal.fire({
      title: '🔗 Gộp bàn',
      html: checkboxHtml,
      showCancelButton: true,
      confirmButtonColor: '#9333ea',
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'Gộp chung',
      cancelButtonText: 'Huỷ',
      reverseButtons: true,
      width: 420,
      preConfirm: () => {
        const checked = [...document.querySelectorAll('[id^="mcb-"]:checked')].map(cb => cb.value);
        if (checked.length === 0) {
          Swal.showValidationMessage('Vui lòng chọn ít nhất 1 bàn!');
          return false;
        }
        return checked;
      }
    });

    if (!selectedIds || selectedIds.length === 0) return;

    for (const sid of selectedIds) {
      const targetTable = tables.find(t => t.id === sid);
      if (!targetTable) continue;
      const targetHostId = targetTable.merged_with || targetTable.id;
      if (targetHostId !== hostId) {
        const targetOrders = orders[targetHostId] || [];
        if (targetOrders.length > 0) {
          await supabase.from('orders')
            .update({ table_id: hostId })
            .in('id', targetOrders.map(o => o.id));
        }
      }
      await supabase.from('tables')
        .update({ status: 'occupied', merged_with: hostId, occupied_at: new Date().toISOString() })
        .eq('id', sid);
    }

    await supabase.from('tables')
      .update({ status: 'occupied', occupied_at: new Date().toISOString() })
      .eq('id', hostId);

    fetchTables();
    setSelectedTable(null);

    const names = selectedIds.map(sid => {
      const t = tables.find(t => t.id === sid);
      return `B${t?.table_number}`;
    }).join(', ');
    Swal.fire({
      title: '🔗 Đã gộp bàn!',
      text: `Bàn ${selectedTable.table_number} đã gộp chung với: ${names}`,
      icon: 'success', toast: true, position: 'top-end',
      showConfirmButton: false, timer: 3000
    });
  }

  async function handleUnmergeTable() {
    if (!selectedTable || !selectedTable.merged_with) return;
    await supabase.from('tables')
      .update({ status: 'available', merged_with: null, occupied_at: null })
      .eq('id', selectedTable.id);
    fetchTables();
    setSelectedTable(null);
    Swal.fire({
      title: 'Đã tách bàn!',
      text: `Bàn ${selectedTable.table_number} đã tách ra độc lập.`,
      icon: 'success', toast: true, position: 'top-end',
      showConfirmButton: false, timer: 2000
    });
  }

  async function mergeBills() {
    if (!selectedTable) return;
    const tableBills = orders[selectedTable.merged_with || selectedTable.id] || [];
    if (tableBills.length <= 1) {
      Swal.fire('Lỗi', 'Không có đủ bill để gộp!', 'error');
      return;
    }

    const { isConfirmed } = await Swal.fire({
      title: 'Gộp bill?',
      html: `Bạn có chắc muốn gộp <b>${tableBills.length} bill</b> của bàn <b>${selectedTable.table_number}</b> thành 1 bill duy nhất?`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#7c3aed',
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'Gộp ngay',
      cancelButtonText: 'Huỷ',
      reverseButtons: true
    });

    if (!isConfirmed) return;

    // Use the oldest bill as the main one
    const sortedBills = [...tableBills].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const mainBill = sortedBills[0];
    const allBillIds = sortedBills.map(b => b.id);
    const otherIds = allBillIds.filter(id => id !== mainBill.id);

    // Fetch all items from all bills
    const { data: allItems, error: fetchErr } = await supabase
      .from('order_items')
      .select('*')
      .in('order_id', allBillIds);

    if (fetchErr) {
      Swal.fire('Lỗi', 'Lỗi khi lấy dữ liệu món ăn: ' + fetchErr.message, 'error');
      return;
    }

    // Group items
    const groupedMap = {};
    allItems.forEach(item => {
      // Create a unique key based on menu_item_id, options, unit_price and note
      const optsString = item.item_options ? JSON.stringify(item.item_options) : '[]';
      const key = `${item.menu_item_id}_${item.unit_price}_${optsString}_${item.note || ''}`;

      if (!groupedMap[key]) {
        groupedMap[key] = {
          order_id: mainBill.id,
          menu_item_id: item.menu_item_id,
          quantity: 0,
          unit_price: item.unit_price,
          item_options: item.item_options,
          note: item.note,
          is_gift: item.is_gift
        };
      }
      groupedMap[key].quantity += item.quantity;
    });

    const newItems = Object.values(groupedMap);

    // Calculate new total
    const newTotal = newItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);

    // Delete all existing items from all these bills
    await supabase.from('order_items').delete().in('order_id', allBillIds);

    // Insert grouped items into main bill
    if (newItems.length > 0) {
      await supabase.from('order_items').insert(newItems);
    }

    // Thay vì xóa, đánh dấu các bill phụ là 'merged' để giữ lịch sử cho khách
    // và ghi nhận merged_into để biết chúng đã được gộp vào bill nào
    if (otherIds.length > 0) {
      await supabase.from('orders')
        .update({ status: 'merged', merged_into: mainBill.id })
        .in('id', otherIds);
    }

    // Update main bill total
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', mainBill.id);

    fetchTables();
    Swal.fire({
      title: 'Thành công',
      text: 'Đã gộp đơn và dồn các món giống nhau!',
      icon: 'success',
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
      timer: 2000
    });
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  function getItemDisplayPrice(item) {
    if (item.price > 0) return formatPrice(item.price);
    let minP = null;
    if (item.options && Array.isArray(item.options)) {
      for (const opt of item.options) {
        if (opt.choices && opt.choices.length > 0 && opt.prices) {
          const validPrices = opt.prices.map(p => p != null && String(p).trim() !== '' ? Number(p) : NaN).filter(p => !isNaN(p) && p >= 0);
          if (validPrices.length > 0) {
            const currentMin = Math.min(...validPrices);
            if (minP === null || currentMin < minP) minP = currentMin;
          }
        }
      }
    }
    return minP !== null ? `Từ ${formatPrice(minP)}` : formatPrice(0);
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
    return orders[selectedTable.merged_with || selectedTable.id] || [];
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

        // ── Bảng màu nhóm bàn gộp ──
        const GROUP_PALETTES = [
          { bg: '#fff7ed', border: '#fb923c', text: '#c2410c', sub: '#ea580c', badge: '#ea580c' },
          { bg: '#f0fdf4', border: '#4ade80', text: '#15803d', sub: '#16a34a', badge: '#16a34a' },
          { bg: '#fef3c7', border: '#fbbf24', text: '#b45309', sub: '#d97706', badge: '#d97706' },
          { bg: '#fce7f3', border: '#f472b6', text: '#be185d', sub: '#db2777', badge: '#db2777' },
          { bg: '#ecfdf5', border: '#34d399', text: '#065f46', sub: '#059669', badge: '#059669' },
          { bg: '#fff1f2', border: '#fb7185', text: '#be123c', sub: '#e11d48', badge: '#e11d48' },
          { bg: '#f0f9ff', border: '#38bdf8', text: '#0369a1', sub: '#0284c7', badge: '#0284c7' },
        ];
        const mergedHostIds = [...new Set(filteredTables.filter(t => t.merged_with).map(t => t.merged_with))];
        const groupColorMap = {};
        mergedHostIds.forEach((hid, idx) => { groupColorMap[hid] = GROUP_PALETTES[idx % GROUP_PALETTES.length]; });

        const tableCard = (table, compact = false) => {
          const tableBills = orders[table.merged_with || table.id] || [];
          const isOccupied = table.status === 'occupied';
          const isMergedSatellite = !!table.merged_with;
          const isHost = !isMergedSatellite && !!groupColorMap[table.id];
          const hostIdCard = table.merged_with || table.id;
          const groupColor = groupColorMap[hostIdCard] || null;
          const totalAmount = tableBills.reduce((s, o) => s + (o.total_amount || 0), 0);
          const guestCount = tableBills.length;
          const hasPrintError = tableBills.some(o => o.print_jobs && o.print_jobs.some(pj => pj.status === 'failed'));
          let timeElapsed = '';
          if (isOccupied && table.occupied_at) {
            const diffMs = Date.now() - new Date(table.occupied_at).getTime();
            const h = Math.floor(diffMs / 3600000);
            const m = Math.floor((diffMs % 3600000) / 60000);
            timeElapsed = h > 0 ? `${h}g ${m}p` : `${m}p`;
          }
          const hostTableCard = isMergedSatellite ? tables.find(t => t.id === table.merged_with) : null;

          const openHistory = async (e) => {
            e.stopPropagation();
            setShowTableHistory(table);
            setTableHistoryLoading(true);
            setTableHistoryData([]);
            const since = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
            const hId = table.merged_with || table.id;
            const { data } = await supabase
              .from('orders')
              .select('*, order_items(*, menu_item:menu_items(name))')
              .eq('table_id', hId)
              .in('status', ['paid', 'cancelled'])
              .gte('created_at', since)
              .order('created_at', { ascending: false });
            setTableHistoryData(data || []);
            setTableHistoryLoading(false);
          };

          return (
            <div
              key={table.id}
              onClick={() => { setSelectedTable(table); if (!isOccupied) setAddingToOrder('admin'); }}
              style={{
                background: groupColor ? groupColor.bg : isOccupied ? '#dbeafe' : 'white',
                border: `2px solid ${groupColor ? groupColor.border : isOccupied ? '#93c5fd' : '#e5e7eb'}`,
                borderRadius: compact ? 12 : 16,
                padding: compact ? '12px 12px 10px' : '14px 14px 12px',
                cursor: 'pointer',
                minHeight: compact ? 80 : 90,
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: groupColor ? `0 2px 10px ${groupColor.border}40` : isOccupied ? '0 2px 8px rgba(37,99,235,0.10)' : '0 1px 4px rgba(0,0,0,0.06)',
                position: 'relative', transition: 'transform 0.1s, box-shadow 0.1s',
              }}
            >
              {isMergedSatellite && groupColor && (
                <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: groupColor.badge, color: 'white', borderRadius: 100, padding: '2px 8px', fontSize: '0.6rem', fontWeight: 700, whiteSpace: 'nowrap', zIndex: 10 }}>
                  🔗 B{hostTableCard?.table_number}
                </div>
              )}
              {isHost && groupColor && (
                <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: groupColor.badge, color: 'white', borderRadius: 100, padding: '2px 8px', fontSize: '0.6rem', fontWeight: 700, whiteSpace: 'nowrap', zIndex: 10 }}>
                  👑 Host
                </div>
              )}
              {/* History button - top right */}
              <div onClick={openHistory} style={{ position: 'absolute', top: 6, right: 6, opacity: 0.55 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={groupColor ? groupColor.border : isOccupied ? '#3b82f6' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 18 }}>
                <div style={{ fontSize: compact ? '1rem' : '1.1rem', fontWeight: 800, color: groupColor ? groupColor.text : isOccupied ? '#1d4ed8' : '#1f2937' }}>
                  B{table.table_number}
                </div>
                {hasPrintError && (
                  <div style={{ background: '#fef2f2', color: '#dc2626', borderRadius: '50%', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #fecaca' }}>
                    <Printer size={12} strokeWidth={2} />
                  </div>
                )}
              </div>
              {isOccupied ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: '0.7rem', color: groupColor ? groupColor.sub : '#3b82f6', fontWeight: 500, marginBottom: 2 }}>
                    {timeElapsed} • {guestCount} khách
                  </div>
                  <div style={{ fontSize: compact ? '0.82rem' : '0.88rem', fontWeight: 700, color: groupColor ? groupColor.text : '#1d4ed8' }}>
                    {totalAmount.toLocaleString('vi-VN')}đ
                  </div>
                </div>
              ) : <div />}
              <div style={{ position: 'absolute', bottom: 6, right: 6 }}
                onClick={e => { e.stopPropagation(); setShowQR(table); }}>
                <QrCode size={12} style={{ color: groupColor ? groupColor.border : isOccupied ? '#93c5fd' : '#d1d5db' }} />
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
              {/* 3-col grid edge-to-edge */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, padding: '8px 8px 24px' }}>
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
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3"><rect x="3" y="7" width="18" height="10" rx="2" /><path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" /><line x1="12" y1="12" x2="12" y2="12" /></svg>
              <p style={{ fontSize: '0.9rem' }}>Chọn bàn để xem đơn hàng</p>
            </div>
          );
          const tableBills = orders[selectedTable.merged_with || selectedTable.id] || [];
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

              {/* Nút Gộp Bill Desktop */}
              {tableBills.length > 1 && (
                <div style={{ padding: '8px 12px', borderTop: '1px solid #e5e7eb', background: '#f8fafc', flexShrink: 0 }}>
                  <button
                    onClick={mergeBills}
                    style={{ flex: 1, width: '100%', padding: '10px', border: '1.5px dashed #8b5cf6', borderRadius: 8, background: '#f5f3ff', color: '#7c3aed', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                    🔗 Gộp tất cả {tableBills.length} bill lại thành 1
                  </button>
                </div>
              )}
              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #e5e7eb', background: 'white', flexShrink: 0 }}>
                <button style={{ flex: 1, padding: '10px', border: '1.5px solid #2563eb', borderRadius: 8, background: 'white', color: '#2563eb', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  🔔 Thông báo
                </button>
                <button onClick={handlePrintInvoice} style={{ flex: 1, padding: '10px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: 'white', color: '#374151', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  📄 In tạm tính
                </button>
                <button
                  onClick={handleMergeTable}
                  title="Chuyển tất cả bill sang bàn khác"
                  style={{ flex: 1, padding: '10px', border: '1.5px solid #d8b4fe', borderRadius: 8, background: '#fdf4ff', color: '#9333ea', fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  <Users size={16} strokeWidth={2} /> Gộp bàn
                </button>
                {/* Huỷ đơn — same as mobile, triggers cancelConfirm modal */}
                <button
                  onClick={() => { if (selectedTable) setCancelConfirm(selectedTable); }}
                  style={{ flex: 1, padding: '10px', border: '1.5px solid #fca5a5', borderRadius: 8, background: '#fff7f7', color: '#dc2626', fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  🗑️ Huỷ đơn
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
            <div style={{ background: '#0b2149', display: 'flex', alignItems: 'flex-end', gap: 15, padding: '8px 12px 0 12px', flexShrink: 0 }}>
              
              {/* Folder Tabs */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
                {[{ label: 'Phòng bàn', view: 'tables', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg> }, { label: 'Thực đơn', view: 'menu', icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg> }].map((tab) => {
                  const isActive = desktopView === tab.view;
                  // For seamless blending, use white. However, table background is f1f5f9. We use a dynamic colour or just white.
                  const activeBg = tab.view === 'menu' ? 'white' : '#f1f5f9';
                  
                  return (
                    <button key={tab.label}
                      onClick={() => setDesktopView(tab.view)}
                      style={{
                        background: isActive ? activeBg : '#0284c7',
                        color: isActive ? '#0f172a' : 'white',
                        border: 'none',
                        padding: isActive ? '10px 20px 12px 20px' : '9px 20px 10px 20px',
                        borderRadius: '16px 16px 0 0',
                        cursor: 'pointer',
                        fontSize: '0.92rem',
                        fontWeight: isActive ? 600 : 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        boxShadow: isActive ? '0 -2px 10px rgba(0,0,0,0.05)' : 'none',
                        position: 'relative',
                        zIndex: isActive ? 10 : 1,
                        transition: 'all 0.2s',
                      }}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              
              {/* Search Bar & Actions */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 10, flex: 1 }}>
                <div style={{ position: 'relative', width: '100%', maxWidth: 350 }}>
                  <div style={{ background: '#0284c7', borderRadius: 20, padding: '0', display: 'flex', alignItems: 'center', gap: 8, color: 'white', border: desktopSearch ? '1.5px solid rgba(255,255,255,0.6)' : '1.5px solid transparent' }}>
                    <Search size={15} style={{ opacity: 0.8, marginLeft: 14, flexShrink: 0 }} />
                    <input
                      type="text"
                      value={desktopSearch}
                      onChange={e => setDesktopSearch(e.target.value)}
                      placeholder="Tìm món (F3)"
                      style={{
                        flex: 1, background: 'transparent', border: 'none', outline: 'none',
                        color: 'white', fontSize: '0.88rem', padding: '8px 12px 8px 0',
                      }}
                    />
                    {desktopSearch && (
                      <button onClick={() => setDesktopSearch('')} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: '0 10px', fontSize: '1.2rem' }}>×</button>
                    )}
                  </div>
                </div>
                
                {/* Plus Button */}
                <button onClick={() => setShowAddModal(true)} style={{ background: '#0284c7', color: 'white', border: 'none', borderRadius: '50%', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '1.4rem', fontWeight: 500, flexShrink: 0, transition: 'all 0.1s' }} onMouseOver={e=>e.target.style.background='#0369a1'} onMouseOut={e=>e.target.style.background='#0284c7'}>+</button>
              </div>

            </div>

            {/* 2-pane content */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              {/* LEFT: Table browser or Menu view */}
              <div style={{ width: '65%', display: 'flex', flexDirection: 'column', background: '#f1f5f9', borderRight: '1px solid #e2e8f0', overflow: 'hidden', transition: 'width 0.25s ease' }}>
                {desktopView === 'menu' ? (
                  /* ── Menu Grid View ── */
                  <>
                    {/* Category tabs */}
                    <div style={{ paddingLeft: '8px', display: 'flex', gap: 0, borderBottom: '1px solid #e5e7eb', overflowX: 'auto', flexShrink: 0, background: 'white' }}>
                      {[{ id: 'all', name: 'Tất cả' }, ...categories].map(cat => (
                        <button key={cat.id} onClick={() => setDesktopMenuCat(cat.id)}
                          style={{
                            padding: '8px 14px', border: 'none', background: 'none', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '0.82rem', fontWeight: desktopMenuCat === cat.id ? 700 : 400,
                            color: desktopMenuCat === cat.id ? '#2563eb' : '#374151',
                            borderBottom: desktopMenuCat === cat.id ? '2.5px solid #2563eb' : '2.5px solid transparent'
                          }}
                        >{cat.name}</button>
                      ))}
                    </div>
                    {/* Menu grid 7 columns */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: '10px', background: '#f8fafc' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
                        {menuItems
                          .filter(m => {
                            const searchStr = desktopSearch.trim();
                            if (searchStr) {
                              const matchName = removeVietnameseTones(m.name).includes(removeVietnameseTones(searchStr));
                              const catName = m.category?.name || categories.find(c => c.id === m.category_id)?.name || '';
                              const matchCat = removeVietnameseTones(catName).includes(removeVietnameseTones(searchStr));
                              if (!matchName && !matchCat) return false;
                            }
                            if (desktopMenuCat === 'all') return true;
                            let itemCats = m.category_id ? [m.category_id] : [];
                            if (m.options) {
                              m.options.forEach(opt => {
                                if (opt.choiceCategories) {
                                  opt.choiceCategories.forEach(c => {
                                    if (c && !itemCats.includes(c)) itemCats.push(c);
                                  });
                                }
                              });
                            }
                            return itemCats.includes(desktopMenuCat);
                          })
                          .map(item => (
                            <div key={item.id}
                              onClick={() => {
                                if (!selectedTable) {
                                  Swal.fire('Chú ý', 'Vui lòng chọn một Phòng/Bàn hoặc Hoá đơn trước khi gọi món!', 'warning');
                                  return;
                                }
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
                                  <img src={item.image_url} alt={item.name} style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' }} />
                                ) : (
                                  <div style={{ width: '100%', aspectRatio: '1/1', background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
                    </div>
                    {/* Table grid */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', background: '#f1f5f9' }}>
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
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 14 }}>
                        {filteredTables.map(table => {
                          const isOccupied = table.status === 'occupied';
                          const isSelected = selectedTable?.id === table.id;
                          const tableTotal = (orders[table.merged_with || table.id] || []).reduce((s, o) => s + (o.total_amount || 0), 0);
                          const hasPrintError = (orders[table.merged_with || table.id] || []).some(o => o.print_jobs && o.print_jobs.some(pj => pj.status === 'failed'));
                          const isMerged = !!table.merged_with;
                          return (
                            <div key={table.id}
                              onClick={() => { setSelectedTable(table); setDesktopView('menu'); }}
                              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = isOccupied ? '0 8px 24px rgba(37,99,235,0.25)' : '0 8px 20px rgba(0,0,0,0.1)'; }}
                              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = isSelected ? '0 4px 16px rgba(37,99,235,0.35)' : isOccupied ? '0 2px 8px rgba(37,99,235,0.12)' : '0 1px 4px rgba(0,0,0,0.06)'; }}
                              style={{
                                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                padding: '14px 8px 12px', borderRadius: 14, cursor: 'pointer', minHeight: 115,
                                background: isSelected
                                  ? 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%)'
                                  : isOccupied
                                  ? 'linear-gradient(135deg, #dbeafe 0%, #eff6ff 100%)'
                                  : 'white',
                                border: '1.5px solid ' + (isSelected ? '#1d4ed8' : isOccupied ? '#93c5fd' : '#e2e8f0'),
                                boxShadow: isSelected ? '0 4px 16px rgba(37,99,235,0.35)' : isOccupied ? '0 2px 8px rgba(37,99,235,0.12)' : '0 1px 4px rgba(0,0,0,0.06)',
                                transition: 'transform 0.15s, box-shadow 0.15s',
                                position: 'relative', gap: 6,
                              }}
                            >
                              {/* Status dot */}
                              <div style={{
                                position: 'absolute', top: 8, right: 9, width: 8, height: 8, borderRadius: '50%',
                                background: isOccupied ? '#22c55e' : '#d1d5db',
                                boxShadow: isOccupied ? '0 0 0 2px rgba(34,197,94,0.25)' : 'none'
                              }} />
                              {/* Print error badge */}
                              {hasPrintError && (
                                <div style={{ position: 'absolute', top: -5, left: -5, background: '#ef4444', color: 'white', borderRadius: '50%', padding: '3px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 4px rgba(0,0,0,0.2)', zIndex: 10 }}>
                                  <Printer size={10} strokeWidth={2.5} />
                                </div>
                              )}
                              {/* Merged badge */}
                              {isMerged && !isSelected && (
                                <div style={{ position: 'absolute', top: 7, left: 7, fontSize: '0.55rem', background: '#f97316', color: 'white', borderRadius: 4, padding: '1px 4px', fontWeight: 700, lineHeight: 1.4 }}>GỘP</div>
                              )}
                              {/* Table icon */}
                              <svg width="40" height="30" viewBox="0 0 40 30" fill="none">
                                <rect x="3" y="10" width="34" height="11" rx="3.5"
                                  fill={isSelected ? 'rgba(255,255,255,0.2)' : isOccupied ? '#bfdbfe' : '#e2e8f0'}
                                  stroke={isSelected ? 'rgba(255,255,255,0.45)' : isOccupied ? '#60a5fa' : '#cbd5e1'} strokeWidth="1.5" />
                                <rect x="7" y="1" width="4.5" height="10" rx="2" fill={isSelected ? 'rgba(255,255,255,0.4)' : isOccupied ? '#60a5fa' : '#cbd5e1'} />
                                <rect x="28.5" y="1" width="4.5" height="10" rx="2" fill={isSelected ? 'rgba(255,255,255,0.4)' : isOccupied ? '#60a5fa' : '#cbd5e1'} />
                                <rect x="7" y="21" width="4.5" height="8" rx="2" fill={isSelected ? 'rgba(255,255,255,0.4)' : isOccupied ? '#60a5fa' : '#cbd5e1'} />
                                <rect x="28.5" y="21" width="4.5" height="8" rx="2" fill={isSelected ? 'rgba(255,255,255,0.4)' : isOccupied ? '#60a5fa' : '#cbd5e1'} />
                              </svg>
                              {/* Table name */}
                              <span style={{ fontSize: '0.82rem', fontWeight: 800, color: isSelected ? 'white' : isOccupied ? '#1e40af' : '#374151', letterSpacing: '0.01em' }}>B{table.table_number}</span>
                              {/* Revenue */}
                              {tableTotal > 0 ? (
                                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: isSelected ? 'rgba(255,255,255,0.9)' : '#2563eb', background: isSelected ? 'rgba(255,255,255,0.2)' : '#dbeafe', borderRadius: 6, padding: '2px 6px', whiteSpace: 'nowrap' }}>
                                  {tableTotal >= 1000 ? (tableTotal / 1000).toFixed(0) + 'k' : tableTotal.toLocaleString('vi-VN')}đ
                                </span>
                              ) : (
                                <span style={{ fontSize: '0.65rem', color: isSelected ? 'rgba(255,255,255,0.5)' : '#9ca3af' }}>Trống</span>
                              )}
                            </div>
                          );
                        })}
                        {/* Add table button */}
                        <div onClick={() => setShowAddModal(true)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: 14, border: '1.5px dashed #cbd5e1', minHeight: 100, cursor: 'pointer', color: '#94a3b8', gap: 6, background: 'white', transition: 'all 0.15s' }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = '#2563eb'; e.currentTarget.style.color = '#2563eb'; e.currentTarget.style.background = '#eff6ff'; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = '#cbd5e1'; e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.background = 'white'; }}
                        >
                          <Plus size={20} strokeWidth={1.5} />
                          <span style={{ fontSize: '0.7rem', fontWeight: 600 }}>Thêm bàn</span>
                        </div>
                      </div>
                    </div>
                    {/* Bottom bar */}
                    <div style={{ padding: '10px 16px', background: 'white', borderTop: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
                      {/* Legend */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 0 2px rgba(34,197,94,0.2)' }} />
                          <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>Có khách</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#d1d5db' }} />
                          <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>Trống</span>
                        </div>
                      </div>
                      <div style={{ flex: 1 }} />
                      <button onClick={() => setShowAddModal(true)} style={{ background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: 'white', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5, boxShadow: '0 2px 8px rgba(37,99,235,0.3)' }}>
                        <Plus size={14} /> Thêm bàn
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

        const closeModal = () => { setPaymentModal(null); setQrAccount(null); setShowTransfer(false); setTransactionCode(null); setPaymentCountdown(0); };

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
          const hostId = table.merged_with || table.id;
          // Hủy tất cả đơn của host (kể cả đơn từ bàn satellite đã được chuyển sang)
          await supabase.from('orders')
            .update({ status: 'cancelled', payment_method: 'cancelled' })
            .eq('table_id', hostId)
            .in('status', ['pending', 'preparing', 'completed']);
          // Reset toàn bộ nhóm gộp (host + all satellites)
          await supabase.from('tables')
            .update({ status: 'available', occupied_at: null, merged_with: null })
            .or(`id.eq.${hostId},merged_with.eq.${hostId}`);
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
          const desc = encodeURIComponent(transactionCode || `T1 B${table.table_number}`);
          return `https://img.vietqr.io/image/${bin}-${acc.account_number}-compact2.png?amount=${total}&addInfo=${desc}&accountName=${encodeURIComponent(acc.account_name)}`;
        };

        const handleTransferClick = async () => {
          // Chỉ sinh mã nếu chưa có
          if (!transactionCode) {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let code = '';
            for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
            
            const tableBills = orders[table.merged_with || table.id] || [];
            const orderIdsStr = tableBills.map(o => o.id).join(',');
            
            if (orderIdsStr) {
              await supabase.from('payment_transactions').insert({
                transaction_code: code,
                order_ids: orderIdsStr,
                account_id: qrAccount?.id || null,
                total_amount: total
              });
            }
            setTransactionCode(code);
          }
          setShowTransfer(true);
          setPaymentCountdown(300);
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
                  <button onClick={handleTransferClick}
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
                          onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
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

                  {paymentCountdown > 0 ? (
                    <div style={{ width: '100%', padding: '13px', background: '#f8fafc', color: '#64748b', border: '1.5px dashed #cbd5e1', borderRadius: 12, fontWeight: 700, fontSize: '0.95rem', textAlign: 'center' }}>
                      ⏳ Đang chờ xác nhận tự động... ({Math.floor(paymentCountdown / 60)}:{String(paymentCountdown % 60).padStart(2, '0')})
                    </div>
                  ) : (
                    <button onClick={doTransferPayment}
                      style={{ width: '100%', padding: '13px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: '1rem', cursor: 'pointer' }}>
                      ✅ Xác nhận thủ công đã nhận tiền
                    </button>
                  )}
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
                                  {item.item_options?.length > 0 && (() => {
                                    const loai = item.item_options.find(o => o.name?.toLowerCase() === 'loại' && o.choice?.toLowerCase() !== 'bình thường');
                                    const others = item.item_options.filter(o => o.name?.toLowerCase() !== 'loại' && o.choice?.toLowerCase() !== 'bình thường');
                                    if (!loai && others.length === 0) return null;
                                    return (
                                      <div style={{ fontSize: '0.75rem', color: '#555', marginTop: '2px' }}>
                                        {loai && <div>{loai.choice}</div>}
                                        {others.length > 0 && <div style={{ fontStyle: 'italic' }}>{others.map(o => o.choice).join(', ')}</div>}
                                      </div>
                                    );
                                  })()}
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
              {orders[selectedTable.merged_with || selectedTable.id]?.length > 0 ? (
                orders[selectedTable.merged_with || selectedTable.id].map((order, idx) => (
                  <div key={order.id} className="order-detail-card">
                    {/* Customer name header per bill */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0 8px', borderBottom: '1px solid #f3f4f6', marginBottom: 4 }}>
                      {orders[selectedTable.merged_with || selectedTable.id].length > 1 && (
                        <span style={{ fontSize: '0.7rem', background: '#2563eb', color: 'white', borderRadius: 10, padding: '1px 7px', fontWeight: 700 }}>
                          #{idx + 1}
                        </span>
                      )}
                      <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#111827' }}>
                        👤 {order.customer_name}
                      </span>
                      {order.customer_phone && order.customer_phone !== 'Quản lý' && (
                        <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>· {order.customer_phone}</span>
                      )}
                      {/* Status badge */}
                      <span style={{
                        fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                        background: order.status === 'pending' ? '#fef3c7' : order.status === 'preparing' ? '#dbeafe' : order.status === 'completed' ? '#dcfce7' : '#f3f4f6',
                        color: order.status === 'pending' ? '#d97706' : order.status === 'preparing' ? '#2563eb' : order.status === 'completed' ? '#16a34a' : '#6b7280',
                      }}>
                        {order.status === 'pending' ? 'Chờ' : order.status === 'preparing' ? 'Đang làm' : order.status === 'completed' ? 'Xong' : order.status}
                      </span>
                      {/* Cancel this single bill */}
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={async () => {
                            const otherTables = tables.filter(t => t.id !== selectedTable.id && t.table_type !== 'takeaway');
                            if (otherTables.length === 0) {
                              Swal.fire('Lỗi', 'Không có bàn nào khác để chuyển!', 'error');
                              return;
                            }

                            const inputOptions = {};
                            otherTables.forEach(t => {
                              inputOptions[t.id] = `Bàn ${t.table_number} ${t.status === 'occupied' ? '(Đang có khách)' : '(Trống)'}`;
                            });

                            const { value: targetTableId } = await Swal.fire({
                              title: 'Chuyển bàn',
                              input: 'select',
                              inputOptions,
                              inputPlaceholder: 'Chọn bàn muốn chuyển đến',
                              showCancelButton: true,
                              confirmButtonColor: '#2563eb',
                              cancelButtonColor: '#6b7280',
                              confirmButtonText: 'Chuyển',
                              cancelButtonText: 'Huỷ',
                              reverseButtons: true,
                              inputValidator: (value) => {
                                if (!value) return 'Vui lòng chọn một bàn!';
                              }
                            });

                            if (targetTableId) {
                              const { error } = await supabase.from('orders').update({ table_id: targetTableId }).eq('id', order.id);
                              if (error) {
                                Swal.fire('Lỗi', error.message, 'error');
                                return;
                              }

                              const targetTable = otherTables.find(t => t.id === targetTableId);
                              if (targetTable && targetTable.status === 'available') {
                                await supabase.from('tables').update({ status: 'occupied', occupied_at: new Date().toISOString() }).eq('id', targetTableId);
                              }

                              const remaining = orders[selectedTable.merged_with || selectedTable.id].filter(o => o.id !== order.id && o.status !== 'cancelled');
                              if (remaining.length === 0) {
                                // Reset toàn bộ nhóm gộp
                                const hId = selectedTable.merged_with || selectedTable.id;
                                await supabase.from('tables').update({ status: 'available', occupied_at: null, merged_with: null }).or(`id.eq.${hId},merged_with.eq.${hId}`);
                                setSelectedTable(null);
                              }
                              fetchTables();
                              Swal.fire({
                                title: 'Thành công',
                                text: 'Đã chuyển bàn!',
                                icon: 'success',
                                toast: true,
                                position: 'top-end',
                                showConfirmButton: false,
                                timer: 2000
                              });
                            }
                          }}
                          title="Chuyển bill này sang bàn khác"
                          style={{ background: '#e0e7ff', border: '1.5px solid #a5b4fc', borderRadius: 8, color: '#4f46e5', cursor: 'pointer', padding: '4px 12px', fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap' }}
                        >
                          Chuyển bàn
                        </button>

                        <button
                          onClick={async () => {
                            const result = await Swal.fire({
                              title: 'Huỷ bill?',
                              html: `Huỷ bill của <b>${order.customer_name}</b>?`,
                              icon: 'warning',
                              showCancelButton: true,
                              confirmButtonColor: '#dc2626',
                              cancelButtonColor: '#6b7280',
                              confirmButtonText: 'Huỷ bill',
                              cancelButtonText: 'Không',
                              reverseButtons: true,
                            });
                            if (!result.isConfirmed) return;
                            await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
                            // If all orders at this table are now cancelled, reset the table
                            const remaining = orders[selectedTable.merged_with || selectedTable.id].filter(o => o.id !== order.id && o.status !== 'cancelled');
                            if (remaining.length === 0) {
                              // Reset toàn bộ nhóm gộp
                              const hId = selectedTable.merged_with || selectedTable.id;
                              await supabase.from('tables').update({ status: 'available', occupied_at: null, merged_with: null }).or(`id.eq.${hId},merged_with.eq.${hId}`);
                              setSelectedTable(null);
                            }
                            fetchTables();
                          }}
                          title="Huỷ bill này"
                          style={{ background: '#fff1f2', border: '1.5px solid #fca5a5', borderRadius: 8, color: '#dc2626', cursor: 'pointer', padding: '4px 12px', fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap' }}
                        >
                          Huỷ bill
                        </button>
                      </div>
                    </div>
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
                              <span style={{ fontSize: '0.97rem', fontWeight: 600, color: '#111827', lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                {item.menu_item?.name || 'Món đã xoá'}
                                {item.is_gift && <span style={{ fontSize: '0.65rem', background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '1px 5px', fontWeight: 700, lineHeight: 1 }}>🎁 Món Tặng</span>}
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

                            {(() => {
                              const fullItem = menuItems.find(m => m.id === item.menu_item_id);
                              const hasOptions = fullItem?.options?.length > 0;

                              const loaiOption = (item.item_options || []).find(o => o.name?.toLowerCase() === 'loại' && o.choice?.toLowerCase() !== 'bình thường');
                              const otherOptions = (item.item_options || []).filter(o => o.name?.toLowerCase() !== 'loại' && o.choice?.toLowerCase() !== 'bình thường');
                              const hasValidOptions = loaiOption || otherOptions.length > 0;

                              if (!hasOptions && !hasValidOptions) return null;

                              const openEdit = () => {
                                if (!hasOptions) return;
                                const current = {};
                                (item.item_options || []).forEach(o => { current[o.name] = o.choice; });
                                setSelectedOptions(current);
                                setOptionQuantity(item.quantity);
                                setOptionNote(item.note || '');
                                setEditingOrderItem({ orderId: order.id, itemId: item.id });
                                setOptionModalItem(fullItem);
                                setEditingPrice(false);
                                setCustomPrice(null);
                              };
                              return (
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 4 }}>
                                  {hasValidOptions && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                      {loaiOption && (
                                        <span style={{ fontSize: '0.85rem', color: '#6b7280', fontWeight: 500 }}>
                                          {loaiOption.choice}
                                        </span>
                                      )}
                                      {otherOptions.length > 0 && (
                                        <span style={{ fontSize: '0.82rem', color: '#9ca3af', fontStyle: 'italic' }}>
                                          {otherOptions.map(o => o.choice).join(', ')}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  {hasOptions && (
                                    <button
                                      onClick={openEdit}
                                      title={item.item_options?.length > 0 ? "Đổi khẩu vị" : "Chọn loại"}
                                      style={{
                                        background: '#eff6ff', border: '1px solid #bfdbfe',
                                        borderRadius: 5, padding: '1px 6px',
                                        cursor: 'pointer', color: '#2563eb',
                                        fontSize: '0.72rem', fontWeight: 600,
                                        display: 'flex', alignItems: 'center', gap: 3,
                                        whiteSpace: 'nowrap', flexShrink: 0,
                                        marginTop: hasValidOptions ? 0 : 2
                                      }}
                                    >
                                      ✏️ {item.item_options?.length > 0 ? 'Đổi' : 'Chọn loại'}
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
                                <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                                  <span style={{ color: '#6b7280', fontWeight: 500, fontSize: '0.82rem' }}>
                                    {formatPrice(item.unit_price).replace('đ', '')}
                                  </span>
                                  <span style={{ color: '#9ca3af', fontSize: '0.78rem' }}>×{item.quantity}</span>
                                  <span style={{ color: '#9ca3af', fontSize: '0.78rem' }}>=</span>
                                  <span style={{ color: '#c53b3b', fontWeight: 800 }}>
                                    {formatPrice(item.unit_price * item.quantity).replace('đ', '')}
                                  </span>
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
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
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
            {orders[selectedTable.merged_with || selectedTable.id]?.length > 0 && (
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
                  touchAction: 'manipulation',
                }}
              >
                <Plus size={22} strokeWidth={2.5} />
              </button>
            )}
            <div className="modal-footer" style={{ padding: '8px 12px', gap: 6, flexDirection: 'column', alignItems: 'stretch' }}>
              {/* Total summary row */}
              {orders[selectedTable.merged_with || selectedTable.id]?.length > 0 && (() => {
                const total = orders[selectedTable.merged_with || selectedTable.id].reduce((s, o) => s + (o.total_amount || 0), 0);
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #f3f4f6' }}>
                    <span style={{ fontSize: '0.88rem', color: '#6b7280', fontWeight: 500 }}>Tổng cộng:</span>
                    <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#c53b3b' }}>{formatPrice(total)}</span>
                  </div>
                );
              })()}

              {/* Nút Gộp Bill Mobile — REMOVED standalone row, moved into action row below */}

              {/* Action buttons row — all in one row */}
              {orders[selectedTable.merged_with || selectedTable.id]?.length > 0 && (() => {
                const tableBills = orders[selectedTable.merged_with || selectedTable.id] || [];
                const smallBtnStyle = {
                  width: 54, minWidth: 54,
                  padding: '5px 2px',
                  borderRadius: 12,
                  background: 'white',
                  cursor: 'pointer',
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  gap: 2,
                  fontSize: '0.65rem', fontWeight: 600,
                };
                return (
                  <div style={{ display: 'flex', gap: 5, width: '100%', alignItems: 'stretch' }}>

                    {/* Tạm tính */}
                    <button onClick={() => setShowBillPreview(true)} style={{ ...smallBtnStyle, border: '1.5px solid #2563eb', color: '#2563eb' }}>
                      <Receipt size={16} strokeWidth={1.8} />
                      Tạm tính
                    </button>

                    {/* Gộp bàn */}
                    <button onClick={handleMergeTable} style={{ ...smallBtnStyle, border: '1.5px solid #d8b4fe', color: '#9333ea' }}>
                      <Users size={16} strokeWidth={1.8} />
                      Gộp bàn
                    </button>

                    {/* Gộp bill — chỉ hiện khi có > 1 bill */}
                    {tableBills.length > 1 && (
                      <button onClick={mergeBills} style={{ ...smallBtnStyle, border: '1.5px dashed #8b5cf6', color: '#7c3aed', background: '#faf5ff' }}>
                        🔗
                        <span style={{ fontSize: '0.6rem', lineHeight: 1.1, textAlign: 'center' }}>Gộp bill</span>
                      </button>
                    )}

                    {/* Huỷ đơn */}
                    <button onClick={() => setCancelConfirm(selectedTable)} style={{ ...smallBtnStyle, border: '1.5px solid #fca5a5', color: '#dc2626' }}>
                      <Trash2 size={16} strokeWidth={1.8} />
                      Huỷ đơn
                    </button>

                    {/* In hoá đơn — compact */}
                    <button onClick={handlePrintInvoice} style={{ ...smallBtnStyle, border: '1.5px solid #2563eb', color: '#2563eb' }}>
                      <Printer size={16} strokeWidth={1.8} />
                      In HĐ
                    </button>

                    {/* Thanh toán — solid blue pill, widest */}
                    <button
                      onClick={() => {
                        const total = orders[selectedTable.merged_with || selectedTable.id]?.reduce((s, o) => s + (o.total_amount || 0), 0) || 0;
                        setConfirmPayment({ table: selectedTable, totalAmount: total });
                      }}
                      style={{
                        flex: 2,
                        padding: '8px 10px',
                        border: 'none',
                        borderRadius: 100,
                        background: '#2563eb',
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: '0.9rem', fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Thanh toán
                    </button>
                  </div>
                );
              })()}
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
                        const v = Number(e.target.value.replace(/\D/g, '')) || 0;
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
                    onChange={e => setCustomNewPrice(Number(e.target.value.replace(/\D/g, '')) || 0)}
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
          if (selectedTable && (!orders[selectedTable.merged_with || selectedTable.id] || orders[selectedTable.merged_with || selectedTable.id].length === 0)) {
            setSelectedTable(null);
          }
        };

        const activeOrder = selectedTable && orders[selectedTable.merged_with || selectedTable.id]
          ? (orders[selectedTable.merged_with || selectedTable.id].find(o => o.customer_name === 'Admin') || orders[selectedTable.merged_with || selectedTable.id][0])
          : null;
        const orderItems = activeOrder?.order_items || [];
        const totalCartItems = orderItems.reduce((sum, oi) => sum + oi.quantity, 0);

        const getItemCategories = (item) => {
          let itemCats = item.category_id ? [item.category_id] : [];
          if (item.options) {
            item.options.forEach(opt => {
              if (opt.choiceCategories) {
                opt.choiceCategories.forEach(c => {
                  if (c && !itemCats.includes(c)) itemCats.push(c);
                });
              }
            });
          }
          return itemCats.length > 0 ? itemCats : [null];
        };

        const filteredItems = menuItems.filter(item => {
          const itemCats = getItemCategories(item);
          const matchesCat = activeMenuCategory === 'all' || itemCats.includes(activeMenuCategory);
          const matchesSearch = removeVietnameseTones(item.name).includes(removeVietnameseTones(addItemSearch));
          return matchesCat && matchesSearch;
        });

        // Group filtered items by category (map them correctly to categories)
        const grouped = categories
          .map(cat => ({
            ...cat,
            items: filteredItems.filter(item => getItemCategories(item).includes(cat.id))
          }))
          .filter(cat => cat.items.length > 0 && (activeMenuCategory === 'all' || cat.id === activeMenuCategory));

        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 1050,
              background: 'white',
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden'
            }}
          >
            {/* Top bar & Search combined */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)', borderBottom: '1px solid #f3f4f6' }}>
              <span style={{ fontWeight: 900, fontSize: '1.25rem', color: '#2563eb', whiteSpace: 'nowrap' }}>Bàn {selectedTable?.table_number}</span>

              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                <input
                  placeholder="Tìm món ăn..."
                  value={addItemSearch}
                  onChange={e => setAddItemSearch(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 28px 8px 34px',
                    borderRadius: 20, border: '1px solid #e5e7eb',
                    background: '#f9fafb', fontSize: '0.88rem', outline: 'none'
                  }}
                />
                {addItemSearch && (
                  <button
                    onClick={() => setAddItemSearch('')}
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2, display: 'flex' }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4, flexShrink: 0, display: 'flex' }}
                onClick={closeModal}
              >
                <X size={24} />
              </button>
            </div>

            {/* Category pills */}
            <div style={{ display: 'flex', gap: 6, padding: '6px 12px', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid #f3f4f6' }}>
              {[{ id: 'all', name: 'Tất cả' }, ...categories].map(cat => (
                <button
                  key={cat.id}
                  onClick={() => setActiveMenuCategory(cat.id)}
                  style={{
                    flexShrink: 0,
                    padding: '5px 14px',
                    borderRadius: 24,
                    border: '1.5px solid',
                    borderColor: activeMenuCategory === cat.id ? '#2563eb' : '#e5e7eb',
                    background: activeMenuCategory === cat.id ? '#2563eb' : 'white',
                    color: activeMenuCategory === cat.id ? 'white' : '#374151',
                    fontWeight: activeMenuCategory === cat.id ? 700 : 500,
                    fontSize: '0.8rem',
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
              {filteredItems.length === 0 && (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Không tìm thấy món ăn nào</div>
              )}

              {activeMenuCategory === 'all' ? (
                /* ── Tất cả: flat list, không header nhóm ── */
                filteredItems.map(item => {
                  const itemsInOrder = orderItems.filter(oi => oi.menu_item_id === item.id);
                  const qty = itemsInOrder.reduce((s, oi) => s + oi.quantity, 0);
                  return (
                    <div
                      key={item.id}
                      onClick={() => addItemToOrder('admin', item)}
                      style={{
                        display: 'flex', alignItems: 'center',
                        padding: '7px 12px',
                        background: 'white',
                        borderBottom: '1px solid #f3f4f6',
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{
                        width: 44, height: 44, borderRadius: 8,
                        overflow: 'hidden', flexShrink: 0,
                        background: '#eff6ff',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        position: 'relative'
                      }}>
                        {item.image_url
                          ? <Image src={item.image_url} alt={item.name} fill sizes="44px" style={{ objectFit: 'cover' }} />
                          : <ChefHat size={20} style={{ color: '#93c5fd' }} />}
                      </div>
                      <div style={{ flex: 1, marginLeft: 10, paddingRight: 6 }}>
                        <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#111827', marginBottom: 1, lineHeight: 1.25 }}>{item.name}</div>
                        <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#6b7280' }}>{getItemDisplayPrice(item)}</div>
                      </div>
                      {qty > 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
                          <button onClick={() => decreaseItemFromMenu(item.id)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #d1d5db', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}>
                            <Minus size={13} strokeWidth={2.5} />
                          </button>
                          <span style={{ width: 18, textAlign: 'center', fontWeight: 700, fontSize: '0.9rem', color: '#111827' }}>{qty}</span>
                          <button onClick={() => addItemToOrder('admin', item)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #d1d5db', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}>
                            <Plus size={13} strokeWidth={2.5} />
                          </button>
                        </div>
                      ) : (
                        <button onClick={e => { e.stopPropagation(); addItemToOrder('admin', item); }} style={{ width: 28, height: 28, borderRadius: '50%', background: 'white', border: '1.5px solid #d1d5db', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, color: '#374151' }}>
                          <Plus size={15} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  );
                })
              ) : (
                /* ── Category cụ thể: hiển thị theo nhóm có header ── */
                grouped.map(cat => (
                  <div key={cat.id}>
                    <div style={{ padding: '8px 16px 2px', fontSize: '0.72rem', fontWeight: 800, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
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
                            padding: '7px 12px',
                            background: 'white',
                            borderBottom: '1px solid #f3f4f6',
                            cursor: 'pointer'
                          }}
                        >
                          <div style={{
                            width: 44, height: 44, borderRadius: 8,
                            overflow: 'hidden', flexShrink: 0,
                            background: '#eff6ff',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            position: 'relative'
                          }}>
                            {item.image_url
                              ? <Image src={item.image_url} alt={item.name} fill sizes="44px" style={{ objectFit: 'cover' }} />
                              : <ChefHat size={20} style={{ color: '#93c5fd' }} />}
                          </div>
                          <div style={{ flex: 1, marginLeft: 10, paddingRight: 6 }}>
                            <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#111827', marginBottom: 1, lineHeight: 1.25 }}>{item.name}</div>
                            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#6b7280' }}>{getItemDisplayPrice(item)}</div>
                          </div>
                          {qty > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
                              <button onClick={() => decreaseItemFromMenu(item.id)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #d1d5db', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}>
                                <Minus size={13} strokeWidth={2.5} />
                              </button>
                              <span style={{ width: 18, textAlign: 'center', fontWeight: 700, fontSize: '0.9rem', color: '#111827' }}>{qty}</span>
                              <button onClick={() => addItemToOrder('admin', item)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #d1d5db', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}>
                                <Plus size={13} strokeWidth={2.5} />
                              </button>
                            </div>
                          ) : (
                            <button onClick={e => { e.stopPropagation(); addItemToOrder('admin', item); }} style={{ width: 28, height: 28, borderRadius: '50%', background: 'white', border: '1.5px solid #d1d5db', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, color: '#374151' }}>
                              <Plus size={15} strokeWidth={2} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
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
                          onChange={e => setCustomPrice(Number(e.target.value.replace(/\D/g, '')))}
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
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {optionModalItem.options && optionModalItem.options.map((opt, idx) => (
                <div key={idx} style={{ marginBottom: 8, marginTop: idx === 0 ? 0 : 4 }}>
                  <div className="options-group-title">{opt.name}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 6 }}>
                    {opt.choices.map((choice, cIdx) => {
                      const choiceP = opt.prices?.[cIdx];
                      const hasPrice = choiceP !== null && choiceP !== '' && Number(choiceP) > 0;
                      const isSelected = selectedOptions[opt.name] === choice;
                      return (
                        <label
                          key={cIdx}
                          onClick={() => {
                            setSelectedOptions({ ...selectedOptions, [opt.name]: choice });
                            if (hasPrice) setCustomPrice(Number(choiceP));
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '7px 4px', cursor: 'pointer',
                            borderBottom: cIdx < opt.choices.length - 1 ? '1px solid #f3f4f6' : 'none',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                              width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                              border: isSelected ? '5px solid #2563eb' : '1.5px solid #d1d5db',
                              background: 'white', transition: 'all 0.15s',
                            }} />
                            <span style={{
                              fontSize: '0.88rem', fontWeight: isSelected ? 700 : 500,
                              color: isSelected ? '#1d4ed8' : '#374151',
                            }}>{choice}</span>
                          </div>
                          {hasPrice ? (
                            <span style={{ fontSize: '0.78rem', color: '#6b7280', fontWeight: 500 }}>
                              +{formatPrice(Number(choiceP))}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
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
        const tableBills = orders[selectedTable.merged_with || selectedTable.id] || [];
        const rawItems = tableBills.flatMap(b => b.order_items || []);
        const grandTotal = tableBills.reduce((s, b) => s + b.total_amount, 0);
        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

        // Gộp các món giống nhau (cùng tên + options + giá + gift)
        const mergedMap = new Map();
        for (const item of rawItems) {
          const name = item.menu_item?.name || '?';
          const optionsKey = (item.item_options || [])
            .map(o => `${o.name}:${o.choice}`)
            .sort()
            .join('|');
          const key = `${name}__${optionsKey}__${item.unit_price}__${item.is_gift ? 'gift' : ''}`;
          if (mergedMap.has(key)) {
            const existing = mergedMap.get(key);
            existing.quantity += item.quantity || 1;
          } else {
            mergedMap.set(key, { ...item, quantity: item.quantity || 1 });
          }
        }
        // Sắp xếp theo alphabet
        const allItems = [...mergedMap.values()].sort((a, b) =>
          (a.menu_item?.name || '').localeCompare(b.menu_item?.name || '', 'vi')
        );
        const totalQty = allItems.reduce((s, i) => s + i.quantity, 0);

        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 2000,
              background: '#f8fafc',
              display: 'flex', flexDirection: 'column',
              fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'white', borderBottom: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <button
                onClick={() => setShowBillPreview(false)}
                style={{
                  width: 32, height: 32, borderRadius: '50%',
                  border: '1.5px solid #e5e7eb', background: 'white',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: '#6b7280', fontSize: '0.9rem', flexShrink: 0
                }}
              >✕</button>
              <span style={{ fontSize: '1rem', fontWeight: 700, color: '#111827', flex: 1 }}>Phiếu tạm tính</span>
              <span style={{
                fontSize: '0.82rem', fontWeight: 700, color: '#2563eb',
                background: '#eff6ff', borderRadius: 20, padding: '3px 12px',
              }}>
                Bàn {selectedTable.table_number}
              </span>
            </div>

            {/* Timestamp */}
            <div style={{ padding: '6px 16px 4px', fontSize: '0.75rem', color: '#9ca3af', textAlign: 'center' }}>
              {timeStr} · {dateStr}
            </div>

            {/* Items list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 8px' }}>
              {allItems.map((item, idx) => {
                const optionText = item.item_options?.map(o => o.choice).join(' · ') || item.note || '';
                const subtotal = item.unit_price * item.quantity;
                return (
                  <div key={idx} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '9px 12px', marginBottom: 5,
                    background: 'white', borderRadius: 10,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                    gap: 8,
                  }}>
                    {/* Left: name + option */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.menu_item?.name || 'Món đã xoá'}
                      </div>
                      {optionText && (
                        <div style={{ fontSize: '0.75rem', color: '#f59e0b', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {optionText}
                        </div>
                      )}
                    </div>
                    {/* Right: qty × price = subtotal */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <span style={{ fontSize: '0.78rem', color: '#9ca3af' }}>
                        {item.unit_price.toLocaleString('vi-VN')} × {item.quantity}
                      </span>
                      <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#111827', minWidth: 60, textAlign: 'right' }}>
                        {subtotal.toLocaleString('vi-VN')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Summary section */}
            <div style={{ background: 'white', borderTop: '1px solid #e5e7eb', padding: '10px 16px 6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                <span style={{ fontSize: '0.82rem', color: '#6b7280' }}>
                  Tổng cộng
                  <span style={{ fontSize: '0.72rem', background: '#f3f4f6', color: '#6b7280', borderRadius: 4, padding: '1px 5px', fontWeight: 600, marginLeft: 6 }}>
                    {totalQty} món
                  </span>
                </span>
                <span style={{ fontSize: '0.82rem', color: '#374151', fontWeight: 500 }}>{grandTotal.toLocaleString('vi-VN')}đ</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0 6px', borderTop: '1px dashed #e5e7eb', marginTop: 4 }}>
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#111827' }}>Khách cần trả</span>
                <span style={{ fontSize: '1.1rem', fontWeight: 800, color: '#2563eb' }}>{grandTotal.toLocaleString('vi-VN')}đ</span>
              </div>
            </div>

            {/* Print button */}
            <div style={{ padding: '10px 16px 16px', background: 'white' }}>
              <button
                onClick={handlePrintInvoice}
                style={{
                  width: '100%', padding: '13px 0',
                  borderRadius: 100, border: 'none',
                  background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: 'white',
                  fontSize: '0.95rem', fontWeight: 700,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  boxShadow: '0 4px 12px rgba(37,99,235,0.35)',
                }}
              >
                🖨️ In phiếu tạm tính
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
      {/* ── Custom Payment Confirmation Modal (Redesigned) ── */}
      {confirmPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
          onClick={() => setConfirmPayment(null)}>
          <div style={{ background: 'white', borderRadius: '24px 24px 0 0', boxShadow: '0 -20px 60px rgba(0,0,0,0.15)', width: '100%', maxWidth: 640, padding: '24px 20px calc(24px + env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#111827', display: 'flex', alignItems: 'center', gap: 8 }}>
                  💳 Thanh toán
                </div>
                <div style={{ fontSize: '0.95rem', color: '#6b7280', marginTop: 4 }}>
                  Bàn {confirmPayment.table.table_number}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.9rem', color: '#6b7280', fontWeight: 500 }}>Tổng cộng</div>
                <div style={{ fontSize: '1.65rem', fontWeight: 800, color: '#dc2626', lineHeight: 1.1 }}>
                  {confirmPayment.totalAmount.toLocaleString('vi-VN')}đ
                </div>
              </div>
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* Tiền mặt Button */}
              <div
                onClick={async () => {
                  await completeTable(confirmPayment.table, 'cash');
                  setConfirmPayment(null);
                  setSelectedTable(null);
                  setDesktopView('tables');
                  Swal.fire({
                    icon: 'success',
                    title: '✅ Thanh toán tiền mặt!',
                    html: `<span style="font-size:1rem">Bàn <b>B${confirmPayment.table.table_number}</b> — <b style="color:#fff;font-size:1.1rem">${confirmPayment.totalAmount.toLocaleString('vi-VN')}đ</b></span>`,
                    timer: 3000, timerProgressBar: true, showConfirmButton: false,
                    position: 'top-end', toast: true, background: '#16a34a', color: '#fff', iconColor: '#fff',
                  });
                }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '16px', background: '#f0fdf4', border: '1.5px solid #bbf7d0',
                  borderRadius: 16, cursor: 'pointer', transition: 'all 0.15s'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ fontSize: '1.8rem' }}>💵</div>
                  <div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#16a34a' }}>Tiền mặt</div>
                    <div style={{ fontSize: '0.8rem', color: '#15803d', marginTop: 2, fontWeight: 500 }}>Nhận tiền mặt — đóng bàn ngay</div>
                  </div>
                </div>
                <div style={{ background: '#16a34a', color: 'white', padding: '6px 14px', borderRadius: 8, fontSize: '0.9rem', fontWeight: 700 }}>
                  Xác nhận
                </div>
              </div>

              {/* Chuyển khoản Button */}
              <div
                onClick={() => openPaymentModal(confirmPayment.table, confirmPayment.totalAmount)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '16px', background: '#eff6ff', border: '1.5px solid #bfdbfe',
                  borderRadius: 16, cursor: 'pointer', transition: 'all 0.15s'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ fontSize: '1.8rem' }}>📲</div>
                  <div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#2563eb' }}>Chuyển khoản</div>
                    <div style={{ fontSize: '0.8rem', color: '#1d4ed8', marginTop: 2, fontWeight: 500 }}>Hiện mã QR cho khách quét</div>
                  </div>
                </div>
                <div style={{ color: '#2563eb', fontSize: '1.2rem', fontWeight: 800, paddingRight: 4 }}>
                  ›
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* ── QR Transfer Payment Modal ── */}
      {paymentModal && qrAccount && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => { setPaymentModal(null); setConfirmPayment(null); }}>
          <div style={{ background: 'white', borderRadius: 20, boxShadow: '0 24px 64px rgba(0,0,0,0.2)', width: '100%', maxWidth: 380, overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ background: qrAccount.overLimit ? '#dc2626' : '#2563eb', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ color: 'white', fontWeight: 800, fontSize: '1rem' }}>📲 Chuyển khoản</div>
                <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: '0.8rem' }}>Bàn B{paymentModal.table.table_number} · {paymentModal.total.toLocaleString('vi-VN')}đ</div>
              </div>
              <button onClick={() => { setPaymentModal(null); }}
                style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '50%', width: 32, height: 32, color: 'white', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>

            {/* QR + account info */}
            <div style={{ padding: '16px 18px' }}>
              <div style={{ border: `2px solid ${qrAccount.overLimit ? '#ef4444' : '#bfdbfe'}`, borderRadius: 16, padding: '24px 16px', background: qrAccount.overLimit ? '#fff7f7' : '#f0f9ff', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>

                {/* QR Code (Large, on top) */}
                <div style={{ padding: 12, background: 'white', borderRadius: 16, border: `1.5px solid ${qrAccount.overLimit ? '#fca5a5' : '#bfdbfe'}`, marginBottom: 16 }}>
                  <img
                    src={buildQrUrl(qrAccount, paymentModal.total, transactionCode || `Thanh toan B${paymentModal.table.table_number}`)}
                    alt="QR"
                    style={{ width: 260, height: 260, display: 'block', objectFit: 'contain', aspectRatio: '1/1' }}
                  />
                </div>

                {/* Account Details (Below) */}
                <div style={{ width: '100%' }}>
                  <div style={{ fontWeight: 800, fontSize: '1.2rem', color: '#0f172a' }}>{qrAccount.bank_name}</div>
                  <div style={{ fontSize: '1.4rem', letterSpacing: 2, fontWeight: 800, color: qrAccount.overLimit ? '#dc2626' : '#1d4ed8', marginTop: 4 }}>{qrAccount.account_number}</div>
                  <div style={{ fontSize: '0.9rem', color: '#475569', marginTop: 4, textTransform: 'uppercase', fontWeight: 600 }}>{qrAccount.account_name}</div>

                  <div style={{ background: 'white', borderRadius: 12, padding: '10px', marginTop: 12, border: '1px dashed #cbd5e1' }}>
                    <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 2 }}>Số tiền cần thanh toán</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#0f172a' }}>{paymentModal.total.toLocaleString('vi-VN')}đ</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Confirm button */}
            <div style={{ padding: '0 18px 18px', display: 'flex', gap: 10 }}>
              <button onClick={() => { setPaymentModal(null); setConfirmPayment(null); setTransactionCode(null); setPaymentCountdown(0); }}
                style={{ flex: 1, padding: '12px', border: '1.5px solid #e5e7eb', borderRadius: 12, background: 'white', color: '#6b7280', fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem' }}>
                Quay lại
              </button>
              {paymentCountdown > 0 ? (
                <div style={{ flex: 2, padding: '12px', background: '#eff6ff', color: '#1d4ed8', border: '1.5px dashed #bfdbfe', borderRadius: 12, fontWeight: 700, fontSize: '0.9rem', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  ⏳ Chờ xác nhận... ({Math.floor(paymentCountdown / 60)}:{String(paymentCountdown % 60).padStart(2, '0')})
                </div>
              ) : (
                <button
                  onClick={async () => {
                    await recordBankPayment(qrAccount.id, paymentModal.total);
                    await completeTable(paymentModal.table, 'transfer');
                    setPaymentModal(null);
                    setConfirmPayment(null);
                    setTransactionCode(null);
                    setPaymentCountdown(0);
                    setSelectedTable(null);
                    setDesktopView('tables');
                    Swal.fire({
                      icon: 'success',
                      title: '✅ Chuyển khoản thành công!',
                      html: `<span style="font-size:1rem">Bàn <b>B${paymentModal.table.table_number}</b> — <b style="color:#fff;font-size:1.1rem">${paymentModal.total.toLocaleString('vi-VN')}đ</b></span>`,
                      timer: 3000, timerProgressBar: true, showConfirmButton: false,
                      position: 'top-end', toast: true, background: '#1d4ed8', color: '#fff', iconColor: '#fff',
                    });
                  }}
                  style={{ flex: 2, padding: '12px', border: 'none', borderRadius: 12, background: '#2563eb', color: 'white', fontWeight: 800, cursor: 'pointer', fontSize: '0.95rem' }}>
                  ✅ Đã nhận tiền
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══ HUỶ ĐƠN CONFIRMATION MODAL ══ */}
      {cancelConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 3000,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          animation: 'fadeIn 0.15s ease',
        }}
          onClick={() => setCancelConfirm(null)}
        >
          <div style={{
            background: 'white',
            borderRadius: '24px 24px 0 0',
            width: '100%', maxWidth: 420,
            padding: '28px 20px 36px',
            boxShadow: '0 -12px 48px rgba(220,38,38,0.15)',
            animation: 'slideUp 0.2s ease',
          }}
            onClick={e => e.stopPropagation()}
          >
            {/* Warning icon */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'linear-gradient(135deg,#fee2e2,#fecaca)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem', boxShadow: '0 4px 20px rgba(220,38,38,0.2)' }}>🗑️</div>
            </div>
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#0f172a' }}>Huỷ toàn bộ đơn?</div>
              <div style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 4 }}>
                Bàn <strong>{cancelConfirm.table_number}</strong> — tất cả đơn chưa thanh toán sẽ bị huỷ
              </div>
            </div>
            {/* Warning note */}
            <div style={{
              background: '#fef9c3', border: '1px solid #fde68a',
              borderRadius: 10, padding: '10px 14px',
              fontSize: '0.8rem', color: '#92400e', fontWeight: 500,
              marginTop: 12, marginBottom: 20, textAlign: 'center',
            }}>
              ⚠️ Hành động này <strong>không thể hoàn tác</strong>. Bàn sẽ được trả về trạng thái trống.
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setCancelConfirm(null)}
                style={{
                  flex: 1, padding: '13px', border: '1.5px solid #e2e8f0',
                  borderRadius: 14, background: 'white', cursor: 'pointer',
                  fontSize: '0.95rem', fontWeight: 700, color: '#374151',
                }}>
                Không, giữ lại
              </button>
              <button
                onClick={async () => {
                  const t = cancelConfirm;

                  // ─── 1. Close ALL panels INSTANTLY ───
                  setCancelConfirm(null);
                  setSelectedTable(null);
                  setAddingToOrder(null);
                  setAddItemSearch('');
                  setActiveMenuCategory('all');
                  setShowBillPreview(false);
                  setPaymentModal(null);
                  setOrders(prev => ({ ...prev, [t.id]: [] }));

                  // ─── 2. DB updates in background (after UI is already gone) ───
                  const hostId = t.merged_with || t.id;
                  // Hủy tất cả đơn của host (kể cả đơn từ bàn satellite đã được chuyển sang)
                  await supabase.from('orders')
                    .update({ status: 'cancelled', payment_method: 'cancelled' })
                    .eq('table_id', hostId)
                    .in('status', ['pending', 'preparing', 'completed']);
                  // Reset toàn bộ nhóm gộp (host + all satellites)
                  await supabase.from('tables')
                    .update({ status: 'available', occupied_at: null, merged_with: null })
                    .or(`id.eq.${hostId},merged_with.eq.${hostId}`);
                  fetchTables();
                }}
                style={{
                  flex: 1, padding: '13px', border: 'none',
                  borderRadius: 14,
                  background: 'linear-gradient(135deg,#ef4444,#dc2626)',
                  color: 'white', cursor: 'pointer',
                  fontSize: '0.95rem', fontWeight: 800,
                  boxShadow: '0 4px 16px rgba(220,38,38,0.35)',
                }}>
                Có, huỷ đơn
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ══ LỊCH SỬ BÀN 8H ══ */}
      {showTableHistory && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3100, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => setShowTableHistory(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, maxHeight: '80dvh', background: 'white', borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: '1rem', color: '#1f2937' }}>🕐 Lịch sử Bàn {showTableHistory.table_number}</div>
                <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 1 }}>8 tiếng gần nhất</div>
              </div>
              <button onClick={() => setShowTableHistory(null)} style={{ background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 30, height: 30, cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '10px 14px 20px' }}>
              {tableHistoryLoading ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: '#9ca3af', fontSize: '0.85rem' }}>Đang tải...</div>
              ) : tableHistoryData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: '#d1d5db', fontSize: '0.85rem' }}>
                  <div style={{ fontSize: '2rem', marginBottom: 6 }}>📭</div>Không có lịch sử trong 8 tiếng qua
                </div>
              ) : tableHistoryData.map(order => {
                const isPaid = order.status === 'paid';
                const tTime = new Date(order.updated_at || order.created_at);
                const timeStr = tTime.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                return (
                  <div key={order.id} style={{ borderBottom: '1px solid #f3f4f6', paddingBottom: 10, marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span style={{ fontSize: '0.68rem', color: '#9ca3af' }}>{timeStr}</span>
                      <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#6b7280' }}>•</span>
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#374151' }}>{order.customer_name || 'Khách'}</span>
                      <span style={{ marginLeft: 'auto', fontSize: '0.62rem', fontWeight: 700, borderRadius: 100, padding: '2px 8px', background: isPaid ? '#dcfce7' : '#fee2e2', color: isPaid ? '#16a34a' : '#dc2626' }}>
                        {isPaid ? '✓ Đã TT' : '✗ Đã huỷ'}
                      </span>
                    </div>
                    {(order.order_items || []).slice(0, 4).map(item => (
                      <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#6b7280', paddingLeft: 4, marginBottom: 2 }}>
                        <span>{item.quantity}x {item.menu_item?.name || item.item_name}</span>
                        <span style={{ fontWeight: 600 }}>{(item.unit_price * item.quantity).toLocaleString('vi-VN')}đ</span>
                      </div>
                    ))}
                    {(order.order_items || []).length > 4 && <div style={{ fontSize: '0.68rem', color: '#9ca3af', paddingLeft: 4 }}>...+{order.order_items.length - 4} món khác</div>}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 4, borderTop: '1px dashed #f3f4f6' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>Tổng</span>
                        <span style={{ fontSize: '0.82rem', fontWeight: 800, color: isPaid ? '#16a34a' : '#dc2626' }}>{(order.total_amount || 0).toLocaleString('vi-VN')}đ</span>
                      </div>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          const btn = e.currentTarget;
                          const orig = btn.textContent;
                          btn.textContent = '⏳'; btn.disabled = true;
                          const { success } = await sendTableSummaryPrintJob(supabase, [order.id]);
                          btn.textContent = success ? '✓ Gửii' : '✗ Lỗi';
                          setTimeout(() => { if (btn) { btn.textContent = orig; btn.disabled = false; } }, 2000);
                        }}
                        style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, color: '#0284c7', fontSize: '0.7rem', fontWeight: 700, padding: '4px 10px', cursor: 'pointer' }}>
                        🖨️ In lại
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── Print Toast ─── */}
      {printToast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9999, padding: '10px 20px', borderRadius: 100, fontWeight: 700,
          fontSize: '0.9rem', whiteSpace: 'nowrap', boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          background: printToast === 'ok' ? '#15803d' : printToast === 'err' ? '#dc2626' : '#2563eb',
          color: 'white', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {printToast === 'sending' && '🖨️ Đang gửi lệnh in...'}
          {printToast === 'ok' && '✅ Đã gửi lệnh in thành công!'}
          {printToast === 'err' && '❌ Lỗi gửi lệnh in!'}
        </div>
      )}
    </div>
  );
}
