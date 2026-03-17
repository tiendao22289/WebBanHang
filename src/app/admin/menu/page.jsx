'use client';

import { useState, useEffect } from 'react';
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

  // Modal states
  const [showCatModal, setShowCatModal] = useState(false);
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingCat, setEditingCat] = useState(null);
  const [editingItem, setEditingItem] = useState(null);

  // Form states
  const [catForm, setCatForm] = useState({ name: '', sort_order: 0 });
  const [itemForm, setItemForm] = useState({
    name: '', description: '', price: '', category_id: '', image_url: '', is_available: true,
  });

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    const [{ data: cats }, { data: items }] = await Promise.all([
      supabase.from('categories').select('*').order('sort_order'),
      supabase.from('menu_items').select('*, category:categories(name)').order('created_at'),
    ]);
    setCategories(cats || []);
    setMenuItems(items || []);
    if (!activeCategory && cats?.length > 0) {
      setActiveCategory(cats[0].id);
    }
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
      });
    } else {
      setEditingItem(null);
      setItemForm({
        name: '', description: '', price: '',
        category_id: activeCategory || '',
        image_url: '', is_available: true,
      });
    }
    setShowItemModal(true);
  }

  async function saveItem() {
    if (!itemForm.name.trim() || !itemForm.price) return;
    const data = {
      ...itemForm,
      price: parseInt(itemForm.price),
      category_id: itemForm.category_id || null,
    };
    if (editingItem) {
      await supabase.from('menu_items').update(data).eq('id', editingItem.id);
    } else {
      await supabase.from('menu_items').insert(data);
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

  function formatPrice(price) {
    return new Intl.NumberFormat('vi-VN').format(price) + 'đ';
  }

  const filteredItems = activeCategory
    ? menuItems.filter(i => i.category_id === activeCategory)
    : menuItems;

  if (loading) {
    return <div className="page-content"><div className="empty-state"><p>Đang tải...</p></div></div>;
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">Thực đơn</h1>
          <p className="page-subtitle">Quản lý danh mục và món ăn</p>
        </div>
        <div className="flex gap-3">
          <button className="btn btn-outline" onClick={() => openCatModal()}>
            <FolderOpen size={16} /> Thêm danh mục
          </button>
          <button className="btn btn-primary" onClick={() => openItemModal()}>
            <Plus size={18} /> Thêm món
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

      {/* Menu Items Grid */}
      <div className="menu-grid">
        {filteredItems.length > 0 ? (
          filteredItems.map((item) => (
            <div key={item.id} className={`menu-card ${!item.is_available ? 'unavailable' : ''}`}>
              <div className="menu-card-image">
                {item.image_url ? (
                  <img src={item.image_url} alt={item.name} />
                ) : (
                  <div className="menu-card-placeholder">
                    <ImageIcon size={32} />
                  </div>
                )}
                <button
                  className="menu-toggle-btn"
                  onClick={() => toggleAvailable(item)}
                  title={item.is_available ? 'Ẩn món' : 'Hiện món'}
                >
                  {item.is_available ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
              </div>
              <div className="menu-card-body">
                <div className="menu-card-cat">{item.category?.name || 'Chưa phân loại'}</div>
                <h4 className="menu-card-name">{item.name}</h4>
                {item.description && (
                  <p className="menu-card-desc">{item.description}</p>
                )}
                <div className="menu-card-footer">
                  <span className="menu-card-price">{formatPrice(item.price)}</span>
                  <div className="flex gap-1">
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
                  <label className="form-label">Giá (VNĐ)</label>
                  <input className="input" type="number" value={itemForm.price} onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })} placeholder="65000" />
                </div>
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
              <label className="flex items-center gap-2" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={itemForm.is_available} onChange={(e) => setItemForm({ ...itemForm, is_available: e.target.checked })} />
                <span className="text-sm">Hiển thị trên thực đơn</span>
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setShowItemModal(false)}>Huỷ</button>
              <button className="btn btn-primary" onClick={saveItem}>{editingItem ? 'Cập nhật' : 'Thêm món'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
