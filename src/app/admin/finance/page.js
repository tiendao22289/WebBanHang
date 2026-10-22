'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, PiggyBank, RefreshCw, Trash2, X } from 'lucide-react';
import './finance.css';

const money = value => `${Math.round(Number(value || 0)).toLocaleString('vi-VN')}đ`;
const dayLabel = date => {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][d.getUTCDay()];
  return `${wd}, ${date.slice(8, 10)}/${date.slice(5, 7)}`;
};
const clock = value => new Date(value).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
const vnToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const digits = value => String(value || '').replace(/\D/g, '');
// Sổ bắt đầu từ tháng 10/2026 — không lùi về trước nữa.
const FIRST_MONTH = '2026-10';
const shiftMonth = (month, step) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + step, 1));
  return d.toISOString().slice(0, 7);
};

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Không kết nối được máy chủ.'), { result });
  return result;
}

const KIND_LABEL = { drink: 'Nước ngọt / bia', salary: 'Lương', fixed: 'Chi cố định', custom: 'Chi khác' };
const NEW = '__new';

// Tên hiển thị của 1 khoản đã nhập: loại lương / mục cố định / tên tab tự tạo.
function entryTitle(entry, categories = []) {
  const own = categories.find(c => c.id === entry.category);
  if (entry.kind === 'salary') return `${own?.name || 'Lương'}: ${entry.label}`;
  if (entry.kind === 'custom') return own && entry.label !== own.name ? `${own.name}: ${entry.label}` : (own?.name || entry.label);
  if (entry.kind === 'fixed') return entry.label;
  const kind = KIND_LABEL[entry.kind] || '';
  return !entry.label || entry.label === kind ? kind : `${kind}: ${entry.label}`;
}

async function post(body) {
  return api('/api/admin/finance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Ô thêm mục / tab mới ngay trong form (không dùng prompt — cần chọn theo ngày/tháng).
function NewCategory({ scope, onDone, onCancel }) {
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('daily');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    setBusy(true); setError('');
    try {
      const { category } = await post({ action: 'add_category', scope, name, schedule });
      onDone(category);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const title = scope === 'tab' ? 'Tên tab mới' : scope === 'salary' ? 'Tên loại lương mới' : 'Tên mục chi cố định mới';
  const example = scope === 'tab' ? 'VD: Gas, Sửa chữa, Quảng cáo' : scope === 'salary' ? 'VD: Thưởng, Tạm ứng, Phụ cấp' : 'VD: Tiền rác, Thuế, Wifi';
  return <div className="fin-new">
    <label>{title}<input value={name} onChange={e => setName(e.target.value)} placeholder={example} maxLength={40} autoFocus
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} /></label>
    {scope === 'tab' && <div className="fin-choice" role="radiogroup" aria-label="Cách nhập">
      {[['daily', 'Nhập theo ngày'], ['monthly', 'Nhập theo tháng']].map(([key, text]) =>
        <button key={key} type="button" role="radio" aria-checked={schedule === key} className={schedule === key ? 'active' : ''}
          onClick={() => setSchedule(key)}>{text}</button>)}
    </div>}
    {scope === 'tab' && <p className="fin-hint">{schedule === 'monthly' ? 'Nhập 1 lần cho cả tháng, tự chia đều cho từng ngày (như tiền nhà).' : 'Nhập vào đúng ngày phát sinh (như tiền gas, sửa chữa).'}</p>}
    {error && <p className="fin-error">{error}</p>}
    <div className="fin-new-actions">
      <button type="button" className="fin-ghost" onClick={onCancel}>Huỷ</button>
      <button type="button" className="fin-primary" disabled={busy || !name.trim()} onClick={create}>{busy ? 'Đang lưu...' : 'Lưu'}</button>
    </div>
  </div>;
}

function AddEntryForm({ data, month, onSaved }) {
  // Mục/tab vừa tạo được giữ tạm ở đây cho tới khi danh sách tải lại xong —
  // không thì form chọn tab mới khi server chưa trả về, mất tên tab.
  const [created, setCreated] = useState([]);
  const loaded = data?.categories || [];
  const categories = [...loaded, ...created.filter(c => !loaded.some(x => x.id === c.id))];
  const active = scope => categories.filter(c => c.scope === scope && !c.archived);
  const tabs = active('tab');
  const [kind, setKind] = useState('drink'); // 'drink' | 'salary' | 'fixed' | 'tab:<id>'
  const [date, setDate] = useState(vnToday());
  const [label, setLabel] = useState('');
  const [fixedCategory, setFixedCategory] = useState('rent');
  const [salaryCategory, setSalaryCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(null); // 'tab' | 'salary' | 'fixed'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const tab = kind.startsWith('tab:') ? categories.find(c => c.id === kind.slice(4)) : null;
  // Tab đã bị ẩn (ở máy khác) → quay về tab mặc định.
  useEffect(() => { if (kind.startsWith('tab:') && data && (!tab || tab.archived)) setKind('drink'); }, [kind, tab, data]);
  const monthly = kind === 'fixed' || tab?.schedule === 'monthly';
  const kindName = (tab ? tab.name : KIND_LABEL[kind]) || '';

  function choose(next) {
    if (next !== kind) setLabel('');
    setKind(next); setAdding(null); setError(''); setSaved('');
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError(''); setSaved('');
    try {
      const { entry } = await post({
        action: 'add', kind: tab ? 'custom' : kind, entry_date: date, month, amount: Number(digits(amount)), note,
        category: tab ? tab.id : kind === 'fixed' ? fixedCategory : kind === 'salary' ? (salaryCategory || undefined) : undefined,
        label: kind === 'drink' ? (label || 'Nước ngọt / bia') : label,
      });
      setAmount(''); setNote(''); if (kind !== 'drink') setLabel('');
      setSaved(`✓ Đã thêm ${entryTitle(entry, categories)} · ${money(entry.amount)}`);
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function archive(category, after) {
    if (!confirm(`Ẩn "${category.name}"? Các khoản đã nhập vẫn được giữ và vẫn tính vào sổ.`)) return;
    try { await post({ action: 'archive_category', id: category.id }); after(); onSaved(); } catch (err) { alert(err.message); }
  }

  const ownFixed = active('fixed');
  const ownSalary = active('salary');
  const selectedOwn = kind === 'fixed' ? ownFixed.find(c => c.id === fixedCategory) : kind === 'salary' ? ownSalary.find(c => c.id === salaryCategory) : null;

  return <form className="fin-form" onSubmit={save}>
    <div className="fin-tabs" role="tablist">
      {['drink', 'salary', 'fixed'].map(k => <button key={k} type="button" role="tab" aria-selected={kind === k}
        className={kind === k ? 'active' : ''} onClick={() => choose(k)}>{KIND_LABEL[k]}</button>)}
      {tabs.map(t => <button key={t.id} type="button" role="tab" aria-selected={kind === `tab:${t.id}`}
        className={kind === `tab:${t.id}` ? 'active' : ''} onClick={() => choose(`tab:${t.id}`)}>{t.name}</button>)}
      <button type="button" className="fin-tab-add" onClick={() => { setAdding(adding === 'tab' ? null : 'tab'); setError(''); }}>+ Thêm tab</button>
    </div>

    {adding === 'tab' && <NewCategory scope="tab" onCancel={() => setAdding(null)}
      onDone={category => { setCreated(prev => [...prev, category]); setAdding(null); onSaved(); choose(`tab:${category.id}`); }} />}

    <div className="fin-fields">
      {kind === 'fixed' && <label>Mục<select value={fixedCategory} onChange={e => e.target.value === NEW ? setAdding('fixed') : setFixedCategory(e.target.value)}>
        {(data?.fixedCategories || []).map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        {ownFixed.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value={NEW}>+ Thêm mục mới...</option>
      </select></label>}
      {kind === 'salary' && <label>Loại<select value={salaryCategory} onChange={e => e.target.value === NEW ? setAdding('salary') : setSalaryCategory(e.target.value)}>
        <option value="">Lương</option>
        {ownSalary.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value={NEW}>+ Thêm loại lương...</option>
      </select></label>}
      {!monthly && <label>Ngày<input type="date" value={date} min={data?.startDate} max={vnToday()} onChange={e => setDate(e.target.value)} required /></label>}
      {kind === 'salary' && <label>Nhân viên
        <input list="fin-staff" value={label} onChange={e => setLabel(e.target.value)} placeholder="Tên nhân viên" required />
        <datalist id="fin-staff">{(data?.staff || []).map(name => <option key={name} value={name} />)}</datalist>
      </label>}
      {(kind === 'drink' || tab) && <label>Nội dung<input value={label} onChange={e => setLabel(e.target.value)} placeholder={tab ? tab.name : 'Nước ngọt / bia'} /></label>}
      <label>Số tiền<input inputMode="numeric" value={amount ? Number(digits(amount)).toLocaleString('vi-VN') : ''}
        onChange={e => setAmount(digits(e.target.value))} placeholder="0" enterKeyHint="done" required /></label>
      <label className="fin-wide">Ghi chú<input value={note} onChange={e => setNote(e.target.value)} placeholder="Không bắt buộc" /></label>
    </div>

    {(adding === 'fixed' || adding === 'salary') && <NewCategory scope={adding} onCancel={() => setAdding(null)}
      onDone={category => {
        const scope = adding;
        setCreated(prev => [...prev, category]); setAdding(null); onSaved();
        if (scope === 'fixed') setFixedCategory(category.id); else setSalaryCategory(category.id);
      }} />}

    {monthly && <p className="fin-hint">Ghi cho cả tháng {month.slice(5)}/{month.slice(0, 4)}, tự chia đều cho từng ngày.</p>}
    {error && <p className="fin-error">{error}</p>}
    {saved && <p className="fin-saved" role="status">{saved}</p>}
    <button className="fin-primary" disabled={busy}>{busy ? 'Đang lưu...' : `Thêm ${kindName.toLowerCase()}`}</button>
    {(tab || selectedOwn) && <button type="button" className="fin-link" onClick={() => tab
      ? archive(tab, () => choose('drink'))
      : archive(selectedOwn, () => kind === 'fixed' ? setFixedCategory('rent') : setSalaryCategory(''))}>
      Ẩn {tab ? `tab "${tab.name}"` : `mục "${selectedOwn.name}"`}
    </button>}
  </form>;
}

// Chênh lệch chốt sổ: dương = thừa, âm = thiếu so với sổ.
const diffText = diff => diff === 0 ? 'Khớp ✓' : diff > 0 ? `Thừa ${money(diff)}` : `Thiếu ${money(-diff)}`;
const diffClass = diff => diff === 0 ? 'ok' : 'bad';

function CloseForm({ detail, accounts, onSaved }) {
  const saved = detail.close;
  const [cash, setCash] = useState(saved?.cash_counted ?? '');
  const [bank, setBank] = useState(() => Object.fromEntries(Object.entries(saved?.bank_counted || {}).map(([k, v]) => [k, String(v)])));
  const [note, setNote] = useState(saved?.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canClose = detail.date >= detail.startDate && detail.date <= detail.today;
  // Tài khoản có tiền trong sổ hôm đó + tài khoản đang hiện trong cài đặt.
  const accountIds = [...new Set([...Object.keys(detail.dayByAccount || {}), ...accounts.map(a => a.id)])].filter(id => id !== 'unknown');
  const name = id => accounts.find(a => a.id === id)?.name || 'Tài khoản khác';

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/admin/finance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close', date: detail.date, cash_counted: cash === '' ? null : Number(digits(cash)),
          bank_counted: Object.fromEntries(Object.entries(bank).map(([k, v]) => [k, v === '' ? null : Number(digits(v))])), note }),
      });
      await onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!canClose) return null;
  const cashDiff = cash === '' ? null : Number(digits(cash)) - detail.dayCash;
  const amountInput = (value, onChange, label) => <input inputMode="numeric" enterKeyHint="done" aria-label={label} placeholder="Chưa nhập"
    value={value === '' ? '' : Number(digits(value)).toLocaleString('vi-VN')} onChange={e => onChange(digits(e.target.value))} />;

  return <form className="fin-close" onSubmit={save}>
    <h3>Chốt sổ cuối ngày</h3>
    <p className="fin-hint">Đếm tiền mặt trong két và xem số tiền thật trên app ngân hàng, nhập vào để so với sổ.{saved && ` Đã chốt lúc ${clock(saved.closed_at)}${saved.closed_by_name ? ` bởi ${saved.closed_by_name}` : ''}.`}</p>
    <div className="fin-close-row">
      <div><b>Tiền mặt</b><small>Sổ ghi {money(detail.dayCash)}</small></div>
      {amountInput(cash, setCash, 'Tiền mặt đếm được')}
      {cashDiff !== null && <span className={`fin-diff ${diffClass(cashDiff)}`}>{diffText(cashDiff)}</span>}
    </div>
    {accountIds.map(id => {
      const value = bank[id] ?? '';
      const diff = value === '' ? null : Number(digits(value)) - (detail.dayByAccount?.[id] || 0);
      return <div key={id} className="fin-close-row">
        <div><b>{name(id)}</b><small>Sổ ghi {money(detail.dayByAccount?.[id] || 0)}</small></div>
        {amountInput(value, v => setBank(prev => ({ ...prev, [id]: v })), `Tiền thật ${name(id)}`)}
        {diff !== null && <span className={`fin-diff ${diffClass(diff)}`}>{diffText(diff)}</span>}
      </div>;
    })}
    <label className="fin-close-note">Ghi chú<input value={note} onChange={e => setNote(e.target.value)} placeholder="Không bắt buộc" /></label>
    {error && <p className="fin-error">{error}</p>}
    <button className="fin-primary" disabled={busy}>{busy ? 'Đang lưu...' : saved ? 'Cập nhật chốt sổ' : 'Chốt sổ ngày'}</button>
  </form>;
}

function DayDetail({ date, accounts, categories, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  async function load() {
    setError('');
    try { setDetail(await api(`/api/admin/finance?date=${date}`)); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [date]);
  // Khoá cuộn trang phía sau (iOS vẫn cuộn nền khi vuốt trong khung) + Esc để đóng.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', onKey); };
  }, []);

  async function remove(entry) {
    if (!confirm(`Xoá "${entry.label}" ${money(entry.amount)}?`)) return;
    try {
      await api('/api/admin/finance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: entry.id }) });
      await load(); onChanged();
    } catch (err) { alert(err.message); }
  }

  const accountName = id => accounts.find(a => a.id === id)?.name || 'Chuyển khoản';
  return <div className="fin-overlay" onClick={onClose}>
    <div className="fin-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={`Chi tiết ${dayLabel(date)}`}>
      <header><h2>{dayLabel(date)}</h2><button className="fin-icon" onClick={onClose} aria-label="Đóng"><X size={20} /></button></header>
      {error && <p className="fin-error">{error}</p>}
      {!detail && !error && <p className="fin-empty">Đang tải...</p>}
      {detail && <>
        <h3>Bill đã thu ({detail.bills.length})</h3>
        {detail.bills.length === 0 && <p className="fin-empty">Chưa có bill.</p>}
        {detail.bills.map(bill => <div key={bill.order_id} className="fin-row-block">
          <button className="fin-row" onClick={() => setOpen(open === bill.order_id ? null : bill.order_id)}>
            <span>{clock(bill.paid_at)} · Bàn {bill.table_number || '?'} · {bill.customer_name || 'Khách'}
              <small>{bill.payment_method === 'transfer' ? accountName(bill.account_id) : 'Tiền mặt'}</small></span>
            <b>{money(bill.amount)}</b>
          </button>
          {open === bill.order_id && <ul className="fin-items">{(bill.items || []).map((item, i) =>
            <li key={i}><span>{item.quantity}× {item.name || 'Món'}{item.is_gift ? ' (tặng)' : ''}</span><span>{money(item.unit_price * item.quantity)}</span></li>)}</ul>}
        </div>)}

        <h3>Đi chợ / nhập hàng (Sổ tay)</h3>
        {detail.notes.length === 0 && <p className="fin-empty">Không có phiếu.</p>}
        {detail.notes.map(note => <div key={note.id} className="fin-row-block">
          <div className="fin-row static"><span>{clock(note.createdAt)} · {note.staffName || 'Nhân viên'}
            {note.debtLeft > 0 ? <small>Còn nợ {money(note.debtLeft)}</small> : note.debt > 0 && <small>Đã trả hết nợ {money(note.debt)}</small>}</span><b>{money(note.cost)}</b></div>
          {note.items?.length > 0 && <ul className="fin-items">{note.items.map((item, i) =>
            <li key={i}><span>{item.qty ? `${item.qty} ` : ''}{item.name}{item.paymentStatus === 'debt' ? ' (nợ)' : ''}</span><span>{item.price}</span></li>)}</ul>}
          {!note.items && note.text && <p className="fin-note-text">{note.text}</p>}
          {note.suspicious?.length > 0 && <p className="fin-warn">⚠ Giá có thể gõ thiếu chữ "k" ({note.suspicious.join(', ')}). Sổ tay hiểu "250" là 250đ, "250k" mới là 250.000đ. Kiểm tra lại phiếu trong Sổ tay.</p>}
        </div>)}

        <h3>Khoản tự nhập</h3>
        {detail.entries.length === 0 && <p className="fin-empty">Chưa có.</p>}
        {detail.entries.map(entry => <div key={entry.id} className="fin-row static">
          <span>{entryTitle(entry, categories)}{entry.note && <small>{entry.note}</small>}</span>
          <span className="fin-row-end"><b>{money(entry.amount)}</b>
            <button className="fin-icon danger" onClick={() => remove(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
        </div>)}

        <CloseForm detail={detail} accounts={accounts} onSaved={async () => { await load(); onChanged(); }} />
      </>}
    </div>
  </div>;
}

export default function FinancePage() {
  const [month, setMonth] = useState(vnToday().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState(null);
  // Mục đang xem (Tổng quan / Từng ngày / Thêm chi) — nhớ trên máy cho lần sau.
  const [view, setView] = useState('overview');
  const pending = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('financeView');
      if (['overview', 'days', 'add'].includes(saved)) setView(saved);
    } catch { /* trình duyệt chặn lưu trữ → dùng mặc định */ }
  }, []);
  function chooseView(next) {
    setView(next);
    try { localStorage.setItem('financeView', next); } catch { /* bỏ qua */ }
  }

  async function load() {
    const ticket = ++pending.current;
    setBusy(true); setError('');
    try {
      const result = await api(`/api/admin/finance?month=${month}`);
      if (ticket === pending.current) setData(result);
    } catch (err) {
      if (ticket === pending.current) { setData(null); setError(err.message); }
    } finally { if (ticket === pending.current) setBusy(false); }
  }
  useEffect(() => { load(); }, [month]);

  async function copyFixed() {
    try {
      const result = await api('/api/admin/finance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'copy_fixed', month }) });
      alert(`Đã chép ${result.entries.length} khoản chi cố định.`);
      load();
    } catch (err) { alert(err.message); }
  }

  async function removeFixed(entry) {
    if (!confirm(`Xoá "${entry.label}" ${money(entry.amount)}?`)) return;
    try {
      await api('/api/admin/finance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: entry.id }) });
      load();
    } catch (err) { alert(err.message); }
  }

  const t = data?.totals;
  const accounts = data?.accounts || [];
  const accountName = id => accounts.find(a => a.id === id)?.name || 'Không rõ tài khoản';
  const days = [...(data?.days || [])].reverse();
  // Tab tự tạo: đang dùng, hoặc đã ẩn nhưng tháng này còn tiền (để tổng vẫn khớp).
  const customTabs = (data?.categories || []).filter(c => c.scope === 'tab' && (!c.archived || data?.totals?.custom?.[c.id]));
  const dayCost = d => d.purchases + d.drinks + d.salary + d.fixedShare + d.customTotal;
  const totalCost = t ? t.purchases + t.drinks + t.salary + t.fixedShare + t.customTotal : 0;
  // Các khoản chi của tháng — dòng 0đ của tab tự tạo thì ẩn cho gọn.
  const costRows = t ? [
    { key: 'purchases', name: 'Nhập hàng (Sổ tay)', amount: t.purchases },
    { key: 'drinks', name: 'Nước ngọt / bia', amount: t.drinks },
    { key: 'salary', name: 'Lương', amount: t.salary },
    { key: 'fixed', name: 'Chi cố định', amount: t.fixedShare, sub: data.fixedMonthTotal ? `cả tháng ${money(data.fixedMonthTotal)}` : '' },
    ...customTabs.map(tab => ({ key: tab.id, name: tab.name, amount: t.custom[tab.id] || 0,
      sub: tab.schedule === 'monthly' ? `cả tháng ${money(data.customMonthTotals?.[tab.id] || 0)}` : '', optional: true })),
  ].filter(r => !r.optional || r.amount > 0) : [];
  const today = days.find(d => d.date === data?.today);
  const monthText = `${month.slice(5)}/${month.slice(0, 4)}`;

  const dayTags = d => <>
    {d.close
      ? <>
          <span className="fin-tag ok">Đã chốt sổ</span>
          {d.close.cashDiff !== null && <span className={`fin-tag ${diffClass(d.close.cashDiff)}`}>Tiền mặt: {diffText(d.close.cashDiff)}</span>}
          {Object.entries(d.close.bankDiffs).filter(([, diff]) => diff !== 0).map(([id, diff]) =>
            <span key={id} className="fin-tag bad">{accountName(id)}: {diffText(diff)}</span>)}
        </>
      : d.date < data.today && <span className="fin-tag muted">Chưa chốt sổ</span>}
    {d.suspiciousNotes > 0 && <span className="fin-tag bad">⚠ {d.suspiciousNotes} phiếu Sổ tay giá đáng ngờ</span>}
  </>;

  return <div className="finance">
    <header className="fin-header">
      <div className="fin-title"><h1><PiggyBank size={22} />Sổ thu chi</h1>
        <p>Số thật từ {data?.startDate ? `${data.startDate.slice(8)}/${data.startDate.slice(5, 7)}/${data.startDate.slice(0, 4)}` : '23/10/2026'}</p></div>
      <div className="fin-header-tools">
        <div className="fin-month" role="group" aria-label="Chọn tháng">
          <button onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= FIRST_MONTH} aria-label="Tháng trước"><ChevronLeft size={18} /></button>
          <b>Tháng {monthText}</b>
          <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= vnToday().slice(0, 7)} aria-label="Tháng sau"><ChevronRight size={18} /></button>
        </div>
        <button className="fin-icon" onClick={load} disabled={busy} aria-label="Tải lại"><RefreshCw size={18} className={busy ? 'fin-spin' : ''} /></button>
      </div>
    </header>

    <nav className="fin-switch" role="tablist" aria-label="Mục sổ thu chi">
      {[['overview', 'Tổng quan'], ['days', 'Từng ngày'], ['add', 'Thêm chi']].map(([key, text]) =>
        <button key={key} role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => chooseView(key)}>{text}</button>)}
    </nav>

    {error && <p className="fin-error">{error}</p>}

    {data?.recoveredBills?.length > 0 && <section className="fin-recovered" role="status">
      <b>✓ Sổ vừa tự bổ sung {data.recoveredBills.length} bill bị sót</b>
      <p>Lấy từ lịch sử bàn, đã cộng vào số liệu bên dưới. Nếu thông báo này hay xuất hiện, báo lại để kiểm tra.</p>
      {data.recoveredBills.map(b => <div key={b.orderId} className="fin-row static">
        <span>{clock(b.paidAt)} · Bàn {b.tableNumber ?? '?'} · {b.customerName || 'Khách'}<small>{b.paymentMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt'}</small></span>
        <b>{money(b.amount)}</b>
      </div>)}
    </section>}

    {data?.missingBills?.length > 0 && <section className="fin-alert" role="alert">
      <b>⚠ Có {data.missingBills.length} bill đã thanh toán nhưng chưa vào sổ</b>
      <p>Sổ chưa tự bổ sung được các bill này (kiểm tra trong 10 giờ gần nhất). Báo lại để kiểm tra.</p>
      {data.missingBills.map(b => <div key={b.orderId} className="fin-row static">
        <span>{clock(b.paidAt)} · Bàn {b.tableNumber ?? '?'} · {b.customerName || 'Khách'}<small>{b.paymentMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt'}</small></span>
        <b>{money(b.amount)}</b>
      </div>)}
    </section>}

    {view === 'overview' && t && <>
      <section className={`fin-hero ${t.profit < 0 ? 'loss' : ''}`}>
        <span>{t.profit < 0 ? 'Lỗ' : 'Lãi'} tháng {monthText}</span>
        <b>{money(Math.abs(t.profit))}</b>
        <div className="fin-hero-split">
          <div><small>Thu</small><strong>{money(t.revenue)}</strong></div>
          <div><small>Chi</small><strong>{money(totalCost)}</strong></div>
        </div>
        <p>{t.bills} bill · Tiền mặt {money(t.cash)} · Chuyển khoản {money(t.transfer)}</p>
      </section>

      {today && <button className="fin-today" onClick={() => setDay(today.date)}>
        <span><b>Hôm nay</b><small>Thu {money(today.revenue)} · Chi {money(dayCost(today))}</small></span>
        <span className={today.profit < 0 ? 'loss' : 'gain'}>{today.profit < 0 ? 'Lỗ' : 'Lãi'} {money(Math.abs(today.profit))}</span>
        <ChevronRight size={18} />
      </button>}

      <section className="fin-panel">
        <h2>Các khoản chi</h2>
        {costRows.map(r => <div key={r.key} className="fin-cost">
          <div className="fin-cost-line"><span>{r.name}{r.sub && <small>{r.sub}</small>}</span><b>{money(r.amount)}</b></div>
          <div className="fin-bar" aria-hidden="true"><i style={{ width: `${totalCost > 0 ? Math.min(100, (r.amount / totalCost) * 100) : 0}%` }} /></div>
        </div>)}
        <div className="fin-cost-total"><span>Tổng chi</span><b>{money(totalCost)}</b></div>
      </section>

      {Object.keys(t.byAccount).length > 0 && <section className="fin-panel">
        <h2>Chuyển khoản theo tài khoản</h2>
        {Object.entries(t.byAccount).map(([id, amount]) => <div key={id} className="fin-row static"><span>{accountName(id)}</span><b>{money(amount)}</b></div>)}
      </section>}
    </>}

    {view === 'days' && <section className="fin-section">
      {data && days.length === 0 && <p className="fin-empty">Tháng này chưa có ngày nào được tính.</p>}
      <div className="fin-days">
        {days.map(d => <button key={d.date} className="fin-day" onClick={() => setDay(d.date)}>
          <div className="fin-day-head">
            <span className="fin-day-date"><b>{dayLabel(d.date)}</b><small>{d.bills} bill · Thu {money(d.revenue)} · Chi {money(dayCost(d))}</small></span>
            <span className={d.profit < 0 ? 'loss' : 'gain'}>{d.profit < 0 ? 'Lỗ' : 'Lãi'}<br />{money(Math.abs(d.profit))}</span>
            <ChevronRight size={16} />
          </div>
          <div className="fin-day-tags">{dayTags(d)}</div>
        </button>)}
      </div>
    </section>}

    {view === 'add' && <section className="fin-section">
      <AddEntryForm data={data} month={month} onSaved={load} />
      {data && !data.fixedEntries?.length && month > '2026-10' && <button className="fin-secondary" onClick={copyFixed} disabled={busy}>
        Chép chi cố định từ tháng trước
      </button>}
      {data?.fixedEntries?.length > 0 && <details className="fin-fixed" open>
        <summary>Chi cố định tháng {monthText}<b>{money(data.fixedMonthTotal)}</b></summary>
        {data.fixedEntries.map(entry => <div key={entry.id} className="fin-row static">
          <span>{entry.label}{entry.note && <small>{entry.note}</small>}</span>
          <span className="fin-row-end"><b>{money(entry.amount)}</b>
            <button className="fin-icon danger" onClick={() => removeFixed(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
        </div>)}
      </details>}
      {data?.customMonthlyEntries?.length > 0 && <details className="fin-fixed" open>
        <summary>Khoản theo tháng {monthText}</summary>
        {data.customMonthlyEntries.map(entry => <div key={entry.id} className="fin-row static">
          <span>{entryTitle(entry, data.categories)}{entry.note && <small>{entry.note}</small>}</span>
          <span className="fin-row-end"><b>{money(entry.amount)}</b>
            <button className="fin-icon danger" onClick={() => removeFixed(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
        </div>)}
      </details>}
      <p className="fin-hint fin-add-hint">Khoản chi theo ngày (nước ngọt, lương, tab theo ngày) xem và xoá trong mục <b>Từng ngày</b>.</p>
    </section>}

    {day && <DayDetail date={day} accounts={accounts} categories={data?.categories || []} onClose={() => setDay(null)} onChanged={load} />}
  </div>;
}
