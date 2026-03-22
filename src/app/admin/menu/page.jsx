'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import {
  Plus,
  Pencil,
  Trash2,
  X,
  GripVertical,
  Eye,
  EyeOff,
  FolderOpen,
  ImageIcon,
} from 'lucide-react';
import './menu.css';

export default function MenuPage() {
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState('visible'); // 'all' | 'visible' | 'hidden'

  // Modal states
  const [showCatModal, setShowCatModal] = useState(false);
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [editingItem, setEditingItem] = useState(null);

  // Form states
  const [catForm, setCatForm] = useState({ name: '', sort_order: 0 });
  const [itemForm, setItemForm] = useState({
    name: '', description: '', price: '', category_id: '', image_url: '', is_available: true,
    counts_for_promotion: false, is_gift_item: false,
  });

  // Promotion config
  const [promoConfig, setPromoConfig] = useState({ enabled: false, threshold: 8 });
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [promoSaving, setPromoSaving] = useState(false);

  useEffect(() => {
    const isModalOpen = showCatModal || showItemModal;
    if (isModalOpen) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [showCatModal, showItemModal]);

  useEffect(() => {
    fetchData();
    fetchPromoConfig();
  }, []);

  async function fetchPromoConfig() {
    const { data } = await supabase.from('settings')
      .select('key, value').in('key', ['promotion_enabled', 'promotion_threshold']);
    if (data) {
      const map = Object.fromEntries(data.map(r => [r.key, r.value]));
      setPromoConfig({
        enabled: map.promotion_enabled === 'true',
        threshold: parseInt(map.promotion_threshold) || 8,
      });
    }
  }

  async function savePromoConfig() {
    setPromoSaving(true);
    // upsert both keys
    for (const [key, value] of [
      ['promotion_enabled', String(promoConfig.enabled)],
      ['promotion_threshold', String(promoConfig.threshold)],
    ]) {
      const { error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'key' });
      if (error) {
        await supabase.from('settings').delete().eq('key', key);
        await supabase.from('settings').insert({ key, value });
      }
    }
    setPromoSaving(false);
    setShowPromoModal(false);
  }

  async function fetchData() {
    const [{ data: cats }, { data: items }] = await Promise.all([
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('menu_items').select('*, category:categories(name)').order('created_at'),
    ]);
    setCategories(cats || []);
    setMenuItems(items || []);
    setLoading(false);
  }

  // Category CRUD
  function openCatModal(cat = null) {
    if (cat) {
      setEditingCat(cat);
      setCatForm({ name: cat.name, sort_order: cat.sort_order });
    } else {
      setEditingCat(null);
      setCatForm({ name: '', sort_order: categories.length + 1 });
    }
    setShowCatModal(true);
  }

  async function saveCat() {
    if (!catForm.name.trim()) return;
    if (editingCat) {
      await supabase.from('categories').update(catForm).eq('id', editingCat.id);
    } else {
      await supabase.from('categories').insert(catForm);
    }
    setShowCatModal(false);
    fetchData();
  }

  async function deleteCat(id) {
    if (!confirm('Xoá danh mục sẽ bỏ liên kết với các món ăn. Tiếp tục?')) return;
    await supabase.from('categories').delete().eq('id', id);
    if (activeCategory === id) setActiveCategory(null);
    fetchData();
  }

  // Menu Item CRUD
  function openItemModal(item = null) {
    if (item) {
      setEditingItem(item);
      setItemForm({
        name: item.name,
        description: item.description || '',
        price: item.price.toString(),
        category_id: item.category_id || '',
        image_url: item.image_url || '',
        is_available: item.is_available,
        counts_for_promotion: item.counts_for_promotion || false,
        is_gift_item: item.is_gift_item || false,
        options: (item.options || []).map(opt => ({
          ...opt,
          prices: opt.prices || Array(opt.choices?.length || 0).fill(null),
        })),
      });
    } else {
      setEditingItem(null);
      setItemForm({
        name: '', description: '', price: '',
        category_id: activeCategory || '',
        image_url: '', is_available: true,
        counts_for_promotion: false, is_gift_item: false,
        options: [],
      });
    }
    setShowItemModal(true);
  }

  async function saveItem() {
    if (!itemForm.name.trim()) return;

    // Auto-compute base price = min of all non-null choice prices
    const allChoicePrices = itemForm.options.flatMap(opt =>
      (opt.prices || []).filter(p => p !== null && p !== '' && Number(p) > 0).map(Number)
    );
    const autoPrice = allChoicePrices.length > 0 ? Math.min(...allChoicePrices) : (parseInt(itemForm.price) || 0);

    // Clean up options (remove empty choices, remove options without names or choices)
    const cleanedOptions = itemForm.options
      .map((opt, oi) => ({
        name: opt.name.trim(),
        choices: opt.choices.map(c => c.trim()).filter(c => c),
        prices: opt.choices
          .map((c, ci) => c.trim() ? (opt.prices?.[ci] ?? null) : null)
          .filter((_, ci) => opt.choices[ci]?.trim()),
      }))
      .filter(opt => opt.name && opt.choices.length > 0);

    const data = {
      name: itemForm.name,
      description: itemForm.description,
      image_url: itemForm.image_url,
      is_available: itemForm.is_available,
      counts_for_promotion: itemForm.counts_for_promotion,
      is_gift_item: itemForm.is_gift_item,
      price: autoPrice,
      category_id: itemForm.category_id || null,
      options: cleanedOptions,
    };

    if (editingItem) {
      const { data: res, error } = await supabase.from('menu_items').update(data).eq('id', editingItem.id).select();
      console.log('[saveItem] update result:', res, 'error:', error, 'payload:', data);
    } else {
      const { data: res, error } = await supabase.from('menu_items').insert(data).select();
      console.log('[saveItem] insert result:', res, 'error:', error);
    }
    setShowItemModal(false);
    fetchData();
  }

  async function deleteItem(id) {
    if (!confirm('Xoá món ăn này?')) return;
    await supabase.from('menu_items').delete().eq('id', id);
    fetchData();
  }

  async function toggleAvailable(item) {
    await supabase.from('menu_items').update({ is_available: !item.is_available }).eq('id', item.id);
    fetchData();
  }

  // Option Handlers
  function addOption() {
    setItemForm(prev => ({
      ...prev,
      options: [...prev.options, { name: '', choices: [''], prices: [null] }]
    }));
  }

  function updateOptionName(index, name) {
    const newOptions = [...itemForm.options];
    newOptions[index].name = name;
    setItemForm({ ...itemForm, options: newOptions });
  }

  function removeOption(index) {
    const newOptions = [...itemForm.options];
    newOptions.splice(index, 1);
    setItemForm({ ...itemForm, options: newOptions });
  }

  function addOptionChoice(optIndex) {
    const newOptions = [...itemForm.options];
    newOptions[optIndex].choices.push('');
    if (!newOptions[optIndex].prices) newOptions[optIndex].prices = [];
    newOptions[optIndex].prices.push(null);
    setItemForm({ ...itemForm, options: newOptions });
  }

  function updateOptionChoice(optIndex, choiceIndex, value) {
    const newOptions = [...itemForm.options];
    newOptions[optIndex].choices[choiceIndex] = value;
    setItemForm({ ...itemForm, options: newOptions });
  }

  function updateChoicePrice(optIndex, choiceIndex, value) {
    const newOptions = [...itemForm.options];
    if (!newOptions[optIndex].prices) newOptions[optIndex].prices = [];
    newOptions[optIndex].prices[choiceIndex] = value === '' ? null : Number(value);
    setItemForm({ ...itemForm, options: newOptions });
  }

  function removeOptionChoice(optIndex, choiceIndex) {
    const newOptions = [...itemForm.options];
    newOptions[optIndex].choices.splice(choiceIndex, 1);
    if (newOptions[optIndex].prices) newOptions[optIndex].prices.splice(choiceIndex, 1);
    setItemForm({ ...itemForm, options: newOptions });
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  function getItemDisplayPrice(item) {
    const allPrices = (item.options || []).flatMap(opt =>
      (opt.prices || []).filter(p => p !== null && p > 0).map(Number)
    );
    if (allPrices.length > 0) {
      return 'Từ ' + new Intl.NumberFormat('vi-VN').format(Math.min(...allPrices)) + 'đ';
    }
    if (item.price > 0) return new Intl.NumberFormat('vi-VN').format(item.price) + 'đ';
    return 'Theo tuỳ chọn';
  }

  // Base: category + search filter (before visibility filter)
  const baseItems = menuItems.filter(i => {
    if (activeCategory && i.category_id !== activeCategory) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return i.name?.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q);
    }
    return true;
  });
  const countAll = baseItems.length;
  const countVisible = baseItems.filter(i => i.is_available).length;
  const countHidden = baseItems.filter(i => !i.is_available).length;

  const filteredItems = baseItems.filter(i => {
    if (visibilityFilter === 'visible' && !i.is_available) return false;
    if (visibilityFilter === 'hidden' && i.is_available) return false;
    return true;
  });

  if (loading) {
    return <div className="page-content"><div className="empty-state"><p>Đang tải...</p></div></div>;
  }

  return (
    <div className="page-content">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'nowrap', gap: 8 }}>
        <div>
          <h1 className="page-title" style={{ marginBottom: 2 }}>Thực đơn</h1>
          <p className="page-subtitle" style={{ margin: 0, fontSize: '0.8rem' }}>Quản lý danh mục và món ăn</p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => setShowPromoModal(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: promoConfig.enabled ? '#eff6ff' : 'white', color: promoConfig.enabled ? '#2563eb' : '#374151', border: `1.5px solid ${promoConfig.enabled ? '#bfdbfe' : '#e5e7eb'}`, borderRadius: 8, fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            🎁 {promoConfig.enabled ? `KM: ${promoConfig.threshold} món` : 'Khuyến mại'}
          </button>
          <button onClick={() => openCatModal()} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: 'white', color: '#374151', border: '1.5px solid #e5e7eb', borderRadius: 8, fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <FolderOpen size={13} /> Thêm DM
          </button>
          <button onClick={() => openItemModal()} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', background: '#111827', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <Plus size={14} /> Thêm món
          </button>
        </div>
      </div>

      {/* Category tabs */}
      <div className="category-tabs">
        <button
          className={`category-tab ${!activeCategory ? 'active' : ''}`}
          onClick={() => setActiveCategory(null)}
        >
          Tất cả ({menuItems.length})
        </button>
        {categories.map((cat) => (
          <div key={cat.id} className="category-tab-wrapper">
            <button
              className={`category-tab ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.name} ({menuItems.filter(i => i.category_id === cat.id).length})
            </button>
            <div className="category-tab-actions">
              <button className="btn-tiny" onClick={() => openCatModal(cat)}><Pencil size={12} /></button>
              <button className="btn-tiny" onClick={() => deleteCat(cat.id)}><Trash2 size={12} /></button>
            </div>
          </div>
        ))}
      </div>

      {/* Search + Visibility Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Search input */}
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none', fontSize: '1rem' }}>🔍</span>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Tìm món ăn..."
            style={{ width: '100%', padding: '9px 36px 9px 36px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box', background: 'white' }}
            onFocus={e => e.target.style.borderColor = '#2563eb'}
            onBlur={e => e.target.style.borderColor = '#e5e7eb'}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '1rem', padding: 2 }}>×</button>
          )}
        </div>
        {/* Visibility filter with counts */}
        <div style={{ display: 'flex', gap: 4, background: '#f3f4f6', borderRadius: 10, padding: 3, flexShrink: 0 }}>
          {[
            {key:'all', label:'Tất cả', count: countAll},
            {key:'visible', label:'👁 Hiện', count: countVisible},
            {key:'hidden', label:'🙈 Ẩn', count: countHidden}
          ].map(f => (
            <button key={f.key} onClick={() => setVisibilityFilter(f.key)}
              style={{ padding: '6px 12px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', transition: 'all 0.15s',
                background: visibilityFilter === f.key ? '#2563eb' : 'transparent',
                color: visibilityFilter === f.key ? 'white' : '#6b7280' }}>
              {f.label} <span style={{ opacity: 0.8, fontWeight: 500 }}>({f.count})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="menu-grid">
        {filteredItems.length > 0 ? (
          filteredItems.map((item) => (
            <div key={item.id} className={`menu-card ${!item.is_available ? 'unavailable' : ''}`}>
              <div className="menu-card-image" style={{ position: 'relative' }}>
                {item.image_url ? (
                  <Image src={item.image_url} alt={item.name} fill sizes="(max-width: 768px) 100vw, 300px" style={{ objectFit: 'cover' }} />
                ) : (
                  <div className="menu-card-placeholder">
                    <ImageIcon size={32} />
                  </div>
                )}
              </div>
              <div className="menu-card-body">
                <div className="menu-card-cat">{item.category?.name || 'Chưa phân loại'}</div>
                <h4 className="menu-card-name">{item.name}</h4>
                {(item.counts_for_promotion || item.is_gift_item) && (
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                    {item.counts_for_promotion && <span style={{ fontSize: '0.65rem', background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>🎯 Tính KM</span>}
                    {item.is_gift_item && <span style={{ fontSize: '0.65rem', background: '#dcfce7', color: '#15803d', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>🎁 Món tặng</span>}
                  </div>
                )}
                {item.description && (
                  <p className="menu-card-desc">{item.description}</p>
                )}
                <div className="menu-card-footer">
                  <span className="menu-card-price">{getItemDisplayPrice(item)}</span>
                  <div className="flex gap-1">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => toggleAvailable(item)}
                      title={item.is_available ? 'Ẩn món' : 'Hiện món'}
                      style={{ color: item.is_available ? '#2563eb' : '#9ca3af' }}
                    >
                      {item.is_available ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openItemModal(item)}>
                      <Pencil size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => deleteItem(item.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
            <FolderOpen size={48} />
            <p>Chưa có món ăn nào</p>
            <button className="btn btn-primary mt-4" onClick={() => openItemModal()}>
              <Plus size={16} /> Thêm món đầu tiên
            </button>
          </div>
        )}
      </div>

      {/* Category Modal */}
      {showCatModal && (
        <div className="modal-overlay" onClick={() => setShowCatModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h3>{editingCat ? 'Sửa danh mục' : 'Thêm danh mục'}</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowCatModal(false)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <div className="form-group mb-4">
                <label className="form-label">Tên danh mục</label>
                <input className="input" value={catForm.name} onChange={(e) => setCatForm({ ...catForm, name: e.target.value })} placeholder="VD: Khai vị, Món chính..." autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">Thứ tự hiển thị</label>
                <input className="input" type="number" value={catForm.sort_order} onChange={(e) => setCatForm({ ...catForm, sort_order: parseInt(e.target.value) || 0 })} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowCatModal(false)}>Huỷ</button>
              <button className="btn btn-primary" onClick={saveCat}>{editingCat ? 'Cập nhật' : 'Thêm'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Menu Item Modal */}
      {showItemModal && (
        <div className="modal-overlay" onClick={() => setShowItemModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingItem ? 'Sửa món ăn' : 'Thêm món ăn'}</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowItemModal(false)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <div className="form-group mb-4">
                <label className="form-label">Tên món</label>
                <input className="input" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} placeholder="VD: Phở bò tái nạm" autoFocus />
              </div>
              <div className="form-group mb-4">
                <label className="form-label">Mô tả</label>
                <textarea className="textarea" value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} placeholder="Mô tả ngắn về món ăn..." />
              </div>
              <div className="flex gap-4 mb-4">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Danh mục</label>
                  <select className="select" value={itemForm.category_id} onChange={(e) => setItemForm({ ...itemForm, category_id: e.target.value })}>
                    <option value="">Chọn danh mục</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group mb-4">
                <label className="form-label">URL hình ảnh</label>
                <input className="input" value={itemForm.image_url} onChange={(e) => setItemForm({ ...itemForm, image_url: e.target.value })} placeholder="https://..." />
              </div>
              <label className="flex items-center gap-2 mb-4" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={itemForm.is_available} onChange={(e) => setItemForm({ ...itemForm, is_available: e.target.checked })} />
                <span className="text-sm">Hiển thị trên thực đơn</span>
              </label>

              {/* Promotion checkboxes */}
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#92400e', marginBottom: 8 }}>🎁 Khuyến mại</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 6 }}>
                  <input type="checkbox" checked={itemForm.counts_for_promotion} onChange={e => setItemForm({ ...itemForm, counts_for_promotion: e.target.checked })} />
                  <span style={{ fontSize: '0.82rem', color: '#374151' }}>🎯 Tính vào khuyến mại (đếm quantity)</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={itemForm.is_gift_item} onChange={e => setItemForm({ ...itemForm, is_gift_item: e.target.checked })} />
                  <span style={{ fontSize: '0.82rem', color: '#374151' }}>🎁 Là món tặng (khách được chọn)</span>
                </label>
              </div>

              {/* Options Section */}
              <div className="options-section" style={{ borderTop: '1px solid #dbeafe', paddingTop: '1rem', marginTop: '1rem' }}>
                <div className="flex justify-between items-center mb-3">
                  <h4 style={{ margin: 0, color: '#111827' }}>Tuỳ chọn món (Khẩu vị, Size...)</h4>
                  <button onClick={addOption} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', border: '1.5px solid #2563eb', borderRadius: 8, background: 'white', color: '#2563eb', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer' }}>
                    <Plus size={13} /> Thêm tuỳ chọn
                  </button>
                </div>

                {itemForm.options.map((opt, optIndex) => (
                  <div key={optIndex} className="option-group" style={{ background: '#f8fafc', border: '1px solid #dbeafe', padding: '12px', borderRadius: 10, marginBottom: '10px' }}>
                    <div className="flex justify-between items-center mb-3 gap-2">
                      <input
                        className="input"
                        value={opt.name}
                        onChange={(e) => updateOptionName(optIndex, e.target.value)}
                        placeholder="Tên tuỳ chọn (VD: Khẩu vị, Độ cay)"
                        style={{ flex: 1 }}
                      />
                      <button className="btn btn-ghost btn-icon" onClick={() => removeOption(optIndex)} title="Xoá tuỳ chọn này" style={{ color: '#dc2626' }}>
                        <Trash2 size={16} />
                      </button>
                    </div>

                    <div className="option-choices">
                      {/* Header row */}
                      <div style={{ display: 'flex', gap: 8, marginBottom: 4, paddingRight: 32 }}>
                        <span style={{ flex: 2, fontSize: '0.72rem', color: '#6b7280', fontWeight: 600 }}>Tên lựa chọn</span>
                        <span style={{ flex: 1, fontSize: '0.72rem', color: '#6b7280', fontWeight: 600 }}>Giá (đ)</span>
                      </div>
                      {opt.choices.map((choice, choiceIndex) => (
                        <div key={choiceIndex} className="flex items-center gap-2 mb-2">
                          <input
                            className="input input-sm"
                            value={choice}
                            onChange={(e) => updateOptionChoice(optIndex, choiceIndex, e.target.value)}
                            placeholder={`Lựa chọn ${choiceIndex + 1} (VD: Xào, Hấp)`}
                            style={{ flex: 2 }}
                          />
                          <input
                            className="input input-sm"
                            type="number"
                            value={opt.prices?.[choiceIndex] ?? ''}
                            onChange={(e) => updateChoicePrice(optIndex, choiceIndex, e.target.value)}
                            placeholder="Giá (VD: 50000)"
                            style={{ flex: 1, borderColor: '#bfdbfe', background: '#eff6ff' }}
                          />
                          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => removeOptionChoice(optIndex, choiceIndex)} style={{ color: '#9ca3af' }}>
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                      <button className="btn btn-ghost btn-sm mt-1" onClick={() => addOptionChoice(optIndex)} style={{ color: '#2563eb', fontSize: '0.8rem' }}>
                        <Plus size={13} /> Thêm lựa chọn
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowItemModal(false)}>Huỷ</button>
              <button onClick={saveItem} style={{ padding: '10px 24px', background: '#111827', color: 'white', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' }}>
                {editingItem ? 'Cập nhật' : 'Thêm món'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Promotion Config Modal */}
      {showPromoModal && (
        <div className="modal-overlay" onClick={() => setShowPromoModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h3>🎁 Cấu hình khuyến mại</h3>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowPromoModal(false)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 20 }}>
                <div style={{ position: 'relative', width: 44, height: 24, background: promoConfig.enabled ? '#2563eb' : '#d1d5db', borderRadius: 12, cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
                  onClick={() => setPromoConfig(p => ({ ...p, enabled: !p.enabled }))}>
                  <div style={{ position: 'absolute', top: 2, left: promoConfig.enabled ? 22 : 2, width: 20, height: 20, background: 'white', borderRadius: '50%', transition: 'left 0.2s' }} />
                </div>
                <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{promoConfig.enabled ? '✅ Đang bật' : '⏸ Đang tắt'}</span>
              </label>
              <div className="form-group">
                <label className="form-label">Số món cần đặt để được tặng (threshold)</label>
                <input className="input" type="number" min="1" value={promoConfig.threshold}
                  onChange={e => setPromoConfig(p => ({ ...p, threshold: parseInt(e.target.value) || 8 }))}
                  placeholder="VD: 8" />
                <p style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 4 }}>
                  Đặt {promoConfig.threshold} món tính KM → tặng 1 món · {promoConfig.threshold * 2} món → tặng 2 món (stacking)
                </p>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowPromoModal(false)}>Huỷ</button>
              <button onClick={savePromoConfig} disabled={promoSaving}
                style={{ padding: '10px 24px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer', opacity: promoSaving ? 0.7 : 1 }}>
                {promoSaving ? 'Đang lưu...' : '💾 Lưu cấu hình'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
