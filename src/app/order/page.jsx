'use client';
import { removeVietnameseTones } from '@/lib/utils';


import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import { sendPrintJob } from '@/lib/print';
import {
  Search,
  Plus,
  Minus,
  Send,
  ChefHat,
  Phone,
  User,
  ShoppingBag,
  X,
  Clock,
  List,
  Grid3X3,
  RotateCcw,
  Check,
} from 'lucide-react';
import PrintErrorAlert from '@/components/PrintErrorAlert';
import './order.css';

function OrderContent() {
  const searchParams = useSearchParams();
  const urlTableId = searchParams.get('table');
  const [activeTableId, setActiveTableId] = useState(urlTableId);

  const [tableNumber, setTableNumber] = useState(null);
  const [isTakeaway, setIsTakeaway] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [showInfoModal, setShowInfoModal] = useState(true);
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [cart, setCart] = useState([]);
  const [notes, setNotes] = useState({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCart, setShowCart] = useState(false);
  const [showOrdered, setShowOrdered] = useState(false);
  const [previousOrders, setPreviousOrders] = useState([]);
  const [viewMode, setViewMode] = useState('list');
  const [orderSuccess, setOrderSuccess] = useState(false);
  const [userScrolling, setUserScrolling] = useState(false);
  const [orderCancelled, setOrderCancelled] = useState(false); // admin cancelled
  const [orderPaid, setOrderPaid] = useState(null); // { total } khi admin thanh toán
  const [locationWarning, setLocationWarning] = useState(false); // khách không ở nhà hàng
  // Promotion
  const [promoConfig, setPromoConfig] = useState({ enabled: false, threshold: 8 });
  const [giftItems, setGiftItems] = useState([]); // is_gift_item items
  const [giftCart, setGiftCart] = useState([]); // { id, name, price:0, is_gift:true }
  const [showGiftModal, setShowGiftModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPromoPopup, setShowPromoPopup] = useState(false);

  // Option selection modal for items with choices
  const [optionModal, setOptionModal] = useState(null);
  const [currentOrderId, setCurrentOrderId] = useState(null);
  const [isGiftMode, setIsGiftMode] = useState(false);
  const [selectedOpts, setSelectedOpts] = useState({});
  const [optionQty, setOptionQty] = useState(1);
  const [optNote, setOptNote] = useState('');
  const [choicePrice, setChoicePrice] = useState(null); // price from selected choice

  const catTabsRef = useRef(null);
  const sectionRefs = useRef({});
  const scrollTimeout = useRef(null);
  const justPaidRef = useRef(false); // track payment to avoid double-banner
  const locationRef = useRef(null); // { lat, lng, accuracy } — thu thập im lặng

  // ─── LocalStorage helpers ───
  const STORAGE_KEY = 'order_session';

  function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function saveSession(name, phone, address = '', orderId = null) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tableId: urlTableId,
        customerName: name,
        customerPhone: phone,
        deliveryAddress: address,
        orderId,
        date: getTodayStr(),
      }));
    } catch (error) {
      console.warn('LocalStorage error:', error);
    }
  }

  function clearSession() {
    // Keep name/phone/address for reuse, only clear table-specific data
    const saved = getSavedSession();
    if (saved) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          customerName: saved.customerName,
          customerPhone: saved.customerPhone,
          deliveryAddress: saved.deliveryAddress,
        }));
      } catch (error) {
        console.warn('LocalStorage error:', error);
      }
    }
  }

  function getSavedSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  // Body scroll lock effect
  useEffect(() => {
    const isModalOpen = showInfoModal || showCart || showOrdered;
    if (isModalOpen) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [showInfoModal, showCart, showOrdered]);

  // Cập nhật trạng thái đơn/in bill tự động mỗi 3 giây khi khách xem "Món đã gọi"
  useEffect(() => {
    if (!showOrdered) return;
    const interval = setInterval(() => {
      fetchPreviousOrders();
    }, 3000);
    return () => clearInterval(interval);
  }, [showOrdered, customerPhone]);

  // ─── Init: check localStorage session ───
  useEffect(() => {
    initSession();
    const saved = getSavedSession();
    if (saved?.orderId) setCurrentOrderId(saved.orderId);
    
    // Thu thập GPS và kiểm tra khách có ở nhà hàng không
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          locationRef.current = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
          // Lấy tọa độ nhà hàng từ settings
          const { data } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'restaurant_location')
            .maybeSingle();
          if (data?.value) {
            try {
              const { lat: rLat, lng: rLng, radius = 300 } = JSON.parse(data.value);
              const dist = getDistanceMeters(pos.coords.latitude, pos.coords.longitude, rLat, rLng);
              if (dist > radius) setLocationWarning(true);
            } catch {}
          }
        },
        () => { /* từ chối — bỏ qua, không cản trở */ },
        { timeout: 8000, maximumAge: 60000 }
      );
    }
  }, []);

  // Tính khoảng cách giữa 2 tọa độ (Haversine, kết quả bằng mét)
  function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const a = sinDLat * sinDLat + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * sinDLng * sinDLng;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ─── Realtime: detect when admin cancels order or resets table ───
  useEffect(() => {
    if (!activeTableId) return;

    const handleTableReset = async (payload) => {
      // Bàn về available = đã thanh toán hoặc huỷ
      if (payload.new?.status !== 'available') return;
      if (justPaidRef.current) {
        justPaidRef.current = false;
        setCart([]);
        setNotes({});
        setPreviousOrders([]);
        clearSession();
        setShowCart(false);
        setShowOrdered(false);
        return;
      }
      const savedOrderId = getSavedSession()?.orderId;
      let isPaid = false;
      if (savedOrderId) {
        const { data: ord } = await supabase
          .from('orders').select('status, total_amount').eq('id', savedOrderId).maybeSingle();
        isPaid = ord?.status === 'paid';
        if (isPaid) {
          setOrderPaid({ total: ord.total_amount });
          setTimeout(() => setOrderPaid(null), 5000);
        }
      }
      setCart([]);
      setNotes({});
      setPreviousOrders([]);
      clearSession();
      setShowCart(false);
      setShowOrdered(false);
      if (!isPaid) setOrderCancelled(true);
    };

    const channel = supabase
      .channel(`order-page-${activeTableId}-${Date.now()}`)
      // Watch for table status change on HOST table
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'tables',
        filter: `id=eq.${activeTableId}`,
      }, handleTableReset)
      // Watch for print_jobs changes — cập nhật trực tiếp state và re-fetch
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'print_jobs' }, (payload) => {
         const updatedJob = payload.new;
         // Cập nhật trực tiếp vào previousOrders state (không cần re-fetch)
         setPreviousOrders(prev => prev.map(order => {
           const jobs = order.print_jobs || [];
           const jobIdx = jobs.findIndex(j => j.id === updatedJob.id);
           if (jobIdx === -1) return order;
           const newJobs = jobs.map(j => j.id === updatedJob.id ? { ...j, status: updatedJob.status, error_message: updatedJob.error_message } : j);
           return { ...order, print_jobs: newJobs };
         }));
         // Đồng thời re-fetch để đảm bảo dữ liệu chính xác
         try {
           const saved = getSavedSession();
           fetchPreviousOrders(saved?.customerPhone || '');
         } catch(e) { fetchPreviousOrders(); }
      })
      // Watch for orders being cancelled or paid at this table
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'orders',
        filter: `table_id=eq.${activeTableId}`,
      }, (payload) => {
        const savedOrderId = getSavedSession()?.orderId;
        const isMyOrder = savedOrderId && payload.new.id === savedOrderId;
        if (payload.new?.status === 'cancelled') {
          if (isMyOrder) {
            setCart([]);
            setNotes({});
            setPreviousOrders([]);
            clearSession();
            setShowCart(false);
            setShowOrdered(false);
            setOrderCancelled(true);
          } else {
            fetchPreviousOrders();
          }
        } else if (payload.new?.status === 'paid' && isMyOrder) {
          // Flag as paid so table handler knows not to show cancelled banner
          justPaidRef.current = true;
          setOrderPaid({ total: payload.new.total_amount });
          setTimeout(() => setOrderPaid(null), 5000);
          // Don't clearSession here — let table handler do the cleanup
        }
      })
      .subscribe();

    // Nếu khách đang ở bàn satellite (urlTableId khác hostId), cũng cần watch bàn satellite
    // để khi admin thanh toán/reset thì khách nhận được tín hiệu reset
    let satelliteChannel = null;
    if (urlTableId && urlTableId !== activeTableId) {
      satelliteChannel = supabase
        .channel(`order-satellite-${urlTableId}-${Date.now()}`)
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'tables',
          filter: `id=eq.${urlTableId}`,
        }, handleTableReset)
        .subscribe();
    }

    return () => {
      supabase.removeChannel(channel);
      if (satelliteChannel) supabase.removeChannel(satelliteChannel);
    };
  }, [activeTableId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (orderCancelled) {
      const timer = setTimeout(() => {
        setOrderCancelled(false);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [orderCancelled]);

  async function initSession() {
    const isTW = await fetchMenu();
    if (!activeTableId) return;

    const saved = getSavedSession();

    // Always pre-fill name/phone/address if available
    if (saved?.customerName) setCustomerName(saved.customerName);
    if (saved?.customerPhone) setCustomerPhone(saved.customerPhone);
    if (saved?.deliveryAddress) setDeliveryAddress(saved.deliveryAddress);

    // Takeaway: check if there's an existing active order first
    if (isTW) {
      const savedPhone = saved?.customerPhone || '';
      if (savedPhone) {
        // Look for an existing active, not-yet-completed takeaway order for this customer
        const { data: activeOrders } = await supabase
          .from('orders')
          .select('*, order_items(*, menu_item:menu_items(name, price))')
          .eq('table_id', activeTableId)
          .eq('customer_phone', savedPhone)
          .eq('kitchen_completed', false)
          .in('status', ['pending', 'preparing'])
          .order('created_at', { ascending: false })
          .limit(1);

        if (activeOrders && activeOrders.length > 0) {
          // Has active order → skip info modal, load orders and show the "Đã gọi" modal
          setShowInfoModal(false);

          // Pre-fill cart with items from the existing order
          const cartItems = [];
          const seen = new Set();
          activeOrders.forEach(order => {
            (order.order_items || []).forEach(oi => {
              if (!oi.menu_item) return;
              if (seen.has(oi.menu_item_id)) {
                const idx = cartItems.findIndex(c => c.id === oi.menu_item_id);
                if (idx !== -1) cartItems[idx].quantity += oi.quantity;
              } else {
                seen.add(oi.menu_item_id);
                cartItems.push({ id: oi.menu_item_id, name: oi.menu_item.name, price: oi.unit_price, quantity: oi.quantity });
              }
            });
          });
          if (cartItems.length > 0) setCart(cartItems);

          await fetchPreviousOrders(savedPhone);
          setShowOrdered(true);
          return;
        }
      }
      // No active order → show info modal (pre-filled)
      setShowInfoModal(true);
      return;
    }

    // Different table → update tableId, show modal for new bill
    if (saved?.tableId && saved.tableId !== urlTableId) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          customerName: saved.customerName || '',
          customerPhone: saved.customerPhone || '',
          tableId: urlTableId,
          date: getTodayStr(),
        }));
      } catch (err) {}
      setPreviousOrders([]);
      setShowInfoModal(true);
      return;
    }

    // No session or different day → fresh start
    if (!saved?.tableId || saved.date !== getTodayStr()) {
      clearSession();
      setPreviousOrders([]);
      setShowInfoModal(true);
      return;
    }

    // Validate table is still active
    const { data: tableData } = await supabase
      .from('tables')
      .select('status')
      .eq('id', activeTableId)
      .single();

    if (tableData?.status !== 'occupied') {
      clearSession();
      setPreviousOrders([]);
      setShowInfoModal(true);
      return;
    }

    // Kiểm tra session còn hợp lệ không (còn bill đang chờ/làm)
    const savedOrderId = saved?.orderId;
    let hasActiveBill = false;
    if (savedOrderId) {
      const { data: ord } = await supabase
        .from('orders').select('status').eq('id', savedOrderId).maybeSingle();
      hasActiveBill = ord?.status === 'pending' || ord?.status === 'preparing';
    } else if (saved?.customerPhone) {
      // Fallback: tìm theo phone nếu chưa có orderId
      const now2 = new Date();
      const startOfDay2 = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate()).toISOString();
      const { data: activeOrds } = await supabase
        .from('orders').select('id')
        .eq('table_id', activeTableId).eq('customer_phone', saved.customerPhone)
        .gte('created_at', startOfDay2)
        .in('status', ['pending', 'preparing']);
      hasActiveBill = (activeOrds?.length || 0) > 0;
    }

    if (!hasActiveBill) {
      // Không còn bill active → clear session, show modal để đặt mới
      clearSession();
      setPreviousOrders([]);
      setShowInfoModal(true);
      return;
    }

    // Session + bill còn active → skip modal, fetch orders
    setShowInfoModal(false);
    fetchPreviousOrders(saved.customerPhone);
  }

  async function fetchMenu() {
    const [{ data: cats }, { data: items }, { data: tableData }] = await Promise.all([
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('menu_items').select('*, category:categories(name)').eq('is_available', true).order('created_at'),
      activeTableId ? supabase.from('tables').select('table_number, status, table_type, table_name').eq('id', activeTableId).single() : { data: null },
    ]);
    const finalCats = cats || [];
    if (items?.some(i => !i.category_id)) {
      finalCats.push({ id: null, name: 'Chưa phân loại' });
    }
    setCategories(finalCats);
    setMenuItems(items || []);
    const isTW = tableData?.table_type === 'takeaway';
    if (tableData) {
      setTableNumber(isTW ? (tableData.table_name || 'Mang về') : tableData.table_number);
      setIsTakeaway(isTW);
      if (tableData.merged_with) {
        setActiveTableId(tableData.merged_with);
      }
    }
    // Load promotion config
    const { data: settings } = await supabase.from('settings').select('key, value')
      .in('key', ['promotion_enabled', 'promotion_threshold']);
    if (settings) {
      const map = Object.fromEntries(settings.map(r => [r.key, r.value]));
      setPromoConfig({ enabled: map.promotion_enabled === 'true', threshold: parseInt(map.promotion_threshold) || 8 });
    }
    const { data: gifts } = await supabase.from('menu_items').select('id, name, price, image_url, options').eq('is_gift_item', true).eq('is_available', true);
    setGiftItems(gifts || []);
    setLoading(false);
    return isTW;
  }

  async function fetchPreviousOrders(phone = null) {
    const phoneToUse = (phone || customerPhone || '').trim();
    if (!activeTableId) return;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    // Kiểm tra xem bản thân có đang ở bàn này không (có orderId hoặc phone match)
    const savedOrderId = getSavedSession()?.orderId;
    let hasMySession = false;
    if (savedOrderId) {
      const { data: myOrder } = await supabase
        .from('orders').select('status').eq('id', savedOrderId).maybeSingle();
      hasMySession = myOrder?.status === 'pending' || myOrder?.status === 'preparing';
    } else if (phoneToUse) {
      const { data: myOrders } = await supabase
        .from('orders').select('id, status')
        .eq('table_id', activeTableId).eq('customer_phone', phoneToUse)
        .gte('created_at', startOfDay).lt('created_at', endOfDay)
        .in('status', ['pending', 'preparing']);
      hasMySession = (myOrders?.length || 0) > 0;
    }

    // Nếu có session tại bàn → lấy TẤT CẢ bills của bàn hôm nay
    // (kể cả admin order, người khác order, bill đã merge)
    if (hasMySession) {
      const { data: allTableBills } = await supabase
        .from('orders')
        .select(`*, order_items(*, menu_item:menu_items(name, price)), print_jobs(id, status, error_message)`)
        .eq('table_id', activeTableId)
        .gte('created_at', startOfDay).lt('created_at', endOfDay)
        .in('status', ['pending', 'preparing', 'merged', 'completed'])
        .order('created_at', { ascending: false });

      setPreviousOrders(allTableBills || []);
      return;
    }

    // Không còn session active → chỉ hiện của chính mình (bill đã hoàn thành)
    let myFinished = [];
    if (phoneToUse) {
      const { data } = await supabase
        .from('orders')
        .select(`*, order_items(*, menu_item:menu_items(name, price)), print_jobs(id, status, error_message)`)
        .eq('table_id', activeTableId)
        .eq('customer_phone', phoneToUse)
        .gte('created_at', startOfDay).lt('created_at', endOfDay)
        .in('status', ['completed', 'paid', 'merged'])
        .order('created_at', { ascending: false });
      myFinished = data || [];
    } else if (savedOrderId) {
      // Fallback: lấy theo savedOrderId
      const { data } = await supabase
        .from('orders')
        .select(`*, order_items(*, menu_item:menu_items(name, price)), print_jobs(id, status, error_message)`)
        .eq('id', savedOrderId);
      myFinished = data || [];
    }

    setPreviousOrders(myFinished);
  }

  function reorderBill(order) {
    order.order_items?.forEach(oi => {
      if (!oi.menu_item) return;
      const menuItem = menuItems.find(m => m.id === oi.menu_item_id);
      if (!menuItem) return;
      setCart(prev => {
        const existing = prev.find(c => c.id === menuItem.id);
        if (existing) {
          return prev.map(c => c.id === menuItem.id ? { ...c, quantity: c.quantity + oi.quantity } : c);
        }
        return [...prev, { ...menuItem, quantity: oi.quantity }];
      });
    });
    setShowOrdered(false);
  }

  function addToCart(item) {
    // If item has configurable options, show selection modal
    if (item.options && item.options.length > 0) {
      setIsGiftMode(false);
      setOptionModal(item);
      const init = {};
      let initPrice = null;
      item.options.forEach(opt => {
        if (opt.choices && opt.choices.length > 0) {
          init[opt.name] = opt.choices[0];
          if (initPrice === null && opt.prices?.[0] != null && Number(opt.prices[0]) > 0) {
            initPrice = Number(opt.prices[0]);
          }
        }
      });
      setSelectedOpts(init);
      setChoicePrice(initPrice);
      setOptionQty(1);
      setOptNote('');
      return;
    }
    setCart(prev => {
      const existing = prev.find(c => c.id === item.id);
      if (existing) return prev.map(c => c.id === item.id ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, { ...item, quantity: 1 }];
    });
  }

  function confirmOptionAdd() {
    if (!optionModal) return;
    const optionsArr = Object.keys(selectedOpts).map(k => ({ name: k, choice: selectedOpts[k] }));
    const label = optionsArr.map(o => o.choice).join(', ');

    if (isGiftMode) {
      if (optionQty > availableGiftSlots) {
        alert(`Bạn chỉ còn ${availableGiftSlots} lượt chọn miễn phí!`);
        return;
      }
      const newGifts = [];
      for (let i = 0; i < optionQty; i++) {
        newGifts.push({
          id: optionModal.id,
          name: optionModal.name,
          price: 0,
          is_gift: true,
          _options: optionsArr,
          _note: optNote
        });
      }
      setGiftCart(prev => [...prev, ...newGifts]);
      setOptionModal(null);
      setIsGiftMode(false);
      if (availableGiftSlots - optionQty <= 0) setShowGiftModal(false);
      return;
    }

    const price = computeModalPrice(optionModal.price, optionModal.options, selectedOpts);
    const cartItem = {
      ...optionModal,
      price,
      _optionKey: `${optionModal.id}-${label}-${optNote}`, // unique key for this variant
      _options: optionsArr,
      _note: optNote,
      quantity: optionQty,
    };
    setCart(prev => {
      const existing = prev.find(c => c._optionKey === cartItem._optionKey);
      if (existing) return prev.map(c => c._optionKey === cartItem._optionKey ? { ...c, quantity: c.quantity + optionQty } : c);
      return [...prev, cartItem];
    });
    setOptionModal(null);
  }

  function updateQuantity(itemId, delta, optionKey = null) {
    setCart(prev =>
      prev.map(c => {
        const match = optionKey ? c._optionKey === optionKey : (c.id === itemId && !c._optionKey);
        if (!match) return c;
        const newQty = c.quantity + delta;
        return newQty <= 0 ? null : { ...c, quantity: newQty };
      }).filter(Boolean)
    );
  }

  // Promotion calculations
  const qualifyingQty = cart.reduce((sum, item) => sum + (menuItems.find(m => m.id === item.id)?.counts_for_promotion ? item.quantity : 0), 0);
  const giftCount = promoConfig.enabled ? Math.floor(qualifyingQty / promoConfig.threshold) : 0;
  const usedGiftSlots = giftCart.length;
  const availableGiftSlots = Math.max(0, giftCount - usedGiftSlots);

  // Auto-trim giftCart if qualifyingQty drops (customer removed items)
  const [giftLostToast, setGiftLostToast] = useState(false);
  useEffect(() => {
    setGiftCart(prev => {
      if (prev.length > giftCount) {
        setGiftLostToast(true);
        setTimeout(() => setGiftLostToast(false), 4000);
        return prev.slice(0, giftCount);
      }
      return prev;
    });
  }, [giftCount]);

  const totalAmount = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);

  function getCartQty(itemId) {
    // Sum all variants of this item in cart
    return cart.filter(c => c.id === itemId).reduce((s, c) => s + c.quantity, 0);
  }

  // Nhắc khách gửi đơn bằng giọng nói AI (Ưu tiên Chrome Text-to-Speech)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    // Lấy danh sách giọng đọc (Chrome tải bất đồng bộ)
    let voices = window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {
       voices = window.speechSynthesis.getVoices();
    };

    if (cart.length > 0 && !showCart) {
      const timer = setTimeout(() => {
        try {
          const msg = new SpeechSynthesisUtterance('Bạn hãy mở giỏ hàng và gửi đơn đi cho bếp nếu đã chọn món xong nhé!');
          msg.lang = 'vi-VN';
          
          // Ép cứng Chrome dùng giọng Tiếng Việt
          const viVoice = voices.find(v => v.lang === 'vi-VN' || v.lang === 'vi_VN' || v.name.includes('Vietnamese') || v.name.includes('Tiếng Việt'));
          if (viVoice) {
            msg.voice = viVoice;
          }
          
          window.speechSynthesis.speak(msg);
        } catch(e) {}
      }, 12000); // Đợi 12s sau lần tương tác cuối mới nhắc
      return () => clearTimeout(timer);
    }
  }, [cart, showCart]);

  async function submitOrder() {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);

    try {
      let customerId = null;
      if (customerPhone.trim()) {
        const { data: existingCustomer } = await supabase
          .from('customers')
          .select('id, total_spent, visit_count, name')
          .eq('phone', customerPhone.trim())
          .single();

        if (existingCustomer) {
          customerId = existingCustomer.id;
          await supabase
            .from('customers')
            .update({
              name: customerName.trim() || existingCustomer.name,
              total_spent: (existingCustomer.total_spent || 0) + totalAmount,
              visit_count: (existingCustomer.visit_count || 0) + 1,
              last_visit_at: new Date().toISOString(),
            })
            .eq('id', customerId);
        } else {
          const { data: newCustomer } = await supabase
            .from('customers')
            .insert({
              name: customerName.trim() || 'Khách mới',
              phone: customerPhone.trim(),
              total_spent: totalAmount,
              visit_count: 1,
              last_visit_at: new Date().toISOString(),
            })
            .select('id')
            .single();
          customerId = newCustomer?.id;
        }
      }

      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .insert({
          table_id: activeTableId,
          customer_id: customerId,
          customer_name: customerName.trim() || 'Khách ẩn danh',
          customer_phone: customerPhone.trim() || '',
          status: 'pending',
          total_amount: totalAmount,
          ...(isTakeaway && deliveryAddress.trim() ? { delivery_address: deliveryAddress.trim() } : {}),
        })
        .select()
        .single();

      if (orderErr) throw orderErr;

      await supabase.from('order_items').insert([
        ...cart.map(item => ({
          order_id: order.id,
          menu_item_id: item.id,
          quantity: item.quantity,
          unit_price: item.price,
          item_options: item._options || [],
          note: item._note || notes[item.id] || null,
          is_gift: false,
        })),
        ...giftCart.map(g => ({
          order_id: order.id,
          menu_item_id: g.id,
          quantity: 1,
          unit_price: 0,
          item_options: g._options || [],
          note: g._note || null,
          is_gift: true,
        })),
      ]);

      await supabase
        .from('tables')
        .update({ status: 'occupied', occupied_at: new Date().toISOString() })
        .eq('id', activeTableId);

      // Gửi lệnh in tự động khi khách đặt món
      await sendPrintJob(supabase, order.id);

      setCart([]);
      setNotes({});
      setGiftCart([]);
      setShowCart(false);
      setOrderSuccess(true);
      setTimeout(() => setOrderSuccess(false), 3000);
      // Save orderId to session so realtime can detect if THIS bill gets cancelled
      saveSession(customerName.trim(), customerPhone.trim(), deliveryAddress.trim(), order.id);
      setCurrentOrderId(order.id);
      fetchPreviousOrders();
    } catch (err) {
      alert('Có lỗi xảy ra. Vui lòng thử lại.');
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price || 0) + 'đ';
  }

  function getItemDisplayPrice(item) {
    const allPrices = (item.options || []).flatMap(opt =>
      (opt.prices || []).filter(p => p != null && Number(p) > 0).map(Number)
    );
    if (allPrices.length > 0) {
      const min = Math.min(...allPrices);
      const max = Math.max(...allPrices);
      const fmt = n => new Intl.NumberFormat('vi-VN').format(n) + 'đ';
      if (min !== max) return `${fmt(min)} — ${fmt(max)}`;
      return fmt(min);
    }
    return new Intl.NumberFormat('vi-VN').format(item.price || 0) + 'đ';
  }

  // Tính tổng giá từ tất cả lựa chọn đang được chọn trong option modal
  function computeModalPrice(basePrice, options, opts) {
    let hasExplicitOptionPrice = false;
    let sum = 0;
    (options || []).forEach(opt => {
      const ci = opt.choices?.indexOf(opts[opt.name]);
      if (ci >= 0) {
        const p = opt.prices?.[ci];
        if (p !== null && p !== '') {
          sum += Number(p);
          hasExplicitOptionPrice = true;
        }
      }
    });
    return hasExplicitOptionPrice ? sum : Number(basePrice || 0);
  }

  // Lấy tất cả choices của item để hiển thị dạng tags
  function getItemOptionTags(item) {
    if (!item.options || item.options.length === 0) return [];
    return item.options.map(opt => ({
      name: opt.name,
      choices: opt.choices || [],
    }));
  }

  const getItemCategories = (item) => {
    let cats = item.category_id ? [item.category_id] : [];
    if (item.options) {
      item.options.forEach(opt => {
        if (opt.choiceCategories) {
          opt.choiceCategories.forEach(c => {
            if (c && !cats.includes(c)) cats.push(c);
          });
        }
      });
    }
    return cats.length > 0 ? cats : [null];
  };

  // Filtered items
  const filteredItems = menuItems.filter(item => {
    const itemCats = getItemCategories(item);
    const matchCategory = activeCategory === 'all' || itemCats.includes(activeCategory);
    const matchSearch = !searchTerm || removeVietnameseTones(item.name).includes(removeVietnameseTones(searchTerm));
    return matchCategory && matchSearch;
  });

  // Group by category for display
  const groupedItems = [];
  if (activeCategory === 'all') {
    // Flat list without grouping to prevent duplication of multi-category items
    groupedItems.push({
      catId: 'all',
      catName: searchTerm ? 'Kết quả tìm kiếm' : 'Tất cả món ăn',
      items: filteredItems,
    });
  } else {
    const catIdMap = {};
    filteredItems.forEach(item => {
      const itemCats = getItemCategories(item);
      itemCats.forEach(catId => {
        if (catId !== activeCategory) return; // only group the active category
        
        const catObj = categories.find(c => c.id === catId);
        const catName = catObj?.name ? catObj.name : 'Chưa phân loại';
        const actualCatId = catId || 'other';
        if (!catIdMap[actualCatId]) {
          catIdMap[actualCatId] = { catId: actualCatId, catName, items: [] };
          groupedItems.push(catIdMap[actualCatId]);
        }
        // Deduplicate
        if (!catIdMap[actualCatId].items.some(i => i.id === item.id)) {
          catIdMap[actualCatId].items.push(item);
        }
      });
    });
  }

  // Scroll spy: observe which category section is in viewport
  useEffect(() => {
    if (activeCategory !== 'all') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (userScrolling) return;
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const catId = entry.target.getAttribute('data-cat-id');
            // Auto-scroll tab into view
            const tabEl = catTabsRef.current?.querySelector(`[data-tab-id="${catId}"]`);
            if (tabEl) {
              tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              tabEl.classList.add('scrollspy-active');
              // Remove from siblings
              catTabsRef.current?.querySelectorAll('.scrollspy-active').forEach(el => {
                if (el !== tabEl) el.classList.remove('scrollspy-active');
              });
            }
          }
        });
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0.1 }
    );

    Object.values(sectionRefs.current).forEach(el => {
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [activeCategory, userScrolling, groupedItems.length]);

  function handleCatClick(catId) {
    setActiveCategory(catId);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // Validate UUID format
  const isValidUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

  if (!urlTableId || !isValidUUID(urlTableId)) {
    return (
      <div className="co-page">
        <div className="co-error">
          <ChefHat size={48} />
          <h2>Quét mã QR để đặt món</h2>
          <p>Vui lòng quét mã QR trên bàn ăn để vào đúng trang đặt món.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="co-page">
        <div className="co-error"><p>Đang tải thực đơn...</p></div>
      </div>
    );
  }

  return (
    <>
      <PrintErrorAlert 
        customerOrderId={currentOrderId} 
        customerOrderIds={previousOrders.map(o => o.id)}
        onRecovered={() => {
          const saved = getSavedSession();
          fetchPreviousOrders(saved?.customerPhone || '');
        }}
      />
      <div className="co-page">
      <style>{`
        @keyframes bounce-pointer {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(6px); }
        }
        @keyframes promo-pop {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        @keyframes promo-shine {
          to { background-position: -200% center; }
        }
      `}</style>
      {/* Customer Info Modal */}
      {showInfoModal && (
        <div className="co-modal-overlay">
          <div className="co-info-modal">
            <div className="co-info-header" style={{ paddingBottom: '16px' }}>
              <h2 style={{ fontSize: '2.2rem', fontWeight: 800, color: '#111827', margin: 0, lineHeight: 1.2 }}>Bàn {tableNumber || '...'}</h2>
              <p style={{ fontSize: '0.85rem', color: '#15803d', fontWeight: 600, margin: '8px 0 0 0', padding: '4px 12px', background: '#dcfce7', borderRadius: '20px', display: 'inline-block' }}>
                🎁 Nhập thông tin để tích điểm Nhận Quà
              </p>
              <p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '6px 0 0 0', fontStyle: 'italic' }}>
                (Có thể thao tác Bỏ qua ngay ở dưới nếu quý khách thấy phiền)
              </p>
            </div>
            <div className="co-info-form">
              {/* Location warning — chỉ hiện nếu khách ra ngoài phạm vi */}
              {locationWarning && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: '#fff7ed', border: '1px solid #fed7aa',
                  borderRadius: 10, padding: '8px 12px', marginBottom: 4,
                  fontSize: '0.82rem', color: '#92400e',
                }}>
                  <span>⚠️</span>
                  <span>Vị trí của bạn có vẻ không ở nhà hàng. Nếu đây là nhầm lẫn, hãy tiếp tục.</span>
                </div>
              )}
              <div className="co-field">
                <User size={18} />
                <input
                  className="co-input"
                  placeholder="Tên của bạn"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="co-field">
                <Phone size={18} />
                <input
                  className="co-input"
                  placeholder="Số điện thoại"
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </div>
              {isTakeaway && (
                <div className="co-field" style={{ borderColor: '#bfdbfe', background: '#eff6ff' }}>
                  <span style={{ fontSize: '1rem', flexShrink: 0 }}>📍</span>
                  <input
                    className="co-input"
                    placeholder="Địa chỉ nhận hàng (bắt buộc)"
                    value={deliveryAddress}
                    onChange={(e) => setDeliveryAddress(e.target.value)}
                    style={{ background: 'transparent' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                <button
                  className="co-btn-start"
                  style={{ flex: 1, background: '#f3f4f6', color: '#4b5563', border: '1.5px solid #e5e7eb' }}
                  onClick={() => {
                    saveSession('', '', '');
                    setShowInfoModal(false);
                    setShowPromoPopup(true);
                    fetchPreviousOrders();
                  }}
                >
                  Bỏ qua
                </button>
                <button
                  className="co-btn-start"
                  style={{ flex: 2 }}
                  disabled={isTakeaway && !deliveryAddress.trim()}
                  onClick={() => {
                    saveSession(customerName.trim(), customerPhone.trim(), deliveryAddress.trim());
                    setShowInfoModal(false);
                    setShowPromoPopup(true);
                    fetchPreviousOrders();
                  }}
                >
                  {isTakeaway ? '🛵 Đặt món Mang về' : 'Xem thực đơn'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Promo Popup Modal ─── */}
      {showPromoPopup && (
        <div className="co-modal-overlay" style={{ zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="co-info-modal" style={{ borderRadius: '24px', padding: '32px 24px', margin: '0 20px', animation: 'coSlideUp 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)', maxWidth: '360px', position: 'relative', overflow: 'hidden', background: 'linear-gradient(180deg, #ffffff 0%, #fff7ed 100%)' }} onClick={e => e.stopPropagation()}>
            {/* Background elements */}
            <div style={{ position: 'absolute', top: -30, left: -30, fontSize: '6rem', opacity: 0.1, transform: 'rotate(-15deg)' }}>🔥</div>
            <div style={{ position: 'absolute', bottom: -20, right: -20, fontSize: '5rem', opacity: 0.1, transform: 'rotate(15deg)' }}>🎁</div>

            <div style={{ position: 'relative', zIndex: 2, textAlign: 'center' }}>
              <div style={{ fontSize: '3.5rem', marginBottom: '8px', animation: 'promo-pop 2s infinite ease-in-out' }}>🎁</div>
              <h2 style={{ fontSize: '1.8rem', fontWeight: 900, color: '#ea580c', margin: '0 0 16px', lineHeight: 1.2, textTransform: 'uppercase' }}>Tin Vui!</h2>
              
              <div style={{
                fontSize: '1.1rem', color: '#ffffff', fontWeight: 900, margin: '0 auto 24px', padding: '12px 20px',
                background: 'linear-gradient(90deg, #ef4444, #f59e0b, #ef4444)', backgroundSize: '200% auto',
                borderRadius: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%',
                animation: 'promo-pop 1.5s infinite ease-in-out, promo-shine 3s linear infinite', 
                boxShadow: '0 6px 20px rgba(239, 68, 68, 0.4)' 
              }}>
                KHUYẾN MÃI 8 MÓN TẶNG 1 MÓN
              </div>

              <p style={{ color: '#4b5563', fontSize: '0.95rem', fontWeight: 600, lineHeight: 1.5, margin: '0 0 24px' }}>
                Cứ mỗi 8 món được đặt, bạn sẽ được tự do chọn 1 món quà ngẫu nhiên từ nhà hàng! Chúc bạn dùng bữa ngon miệng nha.
              </p>

              <button 
                onClick={() => setShowPromoPopup(false)}
                style={{ 
                  width: '100%', padding: '14px', background: '#3b82f6', color: 'white', 
                  border: 'none', borderRadius: '16px', fontSize: '1.05rem', fontWeight: 800, 
                  cursor: 'pointer', boxShadow: '0 4px 14px rgba(59, 130, 246, 0.3)',
                  transition: 'background 0.2s'
                }}
              >
                Đặt món ngay!
              </button>
            </div>
            
            <button
               onClick={() => setShowPromoPopup(false)}
               style={{ position: 'absolute', top: 12, right: 12, width: 32, height: 32, background: 'rgba(0,0,0,0.05)', borderRadius: '50%', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10 }}
            >
              <X size={18} color="#6b7280" />
            </button>
          </div>
        </div>
      )}

      {/* ─── Top Header (compact) ─── */}
      <div className="co-topbar">
        {/* Restaurant name row */}
        <div className="co-header-bar" style={{ padding: '8px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/* Logo & Contact */}
          <div className="co-header-brand" style={{ flex: 1, minWidth: 0, paddingRight: 5 }}>
            <span className="co-header-title" style={{ display: 'block', fontSize: '1.2rem', fontWeight: 800, color: '#1d4ed8' }}>
              Ốc Bảo Khang
            </span>
            <span className="co-header-contact" style={{ display: 'block', fontSize: '0.65rem', marginTop: 2, color: '#4b5563', whiteSpace: 'nowrap', overflow: 'visible' }}>💬 0946.433.417 | 📞 0977.496.781</span>
          </div>

          {/* Table Badge */}
          <div style={{ display: 'flex', alignItems: 'center', marginRight: '10px' }}>
             <span style={{ fontSize: '0.95rem', background: '#eff6ff', color: '#2563eb', padding: '4px 12px', borderRadius: '20px', fontWeight: '900', border: '1.5px solid #bfdbfe', whiteSpace: 'nowrap' }}>
                {isTakeaway ? 'Mang về' : `Bàn ${tableNumber ?? '...'}`}
             </span>
          </div>

          <div className="co-header-actions" style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button
              className="co-history-btn"
              style={{ padding: '5px 10px', fontSize: '0.75rem' }}
              onClick={() => { setShowOrdered(true); fetchPreviousOrders(); }}
            >
              📋 Đã gọi
            </button>
            <button className="co-header-btn" style={{ width: 30, height: 30 }} onClick={() => setShowInfoModal(true)}>✕</button>
          </div>
        </div>

        {/* Filter row: category dropdown + search */}
        <div className="co-filter-row" style={{ padding: '4px 12px 8px', gap: 6 }}>
          <select
            className="co-cat-dropdown"
            style={{ padding: '7px 10px', fontSize: '0.8rem' }}
            value={activeCategory}
            onChange={e => handleCatClick(e.target.value)}
          >
            <option value="all">Tất cả</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <div className="co-search-box" style={{ padding: '7px 10px' }}>
            <Search size={14} />
            <input
              placeholder="Tìm món"
              style={{ fontSize: '0.8rem' }}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button className="co-search-clear" onClick={() => setSearchTerm('')}>
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ─── Menu Content ─── */}
      <div className="co-content">
        {/* Menu Items */}
        {groupedItems.map(({ catId, catName, items }) => (
          <div
            key={catId}
            className="co-category-group"
            data-cat-id={catId}
            ref={el => { sectionRefs.current[catId] = el; }}
          >
            <h3 className="co-cat-title">{catName} ({items.length})</h3>
            <div className={viewMode === 'grid' ? 'co-items-grid' : 'co-items-list'}>
              {items.map(item => {
                const qty = getCartQty(item.id);
                return viewMode === 'list' ? (
                  <div key={item.id} className="co-item-row" onClick={() => addToCart(item)} style={{ cursor: 'pointer' }}>
                    <div className="co-item-img" style={{ position: 'relative' }}>
                      {item.image_url ? (
                        <Image src={item.image_url} alt={item.name} fill sizes="(max-width: 768px) 100px, 150px" style={{ objectFit: 'cover' }} />
                      ) : (
                        <div className="co-item-placeholder"><ChefHat size={20} /></div>
                      )}
                    </div>
                    <div className="co-item-info">
                      <span className="co-item-name">{item.name}</span>
                      {item.description ? (
                        <span style={{ fontSize: '0.72rem', color: '#ea580c', lineHeight: 1.3, marginTop: 1, display: 'block' }}>{item.description}</span>
                      ) : null}
                      {promoConfig.enabled && item.counts_for_promotion && (
                        <span style={{ fontSize: '0.68rem', color: '#b45309', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 4, padding: '1px 6px', fontWeight: 600, marginTop: 2, alignSelf: 'flex-start' }}>🎯 Được Tính vào Khuyến Mãi</span>
                      )}
                      <span className="co-item-price">{getItemDisplayPrice(item)}</span>
                    </div>
                    <div className="co-item-action">
                      {item.options && item.options.length > 0 ? (
                        /* Có options: luôn cho bấm + để chọn thêm variant */
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {qty > 0 && (
                            <span className="co-qty-badge">{qty}</span>
                          )}
                          <button className="co-add-btn" onClick={(e) => { e.stopPropagation(); addToCart(item); }}>
                            <Plus size={18} />
                          </button>
                        </div>
                      ) : qty > 0 ? (
                        /* Không options: nút +/- bình thường */
                        <div className="co-qty-control" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => updateQuantity(item.id, -1, null)}><Minus size={14} /></button>
                          <span>{qty}</span>
                          <button onClick={() => updateQuantity(item.id, 1, null)}><Plus size={14} /></button>
                        </div>
                      ) : (
                        <button className="co-add-btn" onClick={(e) => { e.stopPropagation(); addToCart(item); }}>
                          <Plus size={18} />
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={item.id} className="co-item-card" onClick={() => addToCart(item)} style={{ cursor: 'pointer' }}>
                    <div className="co-card-img" style={{ position: 'relative' }}>
                      {item.image_url ? (
                        <Image src={item.image_url} alt={item.name} fill sizes="(max-width: 768px) 50vw, 33vw" style={{ objectFit: 'cover' }} />
                      ) : (
                        <div className="co-item-placeholder"><ChefHat size={24} /></div>
                      )}
                    </div>
                    <span className="co-item-name">{item.name}</span>
                    {item.description ? (
                      <span style={{ fontSize: '0.7rem', color: '#ea580c', lineHeight: 1.3, marginTop: 1, display: 'block', padding: '0 4px' }}>{item.description}</span>
                    ) : null}
                    {promoConfig.enabled && item.counts_for_promotion && (
                      <span style={{ fontSize: '0.65rem', color: '#b45309', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 4, padding: '1px 5px', fontWeight: 600, display: 'block', marginBottom: 2 }}>🎯 Được Tính vào Khuyến Mãi</span>
                    )}
                    <div className="co-card-bottom">
                      <span className="co-item-price">{getItemDisplayPrice(item)}</span>
                      {item.options && item.options.length > 0 ? (
                        /* Grid — có options */
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {qty > 0 && (
                            <span className="co-qty-badge co-qty-badge--sm">{qty}</span>
                          )}
                          <button className="co-add-btn small" onClick={(e) => { e.stopPropagation(); addToCart(item); }}>
                            <Plus size={14} />
                          </button>
                        </div>
                      ) : qty > 0 ? (
                        <div className="co-qty-control small" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => updateQuantity(item.id, -1, null)}><Minus size={12} /></button>
                          <span>{qty}</span>
                          <button onClick={() => updateQuantity(item.id, 1, null)}><Plus size={12} /></button>
                        </div>
                      ) : (
                        <button className="co-add-btn small" onClick={(e) => { e.stopPropagation(); addToCart(item); }}>
                          <Plus size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ─── Promotion Progress Bar ─── */}
      {promoConfig.enabled && totalItems > 0 && (
        <div style={{ position: 'fixed', bottom: totalItems > 0 ? 76 : 16, left: 0, right: 0, zIndex: 49, padding: '0 16px', pointerEvents: 'none', transition: 'bottom 0.35s cubic-bezier(0.4, 0, 0.2, 1)' }}>
          {giftCount === 0 ? (
            <div style={{ background: 'rgba(255, 255, 255, 0.95)', backdropFilter: 'blur(10px)', border: '1px solid #fde68a', borderRadius: 20, padding: '14px 18px', boxShadow: '0 8px 32px rgba(245, 158, 11, 0.15)', pointerEvents: 'all' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 700, color: '#b45309', marginBottom: 10 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ background: '#fef3c7', padding: '2px 6px', borderRadius: 6, fontSize: '0.8rem' }}>🚀</span>
                  Đã chọn {qualifyingQty}/{promoConfig.threshold} món
                </span>
                <span>Thêm {promoConfig.threshold - qualifyingQty} món để nhận quà 🎁</span>
              </div>
              <div style={{ height: 10, background: '#fef3c7', borderRadius: 6, overflow: 'hidden', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.05)' }}>
                <div style={{ width: `${Math.min((qualifyingQty / promoConfig.threshold) * 100, 100)}%`, height: '100%', background: 'linear-gradient(90deg, #f59e0b, #ea580c)', borderRadius: 6, transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }} />
              </div>
            </div>
          ) : (
            <div style={{ background: 'linear-gradient(135deg, #1e293b, #0f172a)', border: '1px solid #334155', borderRadius: 24, padding: '12px 14px 12px 18px', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.3)', pointerEvents: 'all', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ background: 'linear-gradient(135deg, #f59e0b, #ea580c)', borderRadius: '50%', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem', boxShadow: '0 4px 12px rgba(234, 88, 12, 0.4)', flexShrink: 0 }}>
                  🎁
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '1rem', fontWeight: 800, color: '#f8fafc', letterSpacing: '0.2px' }}>Quà tặng mở khóa!</span>
                  <span style={{ fontSize: '0.78rem', fontWeight: 500, color: '#94a3b8' }}>
                    Được chọn {giftCount} món
                    {usedGiftSlots > 0 && <span style={{ color: '#f59e0b', marginLeft: 4 }}>({usedGiftSlots}/{giftCount})</span>}
                  </span>
                </div>
              </div>
              {availableGiftSlots > 0 && (
                <button 
                  onClick={() => setShowGiftModal(true)} 
                  style={{ flexShrink: 0, pointerEvents: 'all', background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: '1px solid #34d399', borderRadius: 20, padding: '8px 16px', fontWeight: 800, fontSize: '0.85rem', cursor: 'pointer', boxShadow: '0 4px 14px rgba(16,185,129,0.4)', textTransform: 'uppercase', letterSpacing: '0.5px', animation: 'co-gift-pulse 2s infinite' }}
                >
                  Chọn Quà ({availableGiftSlots})
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── Cart FAB ─── */}
      <style>{`
        @keyframes co-cart-shimmer {
          0% { left: -100%; opacity: 0; }
          15% { opacity: 0.8; }
          30% { left: 100%; opacity: 0; }
          100% { left: 100%; opacity: 0; }
        }
        @keyframes co-cart-attention {
          0%, 100% { transform: translateY(0) rotate(0); }
          5% { transform: translateY(-5px) rotate(-8deg); }
          10% { transform: translateY(0) rotate(6deg); }
          15% { transform: translateY(-2px) rotate(-4deg); }
          20% { transform: translateY(0) rotate(0); }
        }
      `}</style>
      
      {/* ─── Cart FAB (Split Design) ─── */}
      {totalItems > 0 && (
        <div style={{ 
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 90, 
          maxWidth: 500, margin: '0 auto', 
          padding: '12px 16px', paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
          display: 'flex', gap: 12, pointerEvents: 'none', alignItems: 'stretch'
        }}>
          {/* Nút Chọn Lại */}
          <button 
            onClick={(e) => {
              e.stopPropagation();
              setShowResetConfirm(true);
            }}
            style={{ 
              pointerEvents: 'auto', flexShrink: 0,
              background: 'white', color: '#ef4444', 
              border: '2px solid #ef4444', borderRadius: '16px', 
              padding: '0 14px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, 
              cursor: 'pointer', boxShadow: '0 4px 14px rgba(239, 68, 68, 0.15)', transition: 'transform 0.1s'
            }}
          >
            <RotateCcw size={18} strokeWidth={2.5} />
            <span style={{ fontSize: '0.7rem', fontWeight: 900 }}>CHỌN LẠI</span>
          </button>

          {/* Nút Giỏ Hàng */}
          <button 
            onClick={() => setShowCart(true)}
            style={{ 
              pointerEvents: 'auto', flex: 1, minWidth: 0,
              background: !showCart ? 'linear-gradient(135deg, #3b82f6, #2563eb)' : '#2563eb',
              boxShadow: !showCart ? '0 6px 20px rgba(37, 99, 235, 0.45)' : '0 4px 14px rgba(37, 99, 235, 0.3)',
              overflow: 'hidden', position: 'relative',
              borderRadius: '16px', border: 'none', color: 'white', padding: '12px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer'
            }}
          >
            {!showCart && (
              <div style={{
                position: 'absolute', top: 0, left: 0, width: '60%', height: '100%',
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)',
                transform: 'skewX(-20deg)', animation: 'co-cart-shimmer 3s infinite', pointerEvents: 'none'
              }} />
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative', zIndex: 2, minWidth: 0 }}>
              <div style={{ position: 'relative', animation: !showCart ? 'co-cart-attention 3s infinite 0.2s' : 'none' }}>
                <ShoppingBag size={24} style={{ flexShrink: 0 }} />
                {!showCart && <span style={{ position: 'absolute', top: -4, right: -4, width: 10, height: 10, background: '#fef3c7', borderRadius: '50%', boxShadow: '0 0 0 2px #2563eb' }} />}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.95rem', fontWeight: 800 }}>
                  {(!showCart && (totalItems + giftCart.length) > 0) ? 'BẤM ĐỂ GỬI MÓN!' : 'Giỏ hàng'}
                </span>
                {!showCart && <span style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.9 }}>{totalItems + giftCart.length} món • Gửi ngay</span>}
              </div>
            </div>
            
            <strong style={{ position: 'relative', zIndex: 2, fontSize: '1.05rem', fontWeight: 900, flexShrink: 0 }}>{formatPrice(totalAmount)}</strong>
          </button>
        </div>
      )}

      {/* ─── Reset Confirm Modal ─── */}
      {showResetConfirm && (
        <div className="co-modal-overlay" onClick={() => setShowResetConfirm(false)} style={{ zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="co-info-modal" style={{ borderRadius: '24px', padding: '24px', margin: '0 20px', animation: 'coSlideUp 0.3s ease', maxWidth: '340px' }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: '#fee2e2', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <RotateCcw size={32} strokeWidth={2.5} />
              </div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 900, color: '#111827', margin: '0 0 8px' }}>Chọn lại từ đầu?</h3>
              <p style={{ color: '#6b7280', fontSize: '0.9rem', fontWeight: 600, lineHeight: 1.5, margin: 0 }}>Toàn bộ món ăn và quà tặng đã chọn sẽ bị xóa. Bạn có chắc chắn muốn bắt đầu lại?</p>
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button 
                onClick={() => setShowResetConfirm(false)}
                style={{ flex: 1, padding: '14px', background: '#f3f4f6', color: '#4b5563', border: 'none', borderRadius: '16px', fontSize: '0.95rem', fontWeight: 800, cursor: 'pointer' }}
              >
                Giữ lại
              </button>
              <button 
                onClick={() => {
                  setCart([]);
                  setGiftCart([]);
                  setShowResetConfirm(false);
                }}
                style={{ flex: 1, padding: '14px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '16px', fontSize: '0.95rem', fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px rgba(239, 68, 68, 0.3)' }}
              >
                Đồng ý xóa
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ─── Gift Item Modal ─── */}
      {showGiftModal && (
        <div className="co-modal-overlay" onClick={() => setShowGiftModal(false)}>
          <div className="co-info-modal" style={{ maxHeight: '80vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div className="co-info-header" style={{ paddingBottom: 12 }}>
              <div style={{ fontSize: '2rem' }}>🎁</div>
              <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Chọn món tặng</h2>
              <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#6b7280' }}>
                Còn {availableGiftSlots} lượt chọn miễn phí
              </p>
            </div>
            <div style={{ padding: '0 16px 16px' }}>
              {giftItems.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Chưa có món tặng nào được cấu hình</p>
              ) : giftItems.map(g => (
                <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ width: 48, height: 48, borderRadius: 8, background: '#f1f5f9', flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
                    {g.image_url
                      ? <img src={g.image_url} alt={g.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.4rem' }}>🍽️</div>}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{g.name}</div>
                    <div style={{ fontSize: '0.75rem', color: '#16a34a', fontWeight: 600 }}>Miễn phí 🎁</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {(() => { const addedQty = giftCart.filter(x => x.id === g.id).length; return addedQty > 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button onClick={() => setGiftCart(prev => { const idx = prev.findLastIndex(x => x.id === g.id); return idx >= 0 ? prev.filter((_, i) => i !== idx) : prev; })} style={{ width: 28, height: 28, borderRadius: '50%', border: '1.5px solid #e5e7eb', background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '1rem', color: '#374151' }}>−</button>
                        <span style={{ fontWeight: 700, minWidth: 18, textAlign: 'center', fontSize: '0.95rem' }}>{addedQty}</span>
                      </div>
                    ) : null; })()}
                    <button
                      disabled={availableGiftSlots === 0}
                      onClick={() => {
                        if (availableGiftSlots <= 0) return;
                        if (g.options && g.options.length > 0) {
                          setIsGiftMode(true);
                          setOptionModal(g);
                          const init = {};
                          g.options.forEach(opt => {
                            if (opt.choices && opt.choices.length > 0) init[opt.name] = opt.choices[0];
                          });
                          setSelectedOpts(init);
                          setOptionQty(1);
                          setOptNote('');
                        } else {
                          setGiftCart(prev => [...prev, { id: g.id, name: g.name, price: 0, is_gift: true }]);
                          if (availableGiftSlots - 1 === 0) setShowGiftModal(false);
                        }
                      }}
                      style={{ background: availableGiftSlots > 0 ? '#16a34a' : '#e2e8f0', color: availableGiftSlots > 0 ? 'white' : '#94a3b8', border: 'none', borderRadius: 8, padding: '6px 14px', fontWeight: 700, fontSize: '0.82rem', cursor: availableGiftSlots > 0 ? 'pointer' : 'not-allowed' }}>
                      + Thêm
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: '0 16px 16px' }}>
              <button onClick={() => setShowGiftModal(false)} style={{ width: '100%', padding: '11px', background: '#f1f5f9', border: 'none', borderRadius: 10, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>Xong</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Order Success Toast ─── */}
      {orderSuccess && (
        <div className="co-success-toast">
          ✅ Đã gửi đơn hàng thành công!
        </div>
      )}

      {/* ─── Gift Lost Toast ─── */}
      {giftLostToast && (
        <div className="co-success-toast" style={{ background: '#92400e', borderColor: '#fbbf24' }}>
          ⚠️ Bạn đã xóa bớt món — món tặng đã bị hủy do không đủ số lượng!
        </div>
      )}

      {/* ─── Order Paid Banner ─── */}
      {orderPaid && (
        <div className="co-cancelled-banner" style={{ background: 'linear-gradient(135deg,#052e16,#14532d)', borderColor: '#16a34a' }}>
          <div className="co-cancelled-icon">✅</div>
          <div className="co-cancelled-text">
            <strong style={{ color: '#4ade80' }}>Thanh toán thành công!</strong>
            <span style={{ color: '#86efac' }}>
              Cảm ơn quý khách đã ủng hộ nhà hàng 🙏
              {orderPaid.total > 0 && (
                <b style={{ display: 'block', fontSize: '1.1rem', color: 'white', marginTop: 4 }}>
                  {orderPaid.total.toLocaleString('vi-VN')} đ
                </b>
              )}
            </span>
          </div>
          <button
            className="co-cancelled-restart"
            style={{ background: '#16a34a', borderColor: '#16a34a' }}
            onClick={() => setOrderPaid(null)}
          >
            Đóng
          </button>
        </div>
      )}

      {/* ─── Order Cancelled Banner ─── */}
      {orderCancelled && (
        <div className="co-cancelled-banner">
          <div className="co-cancelled-icon">🗑️</div>
          <div className="co-cancelled-text">
            <strong>Đơn hàng đã bị hủy</strong>
            <span>Nhà hàng đã hủy toàn bộ đơn của bàn này.</span>
          </div>
          <button
            className="co-cancelled-restart"
            onClick={() => {
              setOrderCancelled(false);
              setShowInfoModal(true);
            }}
          >
            Đặt lại
          </button>
        </div>
      )}

      {/* ─── Option Selection Modal ─── */}
      {optionModal && (
        <div className="co-modal-overlay" onClick={() => setOptionModal(null)}>
          <div className="co-sheet" onClick={e => e.stopPropagation()} style={{ maxHeight: '85vh' }}>
            <div className="co-sheet-handle" />
            <div className="co-sheet-header">
              <div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem', display: 'flex', alignItems: 'center' }}>
                  {optionModal.name} {isGiftMode && <span style={{fontSize: '0.75rem', color: '#16a34a', background: '#dcfce7', padding: '2px 6px', borderRadius: 4, marginLeft: 8}}>🎁 Món Tặng</span>}
                </div>
                {optionModal.description ? (
                  <div style={{ fontSize: '0.78rem', color: '#ea580c', marginTop: 2, lineHeight: 1.4 }}>{optionModal.description}</div>
                ) : null}
                <div style={{ color: isGiftMode ? '#16a34a' : '#2563eb', fontWeight: 700, fontSize: '1rem', marginTop: 2 }}>
                  {isGiftMode ? 'Miễn phí — 0đ' : `${computeModalPrice(optionModal.price, optionModal.options, selectedOpts).toLocaleString('vi-VN')}đ`}
                </div>
              </div>
              <button onClick={() => setOptionModal(null)}><X size={20} /></button>
            </div>
            <div className="co-sheet-body">
              {optionModal.options.map((opt, oi) => (
                <div key={oi} style={{ marginBottom: 10, marginTop: oi === 0 ? 0 : 4 }}>
                  <div style={{
                    fontWeight: 800, fontSize: '0.68rem', textTransform: 'uppercase',
                    letterSpacing: '0.06em', color: '#1d4ed8',
                    background: '#eff6ff', borderLeft: '3px solid #2563eb',
                    padding: '3px 8px', borderRadius: '5px',
                    display: 'inline-block', marginBottom: 6
                  }}>{opt.name}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0px' }}>
                    {opt.choices.map((choice, ci) => {
                      const p = opt.prices?.[ci];
                      const hasPrice = p !== null && p !== '';
                      const displayPrice = hasPrice ? Number(p) : 0;
                      const active = selectedOpts[opt.name] === choice;
                      return (
                        <button key={ci} onClick={() => {
                          setSelectedOpts({ ...selectedOpts, [opt.name]: choice });
                          if (hasPrice) setChoicePrice(Number(p));
                        }} style={{
                          padding: '6px 4px', 
                          border: 'none',
                          background: 'transparent',
                          color: active ? '#1d4ed8' : '#4b5563',
                          fontWeight: active ? 700 : 500,
                          fontSize: '0.85rem', cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: '8px',
                          transition: 'all 0.2s ease',
                          textAlign: 'left',
                          width: '100%',
                          borderBottom: ci < opt.choices.length - 1 ? '1px solid #f3f4f6' : 'none',
                        }}>
                          {/* Radio circle */}
                          <div style={{
                            width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                            border: active ? '4.5px solid #2563eb' : '1.5px solid #d1d5db',
                            background: 'white',
                            transition: 'all 0.2s ease'
                          }} />
                          
                          <span style={{ flex: 1, lineHeight: 1.25 }}>{choice}</span>
                          
                          {hasPrice && Number(p) > 0 ? (
                            <span style={{ 
                              fontSize: '0.72rem', 
                              color: active ? '#1e40af' : '#6b7280',
                              fontWeight: 700
                            }}>
                              +{displayPrice.toLocaleString('vi-VN')}đ
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div style={{ marginBottom: 16, marginTop: 4 }}>
                <div style={{
                  fontWeight: 800, fontSize: '0.68rem', textTransform: 'uppercase',
                  letterSpacing: '0.06em', color: '#1d4ed8',
                  background: '#eff6ff', borderLeft: '3px solid #2563eb',
                  padding: '3px 8px', borderRadius: '5px',
                  display: 'inline-block', marginBottom: 8
                }}>Ghi chú</div>
                <input
                  className="co-input"
                  placeholder="Thêm ghi chú cho nhà bếp..."
                  value={optNote}
                  onChange={e => setOptNote(e.target.value)}
                  style={{ borderRadius: 10, padding: '10px 14px' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 8 }}>
                <button onClick={() => setOptionQty(Math.max(1, optionQty - 1))} style={{ width: 36, height: 36, borderRadius: '50%', border: '1.5px solid #e5e7eb', background: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Minus size={18} /></button>
                <span style={{ fontWeight: 700, fontSize: '1.1rem', minWidth: 24, textAlign: 'center' }}>{optionQty}</span>
                <button onClick={() => setOptionQty(optionQty + 1)} style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={18} /></button>
              </div>
            </div>
            <div className="co-sheet-footer">
              <button className="co-btn-submit" onClick={confirmOptionAdd} style={isGiftMode ? { background: '#16a34a' } : {}}>
                {isGiftMode ? 'Thêm món tặng • 0đ' : `Thêm vào giỏ • ${(computeModalPrice(optionModal.price, optionModal.options, selectedOpts) * optionQty).toLocaleString('vi-VN')}đ`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Cart Sheet ─── */}
      {showCart && (
        <div className="co-modal-overlay" onClick={() => setShowCart(false)}>
          <div className="co-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="co-sheet-handle" />
            <div className="co-sheet-header">
              <h3>Giỏ hàng ({totalItems} món)</h3>
              <button onClick={() => setShowCart(false)}><X size={20} /></button>
            </div>
            <div className="co-sheet-body">
              {[...cart].sort((a, b) => a.name.localeCompare(b.name, 'vi')).map((item, idx) => (
                <div key={item._optionKey || item.id + '-' + idx} className="co-cart-item">
                  <div className="co-cart-item-info">
                    <strong>{item.name}</strong>
                    {/* Hiển thị khẩu vị / options đã chọn */}
                    {item._options && item._options.length > 0 && (
                      <span className="co-cart-item-opts">
                        {item._options.map(o => o.choice).join(' · ')}
                      </span>
                    )}
                    {item._note && (
                      <span className="co-cart-item-note">📝 {item._note}</span>
                    )}
                    <span className="co-cart-item-price">{formatPrice(item.price)}</span>
                  </div>
                  <div className="co-qty-control">
                    <button onClick={() => updateQuantity(item._optionKey || item.id, -1, item._optionKey)}><Minus size={14} /></button>
                    <span>{item.quantity}</span>
                    <button onClick={() => updateQuantity(item._optionKey || item.id, 1, item._optionKey)}><Plus size={14} /></button>
                  </div>
                </div>
              ))}
              {/* Gift items in cart */}
              {giftCart.length > 0 && (
                <div style={{ borderTop: '1.5px dashed #86efac', marginTop: 8, paddingTop: 8 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#15803d', marginBottom: 6 }}>🎁 Món tặng miễn phí</div>
                  {giftCart.map((g, idx) => (
                    <div key={idx} className="co-cart-item" style={{ background: '#f0fdf4', borderRadius: 8, padding: '6px 10px', marginBottom: 4 }}>
                      <div className="co-cart-item-info">
                        <strong style={{ color: '#15803d' }}>{g.name}</strong>
                        {g._options && g._options.length > 0 && (
                          <span className="co-cart-item-opts" style={{ color: '#16a34a', opacity: 0.9 }}>
                            {g._options.map(o => o.choice).join(' · ')}
                          </span>
                        )}
                        {g._note && (
                          <span className="co-cart-item-note" style={{ color: '#15803d', opacity: 0.9 }}>📝 {g._note}</span>
                        )}
                        <span style={{ fontSize: '0.75rem', color: '#16a34a', fontWeight: 700, marginTop: 2, display: 'block' }}>🎁 Miễn phí — 0đ</span>
                      </div>
                      <button onClick={() => setGiftCart(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 4 }}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="co-sheet-footer" style={{ position: 'relative' }}>
              <div className="co-cart-total">
                <span>Tổng cộng</span>
                <strong>{formatPrice(totalAmount)}</strong>
              </div>

              {cart.length > 0 && !submitting && (
                <div style={{ position: 'absolute', top: '-38px', left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 10 }}>
                  <div style={{ background: '#ea580c', color: 'white', padding: '6px 16px', borderRadius: '24px', fontSize: '0.85rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 4px 12px rgba(234, 88, 12, 0.4)', animation: 'bounce-pointer 1.2s infinite' }}>
                    👇 Nhớ bấm Gửi đơn để bếp làm nhé!
                  </div>
                </div>
              )}

              <button
                className="co-btn-submit"
                onClick={submitOrder}
                disabled={submitting}
                style={{ position: 'relative', zIndex: 1, boxShadow: cart.length > 0 ? '0 4px 15px rgba(37, 99, 235, 0.35)' : 'none', animation: cart.length > 0 ? 'co-gift-pulse 2.5s infinite' : 'none' }}
              >
                <Send size={18} />
                {submitting ? 'Đang gửi...' : 'Gửi đơn hàng'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Previous Orders Sheet ─── */}
      {showOrdered && (
        <div className="co-modal-overlay" onClick={() => setShowOrdered(false)}>
          <div className="co-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="co-sheet-handle" />
            <div className="co-sheet-header">
              <h3>Món đã gọi</h3>
              <button onClick={() => setShowOrdered(false)}><X size={20} /></button>
            </div>
            <div className="co-sheet-body">
              {previousOrders.length > 0 ? (
                previousOrders.map(order => (
                  <div key={order.id} className="co-prev-order">
                    <div className="co-prev-header">
                      <div className="co-prev-time">
                        <Clock size={14} />
                        {new Date(order.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                        <span className="co-prev-name">
                          • {order.customer_name || 'Admin'}
                          {order.status === 'merged' && <span style={{ fontSize: '0.65rem', background: '#ede9fe', color: '#7c3aed', borderRadius: 4, padding: '0 4px', marginLeft: 4, fontWeight: 700 }}>Đã gộp</span>}
                        </span>
                      </div>
                      {(() => {
                        let text = "";
                        let statusClass = `co-status-${order.status}`;
                        let customStyle = {};

                        if (order.status === 'pending') {
                          const pJobs = order.print_jobs || [];
                          const failed = pJobs.find(j => j.status === 'failed');
                          const done = pJobs.find(j => j.status === 'done');
                          
                          if (failed) {
                            text = "Bếp chưa nhận Bill! Gọi NV duyệt";
                            statusClass = "co-status-failed";
                            customStyle = { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fca5a5' };
                          } else if (done) {
                            text = "Bếp đã nhận Bill";
                            statusClass = "co-status-preparing";
                            customStyle = { background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' };
                          } else {
                            text = "Đang gửi bill vào bếp...";
                            statusClass = "co-status-pending";
                          }
                        } else if (order.status === 'merged') {
                          text = 'Đã gộp vào bill chính';
                          customStyle = { background: '#f5f3ff', color: '#7c3aed', border: '1px solid #c4b5fd' };
                        } else {
                          text = order.status === 'preparing' ? 'Đang làm' :
                                 order.status === 'completed' ? 'Hoàn thành' : 'Đã thanh toán';
                        }
                        
                        return (
                          <span className={`co-status ${statusClass}`} style={customStyle}>
                            {text}
                          </span>
                        );
                      })()}
                    </div>
                    {order.order_items?.map(oi => (
                      <div key={oi.id} className="co-prev-item">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {oi.quantity}x {oi.menu_item?.name || '—'}
                            {oi.is_gift && <span style={{ fontSize: '0.65rem', background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>🎁 Món Tặng</span>}
                          </span>
                          {oi.item_options && oi.item_options.length > 0 && (
                            <span className="co-prev-item-opts">
                              {oi.item_options.map(o => o.choice).join(' · ')}
                            </span>
                          )}
                          {oi.note && (
                            <span className="co-prev-item-note">📝 {oi.note}</span>
                          )}
                        </div>
                        <span style={{ color: oi.is_gift ? '#16a34a' : undefined, fontWeight: oi.is_gift ? 700 : undefined }}>
                          {oi.is_gift ? '0đ' : formatPrice(oi.unit_price * oi.quantity)}
                        </span>
                      </div>
                    ))}
                    <div className="co-prev-footer">
                      <div className="co-prev-total">
                        Tổng: <strong>{formatPrice(order.total_amount)}</strong>
                      </div>
                      {(order.status === 'completed' || order.status === 'paid') && (
                        <button className="co-reorder-btn" onClick={() => reorderBill(order)}>
                          Đặt lại
                        </button>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="co-empty">
                  <ShoppingBag size={32} />
                  <p>Chưa có món nào được gọi</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

export default function OrderPage() {
  return (
    <Suspense fallback={<div className="co-page"><div className="co-error"><p>Đang tải...</p></div></div>}>
      <OrderContent />
    </Suspense>
  );
}
