'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Swal from 'sweetalert2';
import { supabase } from '@/lib/supabase';
import { removeVietnameseTones } from '@/lib/utils';
import { OFF_MODES, dishChoices, dishOffLabel, isDishOff } from '@/lib/menuAvailability.mjs';

// Khung "Tắt / bật món" ở trang Bàn: gạt nhiều món / nhiều lựa chọn (LOẠI, KHẨU VỊ…) rồi bấm Lưu một lần.
// Dùng đúng cờ của trang Thực đơn (xem lib/menuAvailability.mjs); ghi qua /api/admin/menu-availability.
const MODE_KEY = 'dishQuickToggleMode';
// Bấm tắt món / loại thì hỏi tắt bao lâu — giống hộp "Ẩn món ăn?" của trang Thực đơn.
const MODES = [['today', 'Hết hôm nay'], ['2h', '2 tiếng'], ['4h', '4 tiếng'], ['off', 'Vô thời hạn']];
const MODE_LABEL = Object.fromEntries(MODES);
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const choiceKey = (id, c) => `${id}|${c.optIndex}|${c.index}`;
const norm = s => removeVietnameseTones(String(s || '').toLowerCase());

function Switch({ on, small }) {
  const w = small ? 34 : 40, h = small ? 19 : 22, k = h - 4;
  return (
    <div style={{ position: 'relative', width: w, height: h, background: on ? '#16a34a' : '#d1d5db', borderRadius: h / 2, flexShrink: 0, transition: 'background .2s' }}>
      <div style={{ position: 'absolute', top: 2, left: on ? w - k - 2 : 2, width: k, height: k, background: 'white', borderRadius: '50%', transition: 'left .2s' }} />
    </div>
  );
}

const chip = { fontSize: '0.6rem', fontWeight: 800, color: '#ea580c', background: '#ffedd5', borderRadius: 6, padding: '1px 5px', flexShrink: 0 };

export default function DishQuickToggle({ onClose, onSaved }) {
  const [data, setData] = useState(null);           // { items, cats, offIds } — món thuộc tab nào tính lúc tải
  const [loading, setLoading] = useState(true);
  const [pendingDish, setPendingDish] = useState({});     // { id: { off, mode } } — chưa lưu
  const [pendingChoice, setPendingChoice] = useState({}); // { "id|opt|idx": { id, option, optIndex, choice, index, off, mode } }
  const [lastMode, setLastMode] = useState('today');      // chọn sẵn trong hộp hỏi lần sau
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('on');                   // 'on' = Đang bán, 'off' = Đã tắt
  const [closedCats, setClosedCats] = useState({});
  const [openDishes, setOpenDishes] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    try { const saved = localStorage.getItem(MODE_KEY); if (OFF_MODES.includes(saved)) setLastMode(saved); } catch { }
  }, []);

  // Hỏi tắt bao lâu → 'today' | '2h' | '4h' | 'off', hoặc null nếu bấm Huỷ.
  async function askOffMode(title, name) {
    const { value } = await Swal.fire({
      title, icon: 'question',
      html: `<b>${esc(name)}</b><div style="font-size:.85rem;color:#64748b;margin-top:6px">Chọn thời gian tắt (Hết hôm nay = 5 giờ sáng mai tự bán lại):</div>`,
      input: 'radio', inputOptions: MODE_LABEL, inputValue: lastMode,
      inputValidator: v => (v ? undefined : 'Chọn thời gian tắt giúp ạ!'),
      showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#9ca3af',
      confirmButtonText: 'Vâng, tắt', cancelButtonText: 'Huỷ',
      didOpen: popup => {
        const radios = popup.querySelector('.swal2-radio');
        if (!radios) return;
        Object.assign(radios.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 10px', justifyItems: 'start', padding: '0 14px' });
        radios.querySelectorAll('label').forEach(l => Object.assign(l.style, { margin: '0', whiteSpace: 'nowrap' }));
      },
    });
    if (!value) return null;
    setLastMode(value);
    try { localStorage.setItem(MODE_KEY, value); } catch { }
    return value;
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [itemsRes, catsRes] = await Promise.all([
        supabase.from('menu_items').select('id, name, category_id, sort_order, is_available, hidden_until, options')
          .order('sort_order').order('name'),
        supabase.from('categories').select('id, name, sort_order').order('sort_order'),
      ]);
      if (itemsRes.error) throw itemsRes.error;
      const now = Date.now();
      const items = (itemsRes.data || []).map(m => {
        const choices = dishChoices(m, now);
        return { ...m, choices, off: isDishOff(m, now), label: dishOffLabel(m, now), hasOffChoice: choices.some(c => c.off) };
      });
      // Món đang tắt (cả món hoặc một vài lựa chọn) vào tab "Đã tắt" — tính lúc tải để gạt xong không đổi tab.
      setData({ items, cats: catsRes.data || [], offIds: new Set(items.filter(m => m.off || m.hasOffChoice).map(m => m.id)) });
    } catch (e) {
      console.error('[DishQuickToggle] load', e);
      setData({ items: [], cats: [], offIds: new Set(), error: true });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const nPending = Object.keys(pendingDish).length + Object.keys(pendingChoice).length;
  const dishOffNow = m => pendingDish[m.id]?.off ?? m.off;
  const choiceOffNow = (m, c) => pendingChoice[choiceKey(m.id, c)]?.off ?? c.off;

  // Gạt về như cũ thì bỏ thay đổi; gạt sang TẮT thì hỏi tắt bao lâu trước.
  async function toggleDish(m) {
    const next = !dishOffNow(m);
    const mode = next && next !== m.off ? await askOffMode('Tắt món này?', m.name) : null;
    if (next && next !== m.off && !mode) return;
    setPendingDish(p => {
      const copy = { ...p };
      if (next === m.off) delete copy[m.id]; else copy[m.id] = { off: next, mode };
      return copy;
    });
  }
  async function toggleChoice(m, c) {
    const next = !choiceOffNow(m, c);
    const mode = next && next !== c.off ? await askOffMode('Tắt loại này?', `${m.name} — ${c.choice}`) : null;
    if (next && next !== c.off && !mode) return;
    const key = choiceKey(m.id, c);
    setPendingChoice(p => {
      const copy = { ...p };
      if (next === c.off) delete copy[key];
      else copy[key] = { id: m.id, option: c.option, optIndex: c.optIndex, choice: c.choice, index: c.index, off: next, mode };
      return copy;
    });
  }

  async function close() {
    if (nPending > 0) {
      const r = await Swal.fire({
        icon: 'question', title: `Bỏ ${nPending} thay đổi chưa lưu?`, showCancelButton: true,
        confirmButtonText: 'Bỏ, đóng lại', cancelButtonText: 'Ở lại', confirmButtonColor: '#ef4444',
      });
      if (!r.isConfirmed) return;
    }
    onClose();
  }

  async function save() {
    if (nPending === 0 || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/menu-availability', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dishes: Object.entries(pendingDish).map(([id, d]) => ({ id, off: d.off, mode: d.mode })),
          choices: Object.values(pendingChoice),
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok && !r.saved) {
        Swal.fire({ icon: 'error', title: 'Lưu chưa xong', text: r.message || 'Thử lại giúp ạ.' });
        return;
      }
      setPendingDish({});
      setPendingChoice({});
      await load();
      onSaved?.();
      const problems = [
        ...(r.failed || []).map(f => `${f.name || 'Một món'}: chưa lưu được, có người vừa sửa — gạt lại rồi Lưu.`),
        ...(r.skipped || []).map(s => `${s.name}: không còn lựa chọn "${s.choice}" (vừa bị đổi tên/xoá).`),
        ...((r.missing || []).length ? [`${r.missing.length} món đã bị xoá khỏi thực đơn.`] : []),
      ];
      if (problems.length) {
        Swal.fire({ icon: 'warning', title: 'Lưu được một phần', html: problems.map(p => `<div style="text-align:left;margin:4px 0">• ${p.replace(/</g, '&lt;')}</div>`).join('') });
      } else {
        Swal.fire({ icon: 'success', title: 'Đã lưu!', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
      }
    } catch (e) {
      Swal.fire({ icon: 'error', title: 'Lỗi', text: 'Không lưu được, thử lại giúp ạ.' });
    } finally {
      setSaving(false);
    }
  }

  const q = norm(search.trim());
  const view = useMemo(() => {
    if (!data) return null;
    const match = m => !q || norm(m.name).includes(q) || m.choices.some(c => norm(c.choice).includes(q));
    const items = data.items.filter(match);
    const groups = [...data.cats, { id: null, name: 'Chưa phân loại' }]
      .map(cat => ({ cat, items: items.filter(m => !m.off && ((m.category_id || null) === cat.id || (cat.id === null && !data.cats.some(c => c.id === m.category_id)))) }))
      .filter(g => g.items.length);
    const offTab = items.filter(m => data.offIds.has(m.id));
    return { offWhole: offTab.filter(m => m.off), offSome: offTab.filter(m => !m.off), offCount: offTab.length, onCount: items.filter(m => !m.off).length, groups };
  }, [data, q]);

  function renderChoice(m, c) {
    const off = choiceOffNow(m, c);
    const changed = !!pendingChoice[choiceKey(m.id, c)];
    return (
      <div key={choiceKey(m.id, c)} onClick={() => toggleChoice(m, c)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 4, borderRadius: 8, cursor: 'pointer',
          border: `1.5px solid ${changed ? '#fdba74' : off ? '#fecaca' : '#e5e7eb'}`, background: off ? '#fef2f2' : 'white' }}>
        <Switch on={!off} small />
        <span style={{ flex: 1, minWidth: 0, fontSize: '0.82rem', fontWeight: 600, color: off ? '#b91c1c' : '#374151' }}>
          {c.choice}
          {off && !changed && c.label && <span style={{ display: 'block', fontSize: '0.66rem', fontWeight: 600, color: '#ef4444' }}>{c.label}</span>}
          {off && changed && <span style={{ display: 'block', fontSize: '0.66rem', fontWeight: 600, color: '#ea580c' }}>sẽ tắt: {MODE_LABEL[pendingChoice[choiceKey(m.id, c)].mode]}</span>}
        </span>
        {changed && <span style={chip}>chưa lưu</span>}
        <span style={{ fontSize: '0.68rem', fontWeight: 800, color: off ? '#dc2626' : '#16a34a', flexShrink: 0 }}>{off ? 'TẮT' : 'BẬT'}</span>
      </div>
    );
  }

  function renderDish(m, onlyOffChoices = false) {
    const off = dishOffNow(m);
    const changed = !!pendingDish[m.id];
    const searchHit = q && !norm(m.name).includes(q);
    const expanded = !!openDishes[m.id] || !!searchHit;
    const shown = onlyOffChoices ? m.choices.filter(c => c.off) : searchHit ? m.choices.filter(c => norm(c.choice).includes(q)) : m.choices;
    const nOffChoices = m.choices.filter(c => choiceOffNow(m, c)).length;
    const byOption = [];
    shown.forEach(c => {
      const last = byOption[byOption.length - 1];
      if (last && last.optIndex === c.optIndex) last.list.push(c); else byOption.push({ optIndex: c.optIndex, option: c.option, list: [c] });
    });
    return (
      <div key={m.id} style={{ marginBottom: 7 }}>
        <div style={{ display: 'flex', alignItems: 'stretch', border: `1.5px solid ${changed ? '#fdba74' : off ? '#fecaca' : '#bbf7d0'}`, background: off ? '#fef2f2' : '#f0fdf4', borderRadius: 10, overflow: 'hidden' }}>
          <div onClick={() => toggleDish(m)} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', cursor: 'pointer' }}>
            <Switch on={!off} />
            <span style={{ flex: 1, minWidth: 0, fontSize: '0.86rem', fontWeight: 700, color: off ? '#b91c1c' : '#15803d' }}>
              {m.name}
              {off && !changed && m.label && <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 600, color: '#ef4444' }}>{m.label}</span>}
              {off && changed && <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 600, color: '#ea580c' }}>sẽ tắt: {MODE_LABEL[pendingDish[m.id].mode]}</span>}
              {!off && nOffChoices > 0 && !expanded && !onlyOffChoices && <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 600, color: '#b45309' }}>{nOffChoices} lựa chọn đang tắt</span>}
            </span>
            {changed && <span style={chip}>chưa lưu</span>}
            <span style={{ fontSize: '0.72rem', fontWeight: 800, color: off ? '#dc2626' : '#16a34a', flexShrink: 0 }}>{off ? 'TẮT' : 'BẬT'}</span>
          </div>
          {m.choices.length > 0 && !onlyOffChoices && (
            <button type="button" onClick={() => setOpenDishes(o => ({ ...o, [m.id]: !o[m.id] }))}
              style={{ border: 'none', borderLeft: '1px solid rgba(0,0,0,0.06)', background: 'rgba(255,255,255,0.6)', padding: '0 10px', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 800, color: '#475569', flexShrink: 0, minWidth: 62 }}>
              {m.choices.length} lựa chọn <span style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>›</span>
            </button>
          )}
        </div>
        {(expanded || onlyOffChoices) && shown.length > 0 && (
          <div style={{ margin: '5px 0 0 18px', paddingLeft: 8, borderLeft: '2px solid #e5e7eb', opacity: off ? 0.6 : 1 }}>
            {off && <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginBottom: 4 }}>Cả món đang tắt — khách không thấy lựa chọn nào.</div>}
            {byOption.map(g => (
              <div key={g.optIndex}>
                <div style={{ fontSize: '0.64rem', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '4px 0 3px' }}>{g.option}</div>
                {g.list.map(c => renderChoice(m, c))}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 99998, background: 'rgba(15,23,42,0.45)' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: 'min(94%, 400px)', background: 'white',
          boxShadow: '-8px 0 30px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', borderRadius: '16px 0 0 16px', overflow: 'hidden' }}>
        <div style={{ padding: 'calc(12px + env(safe-area-inset-top)) 14px 10px', background: '#fef2f2', borderBottom: '1px solid #fecaca' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 800, color: '#b91c1c', fontSize: '1rem' }}>🚫 Tắt / bật món</span>
            <button onClick={save} disabled={nPending === 0 || saving}
              style={{ marginLeft: 'auto', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: nPending === 0 ? 'default' : 'pointer', fontSize: '0.78rem', fontWeight: 800,
                background: nPending === 0 ? '#e5e7eb' : 'linear-gradient(135deg,#16a34a,#15803d)', color: nPending === 0 ? '#9ca3af' : 'white',
                boxShadow: nPending === 0 ? 'none' : '0 3px 10px rgba(22,163,74,0.35)' }}>
              {saving ? 'Đang lưu…' : nPending > 0 ? `💾 Lưu (${nPending})` : '💾 Lưu'}
            </button>
            <button onClick={close} aria-label="Đóng" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1 }}>✕</button>
          </div>
          <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: 5, lineHeight: 1.4 }}>
            Bấm tắt sẽ hỏi tắt bao lâu. Gạt nhiều món rồi bấm <b>Lưu</b> một lần.
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm món hoặc loại (vd: ghẹ)…"
            style={{ width: '100%', marginTop: 8, padding: '8px 11px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '0.86rem', boxSizing: 'border-box', background: 'white' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {[['on', `🍽️ Đang bán (${view?.onCount ?? 0})`, '#16a34a', '#dcfce7', '#15803d'], ['off', `🚫 Đã tắt (${view?.offCount ?? 0})`, '#dc2626', '#fee2e2', '#b91c1c']].map(([k, label, bd, bg, fg]) => (
              <button key={k} type="button" onClick={() => setTab(k)}
                style={{ flex: 1, padding: '8px 4px', borderRadius: 10, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 800,
                  border: `1.5px solid ${tab === k ? bd : '#e5e7eb'}`, background: tab === k ? bg : 'white', color: tab === k ? fg : '#64748b' }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px calc(14px + env(safe-area-inset-bottom))' }}>
          {loading && !data ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Đang tải…</div>
          ) : data?.error ? (
            <div style={{ textAlign: 'center', color: '#dc2626', padding: 20 }}>Chưa tải được thực đơn. <button onClick={load} style={{ border: 'none', background: 'none', color: '#2563eb', fontWeight: 700, cursor: 'pointer' }}>Thử lại</button></div>
          ) : tab === 'off' ? (
            view.offCount === 0
              ? <div style={{ fontSize: '0.82rem', color: '#9ca3af', background: '#f8fafc', borderRadius: 10, padding: '10px 12px' }}>{q ? 'Không có món đã tắt khớp.' : 'Không có món nào đang tắt.'}</div>
              : <>
                {view.offWhole.length > 0 && <div style={{ fontWeight: 800, fontSize: '0.8rem', color: '#b91c1c', marginBottom: 8 }}>Tắt cả món ({view.offWhole.length})</div>}
                {view.offWhole.map(m => renderDish(m))}
                {view.offSome.length > 0 && <div style={{ fontWeight: 800, fontSize: '0.8rem', color: '#b45309', margin: `${view.offWhole.length ? 14 : 0}px 0 8px` }}>Món còn bán, tắt vài loại ({view.offSome.length})</div>}
                {view.offSome.map(m => renderDish(m, true))}
              </>
          ) : (
            <>
              {view.groups.length === 0 && <div style={{ fontSize: '0.82rem', color: '#9ca3af' }}>Không có món khớp.</div>}
              {view.groups.map(g => {
                const key = g.cat.id ?? 'none';
                const open = !!q || !closedCats[key];
                const nOff = g.items.filter(m => dishOffNow(m)).length;
                return (
                  <div key={key} style={{ marginBottom: 8 }}>
                    <button type="button" onClick={() => setClosedCats(o => ({ ...o, [key]: !o[key] }))}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 6, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontWeight: 800, fontSize: '0.82rem', color: '#334155', textAlign: 'left' }}>
                      <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>›</span>
                      <span style={{ flex: 1 }}>{g.cat.name} ({g.items.length})</span>
                      {nOff > 0 && <span style={{ fontSize: '0.66rem', color: '#dc2626', background: '#fee2e2', borderRadius: 6, padding: '1px 6px' }}>{nOff} tắt</span>}
                    </button>
                    {open && <div style={{ marginTop: 7 }}>{g.items.map(m => renderDish(m))}</div>}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
