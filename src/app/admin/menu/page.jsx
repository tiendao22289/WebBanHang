'use client';
import { removeVietnameseTones } from '@/lib/utils';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';
import Swal from 'sweetalert2';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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

// ─── Sortable Card Component ───────────────────────────────────────────────
function SortableMenuCard({ item, categories, getItemCategories, getItemDisplayPrice, toggleAvailable, openItemModal, deleteItem }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    position: 'relative',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <MenuCard
        item={item}
        categories={categories}
        getItemCategories={getItemCategories}
        getItemDisplayPrice={getItemDisplayPrice}
        toggleAvailable={toggleAvailable}
        openItemModal={openItemModal}
        deleteItem={deleteItem}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// ─── Menu Card UI ──────────────────────────────────────────────────────────
function MenuCard({ item, categories, getItemCategories, getItemDisplayPrice, toggleAvailable, openItemModal, deleteItem, dragHandleProps }) {
  const isVisible = item.is_available && (!item.hidden_until || new Date(item.hidden_until) < new Date());
  const isTempHidden = item.is_available && item.hidden_until && new Date(item.hidden_until) > new Date();

  return (
    <div className={`menu-card ${!isVisible ? 'unavailable' : ''}`}>
      {/* Drag handle */}
      <div
        {...dragHandleProps}
        style={{
          position: 'absolute',
          top: 6,
          left: 6,
          zIndex: 10,
          cursor: 'grab',
          background: 'rgba(255,255,255,0.85)',
          borderRadius: 6,
          padding: '2px 4px',
          display: 'flex',
          alignItems: 'center',
          color: '#9ca3af',
          touchAction: 'none',
        }}
        title="Kéo để sắp xếp"
      >
        <GripVertical size={14} />
      </div>

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
        <div className="menu-card-cat" style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {getItemCategories(item).map((catId, idx) => {
            const cName = categories.find(c => c.id === catId)?.name || 'Chưa phân loại';
            return <span key={idx} style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontSize: '0.65rem' }}>{cName}</span>;
          })}
        </div>
        <h4 className="menu-card-name" style={{ marginTop: '0.3rem' }}>{item.name}</h4>
        {isTempHidden && (
          <div style={{ fontSize: '0.65rem', background: '#fee2e2', color: '#b91c1c', borderRadius: 4, padding: '2px 6px', fontWeight: 600, display: 'inline-block', marginBottom: 4 }}>
            🕒 Ẩn đến {new Date(item.hidden_until).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        {(item.counts_for_promotion || item.is_gift_item) && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
            {item.counts_for_promotion && <span style={{ fontSize: '0.65rem', background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>🎯 Được Tính vào Khuyến Mãi</span>}
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
              title={isVisible ? 'Ẩn món' : 'Hiện món'}
              style={{ color: isVisible ? '#2563eb' : '#9ca3af' }}
            >
              {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
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
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────
export default function MenuPage() {
  const [categories, setCategories] = useState([]);
  const [menuItems, setMenuItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState('visible');

  // DnD state
  const [activeId, setActiveId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // Modal states
  const [showCatModal, setShowCatModal] = useState(false);
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [editingItem, setEditingItem] = useState(null);

  // Form states
  const [catForm, setCatForm] = useState({ name: '', sort_order: 0 });
  const [itemForm, setItemForm] = useState({
    name: '', description: '', price: '', category_id: '', image_url: '', is_available: true,
    counts_for_promotion: false, is_gift_item: false, promo_divisor: 1,
  });

  // Promotion config
  const [promoConfig, setPromoConfig] = useState({ enabled: false, threshold: 8 });
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [promoSaving, setPromoSaving] = useState(false);

  // DnD sensors — hỗ trợ cả chuột (PC) và ngón tay (điện thoại)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 }, // cần kéo 8px mới kích hoạt
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 6 }, // nhấn giữ 250ms
    })
  );

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

  async function fetchData() {
    const [{ data: cats }, { data: items }] = await Promise.all([
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('menu_items').select('*, category:categories(name)').order('sort_order').order('created_at'),
    ]);
    const fetchedItems = items || [];
    const finalCats = cats || [];
    if (fetchedItems.some(i => getItemCategories(i).includes(null))) {
      finalCats.push({ id: null, name: 'Chưa phân loại' });
    }
    setCategories(finalCats);
    setMenuItems(fetchedItems);
    setLoading(false);
  }

  // ─── Category CRUD ──────────────────────────────────────────────────────
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
    const result = await Swal.fire({
      title: 'Xoá danh mục?',
      text: 'Danh mục này và liên kết với các món ăn sẽ bị huỷ. Tiếp tục?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      cancelButtonColor: '#9ca3af',
      confirmButtonText: 'Vâng, xoá nó',
      cancelButtonText: 'Huỷ'
    });
    if (!result.isConfirmed) return;
    await supabase.from('categories').delete().eq('id', id);
    if (activeCategory === id) setActiveCategory(null);
    fetchData();
  }

  // ─── Menu Item CRUD ─────────────────────────────────────────────────────
  function openItemModal(item = null) {
    if (item) {
      setEditingItem(item);
      const promoOpt = (item.options || []).find(o => o.__promo_divisor);
      const divisor = promoOpt ? promoOpt.__promo_divisor : 1;
      setItemForm({
        name: item.name,
        description: item.description || '',
        price: item.price.toString(),
        category_id: item.category_id || '',
        image_url: item.image_url || '',
        is_available: item.is_available,
        counts_for_promotion: item.counts_for_promotion || false,
        is_gift_item: item.is_gift_item || false,
        promo_divisor: divisor,
        options: (item.options || []).filter(o => !o.__promo_divisor).map(opt => ({
          ...opt,
          prices: opt.prices || Array(opt.choices?.length || 0).fill(null),
          choiceCategories: opt.choiceCategories || Array(opt.choices?.length || 0).fill(''),
          hiddenChoices: opt.hiddenChoices || Array(opt.choices?.length || 0).fill(false),
          promoDivisors: opt.promoDivisors || Array(opt.choices?.length || 0).fill(''),
        })),
      });
    } else {
      setEditingItem(null);
      setItemForm({
        name: '', description: '', price: '',
        category_id: activeCategory || '',
        image_url: '', is_available: true,
        counts_for_promotion: false, is_gift_item: false, promo_divisor: 1,
        options: [
          { name: 'LOẠI', choices: [''], prices: [50000], choiceCategories: [''], hiddenChoices: [false], promoDivisors: [''] },
          {
            name: 'KHẨU VỊ',
            choices: ['Bình Thường', 'Làm Cay', 'Không Cay', 'Xào Mặn', 'Xào Ngọt', 'Ít ớt', 'Cay vừa'],
            prices: [null, null, null, null, null, null, null],
            choiceCategories: ['', '', '', '', '', '', ''],
            hiddenChoices: [false, false, false, false, false, false, false],
            promoDivisors: ['', '', '', '', '', '', ''],
          },
        ],
      });
    }
    setShowItemModal(true);
  }

  async function saveItem() {
    if (!itemForm.name.trim()) return;

    const cleanedOptions = itemForm.options
      .map((opt) => ({
        name: opt.name.trim(),
        choices: opt.choices.map(c => c.trim()).filter(c => c),
        prices: opt.choices
          .map((c, ci) => c.trim() ? (opt.prices?.[ci] ?? null) : null)
          .filter((_, ci) => opt.choices[ci]?.trim()),
        choiceCategories: opt.choices
          .map((c, ci) => c.trim() ? (opt.choiceCategories?.[ci] ?? '') : null)
          .filter((_, ci) => opt.choices[ci]?.trim()),
        hiddenChoices: opt.choices
          .map((c, ci) => c.trim() ? (opt.hiddenChoices?.[ci] ?? false) : false)
          .filter((_, ci) => opt.choices[ci]?.trim()),
        promoDivisors: opt.choices
          .map((c, ci) => c.trim() ? (opt.promoDivisors?.[ci] ?? '') : '')
          .filter((_, ci) => opt.choices[ci]?.trim()),
      }))
      .filter(opt => opt.name && opt.choices.length > 0);

    if (itemForm.counts_for_promotion && parseInt(itemForm.promo_divisor) > 1) {
      cleanedOptions.push({ __promo_divisor: parseInt(itemForm.promo_divisor) });
    }

    const data = {
      name: itemForm.name,
      description: itemForm.description,
      image_url: itemForm.image_url,
      is_available: itemForm.is_available,
      counts_for_promotion: itemForm.counts_for_promotion,
      is_gift_item: itemForm.is_gift_item,
      price: parseInt(itemForm.price) || 0,
      category_id: itemForm.category_id || null,
      options: cleanedOptions,
    };

    if (editingItem) {
      await supabase.from('menu_items').update(data).eq('id', editingItem.id);
    } else {
      // New item: đặt sort_order = max + 1
      const maxOrder = menuItems.reduce((m, i) => Math.max(m, i.sort_order || 0), 0);
      await supabase.from('menu_items').insert({ ...data, sort_order: maxOrder + 1 });
    }
    setShowItemModal(false);
    fetchData();
  }

  async function deleteItem(id) {
    const result = await Swal.fire({
      title: 'Xoá món ăn?',
      text: 'Món ăn này sẽ bị xoá vĩnh viễn khỏi thực đơn.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      cancelButtonColor: '#9ca3af',
      confirmButtonText: 'Vâng, xoá nó',
      cancelButtonText: 'Huỷ'
    });
    if (!result.isConfirmed) return;
    await supabase.from('menu_items').delete().eq('id', id);
    fetchData();
  }

  async function toggleAvailable(item) {
    const isVisible = item.is_available && (!item.hidden_until || new Date(item.hidden_until) < new Date());
    
    if (isVisible) {
      const { value: hideOption } = await Swal.fire({
        title: 'Ẩn món ăn?',
        text: 'Chọn thời gian ẩn món ăn này:',
        icon: 'question',
        input: 'radio',
        inputOptions: {
          'today': 'Hết hôm nay',
          '2h': '2 tiếng',
          '4h': '4 tiếng',
          'indefinite': 'Vô thời hạn'
        },
        inputValidator: (value) => {
          if (!value) {
            return 'Bạn cần chọn thời gian ẩn!';
          }
        },
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#9ca3af',
        confirmButtonText: 'Vâng, ẩn món',
        cancelButtonText: 'Huỷ'
      });

      if (!hideOption) return;

      let updates = {};
      if (hideOption === 'indefinite') {
        updates = { is_available: false, hidden_until: null };
      } else if (hideOption === 'today') {
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        updates = { is_available: true, hidden_until: endOfDay.toISOString() };
      } else if (hideOption === '2h') {
        const time = new Date(Date.now() + 2 * 60 * 60 * 1000);
        updates = { is_available: true, hidden_until: time.toISOString() };
      } else if (hideOption === '4h') {
        const time = new Date(Date.now() + 4 * 60 * 60 * 1000);
        updates = { is_available: true, hidden_until: time.toISOString() };
      }

      await supabase.from('menu_items').update(updates).eq('id', item.id);
    } else {
      const result = await Swal.fire({
        title: 'Hiện món ăn?',
        text: 'Món ăn sẽ hiển thị lại cho khách hàng.',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#2563eb',
        cancelButtonColor: '#9ca3af',
        confirmButtonText: 'Vâng, hiện món',
        cancelButtonText: 'Huỷ'
      });
      if (!result.isConfirmed) return;
      await supabase.from('menu_items').update({ is_available: true, hidden_until: null }).eq('id', item.id);
    }
    fetchData();
  }

  // ─── Option Handlers ────────────────────────────────────────────────────
  function addOption() {
    setItemForm(prev => ({
      ...prev,
      options: [...prev.options, { name: '', choices: [''], prices: [null], choiceCategories: [''], hiddenChoices: [false], promoDivisors: [''] }]
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
    newOptions[optIndex].prices.push(50000);
    if (!newOptions[optIndex].choiceCategories) newOptions[optIndex].choiceCategories = [];
    newOptions[optIndex].choiceCategories.push('');
    if (!newOptions[optIndex].hiddenChoices) newOptions[optIndex].hiddenChoices = [];
    newOptions[optIndex].hiddenChoices.push(false);
    if (!newOptions[optIndex].promoDivisors) newOptions[optIndex].promoDivisors = [];
    newOptions[optIndex].promoDivisors.push('');
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
    if (newOptions[optIndex].choiceCategories) newOptions[optIndex].choiceCategories.splice(choiceIndex, 1);
    if (newOptions[optIndex].hiddenChoices) newOptions[optIndex].hiddenChoices.splice(choiceIndex, 1);
    if (newOptions[optIndex].promoDivisors) newOptions[optIndex].promoDivisors.splice(choiceIndex, 1);
    setItemForm({ ...itemForm, options: newOptions });
  }

  async function toggleChoiceHidden(optIndex, choiceIndex) {
    const newOptions = [...itemForm.options];
    if (!newOptions[optIndex].hiddenChoices) {
      newOptions[optIndex].hiddenChoices = Array(newOptions[optIndex].choices.length).fill(false);
    }
    
    const h = newOptions[optIndex].hiddenChoices[choiceIndex];
    const isHidden = h === true || (typeof h === 'string' && new Date(h) > new Date());

    if (!isHidden) {
      const { value: hideOption } = await Swal.fire({
        title: 'Ẩn lựa chọn này?',
        text: 'Chọn thời gian ẩn:',
        icon: 'question',
        input: 'radio',
        inputOptions: {
          'today': 'Hết hôm nay',
          '2h': '2 tiếng',
          '4h': '4 tiếng',
          'indefinite': 'Vô thời hạn'
        },
        inputValidator: (value) => {
          if (!value) return 'Bạn cần chọn thời gian ẩn!';
        },
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#9ca3af',
        confirmButtonText: 'Vâng, ẩn',
        cancelButtonText: 'Huỷ'
      });

      if (!hideOption) return;

      if (hideOption === 'indefinite') {
        newOptions[optIndex].hiddenChoices[choiceIndex] = true;
      } else if (hideOption === 'today') {
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        newOptions[optIndex].hiddenChoices[choiceIndex] = endOfDay.toISOString();
      } else if (hideOption === '2h') {
        const time = new Date(Date.now() + 2 * 60 * 60 * 1000);
        newOptions[optIndex].hiddenChoices[choiceIndex] = time.toISOString();
      } else if (hideOption === '4h') {
        const time = new Date(Date.now() + 4 * 60 * 60 * 1000);
        newOptions[optIndex].hiddenChoices[choiceIndex] = time.toISOString();
      }
    } else {
      const result = await Swal.fire({
        title: 'Hiện lựa chọn này?',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#2563eb',
        cancelButtonColor: '#9ca3af',
        confirmButtonText: 'Vâng, hiện',
        cancelButtonText: 'Huỷ'
      });
      if (!result.isConfirmed) return;
      newOptions[optIndex].hiddenChoices[choiceIndex] = false;
    }

    setItemForm({ ...itemForm, options: newOptions });
  }

  function updateChoiceCategory(optIndex, choiceIndex, categoryId) {
    const newOptions = [...itemForm.options];
    if (!newOptions[optIndex].choiceCategories) newOptions[optIndex].choiceCategories = [];
    newOptions[optIndex].choiceCategories[choiceIndex] = categoryId;
    setItemForm({ ...itemForm, options: newOptions });
  }

  function updateChoicePromoDivisor(optIndex, choiceIndex, value) {
    const newOptions = [...itemForm.options];
    if (!newOptions[optIndex].promoDivisors) newOptions[optIndex].promoDivisors = [];
    newOptions[optIndex].promoDivisors[choiceIndex] = value === '' ? '' : parseInt(value) || '';
    setItemForm({ ...itemForm, options: newOptions });
  }

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  function getItemDisplayPrice(item) {
    const allPrices = (item.options || []).flatMap(opt =>
      (opt.prices || []).filter(p => p != null && String(p).trim() !== '').map(Number)
    );
    if (allPrices.length > 0) {
      return 'Từ ' + new Intl.NumberFormat('vi-VN').format(Math.min(...allPrices)) + 'đ';
    }
    return new Intl.NumberFormat('vi-VN').format(item.price || 0) + 'đ';
  }

  // ─── DnD Handlers ──────────────────────────────────────────────────────
  function handleDragStart(event) {
    setActiveId(event.active.id);
  }

  async function handleDragEnd(event) {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;

    // Chỉ sắp xếp trong filteredItems (danh sách đang hiển thị)
    const oldIndex = filteredItems.findIndex(i => i.id === active.id);
    const newIndex = filteredItems.findIndex(i => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Tạo mảng mới đã sắp xếp
    const reordered = arrayMove(filteredItems, oldIndex, newIndex);

    // Cập nhật state ngay (optimistic update)
    setMenuItems(prev => {
      // Giữ các item không trong filteredItems, chỉ thay thế những item đang hiển thị
      const filteredIds = new Set(filteredItems.map(i => i.id));
      const others = prev.filter(i => !filteredIds.has(i.id));
      return [...others, ...reordered];
    });

    // Lưu sort_order mới lên Supabase
    setIsSaving(true);
    try {
      const updates = reordered.map((item, idx) => ({
        id: item.id,
        sort_order: idx + 1,
      }));

      // Batch update từng item
      await Promise.all(
        updates.map(u =>
          supabase.from('menu_items').update({ sort_order: u.sort_order }).eq('id', u.id)
        )
      );
    } catch (err) {
      console.error('Lỗi cập nhật thứ tự:', err);
      fetchData(); // rollback nếu lỗi
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Filters ────────────────────────────────────────────────────────────
  const baseItems = menuItems.filter(i => {
    const itemCats = getItemCategories(i);
    if (activeCategory !== null && !itemCats.includes(activeCategory)) return false;
    if (searchQuery.trim()) {
      const q = removeVietnameseTones(searchQuery);
      return removeVietnameseTones(i.name).includes(q) || removeVietnameseTones(i.description || '').includes(q);
    }
    return true;
  });
  const countAll = baseItems.length;
  const countVisible = baseItems.filter(i => i.is_available && (!i.hidden_until || new Date(i.hidden_until) < new Date())).length;
  const countHidden = countAll - countVisible;

  const filteredItems = baseItems.filter(i => {
    const isVisible = i.is_available && (!i.hidden_until || new Date(i.hidden_until) < new Date());
    if (visibilityFilter === 'visible' && !isVisible) return false;
    if (visibilityFilter === 'hidden' && isVisible) return false;
    return true;
  });

  const activeItem = activeId ? menuItems.find(i => i.id === activeId) : null;

  // Drag-and-drop chỉ bật khi không search và xem "Tất cả" danh mục hoặc một danh mục cụ thể
  const isDndEnabled = !searchQuery.trim();

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
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
          {isSaving && (
            <span style={{ fontSize: '0.75rem', color: '#6b7280', fontStyle: 'italic' }}>Đang lưu...</span>
          )}
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
              {cat.name} ({menuItems.filter(i => getItemCategories(i).includes(cat.id)).length})
            </button>
            <div className="category-tab-actions">
              {cat.id !== null && (
                <>
                  <button className="btn-tiny" onClick={() => openCatModal(cat)}><Pencil size={12} /></button>
                  <button className="btn-tiny" onClick={() => deleteCat(cat.id)}><Trash2 size={12} /></button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Search + Visibility Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
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
        <div style={{ display: 'flex', gap: 4, background: '#f3f4f6', borderRadius: 10, padding: 3, flexShrink: 0 }}>
          {[
            { key: 'all', label: 'Tất cả', count: countAll },
            { key: 'visible', label: '👁 Hiện', count: countVisible },
            { key: 'hidden', label: '🙈 Ẩn', count: countHidden }
          ].map(f => (
            <button key={f.key} onClick={() => setVisibilityFilter(f.key)}
              style={{
                padding: '6px 12px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer', transition: 'all 0.15s',
                background: visibilityFilter === f.key ? '#2563eb' : 'transparent',
                color: visibilityFilter === f.key ? 'white' : '#6b7280'
              }}>
              {f.label} <span style={{ opacity: 0.8, fontWeight: 500 }}>({f.count})</span>
            </button>
          ))}
        </div>
      </div>

      {/* DnD hint */}
      {isDndEnabled && filteredItems.length > 1 && (
        <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: '0.76rem' }}>
          <GripVertical size={13} />
          <span>Kéo biểu tượng ⠿ trên mỗi thẻ để thay đổi thứ tự hiển thị</span>
        </div>
      )}

      {/* Menu Grid with DnD */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={filteredItems.map(i => i.id)}
          strategy={rectSortingStrategy}
        >
          <div className="menu-grid">
            {filteredItems.length > 0 ? (
              filteredItems.map((item) => (
                <SortableMenuCard
                  key={item.id}
                  item={item}
                  categories={categories}
                  getItemCategories={getItemCategories}
                  getItemDisplayPrice={getItemDisplayPrice}
                  toggleAvailable={toggleAvailable}
                  openItemModal={openItemModal}
                  deleteItem={deleteItem}
                />
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
        </SortableContext>

        {/* Overlay: bóng mờ hiện trong khi kéo */}
        <DragOverlay>
          {activeItem && (
            <div style={{ opacity: 0.85, transform: 'scale(1.04)', boxShadow: '0 16px 40px rgba(0,0,0,0.2)', borderRadius: 12, background: 'white' }}>
              <MenuCard
                item={activeItem}
                categories={categories}
                getItemCategories={getItemCategories}
                getItemDisplayPrice={getItemDisplayPrice}
                toggleAvailable={() => { }}
                openItemModal={() => { }}
                deleteItem={() => { }}
                dragHandleProps={{}}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

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
                <label className="form-label">Giá bán (đ)</label>
                <input className="input" type="number" value={itemForm.price} onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })} placeholder="0" />
              </div>
              <div className="form-group mb-4">
                <label className="form-label">Mô tả</label>
                <textarea className="textarea" value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} placeholder="Mô tả ngắn về món ăn..." />
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
                {itemForm.counts_for_promotion && (
                  <div style={{ marginLeft: 24, marginBottom: 12 }}>
                    <label style={{ display: 'block', fontSize: '0.75rem', color: '#6b7280', marginBottom: 4 }}>Số lượng cần để tính 1 phần KM</label>
                    <input 
                      type="number" 
                      min="1" 
                      value={itemForm.promo_divisor} 
                      onChange={e => setItemForm({ ...itemForm, promo_divisor: parseInt(e.target.value) || 1 })} 
                      style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '0.8rem', background: '#fff' }}
                    />
                    <p style={{ fontSize: '0.65rem', color: '#9ca3af', marginTop: 4 }}>Ví dụ: Đặt là 2 thì khách mua 2 món này mới tính là 1 phần KM.</p>
                  </div>
                )}
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
                  <div
                    key={optIndex}
                    style={{
                      background: '#fff',
                      border: '1.5px solid #e2e8f0',
                      borderLeft: '4px solid #6366f1',
                      borderRadius: 12,
                      marginBottom: 12,
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: '#f8faff', borderBottom: '1px solid #e2e8f0' }}>
                      <input
                        className="input"
                        value={opt.name}
                        onChange={(e) => updateOptionName(optIndex, e.target.value)}
                        placeholder="Tên nhóm tuỳ chọn (VD: Khẩu vị, Loại)"
                        style={{ flex: 1, fontSize: '0.9rem', fontWeight: 700, border: 'none', background: 'transparent', boxShadow: 'none', padding: '2px 4px', color: '#1e1b4b' }}
                      />
                      <button
                        onClick={() => removeOption(optIndex)}
                        title="Xoá nhóm này"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', opacity: 0.7, padding: 4, display: 'flex', alignItems: 'center' }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>

                    <div style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: itemForm.counts_for_promotion ? '1.5fr 1fr 1.5fr 60px 50px' : '1.7fr 1.3fr 1.6fr 50px', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tên lựa chọn</span>
                        <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Giá (đ)</span>
                        <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Danh mục in</span>
                        {itemForm.counts_for_promotion && <span style={{ fontSize: '0.68rem', color: '#92400e', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', title: 'Số lượng / 1 Khuyến Mãi' }}>SL/1 KM</span>}
                        <span />
                      </div>

                      {opt.choices.map((choice, choiceIndex) => {
                        const h = opt.hiddenChoices?.[choiceIndex];
                        const isHidden = h === true || (typeof h === 'string' && new Date(h) > new Date());
                        const isTempHidden = typeof h === 'string' && new Date(h) > new Date();
                        return (
                        <div key={choiceIndex} style={{ display: 'grid', gridTemplateColumns: itemForm.counts_for_promotion ? '1.5fr 1fr 1.5fr 60px 50px' : '1.7fr 1.3fr 1.6fr 50px', gap: 6, marginBottom: 6, alignItems: 'center', opacity: isHidden ? 0.5 : 1 }}>
                          <input
                            className="input input-sm"
                            value={choice}
                            onChange={(e) => updateOptionChoice(optIndex, choiceIndex, e.target.value)}
                            placeholder={`Xào, Hấp, Luộc...`}
                            style={{ minWidth: 0, textDecoration: isHidden ? 'line-through' : 'none' }}
                          />
                          <input
                            className="input input-sm"
                            type="number"
                            value={opt.prices?.[choiceIndex] ?? ''}
                            onChange={(e) => updateChoicePrice(optIndex, choiceIndex, e.target.value)}
                            placeholder="0"
                            style={{ minWidth: 0, borderColor: '#c7d2fe', background: '#eef2ff', textAlign: 'right', fontSize: '0.85rem', padding: '5px 6px' }}
                          />
                          <select
                            value={opt.choiceCategories?.[choiceIndex] ?? ''}
                            onChange={(e) => updateChoiceCategory(optIndex, choiceIndex, e.target.value)}
                            style={{ minWidth: 0, fontSize: '0.78rem', padding: '5px 6px', border: '1px solid #bbf7d0', borderRadius: 8, background: '#f0fdf4', color: '#166534', cursor: 'pointer', outline: 'none' }}
                          >
                            <option value="">--</option>
                            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                          {itemForm.counts_for_promotion && (
                            <input
                              className="input input-sm"
                              type="number"
                              min="1"
                              value={opt.promoDivisors?.[choiceIndex] ?? ''}
                              onChange={(e) => updateChoicePromoDivisor(optIndex, choiceIndex, e.target.value)}
                              placeholder="-"
                              style={{ minWidth: 0, borderColor: '#fde68a', background: '#fffbeb', textAlign: 'center', fontSize: '0.85rem', padding: '5px 6px', color: '#92400e', fontWeight: 600 }}
                              title="Để trống sẽ dùng số lượng mặc định của món"
                            />
                          )}
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                            <button
                              onClick={() => toggleChoiceHidden(optIndex, choiceIndex)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: isHidden ? '#f59e0b' : '#cbd5e1', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                              title={isTempHidden ? `Đang ẩn đến ${new Date(h).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : isHidden ? "Đang ẩn - Nhấn để hiện" : "Nhấn để ẩn"}
                            >
                              {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                            <button
                              onClick={() => removeOptionChoice(optIndex, choiceIndex)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                              onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                              onMouseLeave={e => e.currentTarget.style.color = '#cbd5e1'}
                              title="Xoá"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        </div>
                      )})}

                      <button
                        onClick={() => addOptionChoice(optIndex)}
                        style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.78rem', color: '#6366f1', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
                      >
                        <Plus size={12} /> Thêm lựa chọn
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
