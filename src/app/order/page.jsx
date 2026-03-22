'use client';

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
} from 'lucide-react';
import './order.css';

function OrderContent() {
  const searchParams = useSearchParams();
  const tableId = searchParams.get('table');

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
  // Option selection modal for items with choices
  const [optionModal, setOptionModal] = useState(null);
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tableId,
      customerName: name,
      customerPhone: phone,
      deliveryAddress: address,
      orderId,
      date: getTodayStr(),
    }));
  }

  function clearSession() {
    // Keep name/phone/address for reuse, only clear table-specific data
    const saved = getSavedSession();
    if (saved) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        customerName: saved.customerName,
        customerPhone: saved.customerPhone,
        deliveryAddress: saved.deliveryAddress,
      }));
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

  // ─── Init: check localStorage session ───
  useEffect(() => {
    initSession();
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
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // ─── Realtime: detect when admin cancels order or resets table ───
  useEffect(() => {
    if (!tableId) return;

    const channel = supabase
      .channel(`order-page-${tableId}-${Date.now()}`)
      // Watch for table status change (admin resets table → available)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'tables',
        filter: `id=eq.${tableId}`,
      }, async (payload) => {
        if (payload.new?.status === 'available') {
          // If order handler already flagged as paid, just cleanup — no cancelled banner
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
          // Otherwise query to distinguish paid vs cancelled
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
        }
      })
      // Watch for orders being cancelled or paid at this table
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'orders',
        filter: `table_id=eq.${tableId}`,
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

    return () => { supabase.removeChannel(channel); };
  }, [tableId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function initSession() {
    const isTW = await fetchMenu();
    if (!tableId) return;

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
          .eq('table_id', tableId)
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
    if (saved?.tableId && saved.tableId !== tableId) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        customerName: saved.customerName || '',
        customerPhone: saved.customerPhone || '',
        tableId,
        date: getTodayStr(),
      }));
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
      .eq('id', tableId)
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
        .eq('table_id', tableId).eq('customer_phone', saved.customerPhone)
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
      tableId ? supabase.from('tables').select('table_number, status, table_type, table_name').eq('id', tableId).single() : { data: null },
    ]);
    setCategories(cats || []);
    setMenuItems(items || []);
    const isTW = tableData?.table_type === 'takeaway';
    if (tableData) {
      setTableNumber(isTW ? (tableData.table_name || 'Mang về') : tableData.table_number);
      setIsTakeaway(isTW);
    }
    // Load promotion config
    const { data: settings } = await supabase.from('settings').select('key, value')
      .in('key', ['promotion_enabled', 'promotion_threshold']);
    if (settings) {
      const map = Object.fromEntries(settings.map(r => [r.key, r.value]));
      setPromoConfig({ enabled: map.promotion_enabled === 'true', threshold: parseInt(map.promotion_threshold) || 8 });
    }
    const { data: gifts } = await supabase.from('menu_items').select('id, name, price, image_url').eq('is_gift_item', true).eq('is_available', true);
    setGiftItems(gifts || []);
    setLoading(false);
    return isTW;
  }

  async function fetchPreviousOrders(phone = null) {
    const phoneToUse = (phone || customerPhone || '').trim();
    if (!tableId) return;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    // Kiểm tra bản thân có bill đang active (pending/preparing) không
    const savedOrderId = getSavedSession()?.orderId;
    let hasMyActiveBill = false;
    if (savedOrderId) {
      const { data: myOrder } = await supabase
        .from('orders').select('status').eq('id', savedOrderId).maybeSingle();
      hasMyActiveBill = myOrder?.status === 'pending' || myOrder?.status === 'preparing';
    } else if (phoneToUse) {
      // Fallback: tìm theo phone nếu chưa có orderId
      const { data: myOrders } = await supabase
        .from('orders').select('id, status')
        .eq('table_id', tableId).eq('customer_phone', phoneToUse)
        .gte('created_at', startOfDay).lt('created_at', endOfDay)
        .in('status', ['pending', 'preparing']);
      hasMyActiveBill = (myOrders?.length || 0) > 0;
    }

    let activeBills = [];
    if (hasMyActiveBill) {
      // Có bill đang chờ → xem được tất cả bills đang active ở bàn
      const { data } = await supabase
        .from('orders')
        .select(`*, order_items(*, menu_item:menu_items(name, price))`)
        .eq('table_id', tableId)
        .gte('created_at', startOfDay).lt('created_at', endOfDay)
        .in('status', ['pending', 'preparing'])
        .order('created_at', { ascending: false });
      activeBills = data || [];
    }

    // Luôn hiện bill hoàn thành của chính mình (theo phone)
    let myFinished = [];
    if (phoneToUse) {
      const { data } = await supabase
        .from('orders')
        .select(`*, order_items(*, menu_item:menu_items(name, price))`)
        .eq('table_id', tableId)
        .eq('customer_phone', phoneToUse)
        .gte('created_at', startOfDay).lt('created_at', endOfDay)
        .in('status', ['completed', 'paid'])
        .order('created_at', { ascending: false });
      myFinished = data || [];
    }

    // Merge & deduplicate
    const allIds = new Set();
    const merged = [];
    [...activeBills, ...myFinished].forEach(order => {
      if (!allIds.has(order.id)) { allIds.add(order.id); merged.push(order); }
    });
    setPreviousOrders(merged);
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
    const price = computeModalPrice(optionModal.options, selectedOpts);
    const optionsArr = Object.keys(selectedOpts).map(k => ({ name: k, choice: selectedOpts[k] }));
    const label = optionsArr.map(o => o.choice).join(', ');
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

  async function submitOrder() {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);

    try {
      let customerId = null;
      const { data: existingCustomer } = await supabase
        .from('customers')
        .select('id, total_spent, visit_count')
        .eq('phone', customerPhone.trim())
        .single();

      if (existingCustomer) {
        customerId = existingCustomer.id;
        await supabase
          .from('customers')
          .update({
            name: customerName.trim(),
            total_spent: (existingCustomer.total_spent || 0) + totalAmount,
            visit_count: (existingCustomer.visit_count || 0) + 1,
            last_visit_at: new Date().toISOString(),
          })
          .eq('id', customerId);
      } else {
        const { data: newCustomer } = await supabase
          .from('customers')
          .insert({
            name: customerName.trim(),
            phone: customerPhone.trim(),
            total_spent: totalAmount,
            visit_count: 1,
            last_visit_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        customerId = newCustomer?.id;
      }

      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .insert({
          table_id: tableId,
          customer_id: customerId,
          customer_name: customerName.trim(),
          customer_phone: customerPhone.trim(),
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
          item_options: [],
          note: null,
          is_gift: true,
        })),
      ]);

      await supabase
        .from('tables')
        .update({ status: 'occupied', occupied_at: new Date().toISOString() })
        .eq('id', tableId);

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
  function computeModalPrice(options, opts) {
    let total = 0;
    (options || []).forEach(opt => {
      const ci = opt.choices?.indexOf(opts[opt.name]);
      if (ci >= 0) {
        const p = opt.prices?.[ci];
        if (p != null && Number(p) > 0) total += Number(p);
      }
    });
    return total; // 0 nếu không có option nào có giá
  }

  // Lấy tất cả choices của item để hiển thị dạng tags
  function getItemOptionTags(item) {
    if (!item.options || item.options.length === 0) return [];
    return item.options.map(opt => ({
      name: opt.name,
      choices: opt.choices || [],
    }));
  }

  // Filtered items
  const filteredItems = menuItems.filter(item => {
    const matchCategory = activeCategory === 'all' || item.category_id === activeCategory;
    const matchSearch = !searchTerm || item.name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchCategory && matchSearch;
  });

  // Group by category for display (include catId for scroll spy)
  const groupedItems = [];
  const catIdMap = {};
  filteredItems.forEach(item => {
    const catName = item.category?.name || 'Khác';
    const catId = item.category_id || 'other';
    if (!catIdMap[catId]) {
      catIdMap[catId] = { catId, catName, items: [] };
      groupedItems.push(catIdMap[catId]);
    }
    catIdMap[catId].items.push(item);
  });

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
    if (catId === 'all') {
      setActiveCategory('all');
      return;
    }
    // If already in 'all' mode, scroll to section
    if (activeCategory === 'all') {
      setUserScrolling(true);
      const el = sectionRefs.current[catId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      clearTimeout(scrollTimeout.current);
      scrollTimeout.current = setTimeout(() => setUserScrolling(false), 800);
    } else {
      setActiveCategory(catId);
    }
  }

  // Validate UUID format
  const isValidUUID = (str) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

  if (!tableId || !isValidUUID(tableId)) {
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
    <div className="co-page">
      {/* Customer Info Modal */}
      {showInfoModal && (
        <div className="co-modal-overlay">
          <div className="co-info-modal">
            <div className="co-info-header">
              <ChefHat size={28} />
              <h2>Ốc Bảo Khang</h2>
              <p>Bàn {tableNumber || '...'}</p>
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
              <button
                className="co-btn-start"
                disabled={!customerName.trim() || !customerPhone.trim() || (isTakeaway && !deliveryAddress.trim())}
                onClick={() => {
                  saveSession(customerName.trim(), customerPhone.trim(), deliveryAddress.trim());
                  setShowInfoModal(false);
                  fetchPreviousOrders();
                }}
              >
                {isTakeaway ? '🛵 Đặt món Mang về' : 'Xem thực đơn'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Top Header (white, app-style) ─── */}
      <div className="co-topbar">
        {/* Restaurant name row */}
        <div className="co-header-bar">
          <div className="co-header-brand">
            <span className="co-header-title">Ốc Bảo Khang</span>
            <span className="co-header-contact">💬 0946.433.417 &nbsp;|&nbsp; 📞 0977.496.781</span>
          </div>
          <div className="co-header-actions">
            <button
              className="co-history-btn"
              onClick={() => { setShowOrdered(true); fetchPreviousOrders(); }}
            >
              📋 Đã gọi
            </button>
            <button className="co-header-btn" onClick={() => setShowInfoModal(true)}>✕</button>
          </div>
        </div>

        {/* Table subtitle */}
        <div className="co-table-info">
          Bạn đang ngồi <strong>{isTakeaway ? 'Mang về' : `Bàn ${tableNumber ?? '...'}`}</strong>
        </div>

        {/* Filter row: category dropdown + search */}
        <div className="co-filter-row">
          <select
            className="co-cat-dropdown"
            value={activeCategory}
            onChange={e => handleCatClick(e.target.value)}
          >
            <option value="all">Tất cả</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <div className="co-search-box">
            <Search size={15} />
            <input
              placeholder="Tìm món"
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
        {/* View toggle — right aligned */}
        <div className="co-content-header">
          <div className="co-view-toggle">
            <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
              <List size={16} />
            </button>
            <button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>
              <Grid3X3 size={16} />
            </button>
          </div>
        </div>

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
                  <div key={item.id} className="co-item-row">
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
                        <span style={{ fontSize: '0.68rem', color: '#b45309', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 4, padding: '1px 6px', fontWeight: 600, marginTop: 2, alignSelf: 'flex-start' }}>🎯 Tính vào KM</span>
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
                          <button className="co-add-btn" onClick={() => addToCart(item)}>
                            <Plus size={18} />
                          </button>
                        </div>
                      ) : qty > 0 ? (
                        /* Không options: nút +/- bình thường */
                        <div className="co-qty-control">
                          <button onClick={() => updateQuantity(item.id, -1, null)}><Minus size={14} /></button>
                          <span>{qty}</span>
                          <button onClick={() => updateQuantity(item.id, 1, null)}><Plus size={14} /></button>
                        </div>
                      ) : (
                        <button className="co-add-btn" onClick={() => addToCart(item)}>
                          <Plus size={18} />
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div key={item.id} className="co-item-card">
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
                      <span style={{ fontSize: '0.65rem', color: '#b45309', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 4, padding: '1px 5px', fontWeight: 600, display: 'block', marginBottom: 2 }}>🎯 Tính KM</span>
                    )}
                    <div className="co-card-bottom">
                      <span className="co-item-price">{getItemDisplayPrice(item)}</span>
                      {item.options && item.options.length > 0 ? (
                        /* Grid — có options */
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {qty > 0 && (
                            <span className="co-qty-badge co-qty-badge--sm">{qty}</span>
                          )}
                          <button className="co-add-btn small" onClick={() => addToCart(item)}>
                            <Plus size={14} />
                          </button>
                        </div>
                      ) : qty > 0 ? (
                        <div className="co-qty-control small">
                          <button onClick={() => updateQuantity(item.id, -1, null)}><Minus size={12} /></button>
                          <span>{qty}</span>
                          <button onClick={() => updateQuantity(item.id, 1, null)}><Plus size={12} /></button>
                        </div>
                      ) : (
                        <button className="co-add-btn small" onClick={() => addToCart(item)}>
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
        <div style={{ position: 'fixed', bottom: totalItems > 0 ? 72 : 12, left: 0, right: 0, zIndex: 49, padding: '0 12px', pointerEvents: 'none' }}>
          <div style={{ background: 'white', border: '1.5px solid #fde68a', borderRadius: 12, padding: '8px 14px', boxShadow: '0 2px 12px rgba(0,0,0,0.12)', pointerEvents: 'all' }}>
            {giftCount === 0 ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600, color: '#92400e', marginBottom: 5 }}>
                  <span>🎯 Tích {qualifyingQty}/{promoConfig.threshold} món tính KM</span>
                  <span>Còn {promoConfig.threshold - qualifyingQty} món nữa để nhận quà 🎁</span>
                </div>
                <div style={{ height: 6, background: '#fef3c7', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min((qualifyingQty / promoConfig.threshold) * 100, 100)}%`, height: '100%', background: 'linear-gradient(90deg,#f59e0b,#d97706)', borderRadius: 3, transition: 'width 0.4s' }} />
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#15803d' }}>🎉 Được tặng {giftCount} món! {usedGiftSlots > 0 && `(${usedGiftSlots}/${giftCount} đã chọn)`}</span>
                {availableGiftSlots > 0 && (
                  <button onClick={() => setShowGiftModal(true)} style={{ pointerEvents: 'all', background: '#16a34a', color: 'white', border: 'none', borderRadius: 8, padding: '5px 12px', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}>
                    🎁 Chọn quà ({availableGiftSlots})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Cart FAB ─── */}
      {totalItems > 0 && (
        <div className="co-cart-fab" onClick={() => setShowCart(true)}>
          <ShoppingBag size={20} />
          <span>Giỏ hàng • {totalItems + giftCart.length} món{giftCart.length > 0 && ` (${giftCart.length} 🎁)`}</span>
          <strong>{formatPrice(totalAmount)}</strong>
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
                        setGiftCart(prev => [...prev, { id: g.id, name: g.name, price: 0, is_gift: true }]);
                        if (availableGiftSlots - 1 === 0) setShowGiftModal(false);
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
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{optionModal.name}</div>
                {optionModal.description ? (
                  <div style={{ fontSize: '0.78rem', color: '#ea580c', marginTop: 2, lineHeight: 1.4 }}>{optionModal.description}</div>
                ) : null}
                <div style={{ color: '#2563eb', fontWeight: 700, fontSize: '1rem', marginTop: 2 }}>
                  {computeModalPrice(optionModal.options, selectedOpts).toLocaleString('vi-VN')}đ
                </div>
              </div>
              <button onClick={() => setOptionModal(null)}><X size={20} /></button>
            </div>
            <div className="co-sheet-body">
              {optionModal.options.map((opt, oi) => (
                <div key={oi} style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6b7280', marginBottom: 8 }}>{opt.name}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {opt.choices.map((choice, ci) => {
                      const p = opt.prices?.[ci];
                      const displayPrice = p != null ? Number(p) : 0;
                      const hasCat = !!(opt.choiceCategories?.[ci]);
                      const active = selectedOpts[opt.name] === choice;
                      return (
                        <button key={ci} onClick={() => {
                          setSelectedOpts({ ...selectedOpts, [opt.name]: choice });
                          if (hasP) setChoicePrice(Number(p));
                        }} style={{
                          padding: '8px 14px', borderRadius: 100,
                          border: active ? '2px solid #2563eb' : '1.5px solid #e5e7eb',
                          background: active ? '#eff6ff' : 'white',
                          color: active ? '#1d4ed8' : '#374151',
                          fontWeight: active ? 700 : 500,
                          fontSize: '0.9rem', cursor: 'pointer'
                        }}>
                          {choice}{hasCat ? <span style={{ fontSize: '0.75rem', marginLeft: 4, color: active ? '#2563eb' : '#9ca3af' }}>{displayPrice.toLocaleString('vi-VN')}đ</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#6b7280', marginBottom: 8 }}>Ghi chú</div>
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
              <button className="co-btn-submit" onClick={confirmOptionAdd}>
                Thêm vào giỏ • {(computeModalPrice(optionModal.options, selectedOpts) * optionQty).toLocaleString('vi-VN')}đ
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
            <div className="co-sheet-footer">
              <div className="co-cart-total">
                <span>Tổng cộng</span>
                <strong>{formatPrice(totalAmount)}</strong>
              </div>
              <button
                className="co-btn-submit"
                onClick={submitOrder}
                disabled={submitting}
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
                        {order.customer_name && <span className="co-prev-name">• {order.customer_name}</span>}
                      </div>
                      <span className={`co-status co-status-${order.status}`}>
                        {order.status === 'pending' ? 'Chờ xác nhận' :
                         order.status === 'preparing' ? 'Đang làm' :
                         order.status === 'completed' ? 'Hoàn thành' : 'Đã thanh toán'}
                      </span>
                    </div>
                    {order.order_items?.map(oi => (
                      <div key={oi.id} className="co-prev-item">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {oi.quantity}x {oi.menu_item?.name || '—'}
                            {oi.is_gift && <span style={{ fontSize: '0.65rem', background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>🎁 Tặng</span>}
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
  );
}

export default function OrderPage() {
  return (
    <Suspense fallback={<div className="co-page"><div className="co-error"><p>Đang tải...</p></div></div>}>
      <OrderContent />
    </Suspense>
  );
}
