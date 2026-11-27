'use client';
/**
 * Trang của chủ gia vị: mở bằng link quán gửi qua Zalo (/giavi/<mã>?don=<đơn>), không cần tài khoản.
 * Thấy tổng đã giao / quán đã trả / quán còn thiếu, đơn cần soạn (điền / sửa giá, báo đã soạn xong, ghi chú),
 * đơn đã giao, lịch sử từng đơn (ai gọi, ai thêm món, đổi giá, nhận hàng — giờ nào) và các lần quán trả tiền.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { STATE_LABELS, addedLater, lineAmount, lineCheck, lineQty, logLine, missingPrices, orderState, orderTotal, shortTime, supplierCanPrice, supplierOrderStats } from '@/lib/spiceOrders.mjs';
import { CheckBadge, DayCard } from '../../admin/spices/SpiceShared';
import '../../admin/spices/spices.css';

const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const qtyText = q => String(Math.round((Number(q) || 0) * 1000) / 1000).replace('.', ',');
const digits = v => String(v ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 9);
const withDots = d => (d ? Number(d).toLocaleString('vi-VN') : '');
const hasPrice = l => l.price !== null && l.price !== undefined;

export default function SpiceSupplierPage() {
  return <Suspense fallback={null}><SupplierView /></Suspense>;
}

function SupplierView() {
  const { token } = useParams();
  const focusId = useSearchParams().get('don');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // drafts: { [orderId]: { prices: { [index]: 'chữ số' }, note } } — giá đang gõ, chưa lưu.
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const scrolled = useRef(false);
  // Link quán gửi (?don=…) chỉ mở đúng đơn đó; bấm "Xem tất cả đơn" mới hiện các đơn khác.
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState(null); // null = tự chọn: có đơn cần soạn thì 'open', không thì 'done'
  const dirty = Object.keys(drafts).length > 0;

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/spice-supplier?t=${encodeURIComponent(token)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'Không tải được.'); return; }
      setError(''); setData(j);
    } catch { setError('Mạng yếu, đang thử lại…'); }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  // Tự tải lại mỗi 30 giây khi đang mở trang và không gõ dở giá (thấy quán thêm món / đã nhận ngay).
  useEffect(() => {
    const tick = () => { if (!document.hidden && !dirty) load(); };
    const id = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load, dirty]);
  useEffect(() => {
    if (!dirty) return undefined;
    const stop = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', stop);
    return () => window.removeEventListener('beforeunload', stop);
  }, [dirty]);
  useEffect(() => {
    if (!data || scrolled.current || !focusId || !showAll) return;
    scrolled.current = true;
    setTimeout(() => document.getElementById(`don-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }, [data, focusId, showAll]);

  const groups = useMemo(() => {
    const list = data?.orders || [];
    return {
      open: list.filter(o => !o.cancelled_at && !o.received_at),
      done: list.filter(o => !o.cancelled_at && o.received_at),
      cancelled: list.filter(o => o.cancelled_at),
    };
  }, [data]);

  const setPrice = (order, index, value) => setDrafts(d => {
    const cur = d[order.id] || { prices: {} };
    return { ...d, [order.id]: { ...cur, prices: { ...cur.prices, [index]: digits(value) } } };
  });
  const setNote = (order, value) => setDrafts(d => ({ ...d, [order.id]: { prices: {}, ...d[order.id], note: value.slice(0, 300) } }));
  const drop = id => setDrafts(d => { const n = { ...d }; delete n[id]; return n; });

  // Gửi một việc khác (thêm món / đánh dấu đã nhận tiền) cho đơn. → true nếu lưu được.
  async function post(order, extra, okText) {
    setBusy(order.id); setNotice(null);
    try {
      const r = await fetch('/api/spice-supplier', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, id: order.id, updated_at: order.updated_at, ...extra }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setNotice({ id: order.id, err: true, text: j.error || 'Không lưu được.' }); if (r.status === 409) load(); return false; }
      setNotice({ id: order.id, text: okText });
      await load();
      return true;
    } catch { setNotice({ id: order.id, err: true, text: 'Mạng yếu, bấm lại.' }); return false; }
    finally { setBusy(''); }
  }

  async function save(order, done) {
    const draft = drafts[order.id] || { prices: {} };
    const prices = Object.entries(draft.prices).map(([index, v]) => ({ index: Number(index), price: v === '' ? null : Number(v) }));
    if (done) {
      const filled = order.items.filter((l, i) => (i in draft.prices ? draft.prices[i] !== '' : hasPrice(l)) || lineQty(l) <= 0).length;
      if (filled < order.items.length) { setNotice({ id: order.id, err: true, text: 'Còn món chưa điền giá (ô viền đỏ).' }); return; }
    }
    setBusy(order.id); setNotice(null);
    try {
      const r = await fetch('/api/spice-supplier', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: token, id: order.id, updated_at: order.updated_at, prices, done, ...('note' in draft ? { note: draft.note } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({ id: order.id, err: true, text: j.error || 'Không lưu được.' });
        if (r.status === 409) { drop(order.id); load(); }
        return;
      }
      drop(order.id);
      setNotice({ id: order.id, text: done ? 'Đã báo quán: hàng soạn xong ✓' : 'Đã lưu ✓' });
      await load();
    } catch { setNotice({ id: order.id, err: true, text: 'Mạng yếu, bấm lại.' }); }
    finally { setBusy(''); }
  }

  if (error && !data) return <div className="sp-page"><div className="sp"><h1>🧂 Đơn gia vị</h1><div className="sp-msg err">{error}</div>
    <button type="button" className="sp-btn block" onClick={load}>Thử lại</button></div></div>;
  if (!data) return <div className="sp-page"><div className="sp"><p className="sp-empty">Đang tải…</p></div></div>;

  const s = data.summary;
  const single = !showAll && focusId ? data.orders.find(o => o.id === focusId) : null;
  const card = order => <OrderCard key={order.id} order={order} draft={drafts[order.id]} focus={order.id === focusId} busy={busy === order.id}
    notice={notice?.id === order.id ? notice : null} onPrice={setPrice} onNote={setNote} onSave={save} onUndo={() => drop(order.id)}
    onAdd={(o, add) => post(o, { add }, `Đã thêm ${add.length} món ✓ Quán sẽ thấy khi nhận hàng.`)} />;
  const tiles = <>
    <div className="sp-tiles sup">
      <div className="sp-tile"><div className="k">Đã giao</div><div className="v">{money(s.delivered)}</div></div>
      <div className="sp-tile paid"><div className="k">Quán đã trả</div><div className="v">{money(s.paid)}</div></div>
      <div className="sp-tile owe"><div className="k">Quán còn thiếu</div><div className="v">{money(Math.max(0, s.owed))}</div></div>
    </div>
    {s.owed < 0 && <p className="sp-mute">Quán đã trả dư {money(-s.owed)}.</p>}
  </>;
  const bar = dirty && <div className="sp-bar"><div className="sp-bar-in"><span className="sp-grow sp-b">Có giá chưa lưu</span>
    <button type="button" className="sp-btn main" onClick={() => {
      const id = Object.keys(drafts)[0];
      const order = data.orders.find(o => o.id === id);
      setTab(order?.received_at ? 'done' : 'open');
      setTimeout(() => document.getElementById(`don-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }}>Tới đơn đang sửa</button></div></div>;
  if (single) return <div className="sp-page"><div className="sp">
    <h1>🧂 Đơn quán gọi</h1>
    <p className="sp-sub">Chào {data.supplier.name}. Điền giá từng món rồi bấm <b>Đã soạn xong</b>.</p>
    {error && <div className="sp-msg err">{error}</div>}
    {card(single)}
    <h2>Tổng với quán</h2>
    {tiles}
    {data.days?.[0] && <><h2>📅 Đối soát ngày gần nhất</h2><DayCard day={data.days[0]} /></>}
    {(groups.open.length > 1 || groups.done.length > 0) && <button type="button" className="sp-btn block" onClick={() => { setShowAll(true); setTab(null); window.scrollTo(0, 0); }}>
      Xem tất cả đơn của bạn{groups.open.length > 1 ? ` (${groups.open.length - (single.received_at || single.cancelled_at ? 0 : 1)} đơn khác đang chờ)` : ''}
    </button>}
  </div>{bar}</div>;
  const view = tab || (groups.open.length ? 'open' : 'done');
  const tabs = [['open', '📦', 'Cần soạn', groups.open.length], ['done', '✅', 'Đã giao', null], ['days', '📅', 'Đối soát', null], ['stats', '📊', 'Thống kê', null]];
  return <div className="sp-page"><div className="sp">
    <div className="sp-head"><h1>🧂 Đơn gia vị</h1><span className="sp-mute sp-small">{data.supplier.name}</span></div>
    {error && <div className="sp-msg err">{error}</div>}
    {tiles}
    <div className="sp-tabs grid four" role="tablist">
      {tabs.map(([k, icon, label, n]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={`sp-tab ${view === k ? 'on' : ''}`} onClick={() => setTab(k)}>
        <span className="ic" aria-hidden="true">{icon}</span>{label}{n > 0 && <span className="sp-count">{n}</span>}
      </button>)}
    </div>

    {view === 'open' && <>
      {groups.open.length > 0 && <p className="sp-mute sp-small" style={{ margin: '0 0 8px' }}>Điền giá từng món (giá lần trước đã điền sẵn, sửa được) rồi bấm <b>✅ Đã soạn xong</b>.</p>}
      {groups.open.length ? groups.open.map(card) : <p className="sp-empty">Chưa có đơn mới. Quán gọi là đơn hiện ở đây.</p>}
    </>}

    {view === 'done' && <>
      {groups.done.length ? groups.done.map(card) : <p className="sp-empty">Chưa có đơn quán đã nhận.</p>}
      {groups.cancelled.length > 0 && <Fold head={`Đơn quán đã huỷ (${groups.cancelled.length})`}>{groups.cancelled.map(card)}</Fold>}
    </>}

    {view === 'days' && <>
      <p className="sp-mute sp-small" style={{ margin: '0 0 8px' }}>Mỗi ngày: quán nhận đủ / thiếu / dư / sai món nào, tiền ngày đó và quán còn nợ tới hết ngày.</p>
      {data.days?.length ? data.days.map((d, i) => <DayCard key={d.date} day={d} initial={i === 0} />) : <p className="sp-empty">Chưa có ngày nào.</p>}
    </>}

    {view === 'stats' && <SupplierStats history={data.history || []} payments={data.payments} busyId={busy} notice={notice}
      onPaid={(o, paid) => post(o, { paid }, paid ? 'Đã đánh dấu: đã thanh toán ✓' : 'Đã đánh dấu: chưa thanh toán')} />}
    <p className="sp-mute sp-small" style={{ textAlign: 'center', marginTop: 20 }}>Trang tự cập nhật. Lưu link này để mở lại lần sau.</p>
  </div>
  {bar}
  </div>;
}

function OrderCard({ order, draft, focus, busy, notice, onPrice, onNote, onSave, onUndo, onAdd }) {
  const [adding, setAdding] = useState(null); // [{ name, qty, unit, price }] đang thêm
  const state = orderState(order);
  const open = !order.cancelled_at && !order.received_at;
  // Đơn đang gõ: tính lại tiền theo giá đang gõ.
  const items = order.items.map((l, i) => (draft && i in draft.prices ? { ...l, price: draft.prices[i] === '' ? null : Number(draft.prices[i]) } : l));
  const total = orderTotal(items);
  const missing = missingPrices(items);
  const canEditAny = !order.cancelled_at && order.items.some((_, i) => supplierCanPrice(order, i));
  const noteValue = draft && 'note' in draft ? draft.note : order.supplier_note || '';
  return <div id={`don-${order.id}`} className={`sp-card sp-order ${state} ${focus ? 'hl' : ''}`}>
    <div className="sp-row between">
      <div className="sp-b">Đơn {shortTime(order.created_at)}</div>
      <span className={`sp-chip ${state}`}>{STATE_LABELS[state]}</span>
    </div>
    <div className="sp-who">
      <span>🕘 Gọi · <b>{order.created_by_name || 'Nhân viên'}</b></span>
      {order.received_at && <span>📥 Nhận {shortTime(order.received_at)} · <b>{order.received_by_name}</b></span>}
      {order.cancelled_at && <span>✖ Huỷ {shortTime(order.cancelled_at)} · <b>{order.cancelled_by_name}</b></span>}
    </div>
    {order.note && <div className="sp-note staff">📝 Quán ghi: {order.note}</div>}
    <ul className="sp-lines">
      {items.map((l, i) => {
        const editable = supplierCanPrice(order, i);
        const later = addedLater(order, l);
        const value = draft && i in draft.prices ? draft.prices[i] : (hasPrice(order.items[i]) ? String(order.items[i].price) : '');
        const got = lineQty(l);
        const old = l.old_price !== null && l.old_price !== undefined ? l.old_price : null;
        return <li key={i} className="sp-line compact">
          <div className="sp-row between">
            <span className="name">{l.name}</span>
            <span className="sp-qtyb">{qtyText(l.qty)} {l.unit}</span>
          </div>
          {l.by_supplier ? <span className="added sup">🧺 Bạn tự thêm lúc {shortTime(l.added_at)}</span>
            : later && <span className="added">➕ {l.added_by || 'Nhân viên'} thêm lúc {shortTime(l.added_at)}</span>}
          {order.received_at && !order.cancelled_at && (() => { const c = lineCheck(order.items[i]); return <div>
            <CheckBadge check={c.check} diff={c.diff} unit={l.unit} note={c.note} />
            {c.check !== 'ok' && <span className="sp-mute sp-small"> quán nhận {qtyText(got)} {l.unit}</span>}
          </div>; })()}
          {editable
            ? <div className="sp-price">
                <span className="unit">Giá / {l.unit || 'phần'}</span>
                <input inputMode="numeric" enterKeyHint="next" placeholder="Nhập giá" aria-label={`Giá ${l.name}`} className={value === '' ? 'empty' : ''}
                  value={withDots(value)} onChange={e => onPrice(order, i, e.target.value)} />
                <span className="sp-money amt">{hasPrice(l) ? money(lineAmount(l)) : ''}</span>
              </div>
            : <div className="sp-row between meta">
                <span>{hasPrice(l) ? `${money(l.price)} / ${l.unit || 'phần'}` : <span className="nop">Chưa có giá</span>}</span>
                <span className="sp-money">{hasPrice(l) ? money(lineAmount(l)) : ''}</span>
              </div>}
          {old !== null && (editable || (hasPrice(l) && l.price !== old)) && <div className="meta">
            Lần trước {money(old)}
            {hasPrice(l) && l.price !== old && <span className={l.price > old ? 'sp-up' : 'sp-down'}> {l.price > old ? '▲' : '▼'} {money(Math.abs(l.price - old))}</span>}
          </div>}
        </li>;
      })}
    </ul>
    <div className="sp-total"><span>Tổng{missing ? ` (còn ${missing} món chưa giá)` : ''}</span><span className="sp-money">{money(total)}</span></div>
    {canEditAny
      ? <textarea className="sp-field" style={{ marginTop: 10 }} placeholder="Ghi chú cho quán (vd: hết sả, giao mai)" value={noteValue} onChange={e => onNote(order, e.target.value)} />
      : order.supplier_note && <div className="sp-note supplier">💬 Bạn ghi: {order.supplier_note}</div>}
    {open && !adding && <button type="button" className="sp-btn ghost" style={{ marginTop: 6 }} onClick={() => setAdding([{ name: '', qty: '1', unit: '', price: '' }])}>
      ➕ Thêm món quán gọi thiếu</button>}
    {open && adding && <div className="sp-addbox">
      <div className="sp-b">Thêm món (quán gọi thiếu)</div>
      <p className="sp-mute sp-small" style={{ margin: '2px 0 8px' }}>Quán sẽ thấy nhãn 🧺 "chủ gia vị tự thêm"; khi nhận, quán không cần thì bấm Không lấy và không tính tiền món đó.</p>
      {adding.map((a, k) => <div key={k} className="sp-addrow">
        <input className="sp-field" placeholder="Tên món" value={a.name} maxLength={60} onChange={e => setAdding(adding.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))} />
        <div className="sp-row" style={{ marginTop: 6 }}>
          <input className="sp-unit" inputMode="decimal" aria-label="Số lượng" placeholder="SL" value={a.qty} onChange={e => setAdding(adding.map((x, j) => (j === k ? { ...x, qty: e.target.value.replace(/[^\d.,]/g, '').slice(0, 7) } : x)))} />
          <input className="sp-unit" placeholder="kg, bó" value={a.unit} maxLength={20} onChange={e => setAdding(adding.map((x, j) => (j === k ? { ...x, unit: e.target.value } : x)))} />
          <input className="sp-field sp-grow" inputMode="numeric" placeholder="Giá / 1" value={withDots(a.price)} onChange={e => setAdding(adding.map((x, j) => (j === k ? { ...x, price: digits(e.target.value) } : x)))} />
          {adding.length > 1 && <button type="button" className="sp-x" aria-label="Bỏ dòng" onClick={() => setAdding(adding.filter((_, j) => j !== k))}>✕</button>}
        </div>
      </div>)}
      <button type="button" className="sp-btn ghost" onClick={() => setAdding([...adding, { name: '', qty: '1', unit: '', price: '' }])}>＋ Thêm dòng</button>
      <div className="sp-btns">
        <button type="button" className="sp-btn" onClick={() => setAdding(null)}>Thôi</button>
        <button type="button" className="sp-btn main" disabled={busy || !adding.some(a => a.name.trim())} onClick={async () => {
          const add = adding.filter(a => a.name.trim()).map(a => ({ name: a.name, unit: a.unit, qty: String(a.qty).replace(',', '.'), price: a.price }));
          if (await onAdd(order, add)) setAdding(null);
        }}>{busy ? 'Đang lưu…' : 'Lưu món thêm'}</button>
      </div>
    </div>}
    {notice && <div className={`sp-msg ${notice.err ? 'err' : 'ok'}`}>{notice.text}</div>}
    {canEditAny && <div className="sp-btns">
      {draft && <button type="button" className="sp-btn" disabled={busy} onClick={onUndo}>Bỏ sửa</button>}
      {draft && <button type="button" className="sp-btn main" disabled={busy} onClick={() => onSave(order, false)}>{busy ? 'Đang lưu…' : 'Lưu giá'}</button>}
      {open && !order.priced_at && <button type="button" className="sp-btn ok" disabled={busy} onClick={() => onSave(order, true)}>✅ Đã soạn xong</button>}
    </div>}
    <History log={order.log} />
  </div>;
}

const monthLabel = m => `Tháng ${m.slice(5)}/${m.slice(0, 4)}`;
const dayShort = d => d.split('-').reverse().slice(0, 2).join('/');

/**
 * Thống kê của chủ gia vị: đơn quán đã nhận, tự đánh dấu đã thanh toán / chưa (bấm trên từng đơn), lọc theo đã / chưa và theo
 * tháng, số lượng + tiền từng món; cuối trang là các lần quán ghi đã trả tiền.
 */
function SupplierStats({ history, payments, busyId, notice, onPaid }) {
  const [paid, setPaid] = useState('unpaid');
  const [month, setMonth] = useState('');
  const months = [...new Set(history.map(o => (o.received_date || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  const range = month ? { from: `${month}-01`, to: `${month}-31` } : {};
  const st = supplierOrderStats(history, { paid, ...range });
  return <>
    <div className="sp-tiles two">
      <button type="button" className={`sp-tile owe ${paid === 'unpaid' ? 'sel' : ''}`} onClick={() => setPaid('unpaid')}>
        <div className="k">Chưa thanh toán · {st.unpaid.count} đơn</div><div className="v">{money(st.unpaid.total)}</div></button>
      <button type="button" className={`sp-tile paid ${paid === 'paid' ? 'sel' : ''}`} onClick={() => setPaid('paid')}>
        <div className="k">Đã thanh toán · {st.paid.count} đơn</div><div className="v">{money(st.paid.total)}</div></button>
    </div>
    <div className="sp-seg" role="tablist">
      {[['unpaid', 'Chưa TT'], ['paid', 'Đã TT'], ['all', 'Tất cả']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={paid === k} className={paid === k ? 'on' : ''} onClick={() => setPaid(k)}>{l}</button>)}
    </div>
    {months.length > 0 && <div className="sp-picks" style={{ marginBottom: 10 }}>
      <button type="button" className={`sp-pick ${month === '' ? 'on' : ''}`} onClick={() => setMonth('')}>Tất cả tháng</button>
      {months.map(m => <button key={m} type="button" className={`sp-pick ${month === m ? 'on' : ''}`} onClick={() => setMonth(m)}>{monthLabel(m)}</button>)}
    </div>}
    <p className="sp-mute sp-small" style={{ margin: '0 0 8px' }}>Bấm nút trên từng đơn để đánh dấu <b>Đã thanh toán</b> hoặc <b>Chưa</b>. Đây là sổ riêng của bạn, quán cũng thấy dấu này.</p>

    <div className="sp-card">
      <div className="sp-row between"><span className="sp-b">Đơn ({st.count})</span><span className="sp-money">{money(st.total)}</span></div>
      {notice?.err && st.orders.some(o => o.id === notice.id) && <div className="sp-msg err">{notice.text}</div>}
      {!st.orders.length && <p className="sp-empty" style={{ padding: 16 }}>Không có đơn.</p>}
      {st.orders.map(o => <div key={o.id} className="sp-hist">
        <div className="sp-row between">
          <div className="sp-grow"><div className="sp-b">{dayShort(o.received_date || '')} · {money(orderTotal(o.items))}</div>
            <div className="sp-mute sp-small">{o.items.filter(l => lineQty(l) > 0).map(l => `${l.name} ${qtyText(lineQty(l))}${l.unit ? ` ${l.unit}` : ''}`).join(', ')}</div></div>
          <button type="button" className={`sp-paybtn ${o.supplier_paid_at ? 'paid' : ''}`} disabled={busyId === o.id}
            onClick={() => onPaid(o, !o.supplier_paid_at)}>{o.supplier_paid_at ? '✓ Đã TT' : 'Chưa TT'}</button>
        </div>
        {o.supplier_paid_at && <div className="sp-mute sp-small">Đánh dấu đã thanh toán {shortTime(o.supplier_paid_at)} · bấm lại nếu nhầm</div>}
      </div>)}
    </div>

    <div className="sp-card">
      <div className="sp-b" style={{ marginBottom: 6 }}>Số lượng từng món {paid === 'paid' ? '(đã TT)' : paid === 'unpaid' ? '(chưa TT)' : ''}{month ? ` · ${monthLabel(month)}` : ''}</div>
      {st.items.length ? <table className="sp-stat">
        <thead><tr><th>Món</th><th>SL</th><th>Lần</th><th>Tiền</th></tr></thead>
        <tbody>{st.items.map(it => <tr key={it.name}><td>{it.name}</td><td>{qtyText(it.qty)} {it.unit}</td><td>{it.orders}</td><td className="sp-money">{money(it.amount)}</td></tr>)}</tbody>
      </table> : <p className="sp-empty" style={{ padding: 16 }}>Chưa có.</p>}
    </div>

    <div className="sp-card">
      <div className="sp-b" style={{ marginBottom: 6 }}>Các lần quán ghi đã trả tiền</div>
      {payments.length ? <ul className="sp-log">{payments.map((p, i) => <li key={i}>
        <span className="t">{dayShort(p.paid_date)}</span>
        <span><span className="sp-money">{money(p.amount)}</span> · {p.method === 'transfer' ? 'chuyển khoản' : 'tiền mặt'}{p.note ? ` · ${p.note}` : ''}</span>
      </li>)}</ul> : <p className="sp-mute">Quán chưa ghi lần trả nào.</p>}
    </div>
  </>;
}

function History({ log }) {
  if (!log?.length) return null;
  return <Fold head={`🕘 Lịch sử đơn (${log.length})`}>
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

