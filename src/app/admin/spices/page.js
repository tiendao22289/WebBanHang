'use client';
/**
 * Gọi gia vị (nhân viên, quản lý, admin): chọn chủ gia vị + món → Gửi → gửi tin kèm link qua Zalo cho chủ gia vị.
 * Tab Đơn: theo dõi đơn, thêm món, bấm Nhận đủ / Nhận thiếu, xem lịch sử (ai gọi, thêm, đổi giá, nhận — giờ nào).
 * Chủ quán thêm: Công nợ (trả gom), Thống kê từng món theo ngày / tháng / năm, Cài đặt (chủ gia vị, link riêng, món).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBackClose } from '@/lib/useBackClose';
import { useReloadHold } from '@/lib/useBuildRefresh';
import {
  STATE_LABELS, addedLater, changeText, cleanName, itemKey, itemStep, plainText, rankItems, lineAmount, lineQty, logLine, missingPrices, orderState, orderTotal, shareText, shortTime,
} from '@/lib/spiceOrders.mjs';
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

  // Sau khi gửi / thêm món: hộp "Gửi qua Zalo" (chia sẻ cần một lần bấm của người dùng, nên không mở tự động).
  const askShare = (supplier, order, items, { added = false, note = '' } = {}) => setShare({
    title: added ? 'Đã thêm món ✓' : 'Đã tạo đơn ✓',
    phone: supplier.phone,
    text: shareText({ supplierName: supplier.name, items, note, by: data?.me?.name, link: linkOf(supplier.token, order.id),
      title: added ? 'Quán gọi THÊM gia vị' : 'Quán gọi gia vị' }),
  });

  if (!data) return <div className="sp">{error ? <div className="sp-msg err">{error}</div> : <p className="sp-empty">Đang tải…</p>}</div>;
  const tabs = [['call', '🧂 Gọi hàng'], ['orders', 'Đơn'], ...(isAdmin ? [['debt', 'Công nợ'], ['stats', 'Thống kê'], ['setup', 'Cài đặt']] : [])];
  return <div className="sp">
    <h1>🧂 Gia vị</h1>
    {error && <div className="sp-msg err">{error}</div>}
    <div className="sp-tabs" role="tablist">
      {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`sp-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
        {label}{k === 'orders' && openCount > 0 && <span className="sp-count">{openCount}</span>}
      </button>)}
    </div>
    {tab === 'call' && <CallTab data={data} onSent={(supplier, order, items, note) => { askShare(supplier, order, items, { note }); load(); setTab('orders'); }} goSetup={isAdmin ? () => setTab('setup') : null} />}
    {tab === 'orders' && <OrdersTab data={data} supplierById={supplierById} reload={load} onShare={askShare} />}
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
    <p className="sp-mute">Gửi tin này qua Zalo cho chủ gia vị (hoặc nhóm). Trong tin có link để họ soạn hàng và điền giá.</p>
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

// Chọn món nhanh: ô to theo danh sách (món hay gọi lên đầu), bấm ô = thêm số mặc định (vd Tiêu 0,5 kg), bấm tiếp = thêm nữa,
// nút − trên ô để bớt. Danh sách dài thì có ô tìm (gõ không dấu cũng được). Món không có trong danh sách: "＋ Món khác".
const num = v => Number(String(v ?? '').replace(',', '.')) || 0;
const fmtQty = n => String(Math.round(n * 1000) / 1000).replace('.', ',');
function ItemPicker({ items, lines, setLines, prices = {}, exclude = [], orders = [], supplierId = null }) {
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
    {lines.length > 0 && <>
      <div className="sp-b" style={{ marginTop: 12 }}>Đã chọn {lines.length} món <span className="sp-mute">(sửa số / đơn vị nếu cần)</span></div>
      <ul className="sp-cart">{lines.map((l, i) => <li key={`${l.name}-${i}`}>
        <span className="nm">{l.name}</span>
        <div className="sp-qty">
          <button type="button" aria-label={`Bớt ${l.name}`} onClick={() => bump(l, -1)}>−</button>
          <input inputMode="decimal" aria-label={`Số lượng ${l.name}`} value={l.qty} onChange={e => setLine(i, { qty: e.target.value.replace(/[^\d.,]/g, '').slice(0, 7) })} />
          <button type="button" aria-label={`Thêm ${l.name}`} onClick={() => bump(l, 1)}>+</button>
        </div>
        <input className="sp-unit" placeholder="đơn vị" aria-label={`Đơn vị ${l.name}`} value={l.unit} maxLength={20} onChange={e => setLine(i, { unit: e.target.value })} />
        <button type="button" className="sp-x" aria-label={`Bỏ ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
      </li>)}</ul>
    </>}
  </>;
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
    <div className="sp-card">
      <div className="sp-b" style={{ marginBottom: 8 }}>1. Gửi cho ai?</div>
      <div className="sp-picks">{active.map(s => <button key={s.id} type="button" className={`sp-pick ${s.id === supplierId ? 'on' : ''}`} onClick={() => setSupplierId(s.id)}>
        {s.name}{s.phone && <small>{s.phone}</small>}
      </button>)}</div>
    </div>
    <div className="sp-card">
      <div className="sp-b" style={{ marginBottom: 8 }}>2. Gọi món gì?</div>
      {!lines.length && lastOrder && <button type="button" className="sp-btn block" style={{ marginBottom: 10 }} onClick={() => setLines(lastOrder.items.map(l => ({ name: l.name, unit: l.unit || '', qty: fmtQty(Number(l.qty)), step: itemStep(data.items.find(i => itemKey(i.name) === itemKey(l.name))) })))}>
        🔁 Gọi giống lần trước ({lastOrder.items.length} món, {shortTime(lastOrder.created_at)})
      </button>}
      <ItemPicker items={data.items} lines={lines} setLines={setLines} prices={data.lastPrices?.[supplierId] || {}} orders={data.orders} supplierId={supplierId} />
      <textarea className="sp-field" style={{ marginTop: 12 }} placeholder="Ghi chú cho chủ gia vị (không bắt buộc)" value={note} maxLength={300} onChange={e => setNote(e.target.value)} />
    </div>
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
  const list = data.orders.filter(o => {
    const st = orderState(o);
    return filter === 'all' || (filter === 'open' ? ['new', 'priced', 'waiting_price'].includes(st) : st === 'done');
  });
  const run = async (order, body, okText) => {
    setBusy(order.id); setMsg(null);
    try { await api({ id: order.id, updated_at: order.updated_at, ...body }); setMsg({ id: order.id, text: okText }); await reload(); return true; }
    catch (e) { setMsg({ id: order.id, err: true, text: e.message }); await reload(); return false; }
    finally { setBusy(''); }
  };
  return <>
    <div className="sp-picks" style={{ marginBottom: 10 }}>
      {[['open', 'Đang chờ'], ['done', 'Đã nhận'], ['all', 'Tất cả']].map(([k, l]) => <button key={k} type="button" className={`sp-pick ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
    </div>
    {!list.length && <p className="sp-empty">Không có đơn.</p>}
    {list.map(o => {
      const st = orderState(o), sup = supplierById[o.supplier_id];
      const open = !o.received_at && !o.cancelled_at;
      return <div key={o.id} className="sp-card">
        <div className="sp-row between"><div className="sp-b">{sup?.name || 'Chủ gia vị'}</div><span className={`sp-chip ${st}`}>{STATE_LABELS[st]}</span></div>
        <div className="sp-mute">Gọi: <b>{o.created_by_name}</b> {shortTime(o.created_at)}
          {o.received_at && <> · Nhận: <b>{o.received_by_name}</b> {shortTime(o.received_at)}</>}
          {o.cancelled_at && <> · Huỷ: <b>{o.cancelled_by_name}</b></>}</div>
        {o.note && <div className="sp-note staff">📝 {o.note}</div>}
        {o.supplier_note && <div className="sp-note supplier">💬 Chủ gia vị: {o.supplier_note}</div>}
        <OrderLines order={o} />
        {msg?.id === o.id && <div className={`sp-msg ${msg.err ? 'err' : 'ok'}`}>{msg.text}</div>}
        <div className="sp-btns">
          {open && <button type="button" className="sp-btn ok" disabled={busy === o.id} onClick={() => run(o, { action: 'receive', received: [] }, 'Đã nhận đủ ✓')}>✅ Nhận đủ</button>}
          {open && <button type="button" className="sp-btn" disabled={busy === o.id} onClick={() => setSheet({ kind: 'receive', order: o })}>Nhận thiếu…</button>}
          {open && <button type="button" className="sp-btn" onClick={() => setSheet({ kind: 'add', order: o })}>➕ Thêm món</button>}
          {open && sup && <button type="button" className="sp-btn zalo" onClick={() => onShare(sup, o, o.items, { note: o.note || '' })}>📤 Gửi lại Zalo</button>}
          {isAdmin && !o.cancelled_at && <button type="button" className="sp-btn" onClick={() => setSheet({ kind: 'price', order: o })}>Sửa giá</button>}
        </div>
        {open && (canManage || o.created_by === me.id) && <div style={{ textAlign: 'right' }}>
          <button type="button" className="sp-btn ghost bad" disabled={busy === o.id} onClick={() => run(o, { action: 'cancel' }, 'Đã huỷ đơn')}>Huỷ đơn</button>
        </div>}
        <History log={o.log} />
      </div>;
    })}
    {sheet?.kind === 'receive' && <ReceiveSheet order={sheet.order} onClose={() => setSheet(null)}
      onSave={received => run(sheet.order, { action: 'receive', received }, 'Đã nhận ✓').then(ok => ok && setSheet(null))} />}
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
      return <li key={i} className="sp-line">
        <div className="sp-row between"><span className="name">{l.name}</span><span className="sp-money">{hasPrice(l) ? money(lineAmount(l)) : <span className="nop">chưa giá</span>}</span></div>
        <div className="meta">
          {qtyText(l.qty)} {l.unit}{hasPrice(l) ? ` × ${money(l.price)}` : ''}
          {ch !== 0 && <span className={ch > 0 ? 'sp-up' : 'sp-down'}> {changeText(ch)}</span>}
          {l.received_qty !== null && l.received_qty !== undefined && <span className="short"> · nhận {qtyText(lineQty(l))}</span>}
        </div>
        {later && <span className="added">➕ {l.added_by} thêm {shortTime(l.added_at)}</span>}
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


function ReceiveSheet({ order, onClose, onSave }) {
  const [got, setGot] = useState(() => order.items.map(l => qtyText(l.qty)));
  const [busy, setBusy] = useState(false);
  return <Sheet title="Nhận hàng" onClose={onClose}>
    <p className="sp-mute">Sửa số đã nhận ở món bị thiếu (0 = không giao). Món nào đủ thì để nguyên.</p>
    <ul className="sp-cart">{order.items.map((l, i) => <li key={i}>
      <span className="nm">{l.name}<br /><span className="sp-mute sp-small">gọi {qtyText(l.qty)} {l.unit}</span></span>
      <div className="sp-qty"><input inputMode="decimal" aria-label={`Đã nhận ${l.name}`} value={got[i]} onChange={e => setGot(got.map((g, j) => (j === i ? e.target.value.replace(/[^\d.,]/g, '').slice(0, 7) : g)))} /></div>
      <span className="sp-mute">{l.unit}</span>
    </li>)}</ul>
    <div className="sp-btns"><button type="button" className="sp-btn ok block" disabled={busy}
      onClick={async () => { setBusy(true); await onSave(got.map(g => g.replace(',', '.'))); setBusy(false); }}>Lưu đã nhận</button></div>
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

/* ---------------- Tab Công nợ (chủ quán) ---------------- */
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
    <p className="sp-mute">Tính theo ngày quán nhận hàng. ▲ giá tăng / ▼ giá giảm so với lần trước.</p>
    {error && <div className="sp-msg err">{error}</div>}
    {!data && !error && <p className="sp-empty">Đang tải…</p>}
    {data && !data.stats.length && <p className="sp-empty">Chưa có đơn đã nhận.</p>}
    {data?.stats.map(g => <Fold key={`${period}-${g.key}`} className="sp-card" plain initial={g === data.stats[0]}
      head={<span className="sp-row between"><span className="sp-b">{label(g.key)}</span><span className="sp-money">{money(g.total)}</span></span>}>
      <table className="sp-stat" style={{ marginTop: 8 }}>
        <thead><tr><th>Món</th><th>SL</th><th>Giá</th><th>Tiền</th></tr></thead>
        <tbody>{g.items.map(it => <tr key={it.name}>
          <td>{it.name}{it.suppliers.length > 0 && <div className="sp-mute sp-small">{it.suppliers.join(', ')}</div>}</td>
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
    <div className="sp-card"><div className="sp-picks">
      {[...data.items].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name, 'vi')).map(i => <button key={i.id} type="button" className="sp-pick" style={i.active ? undefined : { opacity: 0.5, textDecoration: 'line-through' }}
        onClick={() => setItemEdit({ ...i, unit: i.unit || '', default_qty: i.default_qty ? fmtQty(Number(i.default_qty)) : '' })}>
        {i.name}<small>{i.default_qty ? `${fmtQty(Number(i.default_qty))} ` : ''}{i.unit || ''}</small>
      </button>)}
    </div>
    <div className="sp-btns">
      <button type="button" className="sp-btn" onClick={() => setItemEdit({ name: '', unit: '', default_qty: '', active: true })}>➕ Một món</button>
      <button type="button" className="sp-btn main" onClick={() => setBulk('')}>📋 Thêm nhiều món</button>
    </div>
    <p className="sp-mute sp-small" style={{ marginTop: 8 }}>Số nhỏ dưới tên = số lượng mỗi lần nhân viên bấm món. Bấm món để sửa / ẩn. Nhân viên gõ món mới khi gọi thì món đó tự vào danh sách.</p></div>
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
    </Sheet>}
  </>;
}
