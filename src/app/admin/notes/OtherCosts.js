'use client';
/**
 * Sổ tay (chủ quán) — tab "📦 Chi khác": tạo / đổi tên / xoá loại Khác (xăng xe, sửa chữa…) và
 * xem tiền từng loại trong khoảng ngày đang lọc (từ các dòng tab Khác của phiếu đi chợ).
 */
import { useEffect, useState } from 'react';
import { categoryName, lineCategory, MAX_CATEGORIES, OTHER_ID } from '@/lib/noteCategories.mjs';
import { parsePrice, parseQty } from '@/lib/notesMath.mjs';
import { notesApi } from '@/lib/staffApi';

const vnd = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const lineMoney = i => Math.round(parsePrice(i.price) * parseQty(i.qty));
const items = note => { try { const d = JSON.parse(note.content); return d?.type === 'structured_expense' ? d.items || [] : []; } catch { return []; } };
const ddmm = iso => new Date(iso).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit' });

export default function OtherCosts({ notes, categories, filterLabel, onCategories }) {
  const [draft, setDraft] = useState(categories);
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(null);
  useEffect(() => { setDraft(categories); }, [categories]);

  // Tiền từng loại: dòng của loại đã xoá tính vào "Khác".
  const known = new Set(categories.map(c => c.id));
  const groups = new Map();
  let ocTotal = 0;
  for (const note of notes) {
    if (note.note_type !== 'expense') continue;
    for (const item of items(note)) {
      if (!String(item.name || '').trim()) continue;
      const cost = lineMoney(item);
      const id = lineCategory(item);
      if (!id) { ocTotal += cost; continue; }
      const key = known.has(id) ? id : OTHER_ID;
      const g = groups.get(key) || { id: key, name: categoryName(key, categories), total: 0, rows: [] };
      g.total += cost;
      g.rows.push({ at: note.created_at, who: note.staff?.full_name || '', name: item.name, qty: item.qty, cost, debt: item.paymentStatus === 'debt' });
      groups.set(key, g);
    }
  }
  const list = [...groups.values()].sort((a, b) => b.total - a.total);
  const otherTotal = list.reduce((s, g) => s + g.total, 0);
  const changed = JSON.stringify(draft) !== JSON.stringify(categories);

  async function save(next) {
    setSaving(true);
    try { const r = await notesApi('set_categories', { categories: next }); onCategories(r.categories || []); setAdding(''); }
    catch (err) { alert(err.message); } finally { setSaving(false); }
  }
  const add = () => { const name = adding.trim(); if (name) save([...draft, { name }]); };

  return <div className="oc-wrap">
    <section className="oc-card">
      <div className="oc-head"><b>Chi khác · {filterLabel}</b><span>{vnd(otherTotal)}</span></div>
      <p className="oc-sub">Hàng ốc {vnd(ocTotal)} · Khác {vnd(otherTotal)}. Nhân viên ghi ở tab "📦 Khác" khi viết phiếu đi chợ.</p>
      {!list.length && <p className="oc-empty">Chưa có dòng nào ở tab Khác trong khoảng này.</p>}
      {list.map(g => <div key={g.id} className="oc-group">
        <button type="button" className="oc-row" onClick={() => setOpen(open === g.id ? null : g.id)} aria-expanded={open === g.id}>
          <span><b>{g.name}</b><small>{g.rows.length} dòng</small></span>
          <span className="oc-bar"><i style={{ width: `${otherTotal ? g.total / otherTotal * 100 : 0}%` }} /></span>
          <b>{vnd(g.total)}</b>
        </button>
        {open === g.id && <ul className="oc-lines">{g.rows.map((r, i) => <li key={i}>
          <span>{ddmm(r.at)} · {r.name}{r.qty ? ` × ${r.qty}` : ''}<small>{r.who}{r.debt ? ' · nợ' : ''}</small></span><b>{vnd(r.cost)}</b>
        </li>)}</ul>}
      </div>)}
    </section>

    <section className="oc-card">
      <div className="oc-head"><b>Các loại chi khác</b><span>{categories.length}/{MAX_CATEGORIES}</span></div>
      <p className="oc-sub">Nhân viên chọn loại cho từng dòng. Đổi tên thì các dòng đã ghi vẫn giữ loại; xoá loại thì các dòng đó thành "Khác".</p>
      {draft.map((c, i) => <div key={c.id || i} className="oc-edit">
        <input value={c.name} maxLength={40} onChange={e => setDraft(d => d.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} aria-label="Tên loại" />
        <button type="button" className="oc-del" disabled={saving}
          onClick={() => { if (confirm(`Xoá loại "${c.name}"? Các dòng đã ghi loại này sẽ thành "Khác".`)) save(draft.filter((_, k) => k !== i)); }}>Xoá</button>
      </div>)}
      <div className="oc-edit">
        <input value={adding} maxLength={40} placeholder="Loại mới, VD: Xăng xe" onChange={e => setAdding(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add(); }} aria-label="Tên loại mới" />
        <button type="button" className="oc-add" disabled={saving || !adding.trim()} onClick={add}>+ Thêm</button>
      </div>
      <p className="oc-sub">Luôn có sẵn loại "Khác" cho thứ chưa rõ loại.</p>
      {changed && <button type="button" className="oc-save" disabled={saving} onClick={() => save(draft)}>{saving ? 'Đang lưu…' : 'Lưu tên loại'}</button>}
    </section>
  </div>;
}
