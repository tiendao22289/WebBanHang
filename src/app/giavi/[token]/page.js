'use client';
/**
 * Trang của chủ gia vị: mở bằng link quán gửi qua Zalo (/giavi/<mã>?don=<đơn>), không cần tài khoản.
 * Thấy tổng đã giao / quán đã trả / quán còn thiếu, đơn cần soạn (điền / sửa giá, báo đã soạn xong, ghi chú),
 * đơn đã giao, lịch sử từng đơn (ai gọi, ai thêm món, đổi giá, nhận hàng — giờ nào) và các lần quán trả tiền.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { STATE_LABELS, addedLater, lineAmount, lineCheck, lineQty, logLine, missingPrices, orderState, orderTotal, shortTime, supplierCanPrice, supplierOrderStats } from '@/lib/spiceOrders.mjs';
import { CheckBadge, DayCard, DayGroups, vnToday } from '../../admin/spices/SpiceShared';
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
  const [tab, setTab] = useState(null);
  const [addReq, setAddReq] = useState(null); // { id, n } — nút + nổi bấm: mở ô thêm món của đơn id // null = tự chọn: có đơn cần soạn thì 'open', không thì 'done'
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

  // Tích nhiều đơn → đánh dấu đã / chưa thanh toán một lần.
  async function bulkPaid(ids, paid) {
    setNotice(null);
    try {
      const r = await fetch('/api/spice-supplier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token, ids, paid }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setNotice({ id: 'bulk', err: true, text: j.error || 'Không lưu được.' }); return false; }
      setNotice({ id: 'bulk', text: `Đã đánh dấu ${j.changed} đơn ${paid ? 'đã thanh toán' : 'chưa thanh toán'} (${money(j.total)}) ✓` });
      await load();
      return true;
    } catch { setNotice({ id: 'bulk', err: true, text: 'Mạng yếu, bấm lại.' }); return false; }
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
  const singleDone = !!(single && (single.received_at || single.cancelled_at));
  const view = tab || (single ? (singleDone ? 'done' : 'open') : groups.open.length ? 'open' : 'done');
  // Đơn đang làm: nút Lưu giá / Đã soạn xong nằm cố định dưới đáy màn hình (không phải kéo tìm). Ưu tiên đơn đang gõ giá,
  // rồi đơn mở từ link, rồi đơn duy nhất đang chờ soạn.
  const editable = o => !o.cancelled_at && o.items.some((_, i) => supplierCanPrice(o, i));
  const draftId = Object.keys(drafts)[0];
  const active = (draftId && data.orders.find(o => o.id === draftId))
    || (single && editable(single) ? single : null)
    || (!single && view === 'open' && groups.open.length === 1 ? groups.open[0] : null);
  const card = order => <OrderCard key={order.id} order={order} draft={drafts[order.id]} focus={order.id === focusId} busy={busy === order.id} inBar={active?.id === order.id} addReq={addReq?.id === order.id ? addReq.n : 0}
    notice={notice?.id === order.id ? notice : null} onPrice={setPrice} onNote={setNote} onSave={save} onUndo={() => drop(order.id)}
    onAdd={(o, add) => post(o, { add }, `Đã thêm ${add.length} món ✓ Quán sẽ thấy khi nhận hàng.`)}
    onPaid={(o, paid) => post(o, { paid }, paid ? 'Đã đánh dấu: đã thanh toán ✓' : 'Đã đánh dấu: chưa thanh toán')} />;
  // Tổng với quán: một thẻ gọn — số quán còn thiếu to bên trái, đã giao / đã trả nhỏ bên phải.
  const tiles = <div className="sp-sumbar">
    <div className="main">
      <div className="k">{s.owed < 0 ? 'Quán trả dư' : 'Quán còn thiếu'}</div>
      <div className={`v ${s.owed > 0 ? 'owe' : 'ok'}`}>{money(Math.abs(s.owed))}</div>
    </div>
    <div className="side">
      <div><span>Đã giao</span><b>{money(s.delivered)}</b></div>
      <div><span>Quán đã trả</span><b className="paid">{money(s.paid)}</b></div>
    </div>
  </div>;
  let bar = null;
  if (active && view !== 'stats' && view !== 'days') {
    const d = drafts[active.id];
    const items = active.items.map((l, i) => (d && i in d.prices ? { ...l, price: d.prices[i] === '' ? null : Number(d.prices[i]) } : l));
    const miss = missingPrices(items);
    const isBusy = busy === active.id;
    const shown = single ? single.id === active.id : (active.received_at ? view === 'done' : view === 'open');
    const goTo = () => {
      setTab(active.received_at ? 'done' : 'open');
      setTimeout(() => document.getElementById(`don-${active.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    };
    const canAdd = !active.received_at && !active.cancelled_at;
    bar = <div className="sp-bar sp-actbar">

      <div className="sp-bar-in col">
      <div className="sp-row between sp-small">
        <span className="sp-mute">Đơn {shortTime(active.created_at)}{d ? <b className="sp-dirty"> · chưa lưu</b> : ''}{miss ? <span className="nop"> · {miss} món chưa giá</span> : ''}</span>
        <span className="sp-money">{money(orderTotal(items))}</span>
      </div>
      <div className="sp-row sp-actbtns">
        {canAdd && <button type="button" className="sp-fab" aria-label="Thêm món quán gọi thiếu"
        onClick={() => { if (!shown) setTab('open'); setAddReq(r => ({ id: active.id, n: (r?.n || 0) + 1 })); }}>
        <span aria-hidden="true">+</span></button>}
        {!shown && <button type="button" className="sp-btn" onClick={goTo}>Tới đơn</button>}
        {d && <button type="button" className="sp-btn" disabled={isBusy} onClick={() => drop(active.id)}>Bỏ</button>}
        {d && <button type="button" className="sp-btn main" disabled={isBusy} onClick={() => save(active, false)}>{isBusy ? 'Đang lưu…' : 'Lưu giá'}</button>}
        {!active.received_at && !active.priced_at && <button type="button" className="sp-btn ok" disabled={isBusy} onClick={() => save(active, true)}>{d ? '✅ Xong' : '✅ Soạn xong'}</button>}
        {!d && (active.received_at || active.priced_at) && <span className="sp-mute sp-small sp-grow" style={{ textAlign: 'right' }}>{active.priced_at && !active.received_at ? '✅ Đã báo soạn xong, chờ quán nhận' : 'Sửa giá ô nào thì bấm Lưu giá'}</span>}
      </div>
    </div></div>;
  }
  const tabs = [['open', '📦', 'Cần soạn', groups.open.length], ['done', '✅', 'Đã giao', null], ['days', '📅', 'Đối soát', null], ['stats', '📊', 'Thống kê', null]];
  return <div className="sp-page"><div className="sp">
    <div className="sp-head"><h1>🧂 Đơn gia vị</h1><span className="sp-mute sp-small">{data.supplier.name}</span></div>
    {error && <div className="sp-msg err">{error}</div>}
    {tiles}
    <div className="sp-seg four" role="tablist">
      {tabs.map(([k, icon, label, n]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setTab(k)}>
        <span aria-hidden="true">{icon}</span>{label}{n > 0 && <i className="dot">{n}</i>}
      </button>)}
    </div>

    {view === 'open' && <>
      {groups.open.length > 0 && <p className="sp-tip">Điền giá từng món → bấm <b>✅ Soạn xong</b>. Giá cũ đã điền sẵn, sửa được.</p>}
      {single && !singleDone
        ? <>{card(single)}{groups.open.length > 1 && <button type="button" className="sp-btn block" onClick={() => setShowAll(true)}>Xem {groups.open.length - 1} đơn khác đang chờ soạn</button>}</>
        : groups.open.length ? groups.open.map(card) : <p className="sp-empty">Chưa có đơn mới. Quán gọi là đơn hiện ở đây.</p>}
    </>}

    {view === 'done' && <>
      {single && singleDone
        ? <>{single.cancelled_at && <div className="sp-msg err">Đơn này quán đã huỷ lúc {shortTime(single.cancelled_at)} — không giao, không tính tiền.</div>}
          {card(single)}<button type="button" className="sp-btn block" onClick={() => setShowAll(true)}>Xem tất cả đơn đã giao</button></>
        : groups.done.length ? <DayGroups orders={groups.done} today={vnToday()} render={card} /> : <p className="sp-empty">Chưa có đơn quán đã nhận.</p>}
      {groups.cancelled.length > 0 && !(single && singleDone) && <Fold className="sp-dayfold" plain head={<span className="sp-day-head"><span className="sp-b">🗑 Đơn quán đã huỷ</span><span className="sp-mute"> · {groups.cancelled.length} đơn · không tính tiền</span></span>}>
        <div className="sp-dayfold-in">{groups.cancelled.map(card)}</div></Fold>}
    </>}

    {view === 'days' && <>
      <p className="sp-mute sp-small" style={{ margin: '0 0 8px' }}>Mỗi ngày: quán nhận đủ / thiếu / dư / sai món nào, tiền ngày đó và quán còn nợ tới hết ngày.</p>
      {data.days?.length ? data.days.map((d, i) => <DayCard key={d.date} day={d} initial={i === 0} />) : <p className="sp-empty">Chưa có ngày nào.</p>}
    </>}

    {view === 'stats' && <SupplierStats history={data.history || []} payments={data.payments} busyId={busy} notice={notice}
      onPaid={(o, paid) => post(o, { paid }, paid ? 'Đã đánh dấu: đã thanh toán ✓' : 'Đã đánh dấu: chưa thanh toán')} onBulk={bulkPaid} />}
    <p className="sp-mute sp-small" style={{ textAlign: 'center', marginTop: 20 }}>Trang tự cập nhật. Lưu link này để mở lại lần sau.</p>
  </div>
  {bar}
  </div>;
}

function OrderCard({ order, draft, focus, busy, inBar = false, addReq = 0, notice, onPrice, onNote, onSave, onUndo, onAdd, onPaid }) {
  const [adding, setAdding] = useState(null); // [{ name, qty, unit, price }] đang thêm
  const addRef = useRef(null);
  // Bấm nút + nổi: mở ô thêm món của đơn này và cuộn tới, con trỏ vào ô tên món.
  useEffect(() => {
    if (!addReq) return;
    setAdding(a => a || [{ name: '', qty: '1', unit: '', price: '' }]);
    setTimeout(() => { addRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); addRef.current?.querySelector('input')?.focus({ preventScroll: true }); }, 60);
  }, [addReq]);
  const state = orderState(order);
  const open = !order.cancelled_at && !order.received_at;
  // Đơn đã nhận / đã huỷ: gọn — đầu thẻ có tóm tắt đủ / thiếu / dư / sai, bấm mới hiện từng món (đơn mở từ link thì hiện sẵn).
  const [showLines, setShowLines] = useState(() => !order.cancelled_at && (open || focus || order.items.some((_, i) => supplierCanPrice(order, i))));
  const received = !!order.received_at && !order.cancelled_at;
  const counts = received ? order.items.reduce((m, l) => { const c = lineCheck(l).check; m[c] = (m[c] || 0) + 1; return m; }, {}) : {};
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
    {received && onPaid && <div className="sp-row between sp-paidrow">
      <span className="sp-small">{order.supplier_paid_at ? <span className="sp-ok-t">💵 Đã thanh toán · {shortTime(order.supplier_paid_at)}</span> : <span className="sp-mute">Chưa thanh toán</span>}</span>
      <button type="button" className={`sp-paybtn ${order.supplier_paid_at ? 'paid' : ''}`} disabled={busy} onClick={() => onPaid(order, !order.supplier_paid_at)}>
        {order.supplier_paid_at ? '✓ Đã TT' : 'Đánh dấu đã TT'}</button>
    </div>}
    {received && <div className="sp-sum">
      {[['ok', '✅', 'đủ'], ['short', '➖', 'thiếu'], ['over', '➕', 'dư'], ['wrong', '⚠️', 'sai'], ['skip', '🚫', 'không lấy']].filter(([k]) => counts[k])
        .map(([k, ic, label]) => <span key={k} className={`sp-check ${k}`}>{ic} {counts[k]} {label}</span>)}
    </div>}
    {!showLines && <button type="button" className="sp-more" onClick={() => setShowLines(true)}>
      <span>Xem {order.items.length} món</span><span className="sp-money">{money(total)}</span></button>}
    {showLines && <ul className="sp-lines">
      {items.map((l, i) => {
        const editable = supplierCanPrice(order, i);
        const later = addedLater(order, l);
        const value = draft && i in draft.prices ? draft.prices[i] : (hasPrice(order.items[i]) ? String(order.items[i].price) : '');
        const got = lineQty(l);
        const old = l.old_price !== null && l.old_price !== undefined ? l.old_price : null;
        if (!editable) {
          // Món đã chốt: một hàng tên · số — tiền; hàng nhỏ giá / đơn vị, nhãn thiếu / dư / sai (đủ thì không ghi cho gọn).
          const c = received ? lineCheck(order.items[i]) : null;
          const qty = c && c.check !== 'ok' ? `gọi ${qtyText(l.qty)} · nhận ${qtyText(got)} ${l.unit || ''}` : `${qtyText(l.qty)} ${l.unit || ''}`;
          return <li key={i} className={`sp-line tight${c && c.check !== 'ok' ? ` bad ${c.check}` : ''}`}>
            <div className="sp-row between"><span className="name">{l.name} <span className="q">{qty}</span></span>
              <span className="sp-money">{hasPrice(l) ? money(lineAmount(l)) : <span className="nop">chưa giá</span>}</span></div>
            <div className="meta">
              {hasPrice(l) && <span>{money(l.price)}/{l.unit || 'phần'}</span>}
              {hasPrice(l) && old !== null && l.price !== old && <span className={l.price > old ? 'sp-up' : 'sp-down'}> {l.price > old ? '▲' : '▼'}{money(Math.abs(l.price - old))}</span>}
              {l.by_supplier && <span className="sp-tag sup">🧺 bạn thêm</span>}
              {!l.by_supplier && later && <span className="sp-tag">➕ {l.added_by || 'NV'} thêm</span>}
            </div>
            {c && c.check !== 'ok' && <CheckBadge check={c.check} diff={c.diff} unit={l.unit} note={c.note} />}
          </li>;
        }
        // Món cần điền giá: một hàng — bên trái tên + số lượng (+ tiền khi có giá), bên phải ô giá.
        const up = hasPrice(l) && old !== null && l.price !== old;
        return <li key={i} className="sp-pline">
          <div className="info">
            <div className="name">{l.name}</div>
            <div className="sub">
              <b>{order.received_at ? `quán nhận ${qtyText(got)}` : qtyText(l.qty)} {l.unit}</b>
              {hasPrice(l) && <span className="amt"> = {money(lineAmount(l))}</span>}
              {up && <span className={l.price > old ? 'sp-up' : 'sp-down'}> {l.price > old ? '▲' : '▼'}{money(Math.abs(l.price - old))}</span>}
            </div>
            {old !== null && !up && <div className="hint">lần trước {money(old)}</div>}
            {l.by_supplier ? <span className="added sup">🧺 Bạn thêm {shortTime(l.added_at)}</span>
              : later && <span className="added">➕ {l.added_by || 'NV'} thêm {shortTime(l.added_at)}</span>}
          </div>
          <label className={`pin ${value === '' ? 'empty' : ''}`}>
            <input inputMode="numeric" enterKeyHint="next" placeholder="Giá" aria-label={`Giá 1 ${l.unit || 'phần'} ${l.name}`}
              value={withDots(value)} onChange={e => onPrice(order, i, e.target.value)} />
            <small>đ/{l.unit || 'phần'}</small>
          </label>
        </li>;
      })}
    </ul>}
    {showLines && <div className="sp-total"><span>Tổng{missing ? ` (còn ${missing} món chưa giá)` : ''}</span><span className="sp-money">{money(total)}</span></div>}
    {showLines && !open && (!focus || order.cancelled_at) && <button type="button" className="sp-btn ghost" onClick={() => setShowLines(false)}>Thu gọn</button>}
    {canEditAny
      ? <textarea className="sp-field sp-note-in" rows={1} placeholder="💬 Ghi chú cho quán" value={noteValue} onChange={e => onNote(order, e.target.value)} />
      : order.supplier_note && <div className="sp-note supplier">💬 Bạn ghi: {order.supplier_note}</div>}
    {open && !adding && !inBar && <button type="button" className="sp-addmini" aria-label="Thêm món quán gọi thiếu" onClick={() => setAdding([{ name: '', qty: '1', unit: '', price: '' }])}>
      <span aria-hidden="true">+</span> Thêm món</button>}
    {open && adding && <div className="sp-addbox" ref={addRef}>
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
    {canEditAny && !inBar && <div className="sp-btns small">
      {draft && <button type="button" className="sp-btn" disabled={busy} onClick={onUndo}>Bỏ sửa</button>}
      {draft && <button type="button" className="sp-btn main" disabled={busy} onClick={() => onSave(order, false)}>{busy ? 'Đang lưu…' : 'Lưu giá'}</button>}
      {open && !order.priced_at && <button type="button" className="sp-btn ok" disabled={busy} onClick={() => onSave(order, true)}>✅ Đã soạn xong</button>}
    </div>}
    <History log={order.log} />
  </div>;
}

const monthLabel = m => `Tháng ${m.slice(5)}/${m.slice(0, 4)}`;
const dayShort = d => d.split('-').reverse().slice(0, 2).join('/');
const vnDateOfIso = iso => new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 10);

/**
 * Thống kê của chủ gia vị: đơn quán đã nhận, tự đánh dấu đã thanh toán / chưa (bấm trên từng đơn), lọc theo đã / chưa và theo
 * tháng, số lượng + tiền từng món; cuối trang là các lần quán ghi đã trả tiền.
 */
function SupplierStats({ history, payments, busyId, notice, onPaid, onBulk }) {
  const [paid, setPaid] = useState('unpaid');
  const [month, setMonth] = useState('');
  const [picked, setPicked] = useState(() => new Set()); // đơn đang tích chọn
  const [bulkBusy, setBulkBusy] = useState(false);
  const months = [...new Set(history.map(o => (o.received_date || (o.cancelled_at ? vnDateOfIso(o.cancelled_at) : '')).slice(0, 7)).filter(Boolean))].sort().reverse();
  const range = month ? { from: `${month}-01`, to: `${month}-31` } : {};
  const st = supplierOrderStats(history, { paid, ...range });
  const canPick = paid === 'unpaid' || paid === 'paid' || paid === 'all';
  const pickable = st.orders.filter(o => !o.cancelled_at);
  const chosen = pickable.filter(o => picked.has(o.id));
  const chosenTotal = chosen.reduce((t, o) => t + orderTotal(o.items), 0);
  const toggle = id => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = pickable.length > 0 && chosen.length === pickable.length;
  const switchTo = k => { setPaid(k); setPicked(new Set()); };
  // Tích nhiều đơn → đánh dấu một lần. Đơn đang chọn đều chưa TT thì nút là "Đã thanh toán"; đều đã TT thì "Chưa thanh toán".
  const markPaid = !chosen.every(o => o.supplier_paid_at);
  const bulk = async () => {
    setBulkBusy(true);
    if (await onBulk(chosen.map(o => o.id), markPaid)) setPicked(new Set());
    setBulkBusy(false);
  };
  return <>
    <div className="sp-tiles two">
      <button type="button" className={`sp-tile owe ${paid === 'unpaid' ? 'sel' : ''}`} onClick={() => switchTo('unpaid')}>
        <div className="k">Chưa thanh toán · {st.unpaid.count} đơn</div><div className="v">{money(st.unpaid.total)}</div></button>
      <button type="button" className={`sp-tile paid ${paid === 'paid' ? 'sel' : ''}`} onClick={() => switchTo('paid')}>
        <div className="k">Đã thanh toán · {st.paid.count} đơn</div><div className="v">{money(st.paid.total)}</div></button>
    </div>
    <div className="sp-seg four" role="tablist">
      {[['unpaid', 'Chưa TT', st.unpaid.count], ['paid', 'Đã TT', st.paid.count], ['cancelled', 'Đã huỷ', st.cancelled.count], ['all', 'Tất cả', st.unpaid.count + st.paid.count]].map(([k, l, n]) =>
        <button key={k} type="button" role="tab" aria-selected={paid === k} className={paid === k ? 'on' : ''} onClick={() => switchTo(k)}>{l}<small>{n}</small></button>)}
    </div>
    {months.length > 0 && <div className="sp-picks" style={{ marginBottom: 10 }}>
      <button type="button" className={`sp-pick ${month === '' ? 'on' : ''}`} onClick={() => { setMonth(''); setPicked(new Set()); }}>Tất cả tháng</button>
      {months.map(m => <button key={m} type="button" className={`sp-pick ${month === m ? 'on' : ''}`} onClick={() => { setMonth(m); setPicked(new Set()); }}>{monthLabel(m)}</button>)}
    </div>}
    {paid === 'cancelled'
      ? <p className="sp-tip">Đơn quán đã huỷ — không giao, không tính tiền. Chỉ để xem lại.</p>
      : <p className="sp-tip">Tích chọn các đơn rồi bấm <b>Đã thanh toán</b> một lần, hoặc bấm nút trên từng đơn. Đây là sổ riêng của bạn, quán cũng thấy dấu này.</p>}

    <div className="sp-card">
      <div className="sp-row between">
        {canPick && pickable.length > 0
          ? <label className="sp-pickall"><input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(pickable.map(o => o.id)))} /> Chọn tất cả ({pickable.length})</label>
          : <span className="sp-b">Đơn ({st.count})</span>}
        <span className="sp-money">{money(st.total)}</span>
      </div>
      {notice?.err && (notice.id === 'bulk' || st.orders.some(o => o.id === notice.id)) && <div className="sp-msg err">{notice.text}</div>}
      {notice && !notice.err && notice.id === 'bulk' && <div className="sp-msg ok">{notice.text}</div>}
      {!st.orders.length && <p className="sp-empty" style={{ padding: 16 }}>Không có đơn.</p>}
      {st.orders.map(o => <div key={o.id} className={`sp-hist${picked.has(o.id) ? ' on' : ''}${o.cancelled_at ? ' cx' : ''}`}>
        <div className="sp-row">
          {canPick && !o.cancelled_at && <input type="checkbox" className="sp-check-in" aria-label={`Chọn đơn ${dayShort(o.received_date || '')}`} checked={picked.has(o.id)} onChange={() => toggle(o.id)} />}
          <div className="sp-grow" onClick={() => canPick && !o.cancelled_at && toggle(o.id)}>
            <div className="sp-b">{o.cancelled_at ? `Huỷ ${shortTime(o.cancelled_at)}` : dayShort(o.received_date || '')} · {money(orderTotal(o.items))}</div>
            <div className="sp-mute sp-small">{o.items.filter(l => o.cancelled_at || lineQty(l) > 0).map(l => `${l.name} ${qtyText(o.cancelled_at ? l.qty : lineQty(l))}${l.unit ? ` ${l.unit}` : ''}`).join(', ')}</div>
          </div>
          {o.cancelled_at
            ? <span className="sp-chip cancelled">Đã huỷ</span>
            : <button type="button" className={`sp-paybtn ${o.supplier_paid_at ? 'paid' : ''}`} disabled={busyId === o.id}
                onClick={() => onPaid(o, !o.supplier_paid_at)}>{o.supplier_paid_at ? '✓ Đã TT' : 'Chưa TT'}</button>}
        </div>
        {o.supplier_paid_at && !o.cancelled_at && <div className="sp-mute sp-small">Đánh dấu đã thanh toán {shortTime(o.supplier_paid_at)} · bấm lại nếu nhầm</div>}
      </div>)}
    </div>

    <div className="sp-card">
      <div className="sp-b" style={{ marginBottom: 6 }}>Số lượng từng món {paid === 'paid' ? '(đã TT)' : paid === 'unpaid' ? '(chưa TT)' : paid === 'cancelled' ? '(đơn đã huỷ)' : ''}{month ? ` · ${monthLabel(month)}` : ''}</div>
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

    {chosen.length > 0 && <div className="sp-bar sp-actbar"><div className="sp-bar-in col">
      <div className="sp-row between sp-small"><span className="sp-mute">Đã chọn <b>{chosen.length}</b> đơn</span><span className="sp-money">{money(chosenTotal)}</span></div>
      <div className="sp-row sp-actbtns">
        <button type="button" className="sp-btn" disabled={bulkBusy} onClick={() => setPicked(new Set())}>Bỏ chọn</button>
        <button type="button" className={`sp-btn ${markPaid ? 'ok' : 'main'}`} disabled={bulkBusy} onClick={bulk}>
          {bulkBusy ? 'Đang lưu…' : markPaid ? `✓ Đã thanh toán ${chosen.length} đơn` : `Chưa thanh toán ${chosen.length} đơn`}</button>
      </div>
    </div></div>}
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

