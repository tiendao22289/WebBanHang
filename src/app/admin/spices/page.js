'use client';
/**
 * Gọi gia vị (nhân viên, quản lý, admin): chọn chủ gia vị + món → Gửi → gửi tin kèm link qua Zalo cho chủ gia vị.
 * Tab Đơn: theo dõi đơn, thêm món, bấm Nhận đủ / Nhận thiếu, xem lịch sử (ai gọi, thêm, đổi giá, nhận — giờ nào).
 * Chủ quán thêm: Công nợ (trả gom), Thống kê từng món theo ngày / tháng / năm, Cài đặt (chủ gia vị, link riêng, món).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '@/lib/useBackClose';
import { useReloadHold } from '@/lib/useBuildRefresh';
import {
  CHECK_LABELS, STATE_LABELS, addedLater, paidState, changeText, cleanName, dayReportText, lineCheck, itemKey, itemLineText, itemStep, orderedItems, plainText, rankItems, lineAmount, lineQty, logLine, missingPrices, orderState, orderTotal, shareText, shortTime,
} from '@/lib/spiceOrders.mjs';
import { CheckBadge, DayCard, DayGroups } from './SpiceShared';
import './spices.css';

const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const qtyText = q => String(Math.round((Number(q) || 0) * 1000) / 1000).replace('.', ',');
const digits = v => String(v ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 10);
const withDots = d => (d ? Number(d).toLocaleString('vi-VN') : '');
const hasPrice = l => l.price !== null && l.price !== undefined;
const CART_KEY = 'spice-cart-v1';
const linkOf = (token, orderId) => `${window.location.origin}/giavi/${token}${orderId ? `?don=${orderId}` : ''}`;

async function api(body) {
  const r = await fetch('/api/admin/spices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Không lưu được, thử lại.');
  return j;
}

export default function SpicesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('call');
  const [share, setShare] = useState(null); // { title, text, phone }
  const isAdmin = data?.me?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/spices', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'Không tải được.'); return; }
      setError(''); setData(j);
    } catch { setError('Mạng yếu, thử lại.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // Tự tải lại khi quay lại trang / mỗi 30 giây (thấy chủ gia vị điền giá).
  useEffect(() => {
    const tick = () => { if (!document.hidden) load(); };
    const id = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  const suppliers = data?.suppliers || [];
  const supplierById = useMemo(() => Object.fromEntries(suppliers.map(s => [s.id, s])), [suppliers]);
  const openCount = (data?.orders || []).filter(o => ['new', 'priced', 'waiting_price'].includes(orderState(o))).length;
  const payAsks = (data?.orders || []).filter(o => !o.cancelled_at && paidState(o) === 'pending').length;

  // Sau khi gửi / thêm món: hộp "Gửi qua Zalo" (chia sẻ cần một lần bấm của người dùng, nên không mở tự động).
  const askShare = (supplier, order, items, { added = false, note = '' } = {}) => setShare({
    title: added ? 'Đã thêm món ✓' : 'Đã tạo đơn ✓',
    phone: supplier.phone,
    text: shareText({ supplierName: supplier.name, items, note, by: data?.me?.name, link: linkOf(supplier.token, order.id),
      title: added ? 'Quán gọi THÊM gia vị' : 'Quán gọi gia vị' }),
  });

  if (!data) return <div className="sp">{error ? <div className="sp-msg err">{error}</div> : <p className="sp-empty">Đang tải…</p>}</div>;
  const tabs = [['call', '🧂', 'Gọi hàng'], ['orders', '📦', 'Đơn'], ['days', '📅', 'Đối soát'],
    ...(isAdmin ? [['debt', '💰', 'Công nợ'], ['stats', '📊', 'Thống kê'], ['setup', '⚙️', 'Cài đặt']] : [])];
  return <div className="sp">
    <div className="sp-head"><h1>🧂 Gia vị</h1><span className="sp-mute sp-small">{data.me?.name}</span></div>
    {error && <div className="sp-msg err">{error}</div>}
    <div className={`sp-seg ${tabs.length > 3 ? 'six' : 'three'}`} role="tablist">
      {tabs.map(([k, icon, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); window.scrollTo(0, 0); }}>
        <span aria-hidden="true">{icon}</span>{label}{k === 'orders' && openCount > 0 && <i className="dot">{openCount}</i>}{k === 'debt' && payAsks > 0 && <i className="dot">{payAsks}</i>}
      </button>)}
    </div>
    {tab === 'call' && <CallTab data={data} onSent={(supplier, order, items, note) => { askShare(supplier, order, items, { note }); load(); setTab('orders'); }} goSetup={isAdmin ? () => setTab('setup') : null} />}
    {tab === 'orders' && <OrdersTab data={data} supplierById={supplierById} reload={load} onShare={askShare} />}
    {tab === 'days' && <DaysTab data={data} reload={load} onShareText={(title, text, phone) => setShare({ title, text, phone, hint: 'Gửi bảng đối soát ngày này qua Zalo cho chủ gia vị để hai bên cân đối.' })} />}
    {tab === 'debt' && isAdmin && <DebtTab data={data} reload={load} />}
    {tab === 'stats' && isAdmin && <StatsTab />}
    {tab === 'setup' && isAdmin && <SetupTab data={data} reload={load} />}
    {share && <ShareSheet share={share} onClose={() => setShare(null)} />}
  </div>;
}

/* ---------------- Hộp nổi ---------------- */
function Sheet({ title, onClose, children }) {
  useBackClose(true, onClose);
  return <div className="sp-sheet-bg" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="sp-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sp-row between"><h3>{title}</h3><button type="button" className="sp-x" aria-label="Đóng" onClick={onClose}>✕</button></div>
      {children}
    </div>
  </div>;
}

function ShareSheet({ share, onClose }) {
  const [msg, setMsg] = useState('');
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;
  const copy = async () => {
    try { await navigator.clipboard.writeText(share.text); setMsg('Đã chép. Mở Zalo, dán vào tin nhắn của chủ gia vị hoặc nhóm.'); }
    catch { setMsg('Không chép được, giữ tay vào khung chữ để chép.'); }
  };
  const send = async () => {
    try { await navigator.share({ text: share.text }); onClose(); }
    catch (e) { if (e?.name !== 'AbortError') copy(); }
  };
  return <Sheet title={share.title} onClose={onClose}>
    <p className="sp-mute">{share.hint || 'Gửi tin này qua Zalo cho chủ gia vị (hoặc nhóm). Trong tin có link để họ soạn hàng và điền giá.'}</p>
    <textarea className="sp-field" readOnly rows={7} value={share.text} onFocus={e => e.target.select()} />
    {msg && <div className="sp-msg ok">{msg}</div>}
    <div className="sp-btns">
      {canShare && <button type="button" className="sp-btn zalo block" onClick={send}>📤 Gửi qua Zalo</button>}
      <button type="button" className={`sp-btn ${canShare ? '' : 'zalo'} block`} onClick={copy}>📋 Chép tin nhắn</button>
      {share.phone && <a className="sp-btn block" href={`https://zalo.me/${share.phone}`} target="_blank" rel="noreferrer" onClick={copy}>💬 Mở Zalo chủ gia vị</a>}
    </div>
  </Sheet>;
}

/* ---------------- Chọn món (dùng cho gọi mới và thêm món) ---------------- */
function readCart() {
  try { const v = JSON.parse(localStorage.getItem(CART_KEY) || 'null'); return v && Array.isArray(v.lines) ? v : null; } catch { return null; }
}
function saveCart(v) { try { localStorage.setItem(CART_KEY, JSON.stringify(v)); } catch { /* máy chặn lưu: bỏ qua */ } }

// Chọn món nhanh: ô to theo danh sách đúng thứ tự chủ quán xếp, bấm ô = thêm số mặc định (vd Tiêu 0,5 kg), bấm tiếp = thêm nữa,
// nút − trên ô để bớt. Danh sách dài thì có ô tìm (gõ không dấu cũng được). Món không có trong danh sách: "＋ Món khác".
const num = v => Number(String(v ?? '').replace(',', '.')) || 0;
const fmtQty = n => String(Math.round(n * 1000) / 1000).replace('.', ',');
function ItemPicker({ items, lines, setLines, prices = {}, exclude = [], orders = [], supplierId = null, drawer = false }) {
  const [panel, setPanel] = useState(false); // thanh danh sách món bên phải (nút + cố định)
  const [q, setQ] = useState('');
  const [other, setOther] = useState(false);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const idx = new Map(lines.map((l, i) => [itemKey(l.name), i]));
  const blockedKey = exclude.map(itemKey).join('|');
  const ranked = useMemo(() => {
    const blocked = new Set(blockedKey.split('|'));
    return rankItems(items, orders, supplierId).filter(i => !blocked.has(itemKey(i.name)));
  }, [items, orders, supplierId, blockedKey]);
  // Tìm: món có chữ bắt đầu bằng chữ đang gõ lên trước ("hanh" → Hành tím, Hành lá rồi mới tới Chanh).
  const qq = plainText(q);
  const hit = i => { const t = plainText(i.name); return t.startsWith(qq) ? 0 : t.split(' ').some(w => w.startsWith(qq)) ? 1 : t.includes(qq) ? 2 : 3; };
  const shown = qq ? ranked.filter(i => hit(i) < 3).sort((a, b) => hit(a) - hit(b)) : ranked;
  const bump = (item, dir = 1) => {
    const k = itemKey(item.name), step = item.step || itemStep(item);
    if (!k || exclude.some(n => itemKey(n) === k)) return;
    if (!idx.has(k)) {
      if (dir > 0) setLines([...lines, { name: cleanName(item.name), unit: item.unit || '', qty: fmtQty(step), step }]);
      return;
    }
    const i = idx.get(k), next = num(lines[i].qty) + dir * (lines[i].step || step);
    setLines(next <= 0 ? lines.filter((_, j) => j !== i) : lines.map((l, j) => (j === i ? { ...l, qty: fmtQty(next) } : l)));
  };
  const addOther = () => { if (!name.trim()) return; bump({ name, unit }); setName(''); setUnit(''); setOther(false); };
  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return <>
    {lines.length > 0 && <>
      <div className="sp-cart-h top"><span className="sp-b">🧾 Đã chọn {lines.length} món</span><button type="button" className="sp-btn ghost bad" onClick={() => setLines([])}>Xoá hết</button></div>
      <ul className="sp-cart compact">{lines.map((l, i) => { const p = prices[itemKey(l.name)]; return <li key={`${l.name}-${i}`}>
        <span className="nm">{l.name}<small className={p !== undefined ? 'old' : 'new'}>{p !== undefined ? `giá cũ ${money(p)}/${l.unit || 'phần'}` : 'chưa có giá cũ'}</small></span>
        <div className="sp-qty">
          <button type="button" aria-label={`Bớt ${l.name}`} onClick={() => bump(l, -1)}>−</button>
          <input inputMode="decimal" aria-label={`Số lượng ${l.name}`} value={l.qty} onChange={e => setLine(i, { qty: e.target.value.replace(/[^\d.,]/g, '').slice(0, 7) })} />
          <button type="button" aria-label={`Thêm ${l.name}`} onClick={() => bump(l, 1)}>+</button>
        </div>
        <input className="sp-unit" placeholder="đơn vị" aria-label={`Đơn vị ${l.name}`} value={l.unit} maxLength={20} onChange={e => setLine(i, { unit: e.target.value })} />
        <button type="button" className="sp-x" aria-label={`Bỏ ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
      </li>; })}</ul>
      {!drawer && <div className="sp-pick-h">Bấm thêm món:</div>}
    </>}
    {drawer && <DrawerFab onOpen={() => setPanel(true)} hidden={panel} />}
    {drawer && panel && <ItemDrawer items={ranked} lines={lines} idx={idx} prices={prices} bump={bump} onClose={() => setPanel(false)} />}
    {!drawer && <>
    {ranked.length > 8 && <input className="sp-field" type="search" placeholder="🔍 Tìm món (gõ không dấu cũng được)" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 10 }} />}
    {shown.length > 0 && <div className="sp-grid">{shown.map(i => {
      const at = idx.get(itemKey(i.name)), on = at !== undefined, p = prices[itemKey(i.name)];
      return <div key={i.id || i.name} className={`sp-cell ${on ? 'on' : ''}`}>
        <button type="button" className="add" onClick={() => bump(i, 1)} aria-label={`Thêm ${i.name}`}>
          <span className="nm">{i.name}</span>
          <small>+{fmtQty(itemStep(i))} {i.unit || ''}</small>
          {p !== undefined && <small className="pr">{money(p)}</small>}
        </button>
        {on && <span className="badge">{lines[at].qty}{lines[at].unit ? ` ${lines[at].unit}` : ''}</span>}
        {on && <button type="button" className="minus" aria-label={`Bớt ${i.name}`} onClick={() => bump(i, -1)}>−</button>}
      </div>;
    })}</div>}
    {q.trim() && !shown.length && <button type="button" className="sp-btn block" onClick={() => { bump({ name: q }); setQ(''); }}>＋ Thêm món mới "{q.trim()}"</button>}
    {!other
      ? <button type="button" className="sp-btn ghost" style={{ marginTop: 6 }} onClick={() => setOther(true)}>＋ Món khác (không có trong danh sách)</button>
      : <div className="sp-row" style={{ marginTop: 10 }}>
        <input className="sp-field sp-grow" autoFocus placeholder="Tên món" value={name} maxLength={60} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addOther(); }} />
        <input className="sp-unit" placeholder="kg, bịch" value={unit} maxLength={20} onChange={e => setUnit(e.target.value)} />
        <button type="button" className="sp-btn main" disabled={!name.trim()} onClick={addOther}>Thêm</button>
      </div>}
    </>}
  </>;
}

/** Nút + tròn cố định góc phải (trên nút Gửi đơn): mở thanh danh sách món. */
function DrawerFab({ onOpen, hidden }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready || hidden) return null;
  return createPortal(<button type="button" className="sp-fab sp-fab-admin" aria-label="Thêm món" onClick={onOpen}><span aria-hidden="true">+</span></button>, document.body);
}

/**
 * Thanh đứng bên phải: tìm món (không dấu), kéo lên xuống xem cả danh sách, bấm + / − ngay trên từng dòng.
 * Món không có trong danh sách: gõ tên rồi bấm "Thêm món mới". Bấm nền tối, ✕ hoặc nút Back của điện thoại để đóng.
 */
function ItemDrawer({ items, lines, idx, prices, bump, onClose }) {
  const [q, setQ] = useState('');
  useBackClose(true, onClose);
  useEffect(() => {
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // không cuộn trang phía sau
    return () => { document.body.style.overflow = old; };
  }, []);
  const qq = plainText(q);
  const hit = i => { const t = plainText(i.name); return t.startsWith(qq) ? 0 : t.split(' ').some(w => w.startsWith(qq)) ? 1 : t.includes(qq) ? 2 : 3; };
  const shown = qq ? items.filter(i => hit(i) < 3).sort((a, b) => hit(a) - hit(b)) : items;
  return createPortal(<div className="sp sp-drawer-bg" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <aside className="sp-drawer" role="dialog" aria-modal="true" aria-label="Thêm món">
      <div className="sp-drawer-h">
        <b>Thêm món</b>
        <button type="button" className="sp-x" aria-label="Đóng" onClick={onClose}>✕</button>
      </div>
      <input className="sp-field" type="search" placeholder="🔍 Tìm món" value={q} onChange={e => setQ(e.target.value)} />
      <ul className="sp-drawer-list">
        {shown.map(i => {
          const at = idx.get(itemKey(i.name)), l = at !== undefined ? lines[at] : null, p = prices[itemKey(i.name)];
          return <li key={i.id || i.name} className={l ? 'on' : ''}>
            <button type="button" className="nm" onClick={() => bump(i, 1)}>
              <b>{i.name}</b>
              <small>+{fmtQty(itemStep(i))} {i.unit || ''}{p !== undefined ? ` · ${money(p)}` : ''}</small>
            </button>
            {l
              ? <div className="sp-qty"><button type="button" aria-label={`Bớt ${i.name}`} onClick={() => bump(i, -1)}>−</button>
                  <span className="q">{l.qty}<small>{l.unit}</small></span>
                  <button type="button" aria-label={`Thêm ${i.name}`} onClick={() => bump(i, 1)}>+</button></div>
              : <button type="button" className="add" aria-label={`Thêm ${i.name}`} onClick={() => bump(i, 1)}>+</button>}
          </li>;
        })}
        {q.trim() && !shown.length && <li><button type="button" className="sp-btn block" onClick={() => { bump({ name: q }); setQ(''); }}>＋ Thêm món mới "{q.trim()}"</button></li>}
      </ul>
      <button type="button" className="sp-btn main block" onClick={onClose}>Xong{lines.length ? ` · đã chọn ${lines.length} món` : ''}</button>
    </aside>
  </div>, document.body);
}

/* ---------------- Tab Gọi hàng ---------------- */
function CallTab({ data, onSent, goSetup }) {
  const active = data.suppliers.filter(s => s.active);
  const saved = useMemo(() => (typeof window === 'undefined' ? null : readCart()), []);
  const [supplierId, setSupplierId] = useState(() => (saved?.supplierId && active.some(s => s.id === saved.supplierId) ? saved.supplierId : active.length === 1 ? active[0].id : ''));
  const [lines, setLines] = useState(saved?.lines || []);
  const [note, setNote] = useState(saved?.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useReloadHold(lines.length > 0, 'đang gọi gia vị');
  useEffect(() => { saveCart({ supplierId, lines, note }); }, [supplierId, lines, note]);

  if (!active.length) return <div className="sp-card sp-empty">
    Chưa có chủ gia vị.{goSetup ? <><br /><button type="button" className="sp-btn main" style={{ marginTop: 12 }} onClick={goSetup}>Thêm chủ gia vị</button></> : ' Nhờ chủ quán thêm ở trang Gia vị → Cài đặt.'}
  </div>;
  const supplier = active.find(s => s.id === supplierId);
  // Đơn gần nhất (chưa huỷ) gửi cho chủ gia vị này: bấm một lần là có lại đủ món, sửa số rồi gửi.
  const lastOrder = supplier ? data.orders.find(o => o.supplier_id === supplier.id && !o.cancelled_at) : null;
  const send = async () => {
    if (!supplier) { setError('Chọn chủ gia vị trước.'); return; }
    if (!lines.length) { setError('Chưa chọn món nào.'); return; }
    setBusy(true); setError('');
    try {
      const j = await api({ action: 'create', supplier_id: supplier.id, note, lines: lines.map(l => ({ name: l.name, unit: l.unit, qty: String(l.qty).replace(',', '.') })) });
      setLines([]); setNote(''); saveCart({ supplierId, lines: [], note: '' });
      onSent(j.supplier, j.order, j.order.items, note);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <>
    {active.length > 1 && <div className="sp-picks sp-to-picks">
      <span className="sp-mute sp-small">Gửi cho:</span>
      {active.map(s => <button key={s.id} type="button" className={`sp-pick ${s.id === supplierId ? 'on' : ''}`} onClick={() => setSupplierId(s.id)}>{s.name}</button>)}
    </div>}
    {!lines.length && <div className="sp-empty-call">
      <div className="ic" aria-hidden="true">🧂</div>
      <div>Chưa có món nào. Bấm nút <b className="plus">+</b> để chọn món.</div>
      {lastOrder && <button type="button" className="sp-btn block" style={{ marginTop: 10 }} onClick={() => setLines(lastOrder.items.map(l => ({ name: l.name, unit: l.unit || '', qty: fmtQty(Number(l.qty)), step: itemStep(data.items.find(i => itemKey(i.name) === itemKey(l.name))) })))}>
        🔁 Gọi giống lần trước · {lastOrder.items.length} món
      </button>}
    </div>}
    <ItemPicker drawer items={data.items} lines={lines} setLines={setLines} prices={data.lastPrices?.[supplierId] || {}} orders={data.orders} supplierId={supplierId} />
    {lines.length > 0 && <textarea className="sp-field sp-note-in" rows={1} placeholder="💬 Ghi chú cho chủ gia vị (không bắt buộc)" value={note} maxLength={300} onChange={e => setNote(e.target.value)} />}
    {error && <div className="sp-msg err">{error}</div>}
    <div className="sp-bar in-admin"><div className="sp-bar-in">
      <button type="button" className="sp-btn main" disabled={busy || !lines.length || !supplier} onClick={send}>
        {busy ? 'Đang gửi…' : `Gửi đơn${lines.length ? ` (${lines.length} món)` : ''}${supplier ? ` cho ${supplier.name}` : ''}`}
      </button>
    </div></div>
  </>;
}

/* ---------------- Tab Đơn ---------------- */
function OrdersTab({ data, supplierById, reload, onShare }) {
  const [filter, setFilter] = useState('open');
  const [sheet, setSheet] = useState(null); // { kind: 'receive' | 'add' | 'price', order }
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');
  const me = data.me, isAdmin = me.role === 'admin', canManage = isAdmin || me.role === 'manager';
  const counts = {
    open: data.orders.filter(o => ['new', 'priced', 'waiting_price'].includes(orderState(o))).length,
    done: data.orders.filter(o => orderState(o) === 'done').length,
  };
  // Đơn đã huỷ không nằm chung: gom vào mục "Đơn đã huỷ" gập lại ở cuối tab Tất cả (không tính tiền, chỉ để xem lại).
  const cancelled = data.orders.filter(o => o.cancelled_at);
  const list = data.orders.filter(o => {
    const st = orderState(o);
    if (st === 'cancelled') return false;
    return filter === 'all' || (filter === 'open' ? ['new', 'priced', 'waiting_price'].includes(st) : st === 'done');
  });
  const run = async (order, body, okText) => {
    setBusy(order.id); setMsg(null);
    try { await api({ id: order.id, updated_at: order.updated_at, ...body }); setMsg({ id: order.id, text: okText }); await reload(); return true; }
    catch (e) { setMsg({ id: order.id, err: true, text: e.message }); await reload(); return false; }
    finally { setBusy(''); }
  };
  return <>
    <div className="sp-seg" role="tablist">
      {[['open', 'Đang chờ', counts.open], ['done', 'Đã nhận', counts.done], ['all', 'Tất cả', data.orders.length - cancelled.length]].map(([k, l, n]) => <button key={k} type="button" role="tab" aria-selected={filter === k}
        className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}<small>{n}</small></button>)}
    </div>
    {!list.length && <p className="sp-empty">Không có đơn.</p>}
    {filter !== 'open' && list.some(o => o.received_at || o.cancelled_at) && <p className="sp-mute sp-small" style={{ margin: '0 0 8px' }}>Đơn các ngày trước đã gom theo ngày, bấm ngày để xem.</p>}
    <DayGroups orders={list} today={data.today} render={o => {
      const st = orderState(o), sup = supplierById[o.supplier_id];
      const open = !o.received_at && !o.cancelled_at;
      const canCancel = open && (canManage || o.created_by === me.id);
      return <div key={o.id} className={`sp-card sp-order ${st}`}>
        <div className="sp-row between"><div className="sp-b sp-grow">{sup?.name || 'Chủ gia vị'}</div><span className={`sp-chip ${st}`}>{STATE_LABELS[st]}</span></div>
        <div className="sp-who">
          <span>🕘 Gọi {shortTime(o.created_at)} · <b>{o.created_by_name}</b></span>
          {o.received_at && <span>📥 Nhận {shortTime(o.received_at)} · <b>{o.received_by_name}</b></span>}
          {o.cancelled_at && <span>✖ Huỷ · <b>{o.cancelled_by_name}</b></span>}
        </div>
        {o.note && <div className="sp-note staff">📝 {o.note}</div>}
        {o.supplier_note && <div className="sp-note supplier">💬 Chủ gia vị: {o.supplier_note}</div>}
        {open && o.items.some(l => l.by_supplier) && <div className="sp-note supplier">🧺 Chủ gia vị tự thêm {o.items.filter(l => l.by_supplier).length} món. Bấm <b>Kiểm hàng</b> để chọn lấy hay <b>Không lấy</b>.</div>}
        {paidState(o) === 'confirmed' && <div className="sp-paidmark">🔒 Đã xác nhận thanh toán · {shortTime(o.paid_confirmed_at)}</div>}
        {paidState(o) === 'pending' && <div className="sp-paidmark ask">⏳ Chủ gia vị báo đã nhận tiền · {shortTime(o.supplier_paid_at)}
          {isAdmin && <span className="sp-ask-btns">
            <button type="button" className="sp-btn ok" disabled={busy === o.id} onClick={() => run(o, { action: 'confirm_paid', ids: [o.id], ok: true }, 'Đã xác nhận thanh toán ✓')}>✓ Xác nhận</button>
            <button type="button" className="sp-btn bad" disabled={busy === o.id} onClick={() => { const note = window.prompt('Chưa thanh toán đơn này? Ghi lý do cho chủ gia vị (không bắt buộc):', ''); if (note !== null) run(o, { action: 'confirm_paid', ids: [o.id], ok: false, note }, 'Đã báo lại: chưa thanh toán'); }}>Không đúng</button>
          </span>}
        </div>}
        <OrderLines order={o} />
        {msg?.id === o.id && <div className={`sp-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</div>}
        {open && <div className="sp-btns two">
          <button type="button" className="sp-btn ok" disabled={busy === o.id} onClick={() => run(o, { action: 'receive', received: [] }, 'Đã nhận đủ ✓')}>✅ Nhận đủ</button>
          <button type="button" className="sp-btn" disabled={busy === o.id} onClick={() => setSheet({ kind: 'receive', order: o })}>🔍 Kiểm hàng</button>
        </div>}
        <div className="sp-acts">
          {open && <button type="button" onClick={() => setSheet({ kind: 'add', order: o })}>➕ Thêm món</button>}
          {open && sup && <button type="button" className="zalo" onClick={() => onShare(sup, o, o.items, { note: o.note || '' })}>📤 Gửi lại Zalo</button>}
          {!open && !o.cancelled_at && canManage && <button type="button" onClick={() => setSheet({ kind: 'recheck', order: o })}>🔍 Kiểm lại</button>}
          {isAdmin && !o.cancelled_at && <button type="button" onClick={() => setSheet({ kind: 'price', order: o })}>✏️ Sửa giá</button>}
          {canCancel && <button type="button" className="bad" disabled={busy === o.id} onClick={() => { if (window.confirm('Huỷ đơn này?')) run(o, { action: 'cancel' }, 'Đã huỷ đơn'); }}>Huỷ đơn</button>}
          {isAdmin && o.received_at && !o.cancelled_at && <button type="button" className="bad" disabled={busy === o.id} onClick={() => {
            const reason = window.prompt(`Huỷ đơn đã nhận ${money(orderTotal(o.items))}?
Đơn sẽ ra khỏi Sổ thu chi, công nợ và thống kê; lịch sử vẫn giữ.

Ghi lý do (vd: đơn thử, bấm nhận nhầm):`);
            if (reason && reason.trim()) run(o, { action: 'cancel', reason: reason.trim() }, 'Đã huỷ đơn đã nhận');
          }}>🗑 Huỷ đơn đã nhận</button>}
        </div>
        <History log={o.log} />
      </div>;
    }} />
    {filter === 'all' && cancelled.length > 0 && <Fold className="sp-dayfold" plain head={<span className="sp-day-head">
      <span className="sp-b">🗑 Đơn đã huỷ</span><span className="sp-mute"> · {cancelled.length} đơn · không tính tiền</span></span>}>
      <div className="sp-dayfold-in">{cancelled.map(o => {
        const why = [...(o.log || [])].reverse().find(e => e.type === 'cancel');
        return <div key={o.id} className="sp-card sp-order cancelled sp-cx">
          <div className="sp-row between"><span className="sp-b">{supplierById[o.supplier_id]?.name || 'Chủ gia vị'}</span><span className="sp-mute sp-small">{o.items.length} món · {money(orderTotal(o.items))}</span></div>
          <div className="sp-who"><span>🕘 Gọi {shortTime(o.created_at)} · <b>{o.created_by_name}</b></span><span>✖ Huỷ {shortTime(o.cancelled_at)} · <b>{o.cancelled_by_name}</b></span></div>
          {why?.note && <div className="sp-mute sp-small">Lý do: {why.note}</div>}
          <History log={o.log} />
        </div>;
      })}</div>
    </Fold>}
    {(sheet?.kind === 'receive' || sheet?.kind === 'recheck') && <ReceiveSheet order={sheet.order} recheck={sheet.kind === 'recheck'} onClose={() => setSheet(null)}
      onSave={(received, note) => run(sheet.order, { action: sheet.kind, received, note }, sheet.kind === 'recheck' ? 'Đã kiểm lại ✓' : 'Đã nhận ✓').then(ok => { if (ok) setSheet(null); return ok; })} />}
    {sheet?.kind === 'add' && <AddSheet order={sheet.order} data={data} onClose={() => setSheet(null)} onAdded={(j, items, note) => {
      setSheet(null); reload();
      const sup = j.supplier || supplierById[sheet.order.supplier_id];
      if (sup) onShare(sup, j.order, items, { added: true, note });
    }} />}
    {sheet?.kind === 'price' && <PriceSheet order={sheet.order} onClose={() => setSheet(null)}
      onSave={prices => run(sheet.order, { action: 'set_prices', prices }, 'Đã sửa giá ✓').then(ok => ok && setSheet(null))} />}
  </>;
}

function OrderLines({ order }) {
  const missing = missingPrices(order.items);
  return <>
    <ul className="sp-lines">{order.items.map((l, i) => {
      const later = addedLater(order, l);
      const ch = hasPrice(l) && l.old_price !== null && l.old_price !== undefined ? l.price - l.old_price : 0;
      return <li key={i} className="sp-line compact">
        <div className="sp-row between"><span className="name">{l.name} <span className="q">{qtyText(l.qty)} {l.unit}</span></span>
          <span className="sp-money">{hasPrice(l) ? money(lineAmount(l)) : <span className="nop">chưa giá</span>}</span></div>
        {hasPrice(l) && <div className="meta">
          {money(l.price)} / {l.unit || 'phần'}
          {ch !== 0 && <span className={ch > 0 ? 'sp-up' : 'sp-down'}> {changeText(ch)}</span>}
        </div>}
        {order.received_at && !order.cancelled_at && (() => { const c = lineCheck(l); return <div><CheckBadge check={c.check} diff={c.diff} unit={l.unit} note={c.note} /></div>; })()}
        {l.by_supplier ? <span className="added sup">🧺 Chủ gia vị tự thêm {shortTime(l.added_at)}</span>
          : later && <span className="added">➕ {l.added_by} thêm {shortTime(l.added_at)}</span>}
      </li>;
    })}</ul>
    <div className="sp-total"><span>Tổng{missing ? ` (${missing} món chưa giá)` : ''}</span><span className="sp-money">{money(orderTotal(order.items))}</span></div>
  </>;
}

function History({ log }) {
  if (!log?.length) return null;
  return <Fold head={`🕘 Lịch sử (${log.length})`}>
    <ul className="sp-log">{[...log].reverse().map((e, i) => { const x = logLine(e); return <li key={i} className={x.role}>
      <span className="t">{x.time}</span><span><span className="w">{x.who}</span> {x.text}</span></li>; })}</ul>
  </Fold>;
}

// Phần gập / mở bằng nút thường (thẻ details của iPhone đời cũ bấm hay không ăn).
function Fold({ head, initial = false, className = 'sp-fold', plain = false, children }) {
  const [open, setOpen] = useState(initial);
  return <div className={className}>
    <button type="button" className={`sp-fold-btn${plain ? ' plain' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="sp-grow">{head}</span><span className="sp-fold-tag">{open ? 'Ẩn' : 'Xem'}</span>
    </button>
    {open && children}
  </div>;
}


// Kiểm hàng khi nhận: mỗi món bấm Đủ / Thiếu / Dư / Sai hàng; thiếu / dư ghi số thật nhận; sai hàng ghi rõ sai gì (lấy bao
// nhiêu, mặc định 0). recheck = quản lý / chủ quán kiểm lại đơn đã nhận (đối soát).
function ReceiveSheet({ order, recheck = false, onClose, onSave }) {
  const [rows, setRows] = useState(() => order.items.map(l => {
    const c = recheck ? lineCheck(l) : { check: 'ok', got: Number(l.qty), note: '' };
    return { check: c.check, qty: c.check === 'ok' ? '' : qtyText(c.got), note: c.note };
  }));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r)));
  const issues = rows.filter(r => r.check !== 'ok').length;
  return <Sheet title={recheck ? 'Kiểm lại đơn đã nhận' : 'Kiểm hàng khi nhận'} onClose={onClose}>
    <p className="sp-mute">Kiểm từng món rồi bấm: <b>Đủ</b> · <b>Thiếu</b> / <b>Dư</b> (ghi số thật nhận) · <b>Sai hàng</b> (ghi sai gì). Chủ gia vị sẽ thấy.</p>
    {order.items.map((l, i) => {
      const r = rows[i];
      return <div key={i} className={`sp-recv ${r.check}`}>
        <div className="sp-row between"><span className="sp-b">{l.name}</span><span className="sp-mute">{l.by_supplier ? 'chủ gia vị thêm' : 'gọi'} {qtyText(l.qty)} {l.unit}</span></div>
        {l.by_supplier && <span className="added sup">🧺 Chủ gia vị tự thêm — quán không cần thì bấm Không lấy</span>}
        <div className={`sp-recv-checks${l.by_supplier ? ' five' : ''}`}>{['ok', 'short', 'over', 'wrong', ...(l.by_supplier ? ['skip'] : [])].map(k => <button key={k} type="button" className={`sp-pick ${r.check === k ? 'on' : ''} ${k}`}
          onClick={() => set(i, cur => ({ check: k, qty: k === 'ok' ? '' : k === 'wrong' ? (cur.qty || '0') : (cur.check === k ? cur.qty : '') }))}>{CHECK_LABELS[k]}</button>)}</div>
        {r.check !== 'ok' && r.check !== 'skip' && <div className="sp-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <span className="sp-mute">{r.check === 'wrong' ? 'Lấy' : 'Nhận thật'}</span>
          <div className="sp-qty"><input inputMode="decimal" aria-label={`Số nhận ${l.name}`} placeholder={r.check === 'short' ? `< ${qtyText(l.qty)}` : r.check === 'over' ? `> ${qtyText(l.qty)}` : '0'}
            value={r.qty} onChange={e => set(i, { qty: e.target.value.replace(/[^\d.,]/g, '').slice(0, 7) })} /></div>
          <span className="sp-mute">{l.unit}</span>
          <input className="sp-field" style={{ flex: '1 1 100%' }} placeholder={r.check === 'wrong' ? 'Sai gì? (bắt buộc, vd: ớt xanh thay ớt đỏ, hàng hư)' : 'Ghi chú (không bắt buộc)'}
            value={r.note} maxLength={200} onChange={e => set(i, { note: e.target.value })} />
        </div>}
      </div>;
    })}
    <textarea className="sp-field" style={{ marginTop: 10 }} placeholder="Ghi chú chung (vd: giao trễ 30 phút)" value={note} maxLength={300} onChange={e => setNote(e.target.value)} />
    {error && <div className="sp-msg err">{error}</div>}
    <div className="sp-btns"><button type="button" className="sp-btn ok block" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      const ok = await onSave(rows.map(r => (r.check === 'ok' ? null : { check: r.check, qty: r.qty.replace(',', '.'), note: r.note })), note);
      if (!ok) setError('Chưa lưu được, xem thông báo trên thẻ đơn.');
      setBusy(false);
    }}>{recheck ? 'Lưu kiểm lại' : issues ? `Xác nhận nhận (${issues} món không đủ)` : 'Xác nhận nhận đủ'}</button></div>
  </Sheet>;
}

function AddSheet({ order, data, onClose, onAdded }) {
  const [lines, setLines] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Sheet title="Thêm món vào đơn" onClose={onClose}>
    <ItemPicker items={data.items} lines={lines} setLines={setLines} prices={data.lastPrices?.[order.supplier_id] || {}} exclude={order.items.map(l => l.name)} orders={data.orders} supplierId={order.supplier_id} />
    <textarea className="sp-field" style={{ marginTop: 12 }} placeholder="Ghi chú (vd: thêm vì hết giữa ca)" value={note} maxLength={300} onChange={e => setNote(e.target.value)} />
    {error && <div className="sp-msg err">{error}</div>}
    <div className="sp-btns"><button type="button" className="sp-btn main block" disabled={busy || !lines.length} onClick={async () => {
      setBusy(true); setError('');
      try {
        const j = await api({ action: 'add_lines', id: order.id, note, lines: lines.map(l => ({ name: l.name, unit: l.unit, qty: String(l.qty).replace(',', '.') })) });
        const fresh = j.order.items.slice(order.items.length);
        onAdded(j, fresh, note);
      } catch (e) { setError(e.message); setBusy(false); }
    }}>{busy ? 'Đang thêm…' : `Thêm ${lines.length || ''} món`}</button></div>
  </Sheet>;
}

function PriceSheet({ order, onClose, onSave }) {
  const [prices, setPrices] = useState(() => order.items.map(l => (hasPrice(l) ? String(l.price) : '')));
  const [busy, setBusy] = useState(false);
  return <Sheet title="Sửa giá (chủ quán)" onClose={onClose}>
    <p className="sp-mute">Giá 1 đơn vị. Mỗi lần sửa đều ghi vào lịch sử đơn.</p>
    {order.items.map((l, i) => <div key={i} className="sp-line">
      <div className="sp-row between"><span className="name">{l.name}</span><span className="sp-mute">{qtyText(lineQty(l))} {l.unit}</span></div>
      <div className="sp-price"><span className="unit">Giá 1 {l.unit || 'phần'}</span>
        <input inputMode="numeric" aria-label={`Giá ${l.name}`} className={prices[i] === '' ? 'empty' : ''} value={withDots(prices[i])}
          onChange={e => setPrices(prices.map((p, j) => (j === i ? digits(e.target.value) : p)))} /></div>
    </div>)}
    <div className="sp-btns"><button type="button" className="sp-btn main block" disabled={busy} onClick={async () => {
      setBusy(true);
      await onSave(prices.map((p, index) => ({ index, price: p === '' ? null : Number(p) })));
      setBusy(false);
    }}>Lưu giá</button></div>
  </Sheet>;
}


/* ---------------- Tab Đối soát ---------------- */
// Xem lại từng ngày với một chủ gia vị: món gọi / nhận / đủ-thiếu-dư-sai, tiền; chủ quán thấy thêm tiền trả và nợ cuối ngày.
// Nút gửi đối soát ngày qua Zalo để báo lại và cân đối với chủ gia vị.
function DaysTab({ data, reload, onShareText }) {
  const isAdmin = data.me.role === 'admin', canManage = isAdmin || data.me.role === 'manager';
  const [supplierId, setSupplierId] = useState(data.suppliers.find(s => s.active)?.id || data.suppliers[0]?.id || '');
  const [days, setDays] = useState(null);
  const [error, setError] = useState('');
  const [recheck, setRecheck] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!supplierId) return undefined;
    let live = true;
    setDays(null); setError('');
    fetch(`/api/admin/spices?days=${supplierId}`, { cache: 'no-store' }).then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!live) return; if (ok) setDays(j.days); else setError(j.error || 'Không tải được.'); })
      .catch(() => live && setError('Mạng yếu, thử lại.'));
    return () => { live = false; };
  }, [supplierId, tick]);
  const sup = data.suppliers.find(s => s.id === supplierId);
  if (!data.suppliers.length) return <p className="sp-empty">Chưa có chủ gia vị.</p>;
  return <>
    <div className="sp-picks" style={{ marginBottom: 10 }}>{data.suppliers.map(s => <button key={s.id} type="button" className={`sp-pick ${s.id === supplierId ? 'on' : ''}`} onClick={() => setSupplierId(s.id)}>{s.name}</button>)}</div>
    <p className="sp-mute">Từng ngày nhận hàng (60 ngày gần đây). Bấm ngày để xem món đủ / thiếu / dư / sai{isAdmin ? ', tiền đã trả và nợ cuối ngày' : ''}.</p>
    {error && <div className="sp-msg err">{error}</div>}
    {!days && !error && <p className="sp-empty">Đang tải…</p>}
    {days && !days.length && <p className="sp-empty">Chưa nhận đơn nào.</p>}
    {days?.map((d, i) => <DayCard key={d.date} day={d} initial={i === 0}
      onShare={sup ? day => onShareText(`Đối soát ${day.date.split('-').reverse().slice(0, 2).join('/')}`, dayReportText({ supplierName: sup.name, day, withMoney: true }), sup.phone) : null}
      onRecheck={canManage ? id => setRecheck(data.orders.find(o => o.id === id) || { id, missing: true }) : null} />)}
    {recheck?.missing && <Sheet title="Kiểm lại" onClose={() => setRecheck(null)}><p className="sp-mute">Đơn này cũ hơn 60 ngày, mở ở tab Đơn → Tất cả.</p></Sheet>}
    {recheck && !recheck.missing && <ReceiveSheet order={recheck} recheck onClose={() => setRecheck(null)} onSave={async (received, note) => {
      try { await api({ action: 'recheck', id: recheck.id, updated_at: recheck.updated_at, received, note }); setRecheck(null); await reload(); setTick(t => t + 1); return true; }
      catch (e) { setError(e.message); return false; }
    }} />}
  </>;
}

/* ---------------- Tab Công nợ (chủ quán) ---------------- */
/** Chủ gia vị bấm "Đã TT" → chủ quán xác nhận (trừ nợ, khoá đơn) hoặc báo Không đúng. Xác nhận từng đơn hoặc tất cả. */
function PayAsks({ orders, reload }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  if (!orders.length && !msg) return null;
  const total = orders.reduce((t, o) => t + orderTotal(o.items), 0);
  const act = async (ids, ok) => {
    let note = '';
    if (!ok) { note = window.prompt('Ghi lý do cho chủ gia vị (không bắt buộc):', ''); if (note === null) return; }
    setBusy(true); setMsg(null);
    try {
      const j = await api({ action: 'confirm_paid', ids, ok, note });
      setMsg({ text: ok ? `Đã xác nhận ${j.changed} đơn · ${money(j.total)} ✓` : 'Đã báo lại chủ gia vị: chưa thanh toán' });
      await reload();
    } catch (e) { setMsg({ err: true, text: e.message }); }
    setBusy(false);
  };
  return <div className="sp-asks">
    {orders.length > 0 && <>
      <div className="sp-row between"><span className="sp-b">⏳ Chờ xác nhận thanh toán · {orders.length} đơn</span><span className="sp-money">{money(total)}</span></div>
      <p className="sp-mute sp-small" style={{ margin: '2px 0 6px' }}>Chủ gia vị báo đã nhận tiền. Xác nhận thì trừ nợ và khoá đơn (chủ gia vị không sửa được nữa).</p>
      {orders.map(o => <div key={o.id} className="sp-row between sp-ask-row">
        <span><b>{shortTime(o.received_at)}</b> · {money(orderTotal(o.items))}<span className="sp-mute sp-small"> · báo {shortTime(o.supplier_paid_at)}</span></span>
        <span className="sp-ask-btns">
          <button type="button" className="sp-btn ok" disabled={busy} onClick={() => act([o.id], true)}>✓</button>
          <button type="button" className="sp-btn bad" disabled={busy} onClick={() => act([o.id], false)}>✗</button>
        </span>
      </div>)}
      {orders.length > 1 && <button type="button" className="sp-btn ok block" style={{ marginTop: 8 }} disabled={busy} onClick={() => act(orders.map(o => o.id), true)}>✓ Xác nhận tất cả {orders.length} đơn · {money(total)}</button>}
    </>}
    {msg && <div className={`sp-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</div>}
  </div>;
}

function DebtTab({ data, reload }) {
  const [pay, setPay] = useState(null);
  const [msg, setMsg] = useState(null);
  const balances = data.balances || {};
  const name = id => data.suppliers.find(s => s.id === id)?.name || 'Chủ gia vị';
  const total = Object.values(balances).reduce((s, b) => s + b.debt, 0);
  return <>
    <div className="sp-card sp-row between"><span className="sp-b">Tổng còn nợ</span><span className="sp-money" style={{ fontSize: 20, color: 'var(--sp-bad)' }}>{money(total)}</span></div>
    {data.suppliers.map(s => {
      const b = balances[s.id] || { owed: 0, paid: 0, debt: 0, waiting: 0 };
      return <div key={s.id} className="sp-card">
        <div className="sp-b">{s.name}{!s.active && <span className="sp-mute"> (đã ngưng)</span>}</div>
        <div className="sp-tiles" style={{ margin: '8px 0' }}>
          <div className="sp-tile"><div className="k">Đã giao</div><div className="v">{money(b.owed)}</div></div>
          <div className="sp-tile paid"><div className="k">Đã trả</div><div className="v">{money(b.paid)}</div></div>
          <div className="sp-tile owe"><div className="k">Còn nợ</div><div className="v">{money(b.debt)}</div></div>
        </div>
        {b.owed - b.paid - b.debt > 0 && <p className="sp-mute sp-small">🔒 Trong đó {money(b.owed - b.paid - b.debt)} là các đơn chủ gia vị báo đã nhận tiền và quán đã xác nhận.</p>}
        <PayAsks orders={data.orders.filter(o => o.supplier_id === s.id && !o.cancelled_at && paidState(o) === 'pending')} reload={reload} />
        {b.waiting > 0 && <p className="sp-mute">⚠️ {b.waiting} đơn đã nhận còn món chưa có giá.</p>}
        {msg?.id === s.id && <div className={`sp-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</div>}
        <button type="button" className="sp-btn main block" onClick={() => setPay({ supplier: s, amount: String(Math.max(0, b.debt)) })}>💵 Trả tiền</button>
      </div>;
    })}
    <h2>Các lần đã trả</h2>
    {data.payments.length ? <div className="sp-card"><ul className="sp-log">{data.payments.map(p => <li key={p.id} style={{ gridTemplateColumns: '64px 1fr auto' }}>
      <span className="t">{p.paid_date.split('-').reverse().slice(0, 2).join('/')}</span>
      <span><b>{name(p.supplier_id)}</b> · <span className="sp-money">{money(p.amount)}</span> · {p.method === 'transfer' ? 'CK' : 'tiền mặt'}{p.note ? ` · ${p.note}` : ''}
        <br /><span className="sp-mute sp-small">{p.created_by_name} ghi {shortTime(p.created_at)}</span></span>
      <button type="button" className="sp-btn ghost bad" onClick={async () => {
        try { await api({ action: 'delete_payment', id: p.id }); await reload(); } catch (e) { setMsg({ id: p.supplier_id, err: true, text: e.message }); }
      }}>Xoá</button>
    </li>)}</ul></div> : <p className="sp-empty">Chưa trả lần nào.</p>}
    {pay && <PaySheet pay={pay} today={data.today} onClose={() => setPay(null)} onDone={async text => { setMsg({ id: pay.supplier.id, text }); setPay(null); await reload(); }} />}
  </>;
}

function PaySheet({ pay, today, onClose, onDone }) {
  const [amount, setAmount] = useState(digits(pay.amount));
  const [method, setMethod] = useState('cash');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Sheet title={`Trả tiền ${pay.supplier.name}`} onClose={onClose}>
    <label className="sp-mute">Số tiền</label>
    <div className="sp-price" style={{ marginTop: 4 }}><input inputMode="numeric" value={withDots(amount)} onChange={e => setAmount(digits(e.target.value))} aria-label="Số tiền trả" /><span className="unit">đ</span></div>
    <div className="sp-picks" style={{ marginTop: 10 }}>
      {[['cash', '💵 Tiền mặt'], ['transfer', '🏦 Chuyển khoản']].map(([k, l]) => <button key={k} type="button" className={`sp-pick ${method === k ? 'on' : ''}`} onClick={() => setMethod(k)}>{l}</button>)}
    </div>
    <label className="sp-mute" style={{ display: 'block', marginTop: 10 }}>Ngày trả</label>
    <input type="date" className="sp-field" value={date} max={today} onChange={e => setDate(e.target.value)} />
    <textarea className="sp-field" style={{ marginTop: 10 }} placeholder="Ghi chú (không bắt buộc)" value={note} maxLength={300} onChange={e => setNote(e.target.value)} />
    {error && <div className="sp-msg err">{error}</div>}
    <div className="sp-btns"><button type="button" className="sp-btn main block" disabled={busy || !amount} onClick={async () => {
      setBusy(true); setError('');
      try { await api({ action: 'pay', supplier_id: pay.supplier.id, amount, method, paid_date: date, note }); await onDone(`Đã ghi trả ${money(amount)} ✓`); }
      catch (e) { setError(e.message); setBusy(false); }
    }}>Ghi đã trả {amount ? money(amount) : ''}</button></div>
  </Sheet>;
}

/* ---------------- Tab Thống kê (chủ quán) ---------------- */
function StatsTab() {
  const [period, setPeriod] = useState('day');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setData(null); setError('');
    fetch(`/api/admin/spices?stats=${period}`, { cache: 'no-store' }).then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!live) return; if (ok) setData(j); else setError(j.error || 'Không tải được.'); })
      .catch(() => live && setError('Mạng yếu, thử lại.'));
    return () => { live = false; };
  }, [period]);
  const label = k => (period === 'year' ? `Năm ${k}` : period === 'month' ? `Tháng ${k.slice(5)}/${k.slice(0, 4)}` : k.split('-').reverse().join('/'));
  return <>
    <div className="sp-picks" style={{ marginBottom: 10 }}>
      {[['day', 'Theo ngày'], ['month', 'Theo tháng'], ['year', 'Theo năm']].map(([k, l]) => <button key={k} type="button" className={`sp-pick ${period === k ? 'on' : ''}`} onClick={() => setPeriod(k)}>{l}</button>)}
    </div>
    <p className="sp-mute">Tính theo ngày quán nhận hàng. ▲ giá tăng / ▼ giá giảm so với lần trước. 🧺 = chủ gia vị tự thêm món, ✏️ = chủ gia vị sửa giá.</p>
    {error && <div className="sp-msg err">{error}</div>}
    {!data && !error && <p className="sp-empty">Đang tải…</p>}
    {data && !data.stats.length && <p className="sp-empty">Chưa có đơn đã nhận.</p>}
    {data?.stats.map(g => <Fold key={`${period}-${g.key}`} className="sp-card" plain initial={g === data.stats[0]}
      head={<span className="sp-row between"><span className="sp-b">{label(g.key)}</span><span className="sp-money">{money(g.total)}</span></span>}>
      <table className="sp-stat" style={{ marginTop: 8 }}>
        <thead><tr><th>Món</th><th>SL</th><th>Giá</th><th>Tiền</th></tr></thead>
        <tbody>{g.items.map(it => <tr key={it.name}>
          <td>{it.name}{it.suppliers.length > 0 && <div className="sp-mute sp-small">{it.suppliers.join(', ')}</div>}
            {it.supplierOffered > 0 && <div className="sp-tag sup">🧺 CGV tự thêm {qtyText(it.supplierOffered)} {it.unit}{it.supplierAdded < it.supplierOffered ? ` · quán lấy ${qtyText(it.supplierAdded)}` : ''}</div>}
            {it.supplierEdits > 0 && <div className="sp-tag edit">✏️ CGV sửa giá {it.supplierEdits} lần</div>}</td>
          <td>{qtyText(it.qty)} {it.unit}</td>
          <td>{it.price !== null ? money(it.price) : '—'}{it.change ? <div className={it.change > 0 ? 'sp-up' : 'sp-down'}>{changeText(it.change)}</div> : null}</td>
          <td className="sp-money">{money(it.amount)}</td>
        </tr>)}</tbody>
      </table>
    </Fold>)}
  </>;
}

/* ---------------- Tab Cài đặt (chủ quán) ---------------- */
function SetupTab({ data, reload }) {
  const [edit, setEdit] = useState(null); // { id?, name, phone, active }
  const [itemEdit, setItemEdit] = useState(null);
  const [bulk, setBulk] = useState(null); // chữ đang dán: nhiều món một lần
  const [listText, setListText] = useState(null); // sửa cả danh sách bằng chữ
  const [busy, setBusy] = useState(false);
  const items = orderedItems(data.items);
  const move = async (id, dir) => {
    if (busy) return;
    setBusy(true);
    try { await api({ action: 'move_item', id, dir }); await reload(); } catch (e) { setMsg({ key: 'item', err: true, text: e.message }); }
    setBusy(false);
  };
  const [msg, setMsg] = useState(null);
  const run = async (body, text, key) => {
    try { await api(body); setMsg({ key, text }); await reload(); return true; } catch (e) { setMsg({ key, err: true, text: e.message }); return false; }
  };
  const copyLink = async s => {
    try { await navigator.clipboard.writeText(linkOf(s.token)); setMsg({ key: s.id, text: 'Đã chép link. Gửi cho chủ gia vị qua Zalo.' }); }
    catch { setMsg({ key: s.id, text: linkOf(s.token) }); }
  };
  return <>
    <h2>Chủ gia vị</h2>
    {data.suppliers.map(s => <div key={s.id} className="sp-card">
      <div className="sp-row between"><div><div className="sp-b">{s.name}{!s.active && <span className="sp-mute"> (ngưng)</span>}</div>{s.phone && <div className="sp-mute">{s.phone}</div>}</div>
        <button type="button" className="sp-btn" onClick={() => setEdit({ ...s })}>Sửa</button></div>
      {msg?.key === s.id && <div className={`sp-msg ${msg.err ? 'err' : 'ok'}`} style={{ wordBreak: 'break-all' }}>{msg.text}</div>}
      <div className="sp-btns">
        <button type="button" className="sp-btn" onClick={() => copyLink(s)}>📋 Chép link riêng</button>
        <button type="button" className="sp-btn bad" onClick={() => run({ action: 'new_link', id: s.id }, 'Đã đổi link. Link cũ không mở được nữa — gửi link mới cho chủ gia vị.', s.id)}>🔄 Đổi link</button>
      </div>
    </div>)}
    <button type="button" className="sp-btn main block" onClick={() => setEdit({ name: '', phone: '', active: true })}>➕ Thêm chủ gia vị</button>

    <h2>Món gia vị</h2>
    {msg?.key === 'item' && <div className={`sp-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</div>}
    <div className="sp-card">
      <p className="sp-mute sp-small" style={{ marginTop: 0 }}>Nhân viên thấy đúng các món này, đúng thứ tự này. Bấm tên món để sửa tên / đơn vị / số mỗi lần bấm, ẩn hoặc xoá. ▲▼ để đổi chỗ.</p>
      {items.length === 0 && <p className="sp-empty">Chưa có món nào.</p>}
      {items.map((i, k) => <div key={i.id} className="sp-item-row" style={i.active ? undefined : { opacity: 0.55 }}>
        <button type="button" className="sp-item-name" onClick={() => setItemEdit({ ...i, unit: i.unit || '', default_qty: i.default_qty ? fmtQty(Number(i.default_qty)) : '' })}>
          <span className="sp-b">{k + 1}. {i.name}</span>
          <span className="sp-mute"> · {i.default_qty ? fmtQty(Number(i.default_qty)) : 1} {i.unit || ''}{!i.active ? ' · đang ẩn' : ''}</span>
        </button>
        <button type="button" className="sp-move" aria-label="Lên" disabled={busy || k === 0} onClick={() => move(i.id, -1)}>▲</button>
        <button type="button" className="sp-move" aria-label="Xuống" disabled={busy || k === items.length - 1} onClick={() => move(i.id, 1)}>▼</button>
      </div>)}
      <div className="sp-btns">
        <button type="button" className="sp-btn" onClick={() => setItemEdit({ name: '', unit: '', default_qty: '', active: true })}>➕ Một món</button>
        <button type="button" className="sp-btn" onClick={() => setBulk('')}>📋 Thêm nhiều món</button>
        <button type="button" className="sp-btn main" onClick={() => setListText(items.filter(i => i.active).map(itemLineText).join('\n'))}>✏️ Sửa cả danh sách</button>
      </div>
      <p className="sp-mute sp-small" style={{ marginTop: 8 }}>Món nhân viên gõ thêm lúc gọi (＋ Món khác) chỉ nằm trong đơn đó, không tự vào danh sách.</p>
    </div>
    {listText !== null && <Sheet title="Sửa cả danh sách" onClose={() => setListText(null)}>
      <p className="sp-mute">Mỗi dòng một món: <b>tên, số mỗi lần bấm, đơn vị</b> (vd: <i>Tiêu xay 0,5 kg</i>). Sửa tên, đổi thứ tự dòng, thêm dòng mới tuỳ ý. <b>Dòng nào xoá đi thì món đó bị xoá khỏi danh sách</b> (đơn cũ vẫn giữ nguyên).</p>
      <textarea className="sp-field" rows={14} value={listText} onChange={e => setListText(e.target.value)} />
      {msg?.key === 'list' && msg.err && <div className="sp-msg err">{msg.text}</div>}
      <div className="sp-btns"><button type="button" className="sp-btn main block" disabled={!listText.trim()} onClick={async () => {
        try {
          const j = await api({ action: 'replace_items', text: listText });
          setMsg({ key: 'item', text: `Đã lưu danh sách: ${j.total} món${j.added ? `, thêm ${j.added}` : ''}${j.removed ? `, xoá ${j.removed}` : ''} ✓` }); setListText(null); await reload();
        } catch (e) { setMsg({ key: 'list', err: true, text: e.message }); }
      }}>Lưu danh sách</button></div>
    </Sheet>}
    {bulk !== null && <Sheet title="Thêm nhiều món" onClose={() => setBulk(null)}>
      <p className="sp-mute">Mỗi dòng một món: tên, số lượng mặc định, đơn vị. Món đã có thì cập nhật số và đơn vị.</p>
      <textarea className="sp-field" rows={8} placeholder={'Muối 1 kg\nTiêu xay 0,5 kg\nRau răm 2 bó\nNước mắm 2 chai'} value={bulk} onChange={e => setBulk(e.target.value)} />
      {msg?.key === 'bulk' && msg.err && <div className="sp-msg err">{msg.text}</div>}
      <div className="sp-btns"><button type="button" className="sp-btn main block" disabled={!bulk.trim()} onClick={async () => {
        try {
          const j = await api({ action: 'save_items', text: bulk });
          setMsg({ key: 'item', text: `Đã thêm ${j.added} món${j.updated ? `, cập nhật ${j.updated} món` : ''} ✓` }); setBulk(null); await reload();
        } catch (e) { setMsg({ key: 'bulk', err: true, text: e.message }); }
      }}>Lưu danh sách</button></div>
    </Sheet>}

    {edit && <Sheet title={edit.id ? 'Sửa chủ gia vị' : 'Thêm chủ gia vị'} onClose={() => setEdit(null)}>
      <input className="sp-field" placeholder="Tên (vd: Cô Hai gia vị)" value={edit.name} maxLength={60} onChange={e => setEdit({ ...edit, name: e.target.value })} />
      <input className="sp-field" style={{ marginTop: 8 }} inputMode="tel" placeholder="Số Zalo (không bắt buộc)" value={edit.phone} maxLength={20} onChange={e => setEdit({ ...edit, phone: e.target.value })} />
      {edit.id && <label className="sp-row" style={{ marginTop: 10 }}><input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} style={{ width: 22, height: 22 }} /> Đang nhận đơn</label>}
      <div className="sp-btns"><button type="button" className="sp-btn main block" onClick={async () => {
        if (await run({ action: 'save_supplier', ...edit }, 'Đã lưu ✓', edit.id || 'new')) setEdit(null);
      }}>Lưu</button></div>
      {msg?.key === (edit.id || 'new') && msg.err && <div className="sp-msg err">{msg.text}</div>}
    </Sheet>}
    {itemEdit && <Sheet title={itemEdit.id ? 'Sửa món' : 'Món mới'} onClose={() => setItemEdit(null)}>
      <div className="sp-row"><input className="sp-field sp-grow" placeholder="Tên món" value={itemEdit.name} maxLength={60} onChange={e => setItemEdit({ ...itemEdit, name: e.target.value })} />
        <input className="sp-unit" placeholder="kg, bịch" value={itemEdit.unit} maxLength={20} onChange={e => setItemEdit({ ...itemEdit, unit: e.target.value })} /></div>
      <label className="sp-mute" style={{ display: 'block', marginTop: 10 }}>Mỗi lần bấm món thêm bao nhiêu (để trống = 1)</label>
      <input className="sp-field" inputMode="decimal" placeholder="vd: 0,5" value={itemEdit.default_qty} maxLength={7}
        onChange={e => setItemEdit({ ...itemEdit, default_qty: e.target.value.replace(/[^\d.,]/g, '') })} />
      {msg?.key === 'item' && msg.err && <div className="sp-msg err">{msg.text}</div>}
      {itemEdit.id && <label className="sp-row" style={{ marginTop: 10 }}><input type="checkbox" checked={itemEdit.active} onChange={e => setItemEdit({ ...itemEdit, active: e.target.checked })} style={{ width: 22, height: 22 }} /> Hiện khi gọi hàng</label>}
      <div className="sp-btns"><button type="button" className="sp-btn main block" onClick={async () => {
        if (await run({ action: 'save_item', id: itemEdit.id, name: itemEdit.name, unit: itemEdit.unit, active: itemEdit.active, default_qty: String(itemEdit.default_qty || '').replace(',', '.') }, 'Đã lưu món ✓', 'item')) setItemEdit(null);
      }}>Lưu</button></div>
      {itemEdit.id && <div className="sp-btns"><button type="button" className="sp-btn bad block" onClick={async () => {
        if (!window.confirm(`Xoá "${itemEdit.name}" khỏi danh sách? Đơn cũ vẫn giữ nguyên.`)) return;
        if (await run({ action: 'delete_item', id: itemEdit.id }, `Đã xoá ${itemEdit.name}`, 'item')) setItemEdit(null);
      }}>🗑 Xoá món này</button></div>}
    </Sheet>}
  </>;
}
