'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronRight, PiggyBank, RefreshCw, Trash2, X } from 'lucide-react';
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
const KIND_LABEL = { drink: 'Nước ngọt / bia', salary: 'Lương', fixed: 'Chi cố định' };

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Không kết nối được máy chủ.'), { result });
  return result;
}

function AddEntryForm({ data, month, onSaved }) {
  const [kind, setKind] = useState('drink');
  const [date, setDate] = useState(vnToday());
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState('rent');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/api/admin/finance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', kind, entry_date: date, month, category, amount: Number(digits(amount)),
          label: kind === 'drink' ? (label || 'Nước ngọt / bia') : label, note }),
      });
      setAmount(''); setNote(''); if (kind !== 'drink') setLabel('');
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return <form className="fin-form" onSubmit={save}>
    <div className="fin-tabs" role="tablist">
      {['drink', 'salary', 'fixed'].map(k => <button key={k} type="button" role="tab" aria-selected={kind === k}
        className={kind === k ? 'active' : ''} onClick={() => { if (k !== kind) setLabel(''); setKind(k); setError(''); }}>{KIND_LABEL[k]}</button>)}
    </div>
    <div className="fin-fields">
      {kind === 'fixed'
        ? <label>Loại<select value={category} onChange={e => setCategory(e.target.value)}>
            {(data?.fixedCategories || []).map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select></label>
        : <label>Ngày<input type="date" value={date} min={data?.startDate} max={vnToday()} onChange={e => setDate(e.target.value)} required /></label>}
      {kind === 'salary' && <label>Nhân viên
        <input list="fin-staff" value={label} onChange={e => setLabel(e.target.value)} placeholder="Tên nhân viên" required />
        <datalist id="fin-staff">{(data?.staff || []).map(name => <option key={name} value={name} />)}</datalist>
      </label>}
      {kind === 'drink' && <label>Nội dung<input value={label} onChange={e => setLabel(e.target.value)} placeholder="Nước ngọt / bia" /></label>}
      <label>Số tiền<input inputMode="numeric" value={amount ? Number(digits(amount)).toLocaleString('vi-VN') : ''}
        onChange={e => setAmount(digits(e.target.value))} placeholder="0" required /></label>
      <label className="fin-wide">Ghi chú<input value={note} onChange={e => setNote(e.target.value)} placeholder="Không bắt buộc" /></label>
    </div>
    {kind === 'fixed' && <p className="fin-hint">Ghi cho cả tháng {month.slice(5)}/{month.slice(0, 4)}, tự chia đều cho từng ngày.</p>}
    {error && <p className="fin-error">{error}</p>}
    <button className="fin-primary" disabled={busy}>{busy ? 'Đang lưu...' : `Thêm ${KIND_LABEL[kind].toLowerCase()}`}</button>
  </form>;
}

function DayDetail({ date, accounts, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  async function load() {
    setError('');
    try { setDetail(await api(`/api/admin/finance?date=${date}`)); } catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, [date]);

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
            {note.debt > 0 && <small>Còn nợ {money(note.debt)}</small>}</span><b>{money(note.cost)}</b></div>
          {note.items?.length > 0 && <ul className="fin-items">{note.items.map((item, i) =>
            <li key={i}><span>{item.qty ? `${item.qty} ` : ''}{item.name}{item.paymentStatus === 'debt' ? ' (nợ)' : ''}</span><span>{item.price}</span></li>)}</ul>}
          {!note.items && note.text && <p className="fin-note-text">{note.text}</p>}
        </div>)}

        <h3>Khoản tự nhập</h3>
        {detail.entries.length === 0 && <p className="fin-empty">Chưa có.</p>}
        {detail.entries.map(entry => <div key={entry.id} className="fin-row static">
          <span>{KIND_LABEL[entry.kind]}: {entry.label}{entry.note && <small>{entry.note}</small>}</span>
          <span className="fin-row-end"><b>{money(entry.amount)}</b>
            <button className="fin-icon danger" onClick={() => remove(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
        </div>)}
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
  const pending = useRef(0);

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

  return <div className="finance">
    <header className="fin-header">
      <div><h1><PiggyBank size={24} />Sổ thu chi</h1>
        <p>Số liệu thật từng bill, tính từ {data?.startDate ? `${data.startDate.slice(8)}/${data.startDate.slice(5, 7)}/${data.startDate.slice(0, 4)}` : '23/10/2026'}. Không liên quan trang Thống kê.</p></div>
      <div className="fin-header-tools">
        <input type="month" value={month} min="2026-10" max={vnToday().slice(0, 7)} onChange={e => e.target.value && setMonth(e.target.value)} aria-label="Chọn tháng" />
        <button className="fin-icon" onClick={load} disabled={busy} aria-label="Tải lại"><RefreshCw size={18} className={busy ? 'fin-spin' : ''} /></button>
      </div>
    </header>

    {error && <p className="fin-error">{error}</p>}

    {t && <>
      <section className="fin-cards">
        <div className="fin-card revenue"><span>Doanh thu</span><b>{money(t.revenue)}</b>
          <small>{t.bills} bill · Tiền mặt {money(t.cash)} · CK {money(t.transfer)}</small></div>
        <div className="fin-card"><span>Nhập hàng (Sổ tay)</span><b>{money(t.purchases)}</b></div>
        <div className="fin-card"><span>Nước ngọt / bia</span><b>{money(t.drinks)}</b></div>
        <div className="fin-card"><span>Lương</span><b>{money(t.salary)}</b></div>
        <div className="fin-card"><span>Chi cố định (phần các ngày đã qua)</span><b>{money(t.fixedShare)}</b>
          <small>Cả tháng {money(data.fixedMonthTotal)}</small></div>
        <div className={`fin-card profit ${t.profit < 0 ? 'loss' : ''}`}><span>{t.profit < 0 ? 'Lỗ' : 'Lãi'}</span><b>{money(Math.abs(t.profit))}</b>
          <small>Doanh thu − tất cả khoản chi</small></div>
      </section>
      {Object.keys(t.byAccount).length > 0 && <section className="fin-accounts">
        <h3>Chuyển khoản theo tài khoản</h3>
        {Object.entries(t.byAccount).map(([id, amount]) => <div key={id} className="fin-row static"><span>{accountName(id)}</span><b>{money(amount)}</b></div>)}
      </section>}
    </>}

    <section className="fin-section">
      <h2>Thêm khoản chi</h2>
      <AddEntryForm data={data} month={month} onSaved={load} />
      {data?.fixedEntries?.length > 0 && <div className="fin-fixed">
        <h3>Chi cố định tháng {month.slice(5)}/{month.slice(0, 4)}</h3>
        {data.fixedEntries.map(entry => <div key={entry.id} className="fin-row static">
          <span>{entry.label}{entry.note && <small>{entry.note}</small>}</span>
          <span className="fin-row-end"><b>{money(entry.amount)}</b>
            <button className="fin-icon danger" onClick={() => removeFixed(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
        </div>)}
      </div>}
    </section>

    <section className="fin-section">
      <h2>Từng ngày</h2>
      {data && days.length === 0 && <p className="fin-empty">Tháng này chưa có ngày nào được tính.</p>}
      <div className="fin-days">
        {days.map(d => <button key={d.date} className="fin-day" onClick={() => setDay(d.date)}>
          <div className="fin-day-head"><b>{dayLabel(d.date)}</b>
            <span className={d.profit < 0 ? 'loss' : 'gain'}>{d.profit < 0 ? 'Lỗ' : 'Lãi'} {money(Math.abs(d.profit))}</span><ChevronRight size={16} /></div>
          <div className="fin-day-grid">
            <span>Doanh thu <b>{money(d.revenue)}</b></span>
            <span>{d.bills} bill · TM {money(d.cash)} · CK {money(d.transfer)}</span>
            <span>Nhập hàng <b>{money(d.purchases)}</b></span>
            <span>Nước ngọt <b>{money(d.drinks)}</b></span>
            <span>Lương <b>{money(d.salary)}</b></span>
            <span>Cố định <b>{money(d.fixedShare)}</b></span>
          </div>
        </button>)}
      </div>
    </section>

    {day && <DayDetail date={day} accounts={accounts} onClose={() => setDay(null)} onChanged={load} />}
  </div>;
}
