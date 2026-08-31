'use client';
import { removeVietnameseTones } from '@/lib/utils';


import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import { getActiveAccount, processPaymentAtomic, buildQrUrl } from '@/lib/bankAccount';
import { sendTableSummaryPrintJob, sendSmartPrintJobs } from '@/lib/print';
import {
  getChannel, fetchChannelConfig, calcReviewDiscount, startOfTodayISO,
  isReviewDiscountItem,
} from '@/lib/reviewReward';
import { getMenuCached } from '@/lib/menuCache';
import { isLuckyWheelItem } from '@/lib/luckyWheel';
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
  Receipt,
  Search,
  ChefHat,
} from 'lucide-react';
import './tables.css';

// ─── Nhận diện nước ngọt / bia / khăn (không dựa vào category vì DB để trống) ───
const DRINK_KEYWORDS = ['bia', 'coca', 'pepsi', '7 up', '7up', 'xa xi', 'sa xi', 'sting', 'siting', '0 do', 'nuoc', 'tra', 'khan', 'sprite', 'fanta', 'mirinda', 'aquafina', 'lavie', 'la vie', 'red bull', 'redbull', 'revive'];

// Job in còn 'pending' quá 60s coi như treo (PrintAgent tắt/rớt mạng) — job
// dạng này không bao giờ tự chuyển 'failed' nên phải tự tính theo tuổi job,
// nếu không thẻ bàn sẽ không báo gì dù bill chưa in ra máy nào cả.
const STALE_PRINT_JOB_MS = 60000;
function isPrintJobBad(pj) {
  if (pj.status === 'failed') return true;
  return pj.status === 'pending' && pj.created_at && (Date.now() - new Date(pj.created_at).getTime()) > STALE_PRINT_JOB_MS;
}
function isDrinkName(name) {
  const n = removeVietnameseTones(name || '');
  return DRINK_KEYWORDS.some(k => n.includes(k));
}

// Tiếng chuông to vang vọng — Web Audio API, mô phỏng chuông kim loại bằng harmonic partials
let _bellAudioCtx = null;
function getBellAudioCtx() {
  if (typeof window === 'undefined') return null;
  if (_bellAudioCtx && _bellAudioCtx.state !== 'closed') return _bellAudioCtx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  _bellAudioCtx = new AudioCtx();
  return _bellAudioCtx;
}

function playSingleBell(audioCtx, startTime, masterGain) {
  const baseFreq = 660; // Hz — tần số chính, đủ ấm để có cảm giác "lớn"
  // Bell partials (tỉ lệ hơi lệch hài hoà để có timbre chuông kim loại)
  const partials = [
    { freq: baseFreq,        gain: 0.85, duration: 3.2 },
    { freq: baseFreq * 2.0,  gain: 0.55, duration: 2.6 },
    { freq: baseFreq * 3.0,  gain: 0.32, duration: 2.0 },
    { freq: baseFreq * 4.2,  gain: 0.20, duration: 1.4 },
    { freq: baseFreq * 5.4,  gain: 0.12, duration: 1.0 },
  ];
  partials.forEach(p => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = p.freq;
    osc.connect(gain);
    gain.connect(masterGain);
    // Attack nhanh (5ms) + decay dài (vang vọng)
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(p.gain, startTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + p.duration);
    osc.start(startTime);
    osc.stop(startTime + p.duration);
  });
}

function ringBell() {
  try {
    const audioCtx = getBellAudioCtx();
    if (!audioCtx) return;
    // Một số browser suspend AudioContext nếu chưa có user interaction — thử resume
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Master gain để chỉnh âm lượng tổng (1.0 = to)
    const master = audioCtx.createGain();
    master.gain.value = 1.0;
    master.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    playSingleBell(audioCtx, now, master);          // Tiếng 1
    playSingleBell(audioCtx, now + 0.85, master);   // Tiếng 2 (cách 850ms)
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
  const [filterTab, setFilterTab] = useState('OCCUPIED'); // mặc định ưu tiên tab "Sử dụng"
  const [columnsPerRow, setColumnsPerRow] = useState(5);
  const [menuItems, setMenuItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [addingToOrder, setAddingToOrder] = useState(null); // order id being added to
  const [activeMenuCategory, setActiveMenuCategory] = useState('all');
  const [addItemSearch, setAddItemSearch] = useState('');
  const [addedItemAlert, setAddedItemAlert] = useState(null);
  // ─── Draft Cart: giỏ hàng tạm, chỉ push lên server khi bấm "Xác nhận" ───
  const [draftCart, setDraftCart] = useState([]); // [{ menuItemId, menuItem, qty, options, note, price }]
  const [isConfirmingDraft, setIsConfirmingDraft] = useState(false);

  // States for Item Options
  const [optionModalItem, setOptionModalItem] = useState(null);
  const [selectedOptions, setSelectedOptions] = useState({});
  const [optionQuantity, setOptionQuantity] = useState(1);
  const [optionNote, setOptionNote] = useState('');
  const [editingPrice, setEditingPrice] = useState(false);
  const [customPrice, setCustomPrice] = useState(null);
  const [showBillPreview, setShowBillPreview] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false); // panel chọn nhanh nước/bia/khăn
  const [tableNote, setTableNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null); // { orderId, itemId, itemName }
  const [editItemPrice, setEditItemPrice] = useState(null); // { orderId, itemId, value } — LEGACY, replaced by showPriceModal
  const [editingOrderItem, setEditingOrderItem] = useState(null); // { orderId, itemId } for editing options
  const [showPriceModal, setShowPriceModal] = useState(null); // { orderId, itemId, originalPrice }
  const [priceFixModal, setPriceFixModal] = useState(null); // { items: [{ orderItemId, orderId, name, quantity, price }] } — nhập giá cho món 0đ
  const [priceFixSaving, setPriceFixSaving] = useState(false);
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
  const [editingQty, setEditingQty] = useState({}); // { itemId: stringValue }
  const [confirmPayment, setConfirmPayment] = useState(null); // { table, totalAmount }
  const [paymentModal, setPaymentModal] = useState(null); // { table, total }
  const [bankAccounts, setBankAccounts] = useState([]);
  const [qrAccount, setQrAccount] = useState(null); // selected account for QR
  const [showTransfer, setShowTransfer] = useState(false); // QR sub-screen in payment modal
  const [cancelConfirm, setCancelConfirm] = useState(null); // tableId to cancel
  const [showTableHistory, setShowTableHistory] = useState(null); // table object
  const [tableHistoryData, setTableHistoryData] = useState([]);
  const [tableHistoryLoading, setTableHistoryLoading] = useState(false);
  const [currentStaff, setCurrentStaff] = useState(null); // nhân viên đang đăng nhập (từ localStorage)
  const [historyTab, setHistoryTab] = useState('bills'); // 'bills' | 'opens' — tab trong modal lịch sử
  const [tableOpenLog, setTableOpenLog] = useState([]); // nhật ký mở bàn (6 tiếng)
  const [tableOpenLogLoading, setTableOpenLogLoading] = useState(false);
  const [historySynced, setHistorySynced] = useState(false); // đã bấm Đồng bộ tải lịch sử chưa
  const lastLoggedOpenRef = useRef(null); // chống ghi trùng khi re-render
  const [transactionCode, setTransactionCode] = useState(null);
  const [paymentCountdown, setPaymentCountdown] = useState(0);
  const [qrLoading, setQrLoading] = useState(false);

  const invoiceRef = useRef(null);
  const isFirstLoad = useRef(true);
  // Nhóm bàn đang chạy completeTable() — chặn bấm 2 lần / realtime đua với nút bấm
  const completingTablesRef = useRef(new Set());
  const [payingHostId, setPayingHostId] = useState(null); // để làm mờ & khoá nút khi đang xử lý
  const [isMobile, setIsMobile] = useState(true);
  const [printToast, setPrintToast] = useState(''); // '' | 'sending' | 'ok' | 'err'
  // ── Ưu đãi đánh giá Google Maps ──
  const [reviewRequests, setReviewRequests] = useState([]); // các yêu cầu đang chờ duyệt hôm nay
  const [reviewModal, setReviewModal] = useState(null);     // bản ghi đang xem
  const [reviewPreview, setReviewPreview] = useState(null); // { total, discount, percent }
  const [reviewBusy, setReviewBusy] = useState(false);

  const [kitchenAlertTables, setKitchenAlertTables] = useState({});
  const kitchenAlertTimersRef = useRef({});

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const triggerKitchenAlert = useCallback((tableId) => {
    if (!tableId) return;
    setKitchenAlertTables(prev => ({ ...prev, [tableId]: true }));
    if (kitchenAlertTimersRef.current[tableId]) clearTimeout(kitchenAlertTimersRef.current[tableId]);
    kitchenAlertTimersRef.current[tableId] = setTimeout(() => {
      setKitchenAlertTables(prev => {
        const next = { ...prev };
        delete next[tableId];
        return next;
      });
      delete kitchenAlertTimersRef.current[tableId];
    }, 100000);
  }, []);

  useEffect(() => () => {
    Object.values(kitchenAlertTimersRef.current).forEach(clearTimeout);
  }, []);

  // Nhân viên đang đăng nhập — đọc từ localStorage (do admin/layout.js lưu khi login)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('staffUser');
      if (saved) setCurrentStaff(JSON.parse(saved));
    } catch { }
  }, []);

  // Đóng dấu tên nhân viên vào thao tác (gộp vào payload update/insert)
  const createdStamp = () => currentStaff
    ? { created_by_id: currentStaff.id, created_by_name: currentStaff.full_name }
    : {};
  const cancelStamp = () => ({
    cancelled_at: new Date().toISOString(),
    ...(currentStaff ? { cancelled_by_id: currentStaff.id, cancelled_by_name: currentStaff.full_name } : {}),
  });
  const paidStamp = () => ({
    paid_at: new Date().toISOString(),
    ...(currentStaff ? { paid_by_id: currentStaff.id, paid_by_name: currentStaff.full_name } : {}),
  });

  // Nhãn tên hiển thị: nhân viên → "NV: ...", khách → "KHÁCH: ..."
  const orderWhoLabel = (order) => {
    if (order?.created_by_name) return `NV: ${order.created_by_name}`;
    if (order?.customer_phone === 'Quản lý' || order?.customer_name === 'Admin') return `NV: ${order.customer_name}`;
    return `KHÁCH: ${order?.customer_name || 'Khách'}`;
  };

  // Ghi nhật ký MỞ BÀN — mỗi lần nhân viên mở 1 bàn (để biết ai xem cuối cùng)
  useEffect(() => {
    if (!selectedTable) return;
    // chống ghi trùng khi component re-render mà vẫn cùng 1 lượt mở bàn
    if (lastLoggedOpenRef.current === selectedTable.id) return;
    lastLoggedOpenRef.current = selectedTable.id;
    supabase.from('table_open_log').insert({
      table_id: selectedTable.id,
      table_number: String(selectedTable.table_number ?? ''),
      staff_id: currentStaff?.id || null,
      staff_name: currentStaff?.full_name || null,
    }).then(({ error }) => { if (error) console.error('[table_open_log]', error.message); });
  }, [selectedTable, currentStaff]);
  // reset dấu vết khi đóng bàn để lần mở sau ghi lại
  useEffect(() => { if (!selectedTable) lastLoggedOpenRef.current = null; }, [selectedTable]);

  // Mở modal lịch sử — KHÔNG tự tải, chờ bấm "Đồng bộ" mới tải (tiết kiệm data)
  function openTableHistory(table) {
    setShowTableHistory(table);
    setHistoryTab('bills');
    setTableHistoryData([]);
    setTableOpenLog([]);
    setHistorySynced(false);
  }

  // Tải lịch sử (hoá đơn 8h + lượt mở bàn 6h) khi bấm Đồng bộ
  async function syncTableHistory() {
    const table = showTableHistory;
    if (!table) return;
    setTableHistoryLoading(true);
    setTableOpenLogLoading(true);
    const hId = table.merged_with || table.id;
    const since8 = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
    const since6 = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    try {
      const [billsRes, opensRes] = await Promise.all([
        supabase.from('orders')
          .select('*, order_items(*, menu_item:menu_items(name))')
          .eq('table_id', hId)
          .in('status', ['paid', 'cancelled'])
          .gte('created_at', since8)
          .order('created_at', { ascending: false }),
        supabase.from('table_open_log')
          .select('*')
          .eq('table_id', table.id)
          .gte('opened_at', since6)
          .order('opened_at', { ascending: false }),
      ]);
      setTableHistoryData(billsRes.data || []);
      setTableOpenLog(opensRes.data || []);
      setHistorySynced(true);
    } catch (err) {
      console.error('[syncTableHistory]', err);
    } finally {
      setTableHistoryLoading(false);
      setTableOpenLogLoading(false);
    }
  }

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

  // Tính thẳng từ order_items — KHÔNG dùng cột total_amount cache sẵn trên
  // orders, vì cột đó ghi theo kiểu "đọc rồi ghi" không khoá ở nhiều nơi
  // (thêm/xoá món, áp ưu đãi...) nên có thể lệch thấp hơn số PrintAgent in ra
  // (PrintAgent tự đọc order_items tươi để in). Đây chính là chỗ khiến admin
  // hiện số ít hơn bill in ra tạm tính nếu không tính lại kiểu này.
  const sumOrderItems = (ordersList) =>
    (ordersList || []).reduce((sum, o) =>
      sum + (o.order_items || []).reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0), 0);

  // ─── Gửi lệnh in tới PrintAgent — gộp orders của bàn → 1 phiếu → máy mặc định ───
  const handlePrintInvoice = async () => {
    if (!selectedTable) return;
    const tableOrders = getSelectedTableOrders()
      .filter(o => ['pending', 'preparing', 'completed'].includes(o.status));
    if (tableOrders.length === 0) { alert('Không có đơn hàng để in!'); return; }

    const total = sumOrderItems(tableOrders);
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
    const tableOrders = getSelectedTableOrders()
      .filter(o => ['pending', 'preparing', 'completed'].includes(o.status));
    if (tableOrders.length === 0) { alert('Không có đơn hàng để in!'); return; }

    const total = sumOrderItems(tableOrders);
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
    // Menu + categories đọc từ cache admin (adminMenuCache:v1) — không request
    // server. Cache do admin/menu ghi khi fetchData (mount + sau "Đồng bộ").
    // Nếu cache miss (lần đầu chưa vào admin/menu) → getMenuCached() sẽ tự fetch.
    const [{ data: tablesData }, cachedMenu] = await Promise.all([
      supabase.from('tables').select('*').order('table_number'),
      getMenuCached().catch(err => {
        console.error('[fetchTables] menu cache error:', err.message);
        return { items: [], categories: [] };
      }),
    ]);

    // Lọc + sắp xếp menu client-side (giống filter cũ: is_available + order('name'))
    const menuData = (cachedMenu.items || [])
      .filter(i => i.is_available)
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'vi'));
    const catsData = cachedMenu.categories || [];

    if (tablesData) {
      setTables(tablesData);
      const allTableIds = tablesData.map(t => t.id);
      if (allTableIds.length > 0) {
        try {
          const { data: ordersData, error: ordErr } = await supabase
            .from('orders')
            .select(`
              id, table_id, status, total_amount, customer_name, customer_phone, customer_note, delivery_address, created_at, created_by_name,
              order_items (
                id, quantity, unit_price, item_options, note, is_gift, menu_item_id, item_name, added_by_name,
                menu_item:menu_items (name, price, image_url)
              ),
              print_jobs (id, status, created_at)
            `)
            .in('table_id', allTableIds)
            .in('status', ['pending', 'preparing'])
            .order('created_at', { ascending: false });

          if (ordErr) console.error('[fetchTables] orders error:', ordErr.message);

          const ordersByTable = {};
          ordersData?.forEach(order => {
            if (!ordersByTable[order.table_id]) ordersByTable[order.table_id] = [];
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
    setMenuItems(menuData);
    const finalCats = [...catsData];
    if (menuData.some(i => !i.category_id)) finalCats.push({ id: null, name: 'Chưa phân loại' });
    setCategories(finalCats);
    setLoading(false);
  }, []);

  // ─── Chỉ refresh orders (không fetch lại menu/tables/categories) ───
  const fetchOrdersOnly = useCallback(async () => {
    const currentTableIds = tables.map(t => t.id);
    if (currentTableIds.length === 0) return;
    try {
      const { data: ordersData } = await supabase
        .from('orders')
        .select(`
          id, table_id, status, total_amount, customer_name, customer_phone, customer_note, delivery_address, created_at, created_by_name,
          order_items (
            id, quantity, unit_price, item_options, note, is_gift, menu_item_id, item_name, added_by_name,
            menu_item:menu_items (name, price, image_url)
          ),
          print_jobs (id, status, created_at)
        `)
        .in('table_id', currentTableIds)
        .in('status', ['pending', 'preparing'])
        .order('created_at', { ascending: false });
      const ordersByTable = {};
      ordersData?.forEach(order => {
        if (!ordersByTable[order.table_id]) ordersByTable[order.table_id] = [];
        ordersByTable[order.table_id].push(order);
      });
      setOrders(ordersByTable);
    } catch (e) {
      console.error('[fetchOrdersOnly] error:', e);
    }
  }, [tables]);

  // ─── Debounced refetch scheduler ───────────────────────────────────────────
  // Khi khách gửi 1 đơn N món, Supabase Realtime bắn N+2 event (1 orders INSERT
  // + N order_items INSERT + 1 tables UPDATE). Không debounce → fetchTables()
  // chạy N+2 lần ⇒ (N+2) × 4 request. Gom vào 1 timer 200ms để chỉ fetch 1 lần.
  //
  // pendingFullRef=true khi có event trên bảng `tables` (bàn mới / status đổi)
  // → dùng fetchTables (refetch menu/categories/tables/orders).
  // Ngược lại (chỉ orders / order_items) → fetchOrdersOnly (rẻ hơn nhiều).
  const fetchTablesRef = useRef(null);
  const fetchOrdersOnlyRef = useRef(null);
  const refetchTimerRef = useRef(null);
  const pendingFullRef = useRef(false);

  useEffect(() => { fetchTablesRef.current = fetchTables; }, [fetchTables]);
  useEffect(() => { fetchOrdersOnlyRef.current = fetchOrdersOnly; }, [fetchOrdersOnly]);

  const scheduleRefetch = useCallback((full = false) => {
    if (full) pendingFullRef.current = true;
    if (refetchTimerRef.current) return; // đã có timer đang chờ
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      const doFull = pendingFullRef.current;
      pendingFullRef.current = false;
      if (doFull) fetchTablesRef.current?.();
      else fetchOrdersOnlyRef.current?.();
    }, 200);
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

  // Realtime subscription for auto-confirm payment (Chuyển khoản)
  useEffect(() => {
    if (showTransfer && transactionCode) {
      const channel = supabase
        .channel(`payment_tx_${transactionCode}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'payment_transactions',
          filter: `transaction_code=eq.${transactionCode}`
        }, async (payload) => {
          if (payload.new && payload.new.status === 'completed') {
            // Đóng bill + ghi nhận định mức + xử lý is_hidden_from_stats
            // paymentModal.table chứa thông tin bàn cần đóng
            if (paymentModal?.table) {
              await completeTable(paymentModal.table, 'transfer');
            }
            Swal.fire({
              title: 'Thành công',
              text: 'Hệ thống đã nhận được thanh toán chuyển khoản!',
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
  }, [showTransfer, transactionCode, paymentModal, fetchTables]);

  useEffect(() => {
    fetchTables();
    fetchReviewRequests();

    // Use a unique channel name each mount to avoid stale channel on HMR
    const channelName = `tables-realtime-${Date.now()}`;
    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables' }, () => {
        scheduleRefetch(true); // bàn đổi status/thêm/xoá → cần fetchTables đầy đủ
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        if (payload.eventType === 'INSERT' && !isFirstLoad.current) {
          ringBell();
          if (payload.new?.customer_phone === 'BAO_BEP') {
            triggerKitchenAlert(payload.new.table_id);
          }
        }
        scheduleRefetch(false); // orders đổi → chỉ cần fetchOrdersOnly
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => {
        scheduleRefetch(false); // items đổi → chỉ cần fetchOrdersOnly
      })
      // Khách xin ưu đãi đánh giá Google → kêu chuông + hiện badge trên thẻ bàn
      .on('postgres_changes', { event: '*', schema: 'public', table: 'review_rewards' }, (payload) => {
        if (payload.new?.status === 'awaiting_staff' && !isFirstLoad.current) ringBell();
        fetchReviewRequests();
      })
      .subscribe((status) => {
        console.log('[Realtime] channel status:', status);
      });

    // ── Fallback: poll every 30s in case Supabase Realtime is not enabled ──
    const pollInterval = setInterval(() => {
      fetchTables();
    }, 90000);

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
          .update({ status: 'paid', created_at: new Date().toISOString() })
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

      // ── Auto-cleanup đơn TAKEAWAY treo quá 6h ──
      // Tránh list "Xem đơn" bừa bộn vì admin quên bấm "Đã giao đi"
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const takeawayTable = tables.find(t => t.table_type === 'takeaway');
      if (takeawayTable) {
        await supabase
          .from('orders')
          .update({ kitchen_completed: true, status: 'completed' })
          .eq('table_id', takeawayTable.id)
          .eq('kitchen_completed', false)
          .in('status', ['pending', 'preparing'])
          .lt('created_at', sixHoursAgo);
      }
    }, 60000); // Check every 60 seconds

    return () => {
      supabase.removeChannel(channel);
      clearInterval(autoExpireInterval);
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [fetchTables, scheduleRefetch]);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // completeTable — đóng bill cho một nhóm bàn.
  //
  // CHỐNG CỘNG TIỀN HAI LẦN (2 lớp):
  //   Lớp 1 — client: completingTablesRef chặn lượt gọi trùng cho cùng nhóm bàn
  //           (nhân viên bấm nhanh 2 cái, hoặc realtime auto-confirm đua với nút).
  //   Lớp 2 — database: GIÀNH đơn trước (update status → 'paid'), cộng tiền sau.
  //           Postgres chỉ cho MỘT lượt update khớp status pending/preparing/completed;
  //           lượt thứ hai khớp 0 dòng → thoát, không cộng tiền lần nữa.
  //
  // Thứ tự CŨ (cộng tiền → mới đánh dấu paid) để hở khoảng giữa đọc và ghi:
  // hai lượt gọi cùng đọc được đơn chưa paid → cộng tiền 2 lần vào bank_daily_totals,
  // đẩy thẻ chính đầy hạn mức sớm và làm đóng băng thống kê cả ngày.
  // ═══════════════════════════════════════════════════════════════════════════
  async function completeTable(tableObj, paymentMethod = 'cash', shouldHideStats = false) {
    const table = typeof tableObj === 'object' ? tableObj : { id: tableObj, merged_with: null };
    const hostId = table.merged_with || table.id;

    // ── LỚP 1: nhóm bàn này đang xử lý dở → bỏ qua lượt gọi này ───────────────
    if (completingTablesRef.current.has(hostId)) return false;
    completingTablesRef.current.add(hostId);
    setPayingHostId(hostId);

    try {
      // Lấy tất cả table ID trong nhóm gộp (host + satellites)
      const groupTableIds = [hostId, ...tables.filter(t => t.merged_with === hostId).map(t => t.id)];

      // Chốt cuối cho TIỀN MẶT: tuyệt đối không cho qua khi còn món chưa thêm giá
      // (0đ, không phải món tặng). Chuyển khoản không chặn ở đây vì tiền có thể đã vào tài khoản.
      if (paymentMethod === 'cash') {
        const { data: ordersToCheck } = await supabase
          .from('orders')
          .select('id, order_items(id, quantity, unit_price, is_gift, menu_item_id, menu_item:menu_items(name))')
          .in('table_id', groupTableIds)
          .in('status', ['pending', 'preparing', 'completed']);

        const unpriced = collectUnpricedItems(ordersToCheck || []);
        if (unpriced.length > 0) {
          promptFixUnpricedItems(unpriced);
          return false;
        }
      }

      // ── LỚP 2: GIÀNH đơn — chỉ lượt gọi đầu tiên khớp được dòng nào ──────────
      const { data: claimed, error: claimError } = await supabase
        .from('orders')
        .update({
          status: 'paid',
          payment_method: paymentMethod,
          created_at: new Date().toISOString(),
          ...paidStamp(),
        })
        .in('table_id', groupTableIds)
        .in('status', ['pending', 'preparing', 'completed'])
        // Trả về order_items chứ KHÔNG dùng cột total_amount cache sẵn — cột này
        // được ghi lại bằng kiểu "đọc rồi ghi" ở nhiều chỗ khác (thêm món, xoá
        // món, áp ưu đãi...) không có khoá, nên có thể bị lệch (thấp hơn thực tế)
        // nếu 2 thao tác đụng cùng lúc trên cùng 1 order. Cộng tiền doanh thu ở
        // ĐÂY — sau khi đã khoá order bằng status='paid' — mới là số đúng 100%.
        .select('id, order_items(unit_price, quantity)');

      if (claimError) {
        console.error('[completeTable] Không giành được đơn:', claimError);
        Swal.fire('Lỗi', 'Không đóng được bill. Vui lòng thử lại.', 'error');
        return false;
      }

      // Lượt gọi trước đã xử lý xong nhóm bàn này → KHÔNG cộng tiền, chỉ dọn UI
      if (!claimed || claimed.length === 0) {
        setSelectedTable(null);
        fetchTables();
        return true;
      }

      // ── Cộng tiền đúng theo số đơn vừa giành được (tính thẳng từ order_items) ──
      const totalAmount = claimed.reduce((sum, o) =>
        sum + (o.order_items || []).reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0), 0);
      if (totalAmount > 0) {
        try {
          // RPC atomic — check hạn mức + ghi bank_daily_totals trong 1 transaction
          const { shouldHideStats: autoHide } = await processPaymentAtomic(totalAmount);
          if (!shouldHideStats && autoHide) shouldHideStats = autoHide;
        } catch (err) {
          console.error('[completeTable] Error in processPaymentAtomic:', err);
        }
      }

      // Chỉ ghi cờ ẩn khi thật sự cần. Nếu bước này lỗi, bill vẫn nằm trong thống kê
      // — nghiêng về phía KHAI ĐỦ, an toàn hơn là âm thầm giấu doanh thu.
      if (shouldHideStats) {
        await supabase
          .from('orders')
          .update({ is_hidden_from_stats: true })
          .in('id', claimed.map(o => o.id));
      }

      // Reset toàn bộ nhóm bàn gộp
      await supabase
        .from('tables')
        .update({ status: 'available', occupied_at: null, merged_with: null })
        .or(`id.eq.${hostId},merged_with.eq.${hostId}`);

      setSelectedTable(null);
      fetchTables();
      return true;
    } finally {
      completingTablesRef.current.delete(hostId);
      setPayingHostId(null);
    }
  }

  // Lấy hoặc sinh mã Bill Code cố định cho đơn hàng
  // Món "chưa thêm giá" = unit_price <= 0 VÀ KHÔNG phải món tặng (is_gift=false).
  // Món tặng để giá 0 là hợp lệ nên bỏ qua. Trả về mảng chi tiết (kèm id để cập nhật).
  function collectUnpricedItems(bills) {
    const items = [];
    (bills || []).forEach(o => {
      // Bỏ qua order hệ thống "Gọi nhân viên" (BAO_BEP) — món của nó là placeholder 0đ, không phải món ăn
      if (o.customer_phone === 'BAO_BEP') return;
      (o.order_items || []).forEach(it => {
        // menu_item_id == null = món hệ thống (báo bếp...), không phải món tính tiền → bỏ qua
        if (!it.is_gift && it.menu_item_id != null && (Number(it.unit_price) || 0) <= 0) {
          items.push({
            orderItemId: it.id,
            orderId: o.id,
            name: it.menu_item?.name || it.item_name || 'Món chưa đặt tên',
            quantity: Number(it.quantity) || 1,
          });
        }
      });
    });
    return items;
  }

  // Nếu còn món chưa thêm giá → mở modal nhập giá cho từng món. Trả về true nếu CÓ (đã chặn).
  function promptFixUnpricedItems(items) {
    if (!items || items.length === 0) return false;
    setPriceFixModal({ items: items.map(it => ({ ...it, price: '' })) });
    return true;
  }

  // Lưu giá đã nhập cho từng món 0đ, rồi cộng dồn lại total_amount của các bill liên quan.
  async function saveFixedPrices() {
    const rawItems = priceFixModal?.items || [];
    const parsed = rawItems.map(it => ({
      ...it,
      priceNum: Number(String(it.price).replace(/[^\d]/g, '')) || 0,
    }));
    if (parsed.some(p => p.priceNum <= 0)) {
      Swal.fire('Thiếu giá', 'Vui lòng nhập giá lớn hơn 0đ cho tất cả các món.', 'warning');
      return;
    }
    setPriceFixSaving(true);
    try {
      // 1. Cập nhật đơn giá từng món
      for (const p of parsed) {
        await supabase.from('order_items').update({ unit_price: p.priceNum }).eq('id', p.orderItemId);
      }
      // 2. Tính lại tổng tiền các bill bị ảnh hưởng (đọc lại từ DB để chắc chắn)
      const orderIds = [...new Set(parsed.map(p => p.orderId))];
      for (const oid of orderIds) {
        const { data: rows } = await supabase
          .from('order_items').select('unit_price, quantity').eq('order_id', oid);
        const newTotal = (rows || []).reduce(
          (s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0
        );
        await supabase.from('orders').update({ total_amount: newTotal }).eq('id', oid);
      }
      setPriceFixModal(null);
      await fetchOrdersOnly();
      Swal.fire({
        icon: 'success',
        title: '✅ Đã cập nhật giá',
        text: 'Đã cộng dồn tiền các món vào bill. Bạn có thể thanh toán.',
        timer: 2500, timerProgressBar: true, showConfirmButton: false,
        position: 'top-end', toast: true, background: '#16a34a', color: '#fff', iconColor: '#fff',
      });
    } catch (err) {
      console.error('[saveFixedPrices] error:', err);
      Swal.fire('Lỗi', 'Không lưu được giá. Vui lòng thử lại.', 'error');
    } finally {
      setPriceFixSaving(false);
    }
  }

  async function getFreshPaymentSnapshot(tableObj) {
    const table = typeof tableObj === 'object' ? tableObj : { id: tableObj, merged_with: null };
    const hostId = table.merged_with || table.id;

    // Lấy tất cả table ID trong nhóm gộp (host + satellites)
    const { data: _allTables } = await supabase.from('tables').select('id, merged_with');
    const _freshGroupIds = [hostId, ...(_allTables || []).filter(t => t.merged_with === hostId).map(t => t.id)];

    const { data, error } = await supabase
      .from('orders')
      .select('id, total_amount, customer_phone, order_items(id, quantity, unit_price, is_gift, menu_item_id, menu_item:menu_items(name))')
      .in('table_id', _freshGroupIds)
      .in('status', ['pending', 'preparing', 'completed'])
      .order('created_at', { ascending: true });

    if (error) throw error;

    const bills = data || [];
    return {
      hostId,
      bills,
      unpricedItems: collectUnpricedItems(bills),
      orderIdsStr: bills.map(o => o.id).sort().join(','),
      // Tính THẲNG từ order_items vừa fetch — KHÔNG dùng cột total_amount cache
      // sẵn trên orders. Cột đó được ghi kiểu "đọc rồi ghi" không khoá ở nhiều
      // nơi (thêm/xoá món, áp ưu đãi...), nên có thể bị lệch THẤP hơn thực tế
      // nếu 2 thao tác đụng cùng lúc trên cùng order — số tiền yêu cầu chuyển
      // khoản QR/tiền mặt phải đúng 100% nên không được tin cột cache ở đây.
      // Chặn âm: nếu NV xoá hết món sau khi ưu đãi đã được duyệt, dòng giảm giá
      // còn lại sẽ làm tổng nhóm âm → QR mất số tiền, giao dịch ghi số âm.
      total: Math.max(0, bills.reduce((sum, o) =>
        sum + (o.order_items || []).reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0), 0)),
    };
  }

  async function getOrGenerateBillCode(hostId, total, finalAccId = null, freshBills = null) {
    const tableBills = freshBills || orders[hostId] || [];
    if (tableBills.length === 0) return null;
    
    // Sort to keep the string identical for the same set of orders
    const orderIdsStr = [...tableBills].map(o => o.id).sort().join(',');

    // Check if there is already a pending transaction for exactly these orders
    const { data: existingTx } = await supabase
      .from('payment_transactions')
      .select('transaction_code, total_amount')
      .eq('order_ids', orderIdsStr)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingTx && existingTx.transaction_code) {
      if (Number(existingTx.total_amount) !== Number(total)) {
        await supabase
          .from('payment_transactions')
          .update({ total_amount: total, account_id: finalAccId })
          .eq('transaction_code', existingTx.transaction_code);
      }
      return existingTx.transaction_code;
    }

    // Nếu chưa có, sinh mã mới
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];

    await supabase.from('payment_transactions').insert({
      transaction_code: code,
      order_ids: orderIdsStr,
      account_id: finalAccId,
      total_amount: total,
      status: 'pending'
    });

    return code;
  }

  // ── Smart bank account rotation (strict: no buffer) ──
  async function openPaymentModal(table, total) {
    setTransactionCode(null);
    setPaymentModal({ table, total, mode: 'transfer' });
    setQrAccount(null);
    setQrLoading(true);
    setShowTransfer(true);
    setPaymentCountdown(300);

    try {
      const snapshot = await getFreshPaymentSnapshot(table);
      if (snapshot.unpricedItems.length > 0) {
        setPaymentModal(null);
        setConfirmPayment(null);
        promptFixUnpricedItems(snapshot.unpricedItems);
        return;
      }
      if (snapshot.total <= 0 || snapshot.bills.length === 0) {
        setPaymentModal(null);
        setConfirmPayment(null);
        Swal.fire('Lỗi', 'Tổng tiền thanh toán đang là 0đ. Vui lòng tải lại bàn và kiểm tra món trước khi tạo QR.', 'error');
        return;
      }

      setPaymentModal({ table, total: snapshot.total, mode: 'transfer' });

      const { account, overLimit, shouldHideStats } = await getActiveAccount(snapshot.total);
      const finalAcc = account ? { ...account, overLimit, shouldHideStats } : null;
      setQrAccount(finalAcc);

      const code = await getOrGenerateBillCode(snapshot.hostId, snapshot.total, finalAcc?.id || null, snapshot.bills);

      if (code) {
        setTransactionCode(code);
      }
    } finally {
      setQrLoading(false);
    }
  }

  async function recordBankPayment(accountId, amount) {
    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
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
  // ══════════════════════════════════════════════════════════
  //  ƯU ĐÃI ĐÁNH GIÁ GOOGLE MAPS — nhân viên duyệt
  // ══════════════════════════════════════════════════════════
  const fetchReviewRequests = useCallback(async () => {
    const { data, error } = await supabase
      .from('review_rewards')
      .select('*')
      .eq('status', 'awaiting_staff')
      .gte('created_at', startOfTodayISO())
      .order('requested_at', { ascending: true });
    if (error) {
      // Chưa chạy migration thì im lặng bỏ qua, không làm hỏng màn hình bàn
      if (error.code !== '42P01') console.error('[fetchReviewRequests]', error.message);
      return;
    }
    setReviewRequests(data || []);
  }, []);

  // Toàn bộ table id của nhóm gộp (host + satellites)
  function groupTableIds(hostId) {
    return [hostId, ...tables.filter(t => t.merged_with === hostId).map(t => t.id)];
  }

  async function openReviewModal(reward) {
    setReviewModal(reward);
    setReviewPreview(null);
    const cfg = await fetchChannelConfig(supabase, reward.channel);
    const { data } = await supabase
      .from('orders')
      .select('id, customer_phone, order_items(unit_price, quantity)')
      .in('table_id', groupTableIds(reward.host_table_id))
      .in('status', ['pending', 'preparing', 'completed'])
      .gte('created_at', startOfTodayISO());
    const total = sumOrderItems((data || []).filter(o => o.customer_phone !== 'BAO_BEP'));
    setReviewPreview({ total, discount: calcReviewDiscount(total, cfg), percent: cfg.percent, cfg });
  }

  async function approveReviewReward(reward) {
    setReviewBusy(true);
    try {
      const cfg = await fetchChannelConfig(supabase, reward.channel);
      const ids = groupTableIds(reward.host_table_id);

      const { data: groupOrders } = await supabase
        .from('orders')
        .select('id, customer_phone, created_at, order_items(unit_price, quantity)')
        .in('table_id', ids)
        .in('status', ['pending', 'preparing', 'completed'])
        .gte('created_at', startOfTodayISO())
        .order('created_at', { ascending: true });

      const bills = (groupOrders || []).filter(o => o.customer_phone !== 'BAO_BEP');
      if (bills.length === 0) {
        Swal.fire({ icon: 'warning', title: 'Bàn chưa có bill', text: 'Không có hoá đơn nào để giảm giá.' });
        setReviewBusy(false);
        return;
      }

      const total = sumOrderItems(bills);
      const discount = calcReviewDiscount(total, cfg);
      if (discount <= 0) {
        Swal.fire({ icon: 'warning', title: 'Không tính được mức giảm', text: 'Kiểm tra lại % giảm trong Cài đặt hoặc tổng bill của bàn.' });
        setReviewBusy(false);
        return;
      }

      // Chốt trạng thái TRƯỚC khi chèn dòng giảm giá — unique index trong DB
      // sẽ chặn nếu bàn này đã được duyệt hôm nay (2 máy bấm cùng lúc).
      const { data: locked, error: lockErr } = await supabase
        .from('review_rewards')
        .update({
          status: 'approved',
          bill_total: total,
          discount_percent: cfg.percent,
          discount_amount: discount,
          approved_by: currentStaff?.full_name || null,
          decided_at: new Date().toISOString(),
        })
        .eq('id', reward.id)
        .eq('status', 'awaiting_staff')
        .select()
        .maybeSingle();

      if (lockErr || !locked) {
        Swal.fire({
          icon: 'info', title: 'Không duyệt được',
          text: lockErr?.code === '23505'
            ? `Bàn này đã được duyệt ưu đãi "${cfg.name}" hôm nay rồi.`
            : 'Yêu cầu đã được xử lý ở máy khác.',
        });
        await fetchReviewRequests();
        setReviewModal(null);
        setReviewBusy(false);
        return;
      }

      // Chèn dòng giảm giá (giá âm) vào bill cũ nhất của nhóm
      const targetOrderId = bills[0].id;
      const { data: item, error: itemErr } = await supabase
        .from('order_items')
        .insert({
          order_id: targetOrderId,
          menu_item_id: null,
          item_name: cfg.discountLabel,
          quantity: 1,
          unit_price: -discount,
          is_gift: false,
          ...(currentStaff ? { added_by_id: currentStaff.id, added_by_name: currentStaff.full_name } : {}),
        })
        .select()
        .maybeSingle();

      if (itemErr || !item) {
        // Trả lại trạng thái để không "duyệt rồi mà không trừ tiền"
        await supabase.from('review_rewards')
          .update({ status: 'awaiting_staff', decided_at: null, approved_by: null })
          .eq('id', reward.id);
        Swal.fire({ icon: 'error', title: 'Chưa trừ được tiền', text: itemErr?.message || 'Vui lòng thử lại.' });
        setReviewBusy(false);
        return;
      }

      // Tính lại tổng của bill vừa chèn — đọc từ DB cho chắc
      const { data: itemsNow } = await supabase
        .from('order_items').select('unit_price, quantity').eq('order_id', targetOrderId);
      const newTotal = (itemsNow || []).reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
      await supabase.from('orders').update({ total_amount: newTotal }).eq('id', targetOrderId);

      await supabase.from('review_rewards')
        .update({ applied_order_id: targetOrderId, applied_item_id: item.id })
        .eq('id', reward.id);

      setReviewModal(null);
      await fetchReviewRequests();
      fetchOrdersOnly();

      Swal.fire({
        icon: 'success', title: 'Đã duyệt',
        text: `Đã giảm ${discount.toLocaleString('vi-VN')}đ vào bill của bàn.`,
        timer: 2200, showConfirmButton: false, toast: true, position: 'top-end',
      });
    } catch (err) {
      console.error('[approveReviewReward]', err);
      Swal.fire({ icon: 'error', title: 'Lỗi', text: err.message || 'Không duyệt được yêu cầu.' });
    }
    setReviewBusy(false);
  }

  async function rejectReviewReward(reward) {
    const { value: reason, isConfirmed } = await Swal.fire({
      title: 'Từ chối yêu cầu?',
      input: 'text',
      inputPlaceholder: 'Lý do (khách sẽ thấy) — có thể bỏ trống',
      showCancelButton: true,
      confirmButtonText: 'Từ chối',
      cancelButtonText: 'Huỷ',
      confirmButtonColor: '#dc2626',
    });
    if (!isConfirmed) return;

    setReviewBusy(true);
    await supabase.from('review_rewards').update({
      status: 'rejected',
      reject_reason: (reason || '').trim() || 'Nhân viên chưa xác nhận được lượt đánh giá.',
      approved_by: currentStaff?.full_name || null,
      decided_at: new Date().toISOString(),
    }).eq('id', reward.id).eq('status', 'awaiting_staff');
    setReviewBusy(false);
    setReviewModal(null);
    await fetchReviewRequests();
  }

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
        .select(`id, order_items( id, quantity, is_gift, created_at, item_options, menu_items( id, counts_for_promotion, options ) )`)
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
            let divisor = null;
            // 1. Check choice-specific divisor
            if (it.item_options && Array.isArray(it.item_options) && it.menu_items.options) {
              for (const opt of it.item_options) {
                const menuOpt = it.menu_items.options.find(o => o.name === opt.name);
                if (menuOpt && menuOpt.choices && menuOpt.promoDivisors) {
                  const choiceIdx = menuOpt.choices.indexOf(opt.choice);
                  if (choiceIdx !== -1 && menuOpt.promoDivisors[choiceIdx]) {
                    divisor = Number(menuOpt.promoDivisors[choiceIdx]);
                    if (!isNaN(divisor) && divisor > 0) break;
                  }
                }
              }
            }
            // 2. Fallback to default divisor
            if (!divisor || isNaN(divisor) || divisor <= 0) {
              const promoOpt = (it.menu_items.options || []).find(o => o.__promo_divisor);
              divisor = promoOpt ? promoOpt.__promo_divisor : 1;
            }
            qualifyingQty += it.quantity / divisor;
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
    await supabase.from('order_items').delete().eq('id', itemId);

    // Tính total locally: bỏ item vừa xóa ra khỏi mảng hiện tại
    const orderNow = Object.values(orders).flat().find(o => o.id === orderId);
    const newTotal = (orderNow?.order_items || [])
      .filter(i => i.id !== itemId)
      .reduce((s, i) => s + i.unit_price * i.quantity, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);

    await syncOrderPromotions(orderId);
    fetchOrdersOnly();
  }

  async function updateItemQuantity(orderId, itemId, currentQuantity, change) {
    const newQuantity = currentQuantity + change;
    if (newQuantity <= 0) return removeItemFromOrder(orderId, itemId);

    // Optimistic: cập nhật local state ngay lập tức
    setOrders(prev => {
      const next = { ...prev };
      for (const tableId in next) {
        next[tableId] = next[tableId].map(order => {
          if (order.id !== orderId) return order;
          const updatedItems = (order.order_items || []).map(i =>
            i.id === itemId ? { ...i, quantity: newQuantity } : i
          );
          const newTotal = updatedItems.reduce((s, i) => s + i.unit_price * i.quantity, 0);
          return { ...order, order_items: updatedItems, total_amount: newTotal };
        });
      }
      return next;
    });

    // Tính total từ local state (không cần query lại DB)
    const orderNow = Object.values(orders).flat().find(o => o.id === orderId);
    const itemsNow = (orderNow?.order_items || []).map(i =>
      i.id === itemId ? { ...i, quantity: newQuantity } : i
    );
    const newTotal = itemsNow.reduce((s, i) => s + i.unit_price * i.quantity, 0);

    // 2 API calls song song thay vì 3 tuần tự
    await Promise.all([
      supabase.from('order_items').update({ quantity: newQuantity }).eq('id', itemId),
      supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId),
    ]);

    await syncOrderPromotions(orderId);
    // Chỉ refresh orders, không fetch lại toàn bộ
    fetchOrdersOnly();
  }

  async function updateItemPrice(orderId, itemId, newPrice) {
    if (newPrice == null || newPrice < 0) return;
    await supabase.from('order_items').update({ unit_price: newPrice }).eq('id', itemId);
    // Tính lại total locally
    const orderNow = Object.values(orders).flat().find(o => o.id === orderId);
    const newTotal = (orderNow?.order_items || []).reduce((s, i) =>
      s + (i.id === itemId ? newPrice : i.unit_price) * i.quantity, 0
    );
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);
    setEditItemPrice(null);
    setShowPriceModal(null);
    setDiscountValue(0);
    setDiscountMode('VND');
    setCustomNewPrice(null);
    fetchOrdersOnly();
  }

  async function updateOrderItemOptions(orderId, itemId, newOptions, note, newPrice = null, newQty = null) {
    const updatePayload = { item_options: newOptions, note: note || '' };
    if (newPrice != null && newPrice >= 0) updatePayload.unit_price = newPrice;
    if (newQty != null && newQty > 0) updatePayload.quantity = newQty;
    await supabase.from('order_items').update(updatePayload).eq('id', itemId);

    // Tính lại total locally (không cần query DB)
    const orderNow = Object.values(orders).flat().find(o => o.id === orderId);
    const newTotal = (orderNow?.order_items || []).reduce((s, i) => {
      if (i.id !== itemId) return s + i.unit_price * i.quantity;
      const price = newPrice != null && newPrice >= 0 ? newPrice : i.unit_price;
      const qty = newQty != null && newQty > 0 ? newQty : i.quantity;
      return s + price * qty;
    }, 0);
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);

    setEditingOrderItem(null);
    setOptionModalItem(null);
    setSelectedOptions({});
    setOptionNote('');
    fetchOrdersOnly();
  }

  const decreaseItemFromMenu = async (menuItemId) => {
    const _currentOrders = selectedTable ? getSelectedTableOrders() : [];
    const activeOrder = _currentOrders.length > 0
      ? (_currentOrders.find(o => o.customer_name === 'Admin') || _currentOrders[0])
      : null;

    if (!activeOrder) return;

    const existingItems = activeOrder.order_items?.filter(oi => oi.menu_item_id === menuItemId) || [];
    if (existingItems.length === 0) return;

    // Pick the last added item variant directly to decrement
    const existing = existingItems[existingItems.length - 1];
    await updateItemQuantity(activeOrder.id, existing.id, existing.quantity, -1);
  };


  // ─── Draft Cart helpers (0 API calls, chỉ cập nhật local state) ───────────
  // Tính giá món theo lựa chọn hiện tại.
  // - Chỉ NHÓM option có định giá (ít nhất 1 choice > 0đ) mới ảnh hưởng giá (vd nhóm "Loại").
  //   Nhóm không định giá (vd "Khẩu vị") bị bỏ qua, không làm đổi giá.
  // - Trong nhóm định giá: choice CÓ giá → dùng giá đó; choice ĐỂ TRỐNG → 0đ.
  // - Trả về number (có thể 0) nếu có nhóm định giá; null nếu KHÔNG nhóm nào định giá (→ dùng giá gốc món).
  function getChoiceDerivedPrice(menuItem, selectedOpts) {
    let total = null;
    (menuItem?.options || []).forEach(opt => {
      if (!opt.name || !opt.choices || !Array.isArray(opt.prices)) return;
      const groupHasPrice = opt.prices.some(p => p != null && String(p).trim() !== '' && Number(p) > 0);
      if (!groupHasPrice) return;
      const sel = selectedOpts?.[opt.name];
      const cIdx = opt.choices.indexOf(sel);
      const raw = cIdx >= 0 ? opt.prices[cIdx] : null;
      const num = (raw != null && String(raw).trim() !== '') ? Number(raw) : 0;
      total = (total || 0) + (isNaN(num) ? 0 : num);
    });
    return total;
  }

  function getInitialOptionSelection(menuItem) {
    const initialOptions = {};
    (menuItem.options || []).forEach(opt => {
      if (opt.name && opt.choices && opt.choices.length > 0) {
        initialOptions[opt.name] = opt.choices[0];
      }
    });
    const initialPrice = getChoiceDerivedPrice(menuItem, initialOptions);
    return { initialOptions, initialPrice };
  }

  function addToDraft(menuItem, options = [], qty = 1, note = '', price = null) {
    // Nếu món có options mà chưa chọn → mở modal trước
    if (menuItem.options && menuItem.options.length > 0 && options.length === 0) {
      const { initialOptions, initialPrice } = getInitialOptionSelection(menuItem);
      setOptionModalItem(menuItem);
      setSelectedOptions(initialOptions);
      setOptionQuantity(1);
      setOptionNote('');
      setEditingPrice(false);
      setCustomPrice(initialPrice);
      return;
    }
    const finalPrice = price != null ? price : menuItem.price;
    const optsKey = JSON.stringify(options);
    setDraftCart(prev => {
      const idx = prev.findIndex(d =>
        d.menuItemId === menuItem.id &&
        JSON.stringify(d.options) === optsKey &&
        (d.note || '') === (note || '')
      );
      if (idx !== -1) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + qty };
        return next;
      }
      return [...prev, { menuItemId: menuItem.id, menuItem, qty, options, note: note || '', price: finalPrice }];
    });
  }

  function decreaseFromDraft(menuItemId) {
    setDraftCart(prev => {
      let lastIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].menuItemId === menuItemId) { lastIdx = i; break; }
      }
      if (lastIdx === -1) return prev;
      const next = [...prev];
      if (next[lastIdx].qty <= 1) {
        next.splice(lastIdx, 1);
      } else {
        next[lastIdx] = { ...next[lastIdx], qty: next[lastIdx].qty - 1 };
      }
      return next;
    });
  }

  function setDraftQuantity(menuItemId, newQty) {
    if (newQty <= 0) {
      setDraftCart(prev => prev.filter(item => item.menuItemId !== menuItemId));
      return;
    }
    setDraftCart(prev => {
      let lastIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].menuItemId === menuItemId) { lastIdx = i; break; }
      }
      if (lastIdx === -1) return prev;
      const next = [...prev];
      next[lastIdx] = { ...next[lastIdx], qty: newQty };
      return next;
    });
  }

  // ─── Xác nhận draft: gửi tất cả items lên server 1 lần ─────────────────────
  async function confirmDraft() {
    if (draftCart.length === 0 || !selectedTable) return;
    setIsConfirmingDraft(true);
    try {
      // Gộp toàn bộ luồng (tìm/tạo order Admin → ghi món → tính lại tổng) thành
      // 1 lệnh RPC duy nhất — trước đây 5 round-trip tuần tự, mạng quán chập
      // chờn làm độ trễ từng round-trip cộng dồn lại (xem confirm_draft_order_rpc.sql).
      const { data, error } = await supabase.rpc('confirm_draft_order', {
        p_table_id: selectedTable.merged_with || selectedTable.id,
        p_items: draftCart.map(draft => ({
          menu_item_id: draft.menuItemId,
          quantity: draft.qty,
          unit_price: draft.price,
          item_options: draft.options || [],
          note: draft.note || '',
        })),
        p_staff_id: currentStaff?.id || null,
        p_staff_name: currentStaff?.full_name || null,
      });
      if (error) throw error;

      // Sync khuyến mãi (không await — chạy ngầm)
      if (data?.order_id) syncOrderPromotions(data.order_id);

      // Clear draft, đóng modal, refresh
      setDraftCart([]);
      setAddingToOrder(null);
      setAddItemSearch('');
      fetchOrdersOnly();
    } catch (err) {
      console.error('[confirmDraft] error:', err);
    } finally {
      setIsConfirmingDraft(false);
    }
  }

  // ─── Legacy addItemToOrder: chỉ dùng cho các path ngoài menu modal ──────────
  async function addItemToOrder(orderId, menuItem, optionsData = [], qty = 1, note = '') {
    // Nếu gọi từ menu modal → chuyển sang draft
    if (orderId === 'admin') {
      addToDraft(menuItem, optionsData, qty, note, null);
      return;
    }
    // Các path khác (giữ nguyên logic cũ)
    const optionsJsonb = optionsData.length > 0 ? optionsData : [];
    const { data: existingItems } = await supabase
      .from('order_items').select('*')
      .eq('order_id', orderId).eq('menu_item_id', menuItem.id);
    const staffId = currentStaff?.id || null;
    let existing = null;
    if (existingItems?.length > 0) {
      existing = existingItems.find(item => {
        return JSON.stringify(item.item_options || []) === JSON.stringify(optionsJsonb) &&
          (item.note || '') === note &&
          (item.added_by_id || null) === staffId;
      });
    }
    if (existing) {
      await supabase.from('order_items').update({ quantity: existing.quantity + qty }).eq('id', existing.id);
    } else {
      await supabase.from('order_items').insert({
        order_id: orderId, menu_item_id: menuItem.id, quantity: qty,
        unit_price: menuItem.price, item_options: optionsJsonb, note,
        ...(currentStaff ? { added_by_id: currentStaff.id, added_by_name: currentStaff.full_name } : {}),
      });
    }
    const orderNow = Object.values(orders).flat().find(o => o.id === orderId);
    const newTotal = existing
      ? (orderNow?.order_items || []).reduce((s, i) => s + i.unit_price * (i.id === existing.id ? existing.quantity + qty : i.quantity), 0)
      : (orderNow?.order_items || []).reduce((s, i) => s + i.unit_price * i.quantity, 0) + menuItem.price * qty;
    await supabase.from('orders').update({ total_amount: newTotal }).eq('id', orderId);
    syncOrderPromotions(orderId);
    fetchOrdersOnly();
  }

  function handleConfirmOptions() {
    if (!optionModalItem) return;
    const optionsData = Object.keys(selectedOptions).map(key => ({
      name: key,
      choice: selectedOptions[key]
    }));
    const finalPrice = customPrice; // lưu trước khi clear
    const itemWithPrice = finalPrice != null ? { ...optionModalItem, price: finalPrice } : optionModalItem;
    setEditingPrice(false);
    setCustomPrice(null);

    if (editingOrderItem) {
      // EDIT món có sẵn trong bill → vẫn push thẳng lên server
      updateOrderItemOptions(editingOrderItem.orderId, editingOrderItem.itemId, optionsData, optionNote, finalPrice, optionQuantity);
    } else {
      // Món MỚI → thêm vào draft (không push server)
      const price = finalPrice ?? optionModalItem.price;
      addToDraft(itemWithPrice, optionsData, optionQuantity, optionNote, price);
      setOptionModalItem(null);
      setSelectedOptions({});
      setOptionQuantity(1);
      setOptionNote('');
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
      // Nếu bàn này đang là host của nhóm khác, kéo cả satellite của nó về hostId luôn
      const targetHostId = targetTable.merged_with || targetTable.id;
      if (targetHostId !== hostId && targetHostId !== sid) {
        // Chỉ cập nhật merged_with của các satellite con, KHÔNG di chuyển orders
        await supabase.from('tables')
          .update({ merged_with: hostId })
          .eq('merged_with', targetHostId);
      }
      // Chỉ cập nhật merged_with, KHÔNG đụng đến table_id của orders
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
    const tableBills = getSelectedTableOrders();
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

    // Lấy bill tạo đầu tiên làm bill gốc
    const sortedBills = [...tableBills].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const mainBill = sortedBills[0];
    const allBillIds = sortedBills.map(b => b.id);
    const otherIds = allBillIds.filter(id => id !== mainBill.id);

    // Fetch toàn bộ món của tất cả các bills
    const { data: allItems, error: fetchErr } = await supabase
      .from('order_items')
      .select('*')
      .in('order_id', allBillIds);

    if (fetchErr) {
      Swal.fire('Lỗi', 'Lỗi khi lấy dữ liệu món ăn: ' + fetchErr.message, 'error');
      return;
    }

    // Nhóm các món lại bằng key duy nhất (gộp qty nếu giống nhau)
    const groupedMap = {};
    allItems.forEach(item => {
      const optsString = item.item_options ? JSON.stringify(item.item_options) : '[]';
      // item_name nằm trong key: các dòng giảm giá ưu đãi (menu_item_id null)
      // của 2 kênh khác nhau mà tình cờ cùng số tiền sẽ KHÔNG bị gộp làm một,
      // để bill vẫn ghi rõ giảm vì kênh nào.
      const key = `${item.menu_item_id}_${item.unit_price}_${optsString}_${item.note || ''}_${item.is_gift ? 'gift' : 'normal'}_${item.item_name || ''}`;

      if (!groupedMap[key]) {
        groupedMap[key] = {
          order_id: mainBill.id, // Sẽ đẩy vào main bill
          menu_item_id: item.menu_item_id,
          quantity: 0,
          unit_price: item.unit_price,
          item_options: item.item_options,
          note: item.note,
          is_gift: item.is_gift,
          item_name: item.item_name || null
        };
      }
      groupedMap[key].quantity += item.quantity;
    });

    const newItems = Object.values(groupedMap);

    // Tổng mới không cộng tiền từ quà tặng `is_gift` hoặc áp dụng logic riêng (nếu món không phải quà tặng thì cộng)
    let newTotal = 0;
    newItems.forEach(i => {
      if (!i.is_gift) {
        newTotal += Number(i.unit_price) * Number(i.quantity);
      }
    });

    // === THỰC THI ATOMIC BẰNG RPC ===
    const { error: rpcErr } = await supabase.rpc('merge_bills_atomic', {
      p_all_bill_ids: allBillIds,
      p_main_bill_id: mainBill.id,
      p_other_bill_ids: otherIds,
      p_new_total: newTotal,
      p_new_items: newItems
    });

    if (rpcErr) {
      Swal.fire('Lỗi', 'Gộp bill thất bại, dữ liệu được bảo toàn! ' + rpcErr.message, 'error');
      return;
    }

    fetchTables();
    Swal.fire({
      title: 'Thành công',
      text: 'Đã gộp đơn và dồn các món! (Các bill phụ đã chuyển sang Huỷ)',
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
        if (opt.name && opt.choices && opt.choices.length > 0 && opt.prices) {
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

  // Lấy TẤT CẢ đơn hàng của nhóm bàn gộp (host + satellites)
  // Đọc orders theo từng table id, không dựa vào table_id bên trong order
  function getSelectedTableOrders() {
    if (!selectedTable) return [];
    const hostId = selectedTable.merged_with || selectedTable.id;
    // Orders của bàn chính
    let allOrders = [...(orders[hostId] || [])];
    // Orders của tất cả bàn phụ đang gộp vào bàn chính này
    tables.forEach(t => {
      if (t.merged_with === hostId && t.id !== hostId) {
        const satelliteOrders = orders[t.id] || [];
        allOrders = [...allOrders, ...satelliteOrders];
      }
    });
    return allOrders;
  }

  const availableCount = tables.filter(t => t.status === 'available' && t.table_type !== 'takeaway').length;
  const occupiedCount = tables.filter(t => t.status === 'occupied' && t.table_type !== 'takeaway').length;

  const fetchTakeawayOrders = async () => {
    const takeawayTable = tables.find(t => t.table_type === 'takeaway');
    if (!takeawayTable) return;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    // 1. Lấy TẤT CẢ đơn takeaway hôm nay kèm SĐT để build seq map theo khách
    const { data: allToday } = await supabase
      .from('orders')
      .select('id, created_at, customer_phone')
      .eq('table_id', takeawayTable.id)
      .gte('created_at', startOfDay)
      .lt('created_at', endOfDay)
      .order('created_at', { ascending: true });

    // Group theo SĐT (giữ thứ tự xuất hiện đầu tiên), khách mỗi SĐT chia sẻ 1 base code,
    // đơn đầu plain (TW-013), đơn sau thêm suffix (TW-013-2, TW-013-3...)
    const customerOrderMap = new Map();
    const customerFirstSeen = [];
    for (const order of (allToday || [])) {
      const phone = (order.customer_phone || '').trim() || `__anon_${order.id}`;
      if (!customerOrderMap.has(phone)) {
        customerOrderMap.set(phone, []);
        customerFirstSeen.push(phone);
      }
      customerOrderMap.get(phone).push(order);
    }
    const codeMap = new Map();
    customerFirstSeen.forEach((phone, custIdx) => {
      const baseCode = `TW-${String(custIdx + 1).padStart(3, '0')}`;
      const orders = customerOrderMap.get(phone);
      orders.forEach((order, orderIdx) => {
        codeMap.set(order.id, orderIdx === 0 ? baseCode : `${baseCode} Bill ${orderIdx + 1}`);
      });
    });

    // 2. Lấy đơn đang chờ giao để hiển thị
    const { data } = await supabase
      .from('orders')
      .select('*, order_items(*, menu_item:menu_items(name, price))')
      .eq('table_id', takeawayTable.id)
      .eq('kitchen_completed', false)
      .in('status', ['pending', 'preparing'])
      .order('created_at', { ascending: false });

    setTakeawayOrders((data || []).map(o => ({
      ...o,
      orderIds: [o.id],
      displayCode: codeMap.get(o.id) || '',
    })));
  };

  const completeKitchenOrder = async (orderIds) => {
    const ids = Array.isArray(orderIds) ? orderIds : [orderIds];
    await supabase.from('orders').update({ kitchen_completed: true, status: 'completed' }).in('id', ids);
    setTakeawayOrders(prev => prev.filter(o => !o.orderIds?.some(id => ids.includes(id))));
  };

  const cancelTakeawayOrder = async (orderIds, displayCode) => {
    const ids = Array.isArray(orderIds) ? orderIds : [orderIds];
    const confirmed = window.confirm(
      `Huỷ đơn ${displayCode || ''}?\n\nĐơn này sẽ chuyển sang trạng thái "Đã huỷ" và biến mất khỏi danh sách.`
    );
    if (!confirmed) return;
    await supabase
      .from('orders')
      .update({ kitchen_completed: true, status: 'cancelled', payment_method: 'cancelled', ...cancelStamp() })
      .in('id', ids);
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
      {/* Thông báo đơn hàng mới — dùng tiếng chuông Web Audio (xem ringBell()) thay vì toast */}

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
          const isOccupied = table.status === 'occupied';
          const isMergedSatellite = !!table.merged_with;
          const isHost = !isMergedSatellite && !!groupColorMap[table.id];
          const hostIdCard = table.merged_with || table.id;
          // Cộng dồn orders của cả nhóm gộp (host + satellites) để hiển thị tổng tiền chính xác
          const _hostOrdersCard = orders[hostIdCard] || [];
          const _satOrdersCard = tables.filter(t => t.merged_with === hostIdCard && t.id !== hostIdCard).flatMap(t => orders[t.id] || []);
          const tableBills = [..._hostOrdersCard, ..._satOrdersCard];
          const isKitchenAlerting = !!kitchenAlertTables[table.id] || !!kitchenAlertTables[hostIdCard];
          // Yêu cầu ưu đãi — hiện ĐỦ mọi kênh đang chờ, chỉ trên thẻ bàn host của nhóm
          const tableReviewReqs = isMergedSatellite
            ? []
            : reviewRequests.filter(r => r.host_table_id === hostIdCard);
          const groupColor = groupColorMap[hostIdCard] || null;
          const totalAmount = sumOrderItems(tableBills);
          const guestCount = tableBills.length;
          const hasPrintError = tableBills.some(o => o.print_jobs && o.print_jobs.some(isPrintJobBad));
          // Bill của bàn đã dùng vòng xoay may mắn chưa — báo cho nhân viên biết,
          // vì mỗi bill chỉ được nhận 1 lần quà (xem /api/lucky/spin).
          const hasLuckyWheel = tableBills.some(o => (o.order_items || []).some(isLuckyWheelItem));
          let timeElapsed = '';
          if (isOccupied && table.occupied_at) {
            const diffMs = Date.now() - new Date(table.occupied_at).getTime();
            const h = Math.floor(diffMs / 3600000);
            const m = Math.floor((diffMs % 3600000) / 60000);
            timeElapsed = h > 0 ? `${h}g ${m}p` : `${m}p`;
          }
          const hostTableCard = isMergedSatellite ? tables.find(t => t.id === table.merged_with) : null;

          const openHistory = (e) => {
            e.stopPropagation();
            openTableHistory(table);
          };

          return (
            <div
              key={table.id}
              className={isKitchenAlerting ? 'kitchen-alert-blink' : ''}
              onClick={() => { setSelectedTable(table); if (!isOccupied) setAddingToOrder('admin'); }}
              style={{
                background: isKitchenAlerting ? 'linear-gradient(145deg, #ef4444, #b91c1c)' : groupColor ? groupColor.bg : isOccupied ? '#dbeafe' : 'white',
                border: `2px solid ${isKitchenAlerting ? '#991b1b' : groupColor ? groupColor.border : isOccupied ? '#93c5fd' : '#e5e7eb'}`,
                borderRadius: compact ? 12 : 16,
                padding: compact ? '12px 12px 10px' : '14px 14px 12px',
                cursor: 'pointer',
                minHeight: compact ? 80 : 90,
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: isKitchenAlerting ? '0 0 0 4px rgba(239,68,68,0.25), 0 8px 24px rgba(185,28,28,0.45)' : groupColor ? `0 2px 10px ${groupColor.border}40` : isOccupied ? '0 2px 8px rgba(37,99,235,0.10)' : '0 1px 4px rgba(0,0,0,0.06)',
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
                {hasLuckyWheel && (
                  <div title="Bill đã dùng vòng xoay may mắn" style={{ background: '#fdf4ff', color: '#a21caf', borderRadius: '50%', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #f5d0fe', fontSize: '0.7rem' }}>
                    🎰
                  </div>
                )}
              </div>
              {tableReviewReqs.length > 0 && (
                <div style={{ display: 'flex', gap: 3, marginTop: 4, flexWrap: 'wrap' }}>
                  {tableReviewReqs.map(req => {
                    const c = getChannel(req.channel);
                    return (
                      <div
                        key={req.id}
                        className="review-req-blink"
                        onClick={e => { e.stopPropagation(); openReviewModal(req); }}
                        title={`${req.customer_name || 'Khách'} xin ưu đãi ${c.name}`}
                        style={{
                          background: c.color, color: 'white', borderRadius: 6,
                          minWidth: 22, height: 20, padding: '0 5px',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '0.68rem', fontWeight: 800, cursor: 'pointer',
                          boxShadow: '0 1px 4px rgba(15,23,42,0.3)',
                        }}
                      >
                        {c.icon}
                      </div>
                    );
                  })}
                </div>
              )}
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
                  {[{ key: 'ALL', label: `Tất cả (${tables.filter(t => t.table_type !== 'takeaway').length})` }, { key: 'OCCUPIED', label: `Sử dụng (${occupiedCount})` }, { key: 'EMPTY', label: `Còn trống (${availableCount})` }].map(tab => (
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
          const tableBills = getSelectedTableOrders();
          // ── Collect ALL items from ALL orders (same as mobile) ──
          const allOrderItems = tableBills.flatMap(order =>
            (order.order_items || []).map(item => ({ ...item, _orderId: order.id }))
          );
          // Tính thẳng từ order_items đã gom ở trên — không dùng cột total_amount cache
          const totalAmount = allOrderItems.reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0);
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
              {/* Items grouped by bill */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {tableBills.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: '0.9rem' }}>Chưa có món nào</div>
                ) : tableBills.map((order, billIdx) => {
                  const billItems = (order.order_items || []).map(item => ({ ...item, _orderId: order.id }));
                  return (
                    <div key={order.id}>
                      {/* Bill Header Row */}
                      {(
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#f8fafc', borderBottom: '1px solid #e5e7eb', borderTop: billIdx > 0 ? '2px solid #e5e7eb' : 'none' }}>
                          <span style={{ background: '#2563eb', color: 'white', borderRadius: 10, padding: '1px 8px', fontSize: '0.7rem', fontWeight: 700 }}>#{billIdx + 1}</span>
                          <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#111827' }}>👤 {orderWhoLabel(order)}</span>
                          <span style={{
                            fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                            background: order.status === 'pending' ? '#fef3c7' : '#dbeafe',
                            color: order.status === 'pending' ? '#d97706' : '#2563eb',
                          }}>
                            {order.status === 'pending' ? 'Chờ' : 'Đang làm'}
                          </span>
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                            {/* In bếp */}
                            <button
                              onClick={async () => {
                                const { success, error: printErr } = await sendSmartPrintJobs(supabase, order.id);
                                if (success) {
                                  Swal.fire({ title: 'Đã gửi bếp!', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
                                } else {
                                  Swal.fire('Lỗi in bếp', printErr || 'Không kết nối được máy in bếp', 'error');
                                }
                              }}
                              style={{ background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 6, color: '#16a34a', cursor: 'pointer', padding: '3px 10px', fontSize: '0.76rem', fontWeight: 700 }}
                            >In Bếp</button>
                            {/* In bill */}
                            <button
                              onClick={async () => {
                                const items = (order.order_items || []);
                                const total = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
                                const { isConfirmed } = await Swal.fire({
                                  title: '🖨 In hoá đơn?',
                                  html: `In hoá đơn bàn <strong>${selectedTable?.table_number}</strong>?<br/><span style="color:#dc2626;font-weight:700;font-size:1.1em">Tổng: ${total.toLocaleString('vi-VN')}đ</span>`,
                                  showCancelButton: true,
                                  confirmButtonText: '🖨 In ngay',
                                  cancelButtonText: 'Huỷ',
                                  confirmButtonColor: '#2563eb',
                                  reverseButtons: true,
                                });
                                if (!isConfirmed) return;
                                const { success, error: printErr } = await sendTableSummaryPrintJob(supabase, [order.id]);
                                if (success) {
                                  Swal.fire({ title: 'Đã gửi lệnh in!', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
                                } else {
                                  Swal.fire('Lỗi in', printErr || 'Không kết nối được máy in', 'error');
                                }
                              }}
                              style={{ background: '#fff7ed', border: '1.5px solid #fed7aa', borderRadius: 6, color: '#ea580c', cursor: 'pointer', padding: '3px 10px', fontSize: '0.76rem', fontWeight: 700 }}
                            >🖨 In</button>
                            {/* Huỷ bill */}
                            <button
                              onClick={async () => {
                                const confirm = await Swal.fire({
                                  title: 'Huỷ bill?',
                                  text: `Xác nhận huỷ bill của "${order.customer_name}"?`,
                                  icon: 'warning', showCancelButton: true,
                                  confirmButtonText: 'Huỷ bill', cancelButtonText: 'Giữ lại',
                                  confirmButtonColor: '#ef4444', reverseButtons: true,
                                });
                                if (!confirm.isConfirmed) return;
                                await supabase.from('orders').update({ status: 'cancelled', total_amount: 0, ...cancelStamp() }).eq('id', order.id);
                                const remaining = tableBills.filter(o => o.id !== order.id && o.status !== 'cancelled');
                                if (remaining.length === 0) {
                                  const hId = selectedTable.merged_with || selectedTable.id;
                                  await supabase.from('tables').update({ status: 'available', occupied_at: null, merged_with: null }).or(`id.eq.${hId},merged_with.eq.${hId}`);
                                  setSelectedTable(null);
                                }
                                fetchTables();
                                Swal.fire({ title: 'Đã huỷ', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
                              }}
                              style={{ background: '#fff1f2', border: '1.5px solid #fecdd3', borderRadius: 6, color: '#dc2626', cursor: 'pointer', padding: '3px 10px', fontSize: '0.76rem', fontWeight: 700 }}
                            >✕ Huỷ</button>
                            {/* Chuyển bàn */}
                            <button
                              onClick={async () => {
                                const otherTables = tables.filter(t => t.id !== selectedTable.id && t.table_type !== 'takeaway');
                                if (otherTables.length === 0) { Swal.fire('Lỗi', 'Không có bàn khác!', 'error'); return; }
                                const inputOptions = {};
                                otherTables.forEach(t => { inputOptions[t.id] = `Bàn ${t.table_number} ${t.status === 'occupied' ? '(Có khách)' : '(Trống)'}`; });
                                const { value: targetTableId } = await Swal.fire({
                                  title: 'Chuyển bill sang bàn',
                                  input: 'select', inputOptions, inputPlaceholder: 'Chọn bàn...',
                                  showCancelButton: true, confirmButtonText: 'Chuyển', cancelButtonText: 'Huỷ',
                                  confirmButtonColor: '#2563eb', reverseButtons: true,
                                  inputValidator: (v) => { if (!v) return 'Vui lòng chọn bàn!'; }
                                });
                                if (!targetTableId) return;
                                const { error } = await supabase.from('orders').update({ table_id: targetTableId }).eq('id', order.id);
                                if (error) { Swal.fire('Lỗi', error.message, 'error'); return; }
                                const targetTable = otherTables.find(t => t.id === targetTableId);
                                if (targetTable?.status === 'available') {
                                  await supabase.from('tables').update({ status: 'occupied', occupied_at: new Date().toISOString() }).eq('id', targetTableId);
                                }
                                const remaining = tableBills.filter(o => o.id !== order.id && o.status !== 'cancelled');
                                if (remaining.length === 0) {
                                  const hId = selectedTable.merged_with || selectedTable.id;
                                  await supabase.from('tables').update({ status: 'available', occupied_at: null, merged_with: null }).or(`id.eq.${hId},merged_with.eq.${hId}`);
                                  setSelectedTable(null);
                                }
                                fetchTables();
                                Swal.fire({ title: 'Thành công', text: 'Đã chuyển bill!', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
                              }}
                              style={{ background: '#e0e7ff', border: '1.5px solid #a5b4fc', borderRadius: 6, color: '#4f46e5', cursor: 'pointer', padding: '3px 10px', fontSize: '0.76rem', fontWeight: 700 }}
                            >➜ Chuyển bàn</button>
                          </div>
                        </div>
                      )}
                      {/* Items in this bill */}
                      {billItems.map((item, idx) => {
                        const optionText = item.item_options?.map(o => o.choice).join(', ') || '';
                        const isEditingThisPrice = desktopInlinePriceItem === item.id;
                        const subtotal = item.unit_price * item.quantity;
                        return (
                          <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', padding: '9px 12px', borderBottom: '1px solid #f3f4f6', gap: 8, background: isEditingThisPrice ? '#fefce8' : 'white', transition: 'background 0.15s' }}>
                            {/* Index */}
                            <span style={{ color: '#9ca3af', fontSize: '0.78rem', minWidth: 16, paddingTop: 3, flexShrink: 0 }}>{idx + 1}.</span>

                            {/* Name + option + note */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.88rem', color: '#111827', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                {item.menu_item?.name || item.item_name || item.name}
                                {item.added_by_name && <span style={{ fontSize: '0.62rem', background: '#eff6ff', color: '#2563eb', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>👤 NV: {item.added_by_name}</span>}
                              </div>
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
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                                  <span style={{ fontSize: '0.72rem', color: '#d1d5db', fontStyle: 'italic' }}>chưa chọn khẩu vị</span>
                                </div>
                              ) : null}

                              {/* THE 3 ACTION BUTTONS UNDER THE ITEM NAME */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                                {item.menu_item && (
                                  <button
                                    onClick={() => {
                                      const current = {};
                                      (item.item_options || []).forEach(o => { current[o.name] = o.choice; });
                                      setSelectedOptions(current);
                                      setOptionQuantity(item.quantity);
                                      setOptionNote(item.note || '');
                                      setEditingOrderItem({ orderId: item._orderId, itemId: item.id });
                                      const fullItem = menuItems.find(m => m.id === item.menu_item_id) || item.menu_item;
                                      setOptionModalItem(fullItem);
                                      setEditingPrice(false);
                                      setCustomPrice(null);
                                    }}
                                    style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                                  >
                                    🖊 Đổi loại
                                  </button>
                                )}
                              </div>

                            </div>

                            {/* Qty controls */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, paddingTop: 1 }}>
                              <button onClick={() => updateItemQuantity(item._orderId, item.id, item.quantity, -1)} style={{ width: 22, height: 22, border: '1px solid #d1d5db', borderRadius: 4, background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>−</button>
                              <input
                                type="number"
                                min={1}
                                value={editingQty[item.id] !== undefined ? editingQty[item.id] : item.quantity}
                                onChange={e => {
                                  const val = e.target.value;
                                  setEditingQty(prev => ({ ...prev, [item.id]: val }));
                                }}
                                onBlur={async () => {
                                  const val = editingQty[item.id];
                                  if (val !== undefined) {
                                    const parsed = parseInt(val, 10);
                                    if (!isNaN(parsed) && parsed > 0 && parsed !== item.quantity) {
                                      const change = parsed - item.quantity;
                                      await updateItemQuantity(item._orderId, item.id, item.quantity, change);
                                    }
                                    setEditingQty(prev => { const next = { ...prev }; delete next[item.id]; return next; });
                                  }
                                }}
                                onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                                style={{ width: 32, fontSize: '0.85rem', fontWeight: 600, textAlign: 'center', border: '1px solid transparent', background: 'transparent', outline: 'none', color: '#2563eb', padding: 0 }}
                              />
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
                                  style={{ display: 'block', minWidth: 65, textAlign: 'right', fontSize: '0.82rem', color: '#374151', cursor: 'pointer', padding: '2px 4px', borderRadius: 4, border: '1.5px solid transparent' }}
                                  title="Click để sửa giá"
                                >{item.unit_price.toLocaleString('vi-VN')}</span>
                              )}
                            </div>

                            {/* Subtotal */}
                            <span style={{ minWidth: 68, textAlign: 'right', fontSize: '0.85rem', fontWeight: 700, color: '#111827', flexShrink: 0, paddingTop: 3 }}>{subtotal.toLocaleString('vi-VN')}</span>

                            {/* Action icons */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, paddingTop: 1 }}>
                              <button
                                title="Xóa món"
                                onClick={() => updateItemQuantity(item._orderId, item.id, item.quantity, -item.quantity)}
                                style={{ width: 24, height: 24, border: '1px solid #fca5a5', borderRadius: 4, background: '#fff5f5', cursor: 'pointer', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444' }}
                              ><Trash2 size={13} /></button>
                            </div>

                          </div>
                        );
                      })}
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

              {
                tableBills.length > 1 && (
                  <div style={{ padding: '8px 12px', borderTop: '1px solid #e5e7eb', background: '#f8fafc', flexShrink: 0 }}>
                    <button
                      onClick={mergeBills}
                      style={{ flex: 1, width: '100%', padding: '10px', border: '1.5px dashed #8b5cf6', borderRadius: 8, background: '#f5f3ff', color: '#7c3aed', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                      🔗 Gộp tất cả {tableBills.length} bill lại thành 1
                    </button>
                  </div>
                )
              }
              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #e5e7eb', background: 'white', flexShrink: 0 }}>
                <button
                  onClick={() => { if (selectedTable) openTableHistory(selectedTable); }}
                  style={{ flex: 1, padding: '10px', border: '1.5px solid #2563eb', borderRadius: 8, background: '#eff6ff', color: '#1d4ed8', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                  🕐 Lịch sử
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
                  onClick={async () => {
                    if (!selectedTable) return;
                    setTransactionCode(null);
                    const snapshot = await getFreshPaymentSnapshot(selectedTable);
                    if (promptFixUnpricedItems(snapshot.unpricedItems)) return;
                    if (snapshot.total <= 0 || snapshot.bills.length === 0) {
                      Swal.fire('Lỗi', 'Tổng tiền thanh toán đang là 0đ. Vui lòng tải lại bàn và kiểm tra món trước khi thanh toán.', 'error');
                      return;
                    }
                    setConfirmPayment({ table: selectedTable, totalAmount: snapshot.total, transactionCode: null });
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

              {/* Chuông ưu đãi đánh giá — luôn hiện trên thanh nav, kể cả khi đang ở tab Thực đơn */}
              {reviewRequests.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 10, flexShrink: 0 }}>
                  {reviewRequests.map(req => (
                    <button
                      key={req.id}
                      className="review-req-blink"
                      onClick={() => openReviewModal(req)}
                      title={`${req.customer_name || 'Khách'} xin ưu đãi đánh giá Google`}
                      style={{
                        background: getChannel(req.channel).color, color: 'white', border: 'none',
                        borderRadius: 100, padding: '6px 14px', cursor: 'pointer',
                        fontSize: '0.8rem', fontWeight: 800, whiteSpace: 'nowrap',
                      }}
                    >
                      {getChannel(req.channel).icon} B{tables.find(t => t.id === req.host_table_id)?.table_number ?? '?'} · {getChannel(req.channel).short}
                    </button>
                  ))}
                </div>
              )}

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
                <button onClick={() => setShowAddModal(true)} style={{ background: '#0284c7', color: 'white', border: 'none', borderRadius: '50%', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '1.4rem', fontWeight: 500, flexShrink: 0, transition: 'all 0.1s' }} onMouseOver={e => e.target.style.background = '#0369a1'} onMouseOut={e => e.target.style.background = '#0284c7'}>+</button>
              </div>

            </div>

            {/* 2-pane content */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              {/* LEFT: Table browser or Menu view */}
              <div style={{ flex: '6 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', background: '#f1f5f9', borderRight: '1px solid #e2e8f0', overflow: 'hidden', transition: 'flex 0.25s ease' }}>
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
                    {/* Menu grid - responsive auto-fill */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: '10px', background: '#f8fafc' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
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
                                // Bỏ qua OptionModal nếu món không có tuỳ chọn (thêm tức thì cho mượt)
                                if (!item.options || item.options.length === 0) {
                                  addItemToOrder('admin', item, [], 1, '');
                                  return;
                                }

                                // Trì hoãn nhẹ để giải phóng luồng UI, chống lag khi render Modal
                                setTimeout(() => {
                                  const { initialOptions, initialPrice } = getInitialOptionSelection(item);
                                  setOptionModalItem(item);
                                  setSelectedOptions(initialOptions);
                                  setOptionQuantity(1);
                                  setOptionNote('');
                                  setEditingPrice(false);
                                  setCustomPrice(initialPrice);
                                }, 10);
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
                    {/* ── Draft confirm bar (desktop) ── */}
                    {draftCart.length > 0 && (
                      <div style={{
                        padding: '10px 12px', borderTop: '2px solid #e0e7ff',
                        background: 'white', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0
                      }}>
                        <div style={{ flex: 1, fontSize: '0.82rem', color: '#374151', fontWeight: 600 }}>
                          🛒 {draftCart.reduce((s, d) => s + d.qty, 0)} món chưa gửi
                        </div>
                        <button
                          onClick={() => setDraftCart([])}
                          style={{ padding: '6px 14px', borderRadius: 20, border: '1px solid #e5e7eb', background: 'white', color: '#6b7280', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
                        >Huỷ</button>
                        <button
                          onClick={confirmDraft}
                          disabled={isConfirmingDraft}
                          style={{
                            padding: '6px 18px', borderRadius: 20, border: 'none',
                            background: isConfirmingDraft ? '#93c5fd' : '#2563eb',
                            color: 'white', fontSize: '0.82rem', fontWeight: 700,
                            cursor: isConfirmingDraft ? 'not-allowed' : 'pointer',
                            boxShadow: '0 2px 8px rgba(37,99,235,0.3)'
                          }}
                        >
                          {isConfirmingDraft ? '⏳ Đang gửi...' : '✅ Xác nhận gọi món'}
                        </button>
                      </div>
                    )}
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
                      {reviewRequests.length > 0 && (
                        <div className="review-req-banner" style={{
                          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                          background: '#eff6ff', border: '1.5px solid #93c5fd', borderRadius: 12,
                          padding: '10px 12px', marginBottom: 12,
                        }}>
                          <span style={{ fontWeight: 800, fontSize: '0.85rem', color: '#1d4ed8' }}>
                            🎁 {reviewRequests.length} khách xin ưu đãi mạng xã hội
                          </span>
                          {reviewRequests.map(req => (
                            <button
                              key={req.id}
                              onClick={() => openReviewModal(req)}
                              style={{
                                padding: '5px 12px', background: getChannel(req.channel).color, color: 'white', border: 'none',
                                borderRadius: 100, fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {getChannel(req.channel).icon} B{tables.find(t => t.id === req.host_table_id)?.table_number ?? '?'}
                              {req.customer_name ? ` · ${req.customer_name}` : ''} · {getChannel(req.channel).short} → Duyệt
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 14 }}>
                        {filteredTables.map(table => {
                          const isChild = !!table.merged_with;
                          const isHost = tables.some(t => t.merged_with === table.id);
                          const isMergedGroup = isChild || isHost;
                          const isOccupied = table.status === 'occupied' || isMergedGroup;
                          const isSelected = selectedTable?.id === table.id;
                          const alertHostId = table.merged_with || table.id;
                          const isKitchenAlerting = !!kitchenAlertTables[table.id] || !!kitchenAlertTables[alertHostId];
                          // Yêu cầu ưu đãi — hiện đủ mọi kênh, chỉ gắn lên thẻ bàn host của nhóm
                          const tableReviewReqs = isChild
                            ? []
                            : reviewRequests.filter(r => r.host_table_id === alertHostId);
                          const tableTotal = sumOrderItems(orders[table.merged_with || table.id] || []);
                          const hasPrintError = (orders[table.merged_with || table.id] || []).some(o => o.print_jobs && o.print_jobs.some(isPrintJobBad));
                          const hasLuckyWheel = (orders[table.merged_with || table.id] || []).some(o => (o.order_items || []).some(isLuckyWheelItem));

                          // Style derivation: Merged group is Purple, Normal Occupied is Blue, Empty is White
                          const bgColors = {
                            selected: '#1d4ed8', // Dark blue when selected
                            merged: '#f5f3ff', // Light purple for merged
                            occupied: '#eff6ff', // Light blue for normal occupied
                            empty: 'white'
                          };

                          const borderColors = {
                            selected: '#1d4ed8',
                            merged: '#c4b5fd', // Purple border
                            occupied: '#bfdbfe', // Blue border
                            empty: '#e5e7eb'
                          };

                          const iconColors = {
                            selected: 'rgba(255,255,255,0.5)',
                            merged: '#a855f7', // Purple icon
                            occupied: '#60a5fa', // Blue icon
                            empty: '#cbd5e1'
                          };

                          const textColors = {
                            selected: 'white',
                            merged: '#6b21a8', // Deep purple text
                            occupied: '#1e3a8a', // Deep blue text
                            empty: '#374151'
                          };

                          const pillTagColors = {
                            selected: { bg: 'white', text: '#1d4ed8' },
                            merged: { bg: '#ede9fe', text: '#7e22ce' },
                            occupied: { bg: '#e0f2fe', text: '#2563eb' }
                          };

                          const bg = isSelected ? bgColors.selected : isMergedGroup ? bgColors.merged : isOccupied ? bgColors.occupied : bgColors.empty;
                          const border = isSelected ? borderColors.selected : isMergedGroup ? borderColors.merged : isOccupied ? borderColors.occupied : borderColors.empty;
                          const iconCol = isSelected ? iconColors.selected : isMergedGroup ? iconColors.merged : isOccupied ? iconColors.occupied : iconColors.empty;
                          const textCol = isSelected ? textColors.selected : isMergedGroup ? textColors.merged : isOccupied ? textColors.occupied : textColors.empty;
                          const pillStyle = isSelected ? pillTagColors.selected : isMergedGroup ? pillTagColors.merged : pillTagColors.occupied;

                          const shadowHover = isMergedGroup ? '0 8px 16px rgba(147,51,234,0.15)' : isOccupied ? '0 8px 16px rgba(37,99,235,0.15)' : '0 8px 16px rgba(0,0,0,0.08)';

                          return (
                            <div key={table.id}
                              className={isKitchenAlerting ? 'kitchen-alert-blink' : ''}
                              onClick={() => { setSelectedTable(table); setDesktopView('menu'); }}
                              onMouseEnter={e => { if (!isSelected) { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = shadowHover; } }}
                              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = isSelected ? '0 8px 24px rgba(29,78,216,0.3)' : '0 1px 4px rgba(0,0,0,0.07)'; }}
                              style={{
                                position: 'relative', borderRadius: 14, cursor: 'pointer',
                                overflow: 'hidden',
                                background: isKitchenAlerting ? 'linear-gradient(145deg, #ef4444, #b91c1c)'
                                  : isSelected ? 'white'
                                  : isMergedGroup ? 'linear-gradient(145deg, #9333ea, #7e22ce)'
                                    : isOccupied ? 'linear-gradient(145deg, #16a34a, #15803d)'
                                      : 'white',
                                border: `1.5px solid ${isKitchenAlerting ? '#991b1b' : border}`,
                                boxShadow: isKitchenAlerting ? '0 0 0 4px rgba(239,68,68,0.25), 0 8px 24px rgba(185,28,28,0.45)' : isSelected ? '0 8px 24px rgba(29,78,216,0.3)' : '0 1px 4px rgba(0,0,0,0.07)',
                                transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
                              }}
                            >
                              {/* Accent bar at top */}
                              <div style={{
                                height: 4,
                                background: isSelected ? 'linear-gradient(90deg, #1e3a8a, #1d4ed8)'
                                  : isMergedGroup ? 'linear-gradient(90deg, #f3e8ff, #e9d5ff)'
                                    : isOccupied ? 'linear-gradient(90deg, #dcfce7, #bbf7d0)'
                                      : '#e5e7eb',
                              }} />

                              {/* Card body */}
                              <div style={{ padding: '10px 8px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>

                                {/* Merged / print error badges */}
                                {isHost && (
                                  <div style={{
                                    position: 'absolute', top: 10, left: 8,
                                    fontSize: '0.55rem', background: isSelected ? '#f97316' : 'rgba(255,255,255,0.2)',
                                    color: 'white',
                                    borderRadius: 4, padding: '1px 5px', fontWeight: 800, letterSpacing: '0.04em'
                                  }}>GỘP</div>
                                )}
                                {hasPrintError && (
                                  <div style={{ position: 'absolute', top: -1, right: -1, background: '#ef4444', color: 'white', borderRadius: '0 14px 0 8px', padding: '2px 5px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
                                    <Printer size={9} strokeWidth={2.5} />
                                  </div>
                                )}
                                {hasLuckyWheel && (
                                  <div title="Bill đã dùng vòng xoay may mắn" style={{ position: 'absolute', top: -1, left: -1, background: '#a21caf', color: 'white', borderRadius: '14px 0 8px 0', padding: '2px 5px', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, fontSize: '0.6rem' }}>
                                    🎰
                                  </div>
                                )}

                                {/* Number badge */}
                                <div style={{
                                  width: 46, height: 46, borderRadius: '50%',
                                  background: isSelected ? '#1e3a8a'
                                    : (isOccupied || isMergedGroup) ? 'rgba(255,255,255,0.18)'
                                      : '#f1f5f9',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: '1.1rem', fontWeight: 900,
                                  color: isSelected ? 'white' : (isOccupied || isMergedGroup) ? 'white' : '#64748b',
                                  boxShadow: isSelected ? '0 3px 10px rgba(30,58,138,0.3)' : 'none',
                                  border: (isOccupied || isMergedGroup) ? '2px solid rgba(255,255,255,0.25)' : 'none',
                                  flexShrink: 0,
                                }}>
                                  {table.table_number}
                                </div>

                                {/* Table name */}
                                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: isSelected ? '#1d4ed8' : (isOccupied || isMergedGroup) ? 'rgba(255,255,255,0.95)' : '#374151', letterSpacing: '0.01em' }}>
                                  {table.table_name || `B${table.table_number}`}
                                </span>

                                {/* Revenue or empty */}
                                {tableTotal > 0 ? (
                                  <div style={{
                                    fontSize: '0.72rem', fontWeight: 800,
                                    color: isSelected ? '#1d4ed8' : isMergedGroup ? '#e9d5ff' : '#dcfce7',
                                    background: isSelected ? '#eff6ff' : 'rgba(255,255,255,0.15)',
                                    borderRadius: 20, padding: '2px 10px', whiteSpace: 'nowrap',
                                  }}>
                                    {tableTotal >= 1000000 ? (tableTotal / 1000000).toFixed(1) + 'M' : tableTotal >= 1000 ? (tableTotal / 1000).toFixed(0) + 'k' : tableTotal.toLocaleString('vi-VN')}đ
                                  </div>
                                ) : (
                                  <div style={{ fontSize: '0.68rem', color: isSelected ? '#93c5fd' : (isOccupied || isMergedGroup) ? 'rgba(255,255,255,0.4)' : '#cbd5e1', fontWeight: 500 }}>— trống —</div>
                                )}
                              </div>

                              {tableReviewReqs.length > 0 && (
                                <div
                                  className="review-req-blink"
                                  style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 8, display: 'flex' }}
                                >
                                  {tableReviewReqs.map(req => {
                                    const c = getChannel(req.channel);
                                    return (
                                      <div
                                        key={req.id}
                                        onClick={(e) => { e.stopPropagation(); openReviewModal(req); }}
                                        title={`${req.customer_name || 'Khách'} xin ưu đãi ${c.name}`}
                                        style={{
                                          flex: 1, background: c.color, color: 'white', textAlign: 'center',
                                          padding: '3px 0', fontSize: '0.62rem', fontWeight: 800,
                                          cursor: 'pointer', letterSpacing: '0.02em',
                                          borderLeft: '1px solid rgba(255,255,255,0.35)',
                                        }}
                                      >
                                        {c.icon}{tableReviewReqs.length === 1 ? ' Duyệt ưu đãi' : ''}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {/* History button */}
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openTableHistory(table);
                                }}
                                style={{ position: 'absolute', top: 8, right: 7, opacity: 0.45, cursor: 'pointer', zIndex: 5, padding: 3 }}
                                title="Lịch sử bàn 8H"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isSelected ? '#1d4ed8' : (isOccupied || isMergedGroup) ? 'white' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10" />
                                  <polyline points="12 6 12 12 16 14" />
                                </svg>
                              </div>
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
              <div style={{ flex: '4 1 0', minWidth: 320, maxWidth: '45%', display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' }}>
                {desktopOrderDetail()}
              </div>
            </div>
          </div>
        );
      })()}
      {/* ══ PAYMENT MODAL ══ */}
      {
        paymentModal && paymentModal.mode !== 'transfer' && (() => {
          const { table, total } = paymentModal;
          const fmt = (n) => new Intl.NumberFormat('vi-VN').format(n) + 'đ';

          const closeModal = () => { setPaymentModal(null); setQrAccount(null); setShowTransfer(false); setTransactionCode(null); setPaymentCountdown(0); setQrLoading(false); };

          const doCashPayment = async () => {
            if (payingHostId) return;
            const ok = await completeTable(table, 'cash');
            if (!ok) return;
            closeModal();
          };

          const doTransferPayment = async () => {
            if (payingHostId) return;
            closeModal();
            await completeTable(table.id, 'transfer', qrAccount ? qrAccount.shouldHideStats : false);
          };

          const doCancelOrder = async () => {
            if (!window.confirm('Bạn có chắc muốn huỷ tất cả đơn của bàn này?')) return;
            const hostId = table.merged_with || table.id;
            // Hủy tất cả đơn của host (kể cả đơn từ bàn satellite đã được chuyển sang)
            await supabase.from('orders')
              .update({ status: 'cancelled', payment_method: 'cancelled', ...cancelStamp() })
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
            // Chỉ sinh mã nếu chưa có (thường đã tự auto-fetch ở useEffect)
            if (!transactionCode) {
              const snapshot = await getFreshPaymentSnapshot(table);
              if (promptFixUnpricedItems(snapshot.unpricedItems)) return;
              if (snapshot.total <= 0 || snapshot.bills.length === 0) {
                Swal.fire('Lỗi', 'Tổng tiền thanh toán đang là 0đ. Vui lòng tải lại bàn và kiểm tra món trước khi tạo QR.', 'error');
                return;
              }
              const code = await getOrGenerateBillCode(snapshot.hostId, snapshot.total, qrAccount?.id || null, snapshot.bills);
              if (code) setTransactionCode(code);
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
                    <div style={{ fontSize: '0.82rem', color: '#64748b' }}>Bàn {table.table_number}{transactionCode && ` • Mã Bill: #${transactionCode}`}</div>
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
                    <button onClick={doCashPayment} disabled={!!payingHostId}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: '#f0fdf4', border: '1.5px solid #bbf7d0', borderRadius: 14, cursor: payingHostId ? 'not-allowed' : 'pointer', opacity: payingHostId ? 0.5 : 1, textAlign: 'left', width: '100%' }}>
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

                    <button onClick={doTransferPayment} disabled={!!payingHostId}
                      style={{ width: '100%', padding: '13px', background: payingHostId ? '#93c5fd' : '#2563eb', color: 'white', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: '1rem', cursor: payingHostId ? 'not-allowed' : 'pointer' }}>
                      {payingHostId ? '⏳ Đang xử lý...' : '✅ Xác nhận thủ công đã nhận tiền'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })()
      }

      {/* QR Code Modal - uses table UUID in URL */}
      {
        showQR && (
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
        )
      }

      {/* ── Custom Share Sheet ── */}
      {
        showShareSheet && showQR && (() => {
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
        })()
      }

      {/* Table Detail Modal - mobile only; desktop shows inline in right panel */}
      {
        isMobile && selectedTable && !addingToOrder && (
          <div className="modal-overlay" onClick={() => { setSelectedTable(null); setQuickAddOpen(false); }}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
              <div className="modal-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2, paddingBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                  <h3 style={{ fontSize: '1.4rem', fontWeight: 800 }}>Bàn {selectedTable.table_number}</h3>
                  <button className="btn btn-ghost btn-icon" onClick={() => { setSelectedTable(null); setQuickAddOpen(false); }}>
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
                                    {item.menu_item?.name || item.item_name || 'Món đã xoá'}
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
                            {/* Cộng thẳng từng dòng order_items — khớp với bảng món in ngay phía trên,
                                không dùng total_amount cache (có thể lệch, xem sumOrderItems) */}
                            Tổng bill #{idx + 1}: {formatPrice(sumOrderItems([order]))}
                          </div>
                        </div>
                      ))}
                      <div style={{ textAlign: 'right', fontSize: '1.1rem', fontWeight: 'bold', borderTop: '2px solid #333', paddingTop: '8px' }}>
                        TỔNG CỘNG: {formatPrice(sumOrderItems(getSelectedTableOrders()))}
                      </div>
                      <div className="invoice-footer">
                        <p>Cảm ơn quý khách! 🙏</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* On-screen bills display */}
                {(() => {
                  const _screenOrders = getSelectedTableOrders();
                  return _screenOrders?.length > 0 ? (
                    _screenOrders.map((order, idx) => (
                    <div key={order.id} className="order-detail-card">
                      {/* Customer name header per bill */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0 6px', borderBottom: '1px solid #f3f4f6', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {_screenOrders.length > 1 && (
                            <span style={{ fontSize: '0.7rem', background: '#2563eb', color: 'white', borderRadius: 10, padding: '1px 7px', fontWeight: 700 }}>
                              #{idx + 1}
                            </span>
                          )}
                          <span style={{ fontWeight: 700, fontSize: '0.88rem', color: '#111827' }}>
                            👤 {orderWhoLabel(order)}
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
                        </div>
                        {/* Cancel this single bill */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', marginTop: 2, width: '100%' }}>
                          {/* In bếp */}
                          <button
                            onClick={async () => {
                              const { success, error: printErr } = await sendSmartPrintJobs(supabase, order.id);
                              if (success) {
                                Swal.fire({ title: 'Đã gửi bếp!', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
                              } else {
                                Swal.fire('Lỗi in bếp', printErr || 'Không kết nối được máy in bếp', 'error');
                              }
                            }}
                            style={{ background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 6, color: '#16a34a', cursor: 'pointer', padding: '3px 8px', fontSize: '0.7rem', fontWeight: 700 }}
                          >In Bếp</button>
                          {/* In bill */}
                          <button
                            onClick={async () => {
                              const items = (order.order_items || []);
                              const total = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
                              const { isConfirmed } = await Swal.fire({
                                title: '🖨 In hoá đơn?',
                                html: `In hoá đơn bàn <strong>${selectedTable?.table_number}</strong>?<br/><span style="color:#dc2626;font-weight:700;font-size:1.1em">Tổng: ${total.toLocaleString('vi-VN')}đ</span>`,
                                showCancelButton: true,
                                confirmButtonText: '🖨 In ngay',
                                cancelButtonText: 'Huỷ',
                                confirmButtonColor: '#2563eb',
                                reverseButtons: true,
                              });
                              if (!isConfirmed) return;
                              const { success, error: printErr } = await sendTableSummaryPrintJob(supabase, [order.id]);
                              if (success) {
                                Swal.fire({ title: 'Đã gửi lệnh in!', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
                              } else {
                                Swal.fire('Lỗi in', printErr || 'Không kết nối được máy in', 'error');
                              }
                            }}
                            style={{ background: '#fff7ed', border: '1.5px solid #fed7aa', borderRadius: 6, color: '#ea580c', cursor: 'pointer', padding: '3px 8px', fontSize: '0.7rem', fontWeight: 700 }}
                          >🖨 In</button>
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

                                const remaining = getSelectedTableOrders().filter(o => o.id !== order.id && o.status !== 'cancelled');
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
                              await supabase.from('orders').update({ status: 'cancelled', ...cancelStamp() }).eq('id', order.id);
                              // If all orders at this table are now cancelled, reset the table
                              const remaining = getSelectedTableOrders().filter(o => o.id !== order.id && o.status !== 'cancelled');
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
                        {order.order_items?.map((item) => isReviewDiscountItem(item) ? (
                          // Dòng ưu đãi đánh giá Google — không phải món ăn, không cho sửa giá/số lượng
                          <div key={item.id} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            gap: 10, padding: '10px 12px', margin: '8px 0',
                            background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
                          }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#1d4ed8' }}>
                                ⭐ {item.item_name || 'Giảm giá ưu đãi'}
                              </div>
                              {item.added_by_name && (
                                <div style={{ fontSize: '0.72rem', color: '#3b82f6', marginTop: 2 }}>
                                  Duyệt bởi NV: {item.added_by_name}
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                              <span style={{ fontSize: '0.95rem', fontWeight: 800, color: '#047857' }}>
                                {(item.unit_price * item.quantity).toLocaleString('vi-VN')}đ
                              </span>
                              <button
                                title="Gỡ ưu đãi"
                                onClick={() => removeItemFromOrder(order.id, item.id, item.item_name || 'Giảm giá ưu đãi')}
                                style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', padding: '0 2px', fontSize: '1.1rem', lineHeight: 1 }}
                              >
                                ···
                              </button>
                            </div>
                          </div>
                        ) : (
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
                                  {item.menu_item?.name || item.item_name || 'Món đã xoá'}
                                  {item.is_gift && <span style={{ fontSize: '0.65rem', background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '1px 5px', fontWeight: 700, lineHeight: 1 }}>🎁 Món Tặng</span>}
                                  {item.added_by_name && <span style={{ fontSize: '0.62rem', background: '#eff6ff', color: '#2563eb', borderRadius: 4, padding: '1px 6px', fontWeight: 700, lineHeight: 1.3 }}>👤 NV: {item.added_by_name}</span>}
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
                                  <input
                                    type="number"
                                    min={1}
                                    value={editingQty[item.id] !== undefined ? editingQty[item.id] : item.quantity}
                                    onChange={e => {
                                      const val = e.target.value;
                                      setEditingQty(prev => ({ ...prev, [item.id]: val }));
                                    }}
                                    onBlur={async () => {
                                      const val = editingQty[item.id];
                                      if (val !== undefined) {
                                        const parsed = parseInt(val, 10);
                                        if (!isNaN(parsed) && parsed > 0 && parsed !== item.quantity) {
                                          const change = parsed - item.quantity;
                                          await updateItemQuantity(order.id, item.id, item.quantity, change);
                                        }
                                        setEditingQty(prev => { const next = { ...prev }; delete next[item.id]; return next; });
                                      }
                                    }}
                                    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                                    style={{ width: 36, fontSize: '1rem', fontWeight: 600, color: '#2563eb', textAlign: 'center', border: '1px solid transparent', background: 'transparent', outline: 'none', padding: 0 }}
                                  />
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
                 );
                })()}
              </div>

              {/* Floating FAB — absolutely positioned on modal, not in scroll area */}
              {getSelectedTableOrders()?.length > 0 && (
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

              {/* ─── Tab mũi tên "Chọn nhanh nước / bia / khăn" ở mép phải ─── */}
              <button
                onClick={() => setQuickAddOpen(v => !v)}
                title="Chọn nhanh nước / bia / khăn"
                style={{
                  position: 'absolute', right: 0, top: '34%', transform: 'translateY(-50%)',
                  zIndex: 40, width: 30, minHeight: 96,
                  border: 'none', borderRadius: '12px 0 0 12px',
                  background: 'linear-gradient(135deg,#2563eb,#1d4ed8)', color: 'white',
                  cursor: 'pointer', display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 0',
                  boxShadow: '-3px 3px 12px rgba(37,99,235,0.4)',
                }}
              >
                <span style={{ fontSize: '1.05rem', lineHeight: 1, fontWeight: 800 }}>{quickAddOpen ? '›' : '‹'}</span>
                <span style={{ fontSize: '1rem', lineHeight: 1 }}>🥤</span>
                <span style={{ writingMode: 'vertical-rl', fontSize: '0.6rem', fontWeight: 700, letterSpacing: 1 }}>NƯỚC</span>
              </button>

              {/* Backdrop mờ khi mở drawer */}
              {quickAddOpen && (
                <div onClick={() => setQuickAddOpen(false)}
                  style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 35 }} />
              )}

              {/* Drawer danh sách nước / bia / khăn */}
              <div style={{
                position: 'absolute', top: 0, bottom: 0, right: 0, zIndex: 38,
                width: 'min(80%, 300px)', background: 'white',
                boxShadow: '-8px 0 30px rgba(0,0,0,0.18)',
                transform: quickAddOpen ? 'translateX(0)' : 'translateX(105%)',
                transition: 'transform 0.25s ease',
                display: 'flex', flexDirection: 'column',
                borderRadius: '16px 0 0 16px', overflow: 'hidden',
              }}>
                {(() => {
                  const pendingQty = draftCart.reduce((s, d) => s + d.qty, 0);
                  return (
                    <div style={{ padding: 'calc(10px + env(safe-area-inset-top)) 12px 10px', background: '#eff6ff', borderBottom: '1px solid #dbeafe', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <span style={{ fontWeight: 800, color: '#1d4ed8', fontSize: '0.95rem', flexShrink: 0 }}>🥤 Chọn nhanh</span>
                      {/* Nút Gửi đi — chỉ gửi 1 lần khi bấm, tránh lag */}
                      <button
                        disabled={pendingQty === 0 || isConfirmingDraft}
                        onClick={async () => {
                          if (pendingQty === 0 || isConfirmingDraft) return;
                          await confirmDraft();
                          Swal.fire({ title: '✅ Đã gửi lên bill!', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
                        }}
                        style={{
                          marginLeft: 'auto', flexShrink: 0,
                          padding: '6px 12px', borderRadius: 100, border: 'none',
                          background: pendingQty === 0 ? '#cbd5e1' : 'linear-gradient(135deg,#2563eb,#1d4ed8)',
                          color: 'white', fontSize: '0.82rem', fontWeight: 800,
                          cursor: pendingQty === 0 ? 'not-allowed' : 'pointer',
                          display: 'flex', alignItems: 'center', gap: 5,
                          boxShadow: pendingQty === 0 ? 'none' : '0 3px 10px rgba(37,99,235,0.35)',
                        }}
                      >
                        {isConfirmingDraft ? 'Đang gửi…' : `📤 Gửi đi${pendingQty > 0 ? ` (${pendingQty})` : ''}`}
                      </button>
                      <button onClick={() => setQuickAddOpen(false)} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, flexShrink: 0 }}>✕</button>
                    </div>
                  );
                })()}
                <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px calc(8px + env(safe-area-inset-bottom))' }}>
                  {/* Chỉ dựng danh sách (và tải ảnh) khi drawer mở → không tốn data lúc chỉ mở bàn */}
                  {quickAddOpen && (() => {
                    const drinks = menuItems.filter(m => isDrinkName(m.name));
                    if (drinks.length === 0) return <div style={{ padding: 16, color: '#9ca3af', fontSize: '0.85rem', textAlign: 'center' }}>Chưa có món nước / bia / khăn.</div>;
                    const adminItems = getSelectedTableOrders().flatMap(o => o.order_items || []);
                    const inBillOf = (id) => adminItems.filter(it => it.menu_item_id === id).reduce((s, it) => s + it.quantity, 0);
                    const pendingOf = (id) => draftCart.filter(d => d.menuItemId === id).reduce((s, d) => s + d.qty, 0);
                    return drinks.map(item => {
                      const inBill = inBillOf(item.id);
                      const pending = pendingOf(item.id);
                      return (
                        <div key={item.id}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 10px', marginBottom: 6,
                            background: pending > 0 ? '#eff6ff' : 'white',
                            border: `1px solid ${pending > 0 ? '#bfdbfe' : '#e5e7eb'}`, borderRadius: 10,
                          }}
                        >
                          <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, overflow: 'hidden', background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {item.image_url
                              ? <img src={item.image_url} alt={item.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : <span style={{ fontSize: '1.2rem' }}>🥤</span>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 6 }}>
                              {item.name}
                              {inBill > 0 && <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#6b7280', background: '#f3f4f6', borderRadius: 20, padding: '1px 6px' }}>bill ×{inBill}</span>}
                            </div>
                            <div style={{ fontSize: '0.78rem', color: '#6b7280' }}>{formatPrice(item.price)}</div>
                          </div>
                          {/* Stepper cộng dồn cục bộ — chưa gửi server */}
                          {pending > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                              <button onClick={() => decreaseFromDraft(item.id)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #d1d5db', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}>
                                <Minus size={13} strokeWidth={2.5} />
                              </button>
                              <span style={{ minWidth: 18, textAlign: 'center', fontSize: '0.95rem', fontWeight: 800, color: '#2563eb' }}>{pending}</span>
                              <button onClick={() => addToDraft(item)} style={{ width: 26, height: 26, borderRadius: '50%', border: 'none', background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'white' }}>
                                <Plus size={13} strokeWidth={2.5} />
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => addToDraft(item)} style={{ width: 30, height: 30, borderRadius: '50%', border: '1.5px solid #93c5fd', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#2563eb', flexShrink: 0 }}>
                              <Plus size={17} strokeWidth={2.5} />
                            </button>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              <div className="modal-footer" style={{ padding: '8px 12px', gap: 6, flexDirection: 'column', alignItems: 'stretch' }}>
                {/* Total summary row */}
                {getSelectedTableOrders()?.length > 0 && (() => {
                  const total = sumOrderItems(getSelectedTableOrders());
                  return (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontSize: '0.88rem', color: '#6b7280', fontWeight: 500 }}>Tổng cộng:</span>
                      <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#c53b3b' }}>{formatPrice(total)}</span>
                    </div>
                  );
                })()}

                {/* Nút Gộp Bill Mobile — REMOVED standalone row, moved into action row below */}

                {/* Action buttons row — all in one row */}
                {getSelectedTableOrders()?.length > 0 && (() => {
                  const tableBills = getSelectedTableOrders();
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
                      <button onClick={() => { const _u = collectUnpricedItems(getSelectedTableOrders()); if (_u.length > 0) { promptFixUnpricedItems(_u); return; } setShowBillPreview(true); }} style={{ ...smallBtnStyle, border: '1.5px solid #2563eb', color: '#2563eb' }}>
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
                        onClick={async () => {
                          setTransactionCode(null);
                          const snapshot = await getFreshPaymentSnapshot(selectedTable);
                          if (promptFixUnpricedItems(snapshot.unpricedItems)) return;
                          if (snapshot.total <= 0 || snapshot.bills.length === 0) {
                            Swal.fire('Lỗi', 'Tổng tiền thanh toán đang là 0đ. Vui lòng tải lại bàn và kiểm tra món trước khi thanh toán.', 'error');
                            return;
                          }
                          setConfirmPayment({ table: selectedTable, totalAmount: snapshot.total, transactionCode: null });
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
        )
      }

      {/* ── Sửa giá bán bottom-sheet modal ── */}
      {
        showPriceModal && (() => {
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
        })()
      }

      {/* ── Modal nhập giá cho món chưa có giá (0đ, không phải món tặng) ── */}
      {
        priceFixModal && (() => {
          const items = priceFixModal.items || [];
          const addedTotal = items.reduce(
            (s, it) => s + (Number(String(it.price).replace(/[^\d]/g, '')) || 0) * (it.quantity || 1), 0
          );
          const allFilled = items.every(it => (Number(String(it.price).replace(/[^\d]/g, '')) || 0) > 0);
          const setPrice = (idx, raw) => {
            const digits = String(raw).replace(/[^\d]/g, '');
            setPriceFixModal(prev => ({
              ...prev,
              items: prev.items.map((it, i) => i === idx ? { ...it, price: digits } : it),
            }));
          };
          return (
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
              onClick={() => { if (!priceFixSaving) setPriceFixModal(null); }}
            >
              <div
                style={{ background: 'white', borderRadius: 20, width: '100%', maxWidth: 440, maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}
                onClick={e => e.stopPropagation()}
              >
                {/* Header */}
                <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
                    ⚠️ Thêm giá cho món chưa có giá
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 4 }}>
                    Bill còn <b style={{ color: '#dc2626' }}>{items.length}</b> món đang để giá 0đ. Nhập giá rồi lưu để cộng vào bill.
                  </div>
                </div>

                {/* Danh sách món */}
                <div style={{ padding: '12px 22px', overflowY: 'auto', flex: 1 }}>
                  {items.map((it, idx) => {
                    const priceNum = Number(String(it.price).replace(/[^\d]/g, '')) || 0;
                    const lineTotal = priceNum * (it.quantity || 1);
                    return (
                      <div key={it.orderItemId} style={{ padding: '12px 0', borderBottom: idx < items.length - 1 ? '1px dashed #e5e7eb' : 'none' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#111827' }}>{it.name}</div>
                          <div style={{ fontSize: '0.8rem', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap', marginLeft: 8 }}>SL: {it.quantity}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', flex: 1, border: '1.5px solid #2563eb', borderRadius: 12, overflow: 'hidden', background: 'white' }}>
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              autoFocus={idx === 0}
                              placeholder="Nhập đơn giá"
                              value={priceNum ? priceNum.toLocaleString('vi-VN') : ''}
                              onChange={e => setPrice(idx, e.target.value)}
                              style={{ flex: 1, border: 'none', outline: 'none', padding: '12px 14px', fontSize: '16px', fontWeight: 700, textAlign: 'right', background: 'white', color: '#111827' }}
                            />
                            <span style={{ padding: '0 14px', color: '#9ca3af', fontWeight: 700 }}>đ</span>
                          </div>
                        </div>
                        <div style={{ fontSize: '0.8rem', color: lineTotal > 0 ? '#16a34a' : '#9ca3af', fontWeight: 600, textAlign: 'right', marginTop: 6 }}>
                          Thành tiền: {lineTotal.toLocaleString('vi-VN')}đ
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Tổng cộng dồn + nút */}
                <div style={{ padding: '14px 22px 20px', borderTop: '1px solid #f1f5f9', background: '#f8fafc' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <span style={{ fontSize: '0.9rem', color: '#6b7280', fontWeight: 600 }}>Cộng vào bill:</span>
                    <span style={{ fontSize: '1.3rem', fontWeight: 800, color: '#2563eb' }}>{addedTotal.toLocaleString('vi-VN')}đ</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      onClick={() => setPriceFixModal(null)}
                      disabled={priceFixSaving}
                      style={{ flex: 1, padding: '14px', borderRadius: 100, background: 'white', border: '1.5px solid #e5e7eb', color: '#6b7280', fontSize: '0.95rem', fontWeight: 700, cursor: priceFixSaving ? 'not-allowed' : 'pointer' }}
                    >
                      Huỷ
                    </button>
                    <button
                      onClick={saveFixedPrices}
                      disabled={priceFixSaving || !allFilled}
                      style={{ flex: 2, padding: '14px', borderRadius: 100, background: (priceFixSaving || !allFilled) ? '#93c5fd' : '#2563eb', border: 'none', color: 'white', fontSize: '0.95rem', fontWeight: 800, cursor: (priceFixSaving || !allFilled) ? 'not-allowed' : 'pointer', boxShadow: '0 4px 16px rgba(37,99,235,0.35)' }}
                    >
                      {priceFixSaving ? 'Đang lưu…' : 'Lưu & cộng vào bill'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()
      }

      {/* Admin Menu Modal */}

      {
        addingToOrder && (() => {
          const closeModal = () => {
            setDraftCart([]);
            setAddingToOrder(null);
            setAddItemSearch('');
            if (selectedTable && getSelectedTableOrders().length === 0) {
              setSelectedTable(null);
            }
          };

          // Draft cart tổng hợp
          const draftTotal = draftCart.reduce((s, d) => s + d.qty, 0);

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
              <div style={{ flex: 1, overflowY: 'auto', background: '#fafafa', paddingBottom: draftTotal > 0 ? 90 : 16 }}>
                {filteredItems.length === 0 && (
                  <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Không tìm thấy món ăn nào</div>
                )}

                {activeMenuCategory === 'all' ? (
                  /* ── Tất cả: flat list, không header nhóm ── */
                  filteredItems.map(item => {
                    const qty = draftCart.filter(d => d.menuItemId === item.id).reduce((s, d) => s + d.qty, 0);
                    return (
                      <div
                        key={item.id}
                        onClick={() => addToDraft(item)}
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
                            ? <img src={item.image_url} alt={item.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            : <ChefHat size={20} style={{ color: '#93c5fd' }} />}
                        </div>
                        <div style={{ flex: 1, marginLeft: 10, paddingRight: 6 }}>
                          <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#111827', marginBottom: 1, lineHeight: 1.25 }}>{item.name}</div>
                          <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#6b7280' }}>{getItemDisplayPrice(item)}</div>
                        </div>
                        {qty > 0 ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
                            <button onClick={() => decreaseFromDraft(item.id)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #d1d5db', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}>
                              <Minus size={13} strokeWidth={2.5} />
                            </button>
                            <input
                              type="number"
                              min={1}
                              value={editingQty[`draft_${item.id}`] !== undefined ? editingQty[`draft_${item.id}`] : qty}
                              onChange={e => {
                                e.stopPropagation();
                                setEditingQty(prev => ({ ...prev, [`draft_${item.id}`]: e.target.value }));
                              }}
                              onClick={e => e.stopPropagation()}
                              onBlur={e => {
                                e.stopPropagation();
                                const val = editingQty[`draft_${item.id}`];
                                if (val !== undefined) {
                                  const parsed = parseInt(val, 10);
                                  if (!isNaN(parsed) && parsed > 0 && parsed !== qty) {
                                    setDraftQuantity(item.id, parsed);
                                  }
                                  setEditingQty(prev => { const next = { ...prev }; delete next[`draft_${item.id}`]; return next; });
                                }
                              }}
                              onKeyDown={e => {
                                e.stopPropagation();
                                if (e.key === 'Enter') e.target.blur();
                              }}
                              style={{ width: 32, textAlign: 'center', fontWeight: 700, fontSize: '0.9rem', color: '#2563eb', border: '1px solid transparent', background: 'transparent', outline: 'none', padding: 0 }}
                            />
                            <button onClick={() => addToDraft(item)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #2563eb', background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'white' }}>
                              <Plus size={13} strokeWidth={2.5} />
                            </button>
                          </div>
                        ) : (
                          <button onClick={e => { e.stopPropagation(); addToDraft(item); }} style={{ width: 28, height: 28, borderRadius: '50%', background: 'white', border: '1.5px solid #d1d5db', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, color: '#374151' }}>
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
                        const qty = draftCart.filter(d => d.menuItemId === item.id).reduce((s, d) => s + d.qty, 0);
                        return (
                          <div
                            key={item.id}
                            onClick={() => addToDraft(item)}
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
                                ? <img src={item.image_url} alt={item.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                : <ChefHat size={20} style={{ color: '#93c5fd' }} />}
                            </div>
                            <div style={{ flex: 1, marginLeft: 10, paddingRight: 6 }}>
                              <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#111827', marginBottom: 1, lineHeight: 1.25 }}>{item.name}</div>
                              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#6b7280' }}>{getItemDisplayPrice(item)}</div>
                            </div>
                            {qty > 0 ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
                                <button onClick={() => decreaseFromDraft(item.id)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #d1d5db', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#374151' }}>
                                  <Minus size={13} strokeWidth={2.5} />
                                </button>
                                <input
                                  type="number"
                                  min={1}
                                  value={editingQty[`draft_${item.id}`] !== undefined ? editingQty[`draft_${item.id}`] : qty}
                                  onChange={e => {
                                    e.stopPropagation();
                                    setEditingQty(prev => ({ ...prev, [`draft_${item.id}`]: e.target.value }));
                                  }}
                                  onClick={e => e.stopPropagation()}
                                  onBlur={e => {
                                    e.stopPropagation();
                                    const val = editingQty[`draft_${item.id}`];
                                    if (val !== undefined) {
                                      const parsed = parseInt(val, 10);
                                      if (!isNaN(parsed) && parsed > 0 && parsed !== qty) {
                                        setDraftQuantity(item.id, parsed);
                                      }
                                      setEditingQty(prev => { const next = { ...prev }; delete next[`draft_${item.id}`]; return next; });
                                    }
                                  }}
                                  onKeyDown={e => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') e.target.blur();
                                  }}
                                  style={{ width: 32, textAlign: 'center', fontWeight: 700, fontSize: '0.9rem', color: '#2563eb', border: '1px solid transparent', background: 'transparent', outline: 'none', padding: 0 }}
                                />
                                <button onClick={() => addToDraft(item)} style={{ width: 26, height: 26, borderRadius: '50%', border: '1.5px solid #2563eb', background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'white' }}>
                                  <Plus size={13} strokeWidth={2.5} />
                                </button>
                              </div>
                            ) : (
                              <button onClick={e => { e.stopPropagation(); addToDraft(item); }} style={{ width: 28, height: 28, borderRadius: '50%', background: 'white', border: '1.5px solid #d1d5db', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, color: '#374151' }}>
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

              {/* Floating confirm bar — hiện khi có món trong draft */}
              {draftTotal > 0 && (
                <div
                  style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    padding: '10px 16px 14px',
                    background: 'white',
                    borderTop: '2px solid #e0e7ff'
                  }}
                >
                  <div style={{ display: 'flex', gap: 10 }}>
                    {/* Huỷ draft */}
                    <button
                      onClick={closeModal}
                      style={{
                        flex: 1, padding: '10px 0', borderRadius: 100,
                        border: '1.5px solid #e5e7eb', background: 'white',
                        fontSize: '0.9rem', fontWeight: 600, color: '#6b7280',
                        cursor: 'pointer'
                      }}
                    >
                      Huỷ
                    </button>
                    {/* Xác nhận gửi món */}
                    <button
                      onClick={confirmDraft}
                      disabled={isConfirmingDraft}
                      style={{
                        flex: 2, padding: '10px 16px', borderRadius: 100,
                        border: 'none',
                        background: isConfirmingDraft ? '#93c5fd' : 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                        color: 'white', cursor: isConfirmingDraft ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        boxShadow: '0 4px 14px rgba(37,99,235,0.4)',
                        transition: 'all 0.2s'
                      }}
                    >
                      <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                        {isConfirmingDraft ? '⏳ Đang gửi...' : '✅ Xác nhận gọi món'}
                      </span>
                      {!isConfirmingDraft && (
                        <span style={{
                          background: 'white', color: '#2563eb',
                          borderRadius: 20, padding: '2px 10px',
                          fontSize: '0.82rem', fontWeight: 800
                        }}>{draftTotal}</span>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })()
      }

      {/* Item Options Modal */}
      {
        optionModalItem && (
          <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={() => setOptionModalItem(null)}>
            <div className="options-modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="options-modal-header" style={{ padding: '12px 16px 4px', borderBottom: 'none', display: 'flex', justifyContent: 'flex-end', minHeight: 'auto' }}>
                <button style={{ border: 'none', background: '#f3f4f6', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={() => setOptionModalItem(null)}>
                  <X size={16} color="#4b5563" />
                </button>
              </div>

              <div className="options-modal-body">
                <div className="options-item-info" style={{ borderBottom: 'none', paddingBottom: 0 }}>
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

                {/* Hàng 3: Số lượng & Ghi chú */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, paddingTop: 12, paddingBottom: 12, borderTop: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', paddingLeft: 16, paddingRight: 16 }}>
                  {/* Số lượng */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#4b5563', marginRight: 2 }}>Số lượng:</span>
                    <button onClick={() => setOptionQuantity(Math.max(1, (Number(optionQuantity) || 1) - 1))} style={{ width: 28, height: 28, borderRadius: '50%', border: '1px solid #d1d5db', background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Minus size={14} /></button>
                    <input
                      type="number"
                      min={1}
                      value={optionQuantity}
                      onChange={e => {
                        const val = e.target.value;
                        if (val === '') {
                          setOptionQuantity('');
                        } else {
                          const v = parseInt(val, 10);
                          if (!isNaN(v) && v >= 1) setOptionQuantity(v);
                        }
                      }}
                      onBlur={() => {
                        if (optionQuantity === '' || optionQuantity < 1) setOptionQuantity(1);
                      }}
                      style={{ width: 56, textAlign: 'center', fontWeight: 700, fontSize: '1rem', border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 4px', outline: 'none' }}
                    />
                    <button onClick={() => setOptionQuantity((Number(optionQuantity) || 0) + 1)} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Plus size={14} /></button>
                  </div>
                  {/* Ghi chú */}
                  <input
                    type="text"
                    placeholder="Ghi chú cho bếp..."
                    value={optionNote}
                    onChange={(e) => setOptionNote(e.target.value)}
                    style={{ flex: 1, borderRadius: 8, padding: '6px 12px', border: '1px solid #d1d5db', outline: 'none', fontSize: '0.9rem', minWidth: 0 }}
                  />
                </div>

                {optionModalItem.options && optionModalItem.options.filter(opt => opt.name && opt.choices).map((opt, idx) => (
                  <div key={idx} style={{ marginBottom: 12, marginTop: idx === 0 ? 12 : 4, paddingBottom: 12, borderBottom: '1px solid #e5e7eb', paddingLeft: 16, paddingRight: 16 }}>
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
                              const newSel = { ...selectedOptions, [opt.name]: choice };
                              setSelectedOptions(newSel);
                              // Giá theo lựa chọn: choice có giá → giá đó; choice để trống → 0đ.
                              // Luôn tính lại từ toàn bộ lựa chọn → tự reset đúng khi đổi choice.
                              // (null = không nhóm nào định giá → giữ giá gốc món qua fallback ?? bên dưới)
                              setCustomPrice(getChoiceDerivedPrice(optionModalItem, newSel));
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


              </div>

              <div className="options-bottom-bar">
                <button className="btn-add-to-order" onClick={handleConfirmOptions}>
                  Thêm vào đơn • {formatPrice((customPrice ?? optionModalItem.price) * optionQuantity)}
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* ── Takeaway Orders Modal ── */}
      {
        showTakeawayOrders && (
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
                    {/* Mã đơn TW-XXX */}
                    {order.displayCode && (
                      <div style={{
                        display: 'inline-block',
                        background: 'linear-gradient(135deg, #1d4ed8, #2563eb)',
                        color: 'white',
                        padding: '4px 12px',
                        borderRadius: 8,
                        fontWeight: 800,
                        fontSize: '0.95rem',
                        letterSpacing: '0.05em',
                        marginBottom: 10,
                        boxShadow: '0 2px 6px rgba(37,99,235,0.3)'
                      }}>
                        {order.displayCode}
                      </div>
                    )}
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
                          <span>{item.menu_item?.name || item.item_name || 'Món đã xoá'} × {item.quantity}</span>
                          <span style={{ fontWeight: 600 }}>{(item.unit_price * item.quantity).toLocaleString('vi-VN')}đ</span>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, paddingTop: 6, borderTop: '1px dashed #d1d5db', color: '#111827' }}>
                        <span>Tổng cộng</span>
                        <span style={{ color: '#1d4ed8' }}>{sumOrderItems([order]).toLocaleString('vi-VN')}đ</span>
                      </div>
                    </div>
                    {/* Ghi chú khách gửi cho bếp */}
                    {order.customer_note && (
                      <div style={{
                        background: '#fef3c7',
                        border: '1px solid #fcd34d',
                        borderRadius: 8,
                        padding: '8px 10px',
                        marginBottom: 10,
                        display: 'flex',
                        gap: 6,
                        alignItems: 'flex-start'
                      }}>
                        <span style={{ fontSize: '0.9rem', flexShrink: 0 }}>📝</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.7rem', color: '#92400e', fontWeight: 700, marginBottom: 2 }}>GHI CHÚ KHÁCH</div>
                          <div style={{ fontSize: '0.85rem', color: '#78350f', lineHeight: 1.4 }}>{order.customer_note}</div>
                        </div>
                      </div>
                    )}
                    {/* Action buttons: Đã giao / Huỷ */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => completeKitchenOrder(order.orderIds || [order.id])}
                        style={{ flex: 1, padding: '10px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}
                      >
                        ✓ Đã giao đi
                      </button>
                      <button
                        onClick={() => cancelTakeawayOrder(order.orderIds || [order.id], order.displayCode)}
                        style={{ padding: '10px 14px', background: 'white', color: '#dc2626', border: '1.5px solid #fca5a5', borderRadius: 10, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                        title="Huỷ đơn này"
                      >
                        ✕ Huỷ
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      }

      {/* Add Table Modal */}
      {
        showAddModal && (
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
        )
      }
      {/* Full-screen Bill Preview Modal */}
      {
        showBillPreview && selectedTable && (() => {
          const tableBills = getSelectedTableOrders();
          const rawItems = tableBills.flatMap(b => b.order_items || []);
          // Tính thẳng từ order_items (không dùng total_amount cache) — đây là
          // phiếu Tạm tính khách sẽ đối chiếu để trả tiền, phải khớp bill in ra.
          const grandTotal = rawItems.reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 0), 0);

          // Dòng ưu đãi (giá âm, không gắn menu_item) hiện thành mục riêng,
          // không lẫn vào danh sách món và không tính vào số lượng món
          const discountItems = rawItems.filter(isReviewDiscountItem);
          const discountTotal = discountItems.reduce((s, i) => s + i.unit_price * (i.quantity || 1), 0);

          // Gộp các món giống nhau (cùng tên + options + giá + gift)
          const mergedMap = new Map();
          for (const item of rawItems) {
            if (isReviewDiscountItem(item)) continue;
            const name = item.menu_item?.name || item.item_name || '?';
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
          const sortedAll = [...mergedMap.values()].sort((a, b) =>
            (a.menu_item?.name || '').localeCompare(b.menu_item?.name || '', 'vi')
          );
          // Phân vùng: nước ngọt / bia / khăn lên trên, món ăn ở dưới cho dễ nhìn
          const isDrink = (it) => isDrinkName(it.menu_item?.name);
          const drinkItems = sortedAll.filter(isDrink);
          const foodItems = sortedAll.filter(it => !isDrink(it));
          const allItems = [...drinkItems, ...foodItems];
          const totalQty = allItems.reduce((s, i) => s + i.quantity, 0);

          // Tách số lượng theo loại:
          // - Món chính: 🎯 Tính vào khuyến mại (counts_for_promotion)
          // - Món phụ: không tính khuyến mại (nước ngọt, bia, khăn...)
          // - Món tặng: is_gift
          const promoById = new Map(menuItems.map(m => [m.id, !!m.counts_for_promotion]));
          let mainQty = 0, subQty = 0, giftQty = 0;
          for (const it of allItems) {
            const q = it.quantity || 0;
            if (it.is_gift) giftQty += q;
            else if (promoById.get(it.menu_item_id)) mainQty += q;
            else subQty += q;
          }

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
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'calc(12px + env(safe-area-inset-top)) 16px 12px', background: 'white', borderBottom: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
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

              {/* Items list — phân vùng nước/bia/khăn và món ăn */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 8px' }}>
                {(() => {
                  const renderRow = (item, idx) => {
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
                          <div style={{ fontSize: '1.05rem', fontWeight: 600, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.menu_item?.name || item.item_name || 'Món đã xoá'}
                          </div>
                          {optionText && (
                            <div style={{ fontSize: '0.85rem', color: '#f59e0b', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {optionText}
                            </div>
                          )}
                        </div>
                        {/* Right: qty × price = subtotal */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <span style={{ fontSize: '0.9rem', color: '#9ca3af' }}>
                            {item.unit_price.toLocaleString('vi-VN')} × {item.quantity}
                          </span>
                          <span style={{ fontSize: '1.05rem', fontWeight: 700, color: '#111827', minWidth: 60, textAlign: 'right' }}>
                            {subtotal.toLocaleString('vi-VN')}
                          </span>
                        </div>
                      </div>
                    );
                  };
                  const sectionHeader = (label, color, bg) => (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      margin: '6px 2px 6px', padding: '5px 12px',
                      background: bg, borderRadius: 8,
                      fontSize: '0.78rem', fontWeight: 800, color,
                      textTransform: 'uppercase', letterSpacing: 0.3,
                    }}>{label}</div>
                  );
                  return (
                    <>
                      {drinkItems.length > 0 && sectionHeader('🥤 Nước · Bia · Khăn', '#0369a1', '#e0f2fe')}
                      {drinkItems.map((item, i) => renderRow(item, `d${i}`))}
                      {foodItems.length > 0 && sectionHeader('🍽️ Món ăn', '#b45309', '#fef3c7')}
                      {foodItems.map((item, i) => renderRow(item, `f${i}`))}
                      {discountItems.length > 0 && sectionHeader('⭐ Ưu đãi · Giảm giá', '#1d4ed8', '#eff6ff')}
                      {discountItems.map((item, i) => (
                        <div key={`kt${i}`} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '9px 12px', marginBottom: 5, gap: 8,
                          background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
                        }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#1d4ed8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              ⭐ {item.item_name || 'Giảm giá ưu đãi'}
                            </div>
                            {item.added_by_name && (
                              <div style={{ fontSize: '0.78rem', color: '#3b82f6', marginTop: 2 }}>
                                Duyệt bởi NV: {item.added_by_name}
                              </div>
                            )}
                          </div>
                          <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#047857', flexShrink: 0 }}>
                            {(item.unit_price * item.quantity).toLocaleString('vi-VN')}đ
                          </span>
                        </div>
                      ))}
                    </>
                  );
                })()}
              </div>

              {/* Summary section — gọn */}
              <div style={{ background: 'white', borderTop: '1px solid #e5e7eb', padding: '6px 16px 4px' }}>
                {/* Phân loại gọn 1 hàng: chính · phụ · tổng */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: '0.8rem', flexWrap: 'wrap' }}>
                  <span style={{ color: '#6b7280' }}>🎯 Chính <b style={{ color: '#b45309' }}>{mainQty}</b></span>
                  <span style={{ color: '#d1d5db' }}>·</span>
                  <span style={{ color: '#6b7280' }}>🥤 Phụ <b style={{ color: '#0369a1' }}>{subQty}</b></span>
                  <span style={{ color: '#d1d5db' }}>·</span>
                  <span style={{ color: '#6b7280', marginLeft: 'auto' }}>Tổng <b style={{ color: '#111827' }}>{totalQty} món</b></span>
                </div>
                {discountTotal < 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0 0', borderTop: '1px dashed #e5e7eb', marginTop: 4, fontSize: '0.85rem' }}>
                    <span style={{ color: '#6b7280' }}>Tạm tính món</span>
                    <span style={{ fontWeight: 700, color: '#374151' }}>{(grandTotal - discountTotal).toLocaleString('vi-VN')}đ</span>
                  </div>
                )}
                {discountTotal < 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: '0.85rem' }}>
                    <span style={{ color: '#1d4ed8', fontWeight: 600 }}>⭐ Ưu đãi đã duyệt</span>
                    <span style={{ fontWeight: 800, color: '#047857' }}>{discountTotal.toLocaleString('vi-VN')}đ</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0 4px', borderTop: '1px dashed #e5e7eb', marginTop: 4 }}>
                  <span style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>Khách cần trả</span>
                  <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#2563eb' }}>{grandTotal.toLocaleString('vi-VN')}đ</span>
                </div>
              </div>

              {/* Action buttons — 3 nút cùng 1 hàng cho gọn */}
              <div style={{ padding: '6px 16px calc(10px + env(safe-area-inset-bottom))', background: 'white', display: 'flex', gap: 6 }}>
                {/* Print — secondary outline */}
                <button
                  onClick={handlePrintInvoice}
                  style={{
                    flex: 1, padding: '8px 0',
                    borderRadius: 100, border: '1.5px solid #2563eb',
                    background: 'white', color: '#2563eb',
                    fontSize: '0.78rem', fontWeight: 700,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                  }}
                >
                  🖨️ In tạm tính
                </button>

                {/* Huỷ đơn — same handler as the table action bar */}
                <button
                  onClick={() => setCancelConfirm(selectedTable)}
                  style={{
                    flex: 1, padding: '8px 0',
                    borderRadius: 100, border: '1.5px solid #fca5a5',
                    background: 'white', color: '#dc2626',
                    fontSize: '0.78rem', fontWeight: 700,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                  }}
                >
                  🗑️ Huỷ đơn
                </button>

                {/* Thanh toán — same handler as the table action bar */}
                <button
                  onClick={async () => {
                    setTransactionCode(null);
                    const snapshot = await getFreshPaymentSnapshot(selectedTable);
                    if (promptFixUnpricedItems(snapshot.unpricedItems)) return;
                    if (snapshot.total <= 0 || snapshot.bills.length === 0) {
                      Swal.fire('Lỗi', 'Tổng tiền thanh toán đang là 0đ. Vui lòng tải lại bàn và kiểm tra món trước khi thanh toán.', 'error');
                      return;
                    }
                    setConfirmPayment({ table: selectedTable, totalAmount: snapshot.total, transactionCode: null });
                  }}
                  style={{
                    flex: 1, padding: '8px 0',
                    borderRadius: 100, border: 'none',
                    background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: 'white',
                    fontSize: '0.78rem', fontWeight: 700,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                    boxShadow: '0 3px 10px rgba(37,99,235,0.3)',
                  }}
                >
                  💵 Thanh toán
                </button>
              </div>
            </div>
          );
        })()
      }
      {/* Custom Delete Confirmation Modal */}
      {
        confirmDelete && (
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
        )
      }
      {/* ── Custom Payment Confirmation Modal (Redesigned) ── */}
      {
        confirmPayment && (
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
                    {confirmPayment.transactionCode && ` • Mã Bill: #${confirmPayment.transactionCode}`}
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
                {/* completeTable() tự xử lý: check hạn mức → cộng bank_daily_totals → gán is_hidden_from_stats */}
                {/* Khoá nút khi đang xử lý — chặn bấm 2 lần làm cộng tiền 2 lượt vào thẻ */}
                <div
                  onClick={async () => {
                    if (payingHostId) return;
                    const ok = await completeTable(confirmPayment.table, 'cash');
                    if (!ok) return;
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
                    borderRadius: 16, transition: 'all 0.15s',
                    cursor: payingHostId ? 'not-allowed' : 'pointer',
                    opacity: payingHostId ? 0.5 : 1,
                    pointerEvents: payingHostId ? 'none' : 'auto',
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
        )
      }

      {/* ── QR Transfer Payment Modal ── */}
      {
        paymentModal?.mode === 'transfer' && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
            onClick={() => { setPaymentModal(null); setConfirmPayment(null); setQrLoading(false); }}>
            <div style={{ background: 'white', borderRadius: 20, boxShadow: '0 24px 64px rgba(0,0,0,0.2)', width: '100%', maxWidth: 380, overflow: 'hidden' }}
              onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div style={{ background: qrAccount?.overLimit ? '#dc2626' : '#2563eb', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ color: 'white', fontWeight: 800, fontSize: '1rem' }}>📲 Chuyển khoản</div>
                  <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: '0.8rem' }}>Bàn B{paymentModal.table.table_number} · {paymentModal.total.toLocaleString('vi-VN')}đ</div>
                </div>
                <button onClick={() => { setPaymentModal(null); setQrLoading(false); }}
                  style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '50%', width: 32, height: 32, color: 'white', cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
              </div>

              {/* QR + account info */}
              <div style={{ padding: '16px 18px' }}>
                {!qrAccount ? (
                  <div style={{ border: '2px solid #bfdbfe', borderRadius: 16, padding: '34px 16px', background: '#f0f9ff', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
                    <div style={{ width: 42, height: 42, borderRadius: '50%', border: '4px solid #bfdbfe', borderTopColor: '#2563eb', animation: 'spin 0.8s linear infinite' }} />
                    <div style={{ fontWeight: 800, color: '#1d4ed8' }}>{qrLoading ? 'Đang tạo mã QR...' : 'Chưa có tài khoản QR'}</div>
                    <div style={{ fontSize: '0.85rem', color: '#64748b' }}>Hệ thống đang lấy tài khoản nhận tiền và mã bill.</div>
                  </div>
                ) : (
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
                )}
              </div>

              {/* Confirm button */}
              <div style={{ padding: '0 18px 18px', display: 'flex', gap: 10 }}>
                <button onClick={() => { setPaymentModal(null); setConfirmPayment(null); setTransactionCode(null); setPaymentCountdown(0); setQrLoading(false); }}
                  style={{ flex: 1, padding: '12px', border: '1.5px solid #e5e7eb', borderRadius: 12, background: 'white', color: '#6b7280', fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem' }}>
                  Quay lại
                </button>
                <button
                  disabled={!qrAccount || !!payingHostId}
                  onClick={async () => {
                    if (!qrAccount || payingHostId) return;
                    await completeTable(paymentModal.table, 'transfer', qrAccount.shouldHideStats);
                    setPaymentModal(null);
                    setConfirmPayment(null);
                    setTransactionCode(null);
                    setPaymentCountdown(0);
                    setQrLoading(false);
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
                  style={{ flex: 2, padding: '12px', border: 'none', borderRadius: 12, background: (qrAccount && !payingHostId) ? '#2563eb' : '#93c5fd', color: 'white', fontWeight: 800, cursor: (qrAccount && !payingHostId) ? 'pointer' : 'not-allowed', fontSize: '0.95rem' }}>
                  {payingHostId ? '⏳ Đang xử lý...' : '✅ Đã nhận tiền'}
                </button>
              </div>
            </div>
          </div>
        )
      }

      {/* ══ HUỶ ĐƠN CONFIRMATION MODAL ══ */}
      {
        cancelConfirm && (
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
                      .update({ status: 'cancelled', payment_method: 'cancelled', ...cancelStamp() })
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
        )
      }
      {/* ══ LỊCH SỬ BÀN 8H ══ */}
      {
        showTableHistory && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 3100, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => setShowTableHistory(null)}>
            <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 480, maxHeight: '80dvh', background: 'white', borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: '1rem', color: '#1f2937' }}>🕐 Lịch sử Bàn {showTableHistory.table_number}</div>
                  <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 1 }}>{historyTab === 'opens' ? 'Lượt mở bàn · 6 tiếng gần nhất' : 'Hoá đơn · 8 tiếng gần nhất'}</div>
                </div>
                <button onClick={() => setShowTableHistory(null)} style={{ background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 30, height: 30, cursor: 'pointer', fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
              </div>
              {/* Tabs: Hoá đơn / Lượt mở bàn */}
              <div style={{ display: 'flex', gap: 6, padding: '8px 14px 10px', borderBottom: '1px solid #f3f4f6' }}>
                {[{ k: 'bills', label: '🧾 Hoá đơn' }, { k: 'opens', label: '🔎 Lượt mở bàn' }].map(t => (
                  <button key={t.k} onClick={() => setHistoryTab(t.k)}
                    style={{
                      flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer',
                      border: historyTab === t.k ? '1.5px solid #2563eb' : '1.5px solid #e5e7eb',
                      background: historyTab === t.k ? '#eff6ff' : 'white',
                      color: historyTab === t.k ? '#1d4ed8' : '#6b7280',
                      fontSize: '0.8rem', fontWeight: 700,
                    }}>{t.label}</button>
                ))}
              </div>
              {/* Nút Đồng bộ — chỉ tải lịch sử khi bấm (tiết kiệm data) */}
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}>
                <button
                  onClick={syncTableHistory}
                  disabled={tableHistoryLoading || tableOpenLogLoading}
                  style={{
                    width: '100%', padding: '10px 0', borderRadius: 100, border: 'none',
                    background: (tableHistoryLoading || tableOpenLogLoading) ? '#cbd5e1' : 'linear-gradient(135deg,#2563eb,#1d4ed8)',
                    color: 'white', fontSize: '0.9rem', fontWeight: 800,
                    cursor: (tableHistoryLoading || tableOpenLogLoading) ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    boxShadow: (tableHistoryLoading || tableOpenLogLoading) ? 'none' : '0 3px 10px rgba(37,99,235,0.3)',
                  }}
                >
                  {(tableHistoryLoading || tableOpenLogLoading) ? '⏳ Đang tải...' : (historySynced ? '🔄 Đồng bộ lại' : '🔄 Đồng bộ để xem lịch sử')}
                </button>
              </div>
              <div style={{ overflowY: 'auto', flex: 1, padding: '10px 14px 20px' }}>
                {!historySynced ? (
                  (tableHistoryLoading || tableOpenLogLoading) ? (
                    <div style={{ textAlign: 'center', padding: '30px 0', color: '#9ca3af', fontSize: '0.85rem' }}>Đang tải...</div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: '44px 16px', color: '#9ca3af' }}>
                      <div style={{ fontSize: '2.4rem', marginBottom: 10 }}>🔄</div>
                      <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#6b7280' }}>Bấm &quot;Đồng bộ&quot; để tải lịch sử</div>
                      <div style={{ fontSize: '0.75rem', color: '#d1d5db', marginTop: 4 }}>Không tự tải để tiết kiệm dữ liệu</div>
                    </div>
                  )
                ) : historyTab === 'opens' ? (
                  tableOpenLogLoading ? (
                    <div style={{ textAlign: 'center', padding: '30px 0', color: '#9ca3af', fontSize: '0.85rem' }}>Đang tải...</div>
                  ) : tableOpenLog.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '30px 0', color: '#d1d5db', fontSize: '0.85rem' }}>
                      <div style={{ fontSize: '2rem', marginBottom: 6 }}>📭</div>Chưa có lượt mở bàn trong 6 tiếng qua
                    </div>
                  ) : tableOpenLog.map((log, i) => {
                    const t = new Date(log.opened_at);
                    const timeStr = t.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                    const dateStr = t.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
                    const isLatest = i === 0;
                    return (
                      <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', marginBottom: 6, background: isLatest ? '#eff6ff' : 'white', border: `1px solid ${isLatest ? '#bfdbfe' : '#f3f4f6'}`, borderRadius: 10 }}>
                        <div style={{ fontSize: '1.1rem' }}>{isLatest ? '🟢' : '👤'}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#111827' }}>{log.staff_name ? `NV: ${log.staff_name}` : 'Không rõ'}</div>
                          <div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>{timeStr} · {dateStr}</div>
                        </div>
                        {isLatest && <span style={{ fontSize: '0.58rem', fontWeight: 800, color: '#2563eb', background: '#dbeafe', borderRadius: 20, padding: '2px 8px', flexShrink: 0 }}>MỞ GẦN NHẤT</span>}
                      </div>
                    );
                  })
                ) : tableHistoryLoading ? (
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
                        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#374151' }}>{orderWhoLabel(order)}</span>
                        <span style={{ marginLeft: 'auto', fontSize: '0.62rem', fontWeight: 700, borderRadius: 100, padding: '2px 8px', background: isPaid ? '#dcfce7' : '#fee2e2', color: isPaid ? '#16a34a' : '#dc2626' }}>
                          {isPaid ? '✓ Đã TT' : '✗ Đã huỷ'}
                        </span>
                      </div>
                      {/* Ai thực hiện thao tác */}
                      {(isPaid ? order.paid_by_name : order.cancelled_by_name) && (
                        <div style={{ fontSize: '0.66rem', color: '#9ca3af', paddingLeft: 4, marginBottom: 4 }}>
                          {isPaid ? `💵 Thanh toán bởi ${order.paid_by_name}` : `🗑️ Huỷ bởi ${order.cancelled_by_name}`}
                        </div>
                      )}
                      {(order.order_items || []).map(item => {
                        const optionText = (item.item_options || []).map(o => o.choice).join(' · ') || item.note || '';
                        return (
                          <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.75rem', color: '#6b7280', paddingLeft: 4, marginBottom: 3 }}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ fontWeight: 600, color: '#374151' }}>{item.quantity}x</span> {item.menu_item?.name || item.item_name || 'Món đã xoá'}
                              {item.is_gift && <span style={{ fontSize: '0.6rem', background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '0 4px', fontWeight: 700, marginLeft: 4 }}>🎁</span>}
                              {item.added_by_name && <span style={{ fontSize: '0.6rem', background: '#eff6ff', color: '#2563eb', borderRadius: 4, padding: '0 5px', fontWeight: 700, marginLeft: 4 }}>👤 NV: {item.added_by_name}</span>}
                              {optionText && <span style={{ display: 'block', fontSize: '0.68rem', color: '#f59e0b' }}>{optionText}</span>}
                            </span>
                            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{(item.unit_price * item.quantity).toLocaleString('vi-VN')}đ</span>
                          </div>
                        );
                      })}
                      <div style={{ fontSize: '0.66rem', color: '#9ca3af', paddingLeft: 4, marginTop: 1 }}>{(order.order_items || []).length} món</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 4, borderTop: '1px dashed #f3f4f6' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>Tổng</span>
                          <span style={{ fontSize: '0.82rem', fontWeight: 800, color: isPaid ? '#16a34a' : '#dc2626' }}>{sumOrderItems([order]).toLocaleString('vi-VN')}đ</span>
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
        )
      }

      {/* ─── Duyệt ưu đãi đánh giá Google Maps ─── */}
      {
        reviewModal && (
          <div
            onClick={() => !reviewBusy && setReviewModal(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 999999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(3px)', padding: 16 }}
          >
            <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 400, padding: 20, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
              <div style={{ fontWeight: 800, fontSize: '1.05rem', color: getChannel(reviewModal.channel).colorDark, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  background: getChannel(reviewModal.channel).color, color: 'white',
                  borderRadius: 8, width: 28, height: 28,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.95rem',
                }}>{getChannel(reviewModal.channel).icon}</span>
                {getChannel(reviewModal.channel).name}
              </div>
              <div style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: 14 }}>
                Nhìn màn hình điện thoại của khách để xác nhận, rồi bấm Duyệt.
              </div>

              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '11px 13px', fontSize: '0.86rem', color: '#334155', lineHeight: 1.75, marginBottom: 14 }}>
                <div>Khách: <b>{reviewModal.customer_name || '—'}</b></div>
                <div>SĐT: <b>{reviewModal.customer_phone || '—'}</b></div>
                <div>
                  Bàn: <b>B{tables.find(t => t.id === reviewModal.host_table_id)?.table_number ?? '?'}</b>
                </div>
                <div style={{ borderTop: '1px dashed #cbd5e1', marginTop: 8, paddingTop: 8 }}>
                  Tổng bill bàn:{' '}
                  <b>{reviewPreview ? `${reviewPreview.total.toLocaleString('vi-VN')}đ` : 'đang tính...'}</b>
                </div>
                <div style={{ color: '#047857' }}>
                  Sẽ giảm{' '}
                  <b style={{ fontSize: '1.05rem' }}>
                    {reviewPreview ? `${reviewPreview.discount.toLocaleString('vi-VN')}đ` : '...'}
                  </b>
                  {reviewPreview ? ` (${reviewPreview.percent}%)` : ''}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => rejectReviewReward(reviewModal)}
                  disabled={reviewBusy}
                  style={{ flex: 1, padding: '11px 12px', background: '#fff7f7', color: '#dc2626', border: '1.5px solid #fecaca', borderRadius: 10, fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer', opacity: reviewBusy ? 0.6 : 1 }}
                >
                  Từ chối
                </button>
                <button
                  onClick={() => approveReviewReward(reviewModal)}
                  disabled={reviewBusy || !reviewPreview || reviewPreview.discount <= 0}
                  style={{ flex: 1.4, padding: '11px 12px', background: getChannel(reviewModal.channel).color, color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '0.88rem', cursor: 'pointer', opacity: (reviewBusy || !reviewPreview || reviewPreview.discount <= 0) ? 0.6 : 1 }}
                >
                  {reviewBusy ? 'Đang xử lý...' : '✅ Duyệt & trừ tiền'}
                </button>
              </div>

              <button
                onClick={() => setReviewModal(null)}
                disabled={reviewBusy}
                style={{ width: '100%', marginTop: 8, padding: '8px', background: 'transparent', border: 'none', color: '#64748b', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Để sau
              </button>
            </div>
          </div>
        )
      }

      {/* ─── Print Toast ─── */}
      {
        printToast && (
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
        )
      }
    </div >
  );
}
