'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
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

  const catTabsRef = useRef(null);
  const sectionRefs = useRef({});
  const scrollTimeout = useRef(null);

  // ─── LocalStorage helpers ───
  const STORAGE_KEY = 'order_session';

  function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function saveSession(name, phone, address = '') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tableId,
      customerName: name,
      customerPhone: phone,
      deliveryAddress: address,
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
  }, []);

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

    // Session valid → skip modal
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
    setLoading(false);
    return isTW; // return so initSession can decide immediately
  }

  async function fetchPreviousOrders(phone = null) {
    const phoneToUse = (phone || customerPhone || '').trim();
    if (!tableId) return;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    // 1. All active (pending/preparing) bills at this table today — any customer
    const { data: activeBills } = await supabase
      .from('orders')
      .select(`*, order_items(*, menu_item:menu_items(name, price))`)
      .eq('table_id', tableId)
      .gte('created_at', startOfDay)
      .lt('created_at', endOfDay)
      .in('status', ['pending', 'preparing'])
      .order('created_at', { ascending: false });

    // 2. This customer's own completed/paid bills at this table today
    let myFinished = [];
    if (phoneToUse) {
      const { data } = await supabase
        .from('orders')
        .select(`*, order_items(*, menu_item:menu_items(name, price))`)
        .eq('table_id', tableId)
        .eq('customer_phone', phoneToUse)
        .gte('created_at', startOfDay)
        .lt('created_at', endOfDay)
        .in('status', ['completed', 'paid'])
        .order('created_at', { ascending: false });
      myFinished = data || [];
    }

    // Merge & deduplicate
    const allIds = new Set();
    const merged = [];
    [...(activeBills || []), ...myFinished].forEach(order => {
      if (!allIds.has(order.id)) {
        allIds.add(order.id);
        merged.push(order);
      }
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
    setCart(prev => {
      const existing = prev.find(c => c.id === item.id);
      if (existing) return prev.map(c => c.id === item.id ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, { ...item, quantity: 1 }];
    });
  }

  function updateQuantity(itemId, delta) {
    setCart(prev =>
      prev.map(c => {
        if (c.id !== itemId) return c;
        const newQty = c.quantity + delta;
        return newQty <= 0 ? null : { ...c, quantity: newQty };
      }).filter(Boolean)
    );
  }

  function getCartQty(itemId) {
    return cart.find(c => c.id === itemId)?.quantity || 0;
  }

  const totalAmount = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);

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

      await supabase.from('order_items').insert(
        cart.map(item => ({
          order_id: order.id,
          menu_item_id: item.id,
          quantity: item.quantity,
          unit_price: item.price,
          note: notes[item.id] || null,
        }))
      );

      await supabase
        .from('tables')
        .update({ status: 'occupied', occupied_at: new Date().toISOString() })
        .eq('id', tableId);

      setCart([]);
      setNotes({});
      setShowCart(false);
      setOrderSuccess(true);
      setTimeout(() => setOrderSuccess(false), 3000);
      fetchPreviousOrders();
    } catch (err) {
      alert('Có lỗi xảy ra. Vui lòng thử lại.');
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
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

  if (!tableId) {
    return (
      <div className="co-page">
        <div className="co-error">
          <ChefHat size={48} />
          <h2>Quét mã QR để đặt món</h2>
          <p>Vui lòng quét mã QR trên bàn ăn</p>
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
              <ChefHat size={32} />
              <h2>Chào mừng đến Nhà Hàng</h2>
              <p>Bàn {tableNumber || '...'}</p>
            </div>
            <div className="co-info-form">
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

      {/* ─── Top Bar ─── */}
      <div className="co-topbar">
        <div className="co-topbar-row">
          <div className="co-search">
            <Search size={16} />
            <input
              placeholder="Tìm món..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button className="co-search-clear" onClick={() => setSearchTerm('')}>
                <X size={14} />
              </button>
            )}
          </div>
          <button
            className="co-topbar-btn"
            onClick={() => { setShowOrdered(true); fetchPreviousOrders(); }}
          >
            <ShoppingBag size={16} />
            <span>Đã gọi</span>
          </button>
        </div>

        {/* Category Tabs */}
        <div className="co-categories" ref={catTabsRef}>
          <button
            className={`co-cat-btn ${activeCategory === 'all' ? 'active' : ''}`}
            onClick={() => handleCatClick('all')}
          >
            Tất cả
          </button>
          {categories.map(cat => (
            <button
              key={cat.id}
              data-tab-id={cat.id}
              className={`co-cat-btn ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => handleCatClick(cat.id)}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Menu Content ─── */}
      <div className="co-content">
        {/* Item count + view toggle */}
        <div className="co-content-header">
          <span>Tất cả {filteredItems.length} món</span>
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
                      <span className="co-item-price">{formatPrice(item.price)}</span>
                    </div>
                    <div className="co-item-action">
                      {qty > 0 ? (
                        <div className="co-qty-control">
                          <button onClick={() => updateQuantity(item.id, -1)}><Minus size={14} /></button>
                          <span>{qty}</span>
                          <button onClick={() => updateQuantity(item.id, 1)}><Plus size={14} /></button>
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
                    <div className="co-card-bottom">
                      <span className="co-item-price">{formatPrice(item.price)}</span>
                      {qty > 0 ? (
                        <div className="co-qty-control small">
                          <button onClick={() => updateQuantity(item.id, -1)}><Minus size={12} /></button>
                          <span>{qty}</span>
                          <button onClick={() => updateQuantity(item.id, 1)}><Plus size={12} /></button>
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

      {/* ─── Cart FAB ─── */}
      {totalItems > 0 && (
        <div className="co-cart-fab" onClick={() => setShowCart(true)}>
          <ShoppingBag size={20} />
          <span>Giỏ hàng • {totalItems} món</span>
          <strong>{formatPrice(totalAmount)}</strong>
        </div>
      )}

      {/* ─── Order Success Toast ─── */}
      {orderSuccess && (
        <div className="co-success-toast">
          ✅ Đã gửi đơn hàng thành công!
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
              {cart.map(item => (
                <div key={item.id} className="co-cart-item">
                  <div className="co-cart-item-info">
                    <strong>{item.name}</strong>
                    <span className="co-cart-item-price">{formatPrice(item.price)}</span>
                  </div>
                  <div className="co-qty-control">
                    <button onClick={() => updateQuantity(item.id, -1)}><Minus size={14} /></button>
                    <span>{item.quantity}</span>
                    <button onClick={() => updateQuantity(item.id, 1)}><Plus size={14} /></button>
                  </div>
                </div>
              ))}
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
                        <span>{oi.quantity}x {oi.menu_item?.name || '—'}</span>
                        <span>{formatPrice(oi.unit_price * oi.quantity)}</span>
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
