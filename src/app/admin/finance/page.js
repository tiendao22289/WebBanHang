'use client';

import { useEffect, useRef, useState } from 'react';
import { Banknote, Camera, ChevronLeft, ChevronRight, CreditCard, PiggyBank, RefreshCw, Trash2, X } from 'lucide-react';
import { compressImage, fetchWithTimeout } from '@/lib/compressImage';
import { useBackClose } from '@/lib/useBackClose';
import CameraCapture, { cameraSupported } from '@/lib/CameraCapture';
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

// Gửi lên /api/admin/receipts (thêm ảnh CK, xoá bill giấy) — dùng chung với trang Bill giấy.
async function sendReceipt(fields, image) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (image) form.set('image', image, 'ck.jpg');
  const response = await fetchWithTimeout('/api/admin/receipts', { method: 'POST', body: form, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Không lưu được.');
  return result;
}

function DayDetail({ date, accounts, categories, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [view, setView] = useState(null);
  const [attaching, setAttaching] = useState(null);
  const attachInput = useRef(null);
  // Back (Android) / vuốt lùi (iPhone): đóng ảnh đang xem trước, rồi mới đóng chi tiết ngày.
  useBackClose(true, onClose);
  useBackClose(!!view, () => setView(null));

  // Ảnh CK: chụp màn hình ĐT khách trong web (không lưu vào máy) hoặc chọn ảnh có sẵn.
  // target.action 'attach_bill': ảnh tờ bill cho bill giấy chưa có ảnh.
  const [cameraFor, setCameraFor] = useState(null);
  const pendingGallery = useRef(null);
  const attachCapture = useRef(null);
  async function uploadProof(target, blob) {
    setAttaching(target);
    try { await sendReceipt({ action: 'attach_transfer', ...target }, blob); await load(); }
    catch (err) { alert(err.message); } finally { setAttaching(null); }
  }
  function startCamera(target) { if (cameraSupported()) setCameraFor(target); else { pendingGallery.current = target; attachCapture.current.click(); } }
  function startAttach(target) { pendingGallery.current = target; attachInput.current.click(); }
  async function attach(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const target = pendingGallery.current;
    pendingGallery.current = null;
    if (!file || !target) return;
    try { await uploadProof(target, await compressImage(file)); } catch (err) { alert(err.message); }
  }
  async function removePaper(bill) {
    if (!confirm(`Xoá bill giấy ${money(bill.amount)}${bill.tableLabel ? ` (${bill.tableLabel})` : ''}?`)) return;
    try { await sendReceipt({ action: 'delete_paper', id: bill.id }); await load(); onChanged(); } catch (err) { alert(err.message); }
  }

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
          {bill.payment_method === 'transfer' && <div className="fin-ck">
            {bill.transfer_image_url
              ? <button className="fin-ck-view" onClick={() => setView(bill.transfer_image_url)}>📷 Xem ảnh chuyển khoản</button>
              : <span className="fin-ck-none">Chưa có ảnh chuyển khoản</span>}
            <span className="fin-ck-buttons">
              <button className="fin-ck-add primary" onClick={() => startCamera({ order_id: bill.order_id })} disabled={!!attaching}>📷 Chụp</button>
              <button className="fin-ck-add" onClick={() => startAttach({ order_id: bill.order_id })} disabled={!!attaching}>Chọn ảnh</button>
            </span>
          </div>}
          {open === bill.order_id && <ul className="fin-items">{(bill.items || []).map((item, i) =>
            <li key={i}><span>{item.quantity}× {item.name || 'Món'}{item.is_gift ? ' (tặng)' : ''}</span><span>{money(item.unit_price * item.quantity)}</span></li>)}</ul>}
        </div>)}

        <h3>Bill giấy ({detail.paperBills?.length || 0})</h3>
        {!detail.paperBills?.length && <p className="fin-empty">Không có bill giấy.</p>}
        {(detail.paperBills || []).map(b => <div key={b.id} className="fin-row-block">
          <div className="fin-paper">
            {b.imageUrl ? <button className="fin-thumb" onClick={() => setView(b.imageUrl)} aria-label="Xem ảnh bill"><img src={b.imageUrl} alt="" /></button>
              : <span className="fin-thumb empty" title={b.imagesPurged ? 'Ảnh đã xoá sau 3 tháng' : ''} />}
            <span>{clock(b.receivedAt)}{b.tableLabel ? ` · ${b.tableLabel}` : ''}
              <small>{b.paymentMethod === 'transfer' ? accountName(b.accountId) : 'Tiền mặt'}{b.createdByName ? ` · ${b.createdByName}` : ''}{b.note ? ` · ${b.note}` : ''}</small></span>
            <b>{money(b.amount)}</b>
            <button className="fin-icon danger" onClick={() => removePaper(b)} aria-label="Xoá bill giấy"><Trash2 size={16} /></button>
          </div>
          {/* Bill không có ảnh nào (vd. từ trang Mã QR trước khi bắt buộc chụp): chụp bổ sung được. */}
          {!b.imageUrl && !b.transferImageUrl && !b.imagesPurged && <div className="fin-ck">
            <span className="fin-ck-none">Chưa có ảnh bill</span>
            <span className="fin-ck-buttons">
              <button className="fin-ck-add primary" onClick={() => startCamera({ action: 'attach_bill', receipt_id: b.id })} disabled={!!attaching}>📷 Chụp</button>
              <button className="fin-ck-add" onClick={() => startAttach({ action: 'attach_bill', receipt_id: b.id })} disabled={!!attaching}>Chọn ảnh</button>
            </span>
          </div>}
          {b.paymentMethod === 'transfer' && <div className="fin-ck">
            {b.transferImageUrl ? <button className="fin-ck-view" onClick={() => setView(b.transferImageUrl)}>📷 Xem ảnh chuyển khoản</button>
              : <span className="fin-ck-none">Chưa có ảnh chuyển khoản</span>}
            <span className="fin-ck-buttons">
              <button className="fin-ck-add primary" onClick={() => startCamera({ receipt_id: b.id })} disabled={!!attaching}>📷 Chụp</button>
              <button className="fin-ck-add" onClick={() => startAttach({ receipt_id: b.id })} disabled={!!attaching}>Chọn ảnh</button>
            </span>
          </div>}
        </div>)}

        <h3>Đi chợ / nhập hàng (Sổ tay)</h3>
        {detail.notes.length === 0 && <p className="fin-empty">Không có phiếu.</p>}
        {detail.notes.map(note => <div key={note.id} className="fin-row-block">
          <div className="fin-row static"><span>{clock(note.createdAt)} · {note.staffName || 'Nhân viên'}
            {note.debtLeft > 0 ? <small>Còn nợ {money(note.debtLeft)}</small> : note.debt > 0 && <small>Đã trả hết nợ {money(note.debt)}</small>}</span><b>{money(note.cost)}</b></div>
          {note.items?.length > 0 && <ul className="fin-items">{note.items.map((item, i) =>
            <li key={i}><span>{item.qty ? `${item.qty} ` : ''}{item.name}{item.paymentStatus === 'debt' ? ' (nợ)' : ''}</span><span>{item.price}</span></li>)}</ul>}
          {!note.items && note.text && <p className="fin-note-text">{note.text}</p>}
          {note.mismatch !== 0 && note.mismatch !== undefined && <p className="fin-warn">⚠ Phiếu lệch tiền: tổng phiếu ghi {money(note.cost)} nhưng các dòng hàng cộng lại {money(note.cost - note.mismatch)} (lệch {money(Math.abs(note.mismatch))}). Thường do lỗi cũ của Sổ tay, ví dụ "2,5kg" bị tính thành 25kg. Mở phiếu trong Sổ tay, bấm Sửa rồi Lưu để tính lại.</p>}
          {note.lineWarnings?.length > 0 && <p className="fin-warn">⚠ {note.lineWarnings.join(' · ')}</p>}
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
      <input ref={attachInput} type="file" accept="image/*" onChange={attach} hidden />
      <input ref={attachCapture} type="file" accept="image/*" capture="environment" onChange={attach} hidden />
      {cameraFor && <CameraCapture onCapture={blob => uploadProof(cameraFor, blob)} onClose={() => setCameraFor(null)} />}
      {view && <div className="rc-viewer" onClick={() => setView(null)} onContextMenu={e => e.preventDefault()} role="dialog" aria-label="Xem ảnh">
        <button className="fin-icon" aria-label="Đóng"><X size={20} /></button>
        <img src={view} alt="Ảnh" draggable={false} />
      </div>}
    </div>
  </div>;
}

// Tra cứu bill trong khoảng ngày để đối chiếu ảnh chuyển khoản / ảnh bill giấy.
const shortDate = date => `${dayLabel(date)}`;
const addDaysLocal = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const cardLabel = a => `${a.name.split(' · ')[0]}${a.last4 ? ` ·${a.last4}` : ''}`;
const stamp = iso => { const d = new Date(Date.parse(iso) + 7 * 3600000).toISOString(); return `${clock(iso)} ${d.slice(8, 10)}/${d.slice(5, 7)}`; };

function Chips({ label, value, options, onPick }) {
  return <div className="fin-filter-row">
    <span>{label}</span>
    <div className="fin-search-tables">
      {options.map(([k, t]) => <button key={k} type="button" aria-pressed={value === k} className={value === k ? 'active' : ''} onClick={() => onPick(k)}>{t}</button>)}
    </div>
  </div>;
}

function SearchView({ accounts, preset }) {
  const today = vnToday();
  const [filters, setFilters] = useState(() => ({
    table: '', amount: '', from: addDaysLocal(today, -6), to: today, type: 'all', account: '', photo: 'all', check: 'all', ...preset,
  }));
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [view, setView] = useState(null);
  const [saving, setSaving] = useState(null);
  useBackClose(!!view, () => setView(null));
  const accountName = id => accounts.find(a => a.id === id)?.name || 'Chuyển khoản';
  // Tên thẻ ngắn cho dòng bill gọn: "MB Bank ·6781".
  const cardName = id => { const a = accounts.find(x => x.id === id); return a ? cardLabel(a) : 'Chuyển khoản'; };
  const set = patch => setFilters(f => ({ ...f, ...patch }));

  async function search(event, patch = {}) {
    event?.preventDefault();
    const f = { ...filters, ...patch };
    setFilters(f);
    setBusy(true); setError('');
    try {
      const q = new URLSearchParams({ search: '1', from: f.from, to: f.to, type: f.type });
      if (f.table.trim()) q.set('table', f.table.trim());
      if (digits(f.amount)) q.set('amount', digits(f.amount));
      if (f.account) q.set('account', f.account);
      if (f.photo !== 'all') q.set('image', f.photo === 'has' ? '1' : 'missing');
      if (f.check !== 'all') q.set('check', f.check);
      setResult(await api(`/api/admin/finance?${q}`));
      setOpen(null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  useEffect(() => { search(); }, []);

  // Đánh dấu đã đối chiếu với app ngân hàng (bấm lại để bỏ).
  async function toggleVerify(r) {
    const verified = !r.verifiedAt;
    const patchHit = fields => setResult(res => ({ ...res, results: res.results.map(x => x.kind === r.kind && x.id === r.id ? { ...x, ...fields } : x) }));
    setSaving(r.id);
    try {
      const res = await post({ action: 'verify', kind: r.kind, id: r.id, verified });
      patchHit({ verifiedAt: res.verifiedAt, verifiedBy: res.verifiedBy });
      setResult(cur => cur.alerts ? { ...cur, alerts: { ...cur.alerts, unchecked: Math.max(0, cur.alerts.unchecked + (verified ? -1 : 1)) } } : cur);
    } catch (err) { alert(err.message); } finally { setSaving(null); }
  }

  // Chụp bổ sung ảnh CK cho bill chưa có ảnh.
  const [cameraFor, setCameraFor] = useState(null);
  const pendingGallery = useRef(null);
  const galleryInput = useRef(null);
  const captureInput = useRef(null);
  const target = r => r.kind === 'paper' ? { receipt_id: r.id } : { order_id: r.id };
  async function uploadProof(r, blob) {
    setSaving(r.id);
    try { await sendReceipt({ action: 'attach_transfer', ...target(r) }, blob); await search(); }
    catch (err) { alert(err.message); } finally { setSaving(null); }
  }
  function startCamera(r) { if (cameraSupported()) setCameraFor(r); else { pendingGallery.current = r; captureInput.current.click(); } }
  function startGallery(r) { pendingGallery.current = r; galleryInput.current.click(); }
  async function picked(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const r = pendingGallery.current;
    pendingGallery.current = null;
    if (!file || !r) return;
    try { await uploadProof(r, await compressImage(file)); } catch (err) { alert(err.message); }
  }

  const { table, amount, from, to, type, account, photo, check } = filters;
  const total = (result?.results || []).reduce((s, r) => s + r.amount, 0);
  // Bill theo ngày, giữ thứ tự mới → cũ của máy chủ.
  const days = [...(result?.results || []).reduce((map, r) => {
    const day = map.get(r.date) || map.set(r.date, { date: r.date, items: [], total: 0 }).get(r.date);
    day.items.push(r); day.total += r.amount;
    return map;
  }, new Map()).values()];
  const alerts = result?.alerts;
  const normTable = table.trim().replace(/^b(àn)?\s*/i, '').toLowerCase();
  return <section className="fin-section">
    <form className="fin-panel fin-search" onSubmit={search}>
      <div className="fin-search-grid">
        <label>Bàn<input value={table} onChange={e => set({ table: e.target.value })} placeholder="VD: 43" inputMode="text" enterKeyHint="search" /></label>
        <label>Số tiền<input inputMode="numeric" value={amount ? Number(digits(amount)).toLocaleString('vi-VN') : ''} onChange={e => set({ amount: digits(e.target.value) })} placeholder="Tất cả" enterKeyHint="search" /></label>
        <label>Từ ngày<input type="date" value={from} min={FIRST_MONTH + '-01'} max={to} onChange={e => e.target.value && set({ from: e.target.value })} /></label>
        <label>Đến ngày<input type="date" value={to} min={from} max={today} onChange={e => e.target.value && set({ to: e.target.value })} /></label>
      </div>
      <div className="fin-search-types" role="radiogroup" aria-label="Loại bill">
        {[['all', 'Tất cả'], ['transfer', 'Chuyển khoản'], ['cash', 'Tiền mặt'], ['paper', 'Bill giấy']].map(([k, t]) =>
          <button key={k} type="button" role="radio" aria-checked={type === k} className={type === k ? 'active' : ''} onClick={() => search(null, { type: k })}>{t}</button>)}
      </div>
      {result?.tables?.length > 0 && <Chips label="Bàn" value={result.tables.find(t => t.name.toLowerCase() === normTable)?.name || (normTable ? null : '')}
        options={[['', 'Tất cả bàn'], ...result.tables.map(t => [t.name, <>{/^\d/.test(t.name) ? `Bàn ${t.name}` : t.name}<small>{t.count}</small></>])]}
        onPick={name => search(null, { table: name })} />}
      {accounts.length > 0 && <Chips label="Thẻ" value={account} options={[['', 'Mọi thẻ'], ...accounts.map(a => [a.id, cardLabel(a)])]}
        onPick={id => search(null, { account: id })} />}
      <Chips label="Ảnh" value={photo} options={[['all', 'Tất cả'], ['has', 'Có ảnh'], ['missing', 'Chưa có ảnh CK']]} onPick={k => search(null, { photo: k })} />
      <Chips label="Đối chiếu" value={check} options={[['all', 'Tất cả'], ['unchecked', 'Chưa đối chiếu'], ['checked', 'Đã đối chiếu']]} onPick={k => search(null, { check: k })} />
      <button className="fin-primary" disabled={busy}>{busy ? 'Đang tìm...' : 'Tìm'}</button>
    </form>

    {error && <p className="fin-error">{error}</p>}
    {alerts && (alerts.missingPhoto > 0 || alerts.unchecked > 0) && <div className="fin-pending">
      {alerts.missingPhoto > 0 && photo !== 'missing' && <button onClick={() => search(null, { photo: 'missing', check: 'all' })}>📷 {alerts.missingPhoto} bill CK chưa có ảnh <ChevronRight size={16} /></button>}
      {alerts.unchecked > 0 && check !== 'unchecked' && <button onClick={() => search(null, { check: 'unchecked', photo: 'all' })}>☐ {alerts.unchecked} bill CK chưa đối chiếu <ChevronRight size={16} /></button>}
    </div>}
    {result && <p className="fin-search-sum">{result.results.length} bill · {money(total)}{result.truncated ? ' · chỉ hiện 200 bill mới nhất, thu hẹp ngày để xem thêm' : ''}</p>}
    {result && !result.results.length && <p className="fin-empty">Không có bill nào khớp.</p>}

    {/* Gọn: gom theo ngày, mỗi bill 1 dòng (ảnh nhỏ | giờ · bàn | tiền + đối chiếu); bấm vào để xem thêm. */}
    <div className="fin-search-list">
      {days.map(day => <section key={day.date} className="fin-bill-day">
        <h4><span>{shortDate(day.date)}</span><span>{day.items.length} bill · {money(day.total)}</span></h4>
        {day.items.map(r => {
          const isOpen = open === `${r.kind}-${r.id}`;
          const ckMissing = r.method === 'transfer' && !r.transferImageUrl && !r.imageExpired;
          const photo = r.transferImageUrl || r.billImageUrl;
          return <div key={`${r.kind}-${r.id}`} className={`fin-bill${r.verifiedAt ? ' verified' : ''}`}>
            {photo
              ? <button className="fin-bill-photo" onClick={() => setView(photo)} aria-label={r.transferImageUrl ? 'Xem ảnh CK' : 'Xem ảnh bill'}><img src={photo} alt="" draggable={false} /></button>
              : ckMissing
                ? <button className="fin-bill-photo add" onClick={() => startCamera(r)} disabled={saving === r.id} aria-label="Chụp ảnh CK"><Camera size={18} /><small>Chụp</small></button>
                : <span className="fin-bill-photo none" title={r.imageExpired ? 'Ảnh đã xoá sau 3 tháng' : ''}>{r.method === 'transfer' ? <CreditCard size={18} /> : <Banknote size={18} />}</span>}
            <button className="fin-bill-main" onClick={() => setOpen(isOpen ? null : `${r.kind}-${r.id}`)} aria-expanded={isOpen}>
              <b>{clock(r.at)} · {r.kind === 'paper' && !/^\d/.test(r.table || '') ? (r.table || 'Bill giấy') : `Bàn ${r.table || '?'}`}</b>
              <small>{r.kind === 'paper' ? 'Bill giấy' : (r.customer || 'Khách')} · {r.method === 'transfer' ? cardName(r.accountId) : 'Tiền mặt'}</small>
            </button>
            <div className="fin-bill-end">
              <b>{money(r.amount)}</b>
              {r.method === 'transfer' && <button className={`fin-bill-check${r.verifiedAt ? ' on' : ''}`} onClick={() => toggleVerify(r)} disabled={saving === r.id} aria-pressed={!!r.verifiedAt}>
                {r.verifiedAt ? '✓ Đã đối chiếu' : 'Đối chiếu'}</button>}
            </div>
            {isOpen && <div className="fin-bill-more">
              {r.by && <p>Người nhập: {r.by}</p>}
              {r.verifiedAt && <p>Đối chiếu: {r.verifiedBy ? `${r.verifiedBy} · ` : ''}{stamp(r.verifiedAt)}</p>}
              {r.imageExpired && <p>Ảnh đã xoá (quá 3 tháng)</p>}
              {r.kind === 'paper' && r.transferImageUrl && r.billImageUrl && <button className="fin-hit-photo" onClick={() => setView(r.billImageUrl)}><img src={r.billImageUrl} alt="" draggable={false} /><span>Ảnh bill</span></button>}
              {r.method === 'transfer' && !r.imageExpired && <span className="fin-hit-add">
                <button className="fin-ck-add primary" onClick={() => startCamera(r)} disabled={saving === r.id}>📷 {r.transferImageUrl ? 'Chụp lại ảnh CK' : 'Chụp ảnh CK'}</button>
                <button className="fin-ck-add" onClick={() => startGallery(r)} disabled={saving === r.id}>Chọn ảnh có sẵn</button>
              </span>}
              {r.kind === 'bill'
                ? <ul className="fin-items">{(r.items || []).map((item, i) => <li key={i}><span>{item.quantity}× {item.name || 'Món'}</span><span>{money(item.unit_price * item.quantity)}</span></li>)}</ul>
                : r.note && <p className="fin-note-text">{r.note}</p>}
            </div>}
          </div>;
        })}
      </section>)}
    </div>

    <input ref={galleryInput} type="file" accept="image/*" onChange={picked} hidden />
    <input ref={captureInput} type="file" accept="image/*" capture="environment" onChange={picked} hidden />
    {cameraFor && <CameraCapture onCapture={blob => uploadProof(cameraFor, blob)} onClose={() => setCameraFor(null)} />}
    {view && <div className="rc-viewer" onClick={() => setView(null)} onContextMenu={e => e.preventDefault()} role="dialog" aria-label="Xem ảnh">
      <button className="fin-icon" aria-label="Đóng"><X size={20} /></button>
      <img src={view} alt="Ảnh" draggable={false} />
    </div>}
  </section>;
}

// Giờ gửi báo cáo Zalo: mốc 30 phút trong ngày.
const SEND_TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

// Báo cáo thu chi gửi qua Zalo OA mỗi sáng tới chủ quán.
function ZaloReportPanel({ status, onChanged }) {
  const [state, setState] = useState(status);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { setState(status); }, [status]);
  if (!state) return null;

  async function act(action) {
    if (action === 'zalo_unlink' && !confirm('Ngừng gửi báo cáo Zalo?')) return;
    setBusy(action); setMessage('');
    try {
      const res = await post({ action });
      setState(res.zaloReport);
      if (action === 'zalo_test') setMessage('✓ Đã gửi, mở Zalo để xem.');
    } catch (err) {
      if (err.result?.zaloReport) setState(err.result.zaloReport);
      setMessage(err.message);
    } finally { setBusy(''); }
  }
  async function toggleSection(key) {
    const sections = { ...(state.sections || {}), [key]: !(state.sections?.[key] !== false) };
    setBusy('sections'); setMessage('');
    try { setState((await post({ action: 'zalo_set_sections', sections })).zaloReport); }
    catch (err) { setMessage(err.message); } finally { setBusy(''); }
  }
  async function setTime(time) {
    setBusy('time'); setMessage('');
    try { setState((await post({ action: 'zalo_set_time', time })).zaloReport); setMessage(`✓ Sẽ gửi lúc ${time} mỗi ngày.`); }
    catch (err) { setMessage(err.message); } finally { setBusy(''); }
  }
  async function setEnabled(enabled) {
    setBusy('enabled'); setMessage('');
    try { setState((await post({ action: 'zalo_set_enabled', enabled })).zaloReport); setMessage(enabled ? '✓ Đã bật gửi Zalo.' : '✓ Đã tắt gửi Zalo. Vẫn xem được ở trang Thống kê nhanh.'); }
    catch (err) { setMessage(err.message); } finally { setBusy(''); }
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(`BC ${state.linkCode}`); setMessage('Đã chép, dán vào Zalo.'); } catch { /* trình duyệt chặn → tự gõ */ }
  }

  return <section className="fin-panel fin-zalo">
    <h2>Báo cáo Zalo hằng ngày</h2>
    {state.linkCode ? <>
      <p>Mở Zalo, nhắn cho <b>OA của quán</b> đúng nội dung:</p>
      <button className="fin-zalo-code" onClick={copyCode} aria-label="Chép mã">BC {state.linkCode}</button>
      <p className="fin-zalo-hint">Mã dùng trong 30 phút. Nhắn xong bấm “Kiểm tra”.</p>
      <div className="fin-zalo-actions">
        <button className="fin-primary" onClick={onChanged}>Kiểm tra</button>
      </div>
    </> : state.linked > 0 ? <>
      <label className="fin-zalo-switch"><input type="checkbox" checked={state.enabled !== false} disabled={!!busy} onChange={e => setEnabled(e.target.checked)} /> Gửi báo cáo qua Zalo mỗi ngày</label>
      {state.enabled === false
        ? <p className="fin-zalo-hint">Đang tắt — không gửi Zalo, Zalo đã liên kết vẫn giữ nguyên.</p>
        : <p className="fin-zalo-ok">✓ Đang gửi tới {state.linked} Zalo · khoảng {state.sendAt || '08:00'} gửi số liệu {Number(String(state.sendAt || '08:00').slice(0, 2)) < 12 ? 'ngày hôm qua' : 'hôm nay'}.</p>}
      <label className="fin-zalo-time">Giờ gửi
        <select value={state.sendAt || '08:00'} disabled={!!busy} onChange={e => setTime(e.target.value)}>
          {SEND_TIMES.map(t => <option key={t} value={t}>{t}{Number(t.slice(0, 2)) < 12 ? ' — số hôm qua' : ' — số hôm nay'}</option>)}
        </select>
      </label>
      <div className="fin-zalo-sections" role="group" aria-label="Mục trong báo cáo">
        {[['loss', '🔍 Thất thoát (bill huỷ, món bớt, giảm giá, tặng)'], ['staff', '👥 Nhân viên (chấm công, chờ duyệt)'], ['compare', '📈 So sánh, món bán chạy'], ['notes', '🛒 Sổ tay chi tiết']].map(([key, text]) => (
          <label key={key}><input type="checkbox" checked={state.sections?.[key] !== false} disabled={!!busy} onChange={() => toggleSection(key)} /> {text}</label>
        ))}
      </div>
      {state.lastSentAt && <p className="fin-zalo-hint">Lần gửi gần nhất: {stamp(state.lastSentAt)}</p>}
      {state.lastError && <p className="fin-warn">⚠ Lần gần nhất Zalo không gửi được. Mở Zalo, nhắn “ok” cho OA của quán rồi bấm “Gửi thử”. Zalo chỉ cho OA nhắn lại người vừa nhắn mình trong vài ngày.</p>}
      <div className="fin-zalo-actions">
        <button className="fin-primary" onClick={() => act('zalo_test')} disabled={!!busy}>{busy === 'zalo_test' ? 'Đang gửi...' : 'Gửi thử số hôm nay'}</button>
        <button className="fin-secondary" onClick={() => act('zalo_link_code')} disabled={!!busy}>Thêm Zalo khác</button>
        <button className="fin-secondary danger" onClick={() => act('zalo_unlink')} disabled={!!busy}>Ngừng gửi</button>
      </div>
    </> : <>
      <p>Nhận tổng kết thu chi, lệch két, bill CK chưa có ảnh / chưa đối chiếu qua Zalo mỗi sáng — không cần mở web.</p>
      <div className="fin-zalo-actions">
        <button className="fin-primary" onClick={() => act('zalo_link_code')} disabled={!!busy}>Liên kết Zalo</button>
      </div>
    </>}
    {message && !(state.lastError && state.linked > 0 && !message.startsWith('✓')) && <p className="fin-zalo-hint" role="status">{message}</p>}
    <p className="fin-zalo-hint"><a href="/thongke" target="_blank" rel="noopener">Mở trang Thống kê nhanh (/thongke) ↗</a> — đọc báo cáo trên điện thoại, xem lại ngày cũ.</p>
  </section>;
}

// Bán ra theo món (bill) / nhập vào theo hàng (Sổ tay), gom theo nhóm để biết từng thứ lời lỗ.
const pct = ratio => ratio === null || ratio === undefined ? '' : `${Math.round(ratio * 100)}%`;

function GroupForm({ group, onSaved, onCancel }) {
  const [name, setName] = useState(group?.name || '');
  const [keywords, setKeywords] = useState((group?.keywords || []).join(', '));
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try { await post({ action: 'save_item_group', id: group?.id, name, keywords }); onSaved(); }
    catch (err) { alert(err.message); } finally { setBusy(false); }
  }
  return <form className="fin-group-form" onSubmit={save}>
    <label>Tên nhóm<input value={name} onChange={e => setName(e.target.value)} placeholder="VD: Ốc hương" autoFocus /></label>
    <label>Từ khoá (cách nhau dấu phẩy)<input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="Bỏ trống = dùng tên nhóm" /></label>
    <p className="fin-hint">Món bán và hàng Sổ tay có chứa từ khoá sẽ vào nhóm (không phân biệt dấu, hoa thường).</p>
    <div className="fin-group-actions">
      <button type="button" className="fin-secondary" onClick={onCancel}>Huỷ</button>
      <button className="fin-primary" disabled={busy}>{busy ? 'Đang lưu...' : 'Lưu nhóm'}</button>
    </div>
  </form>;
}

function ItemsView({ month, today }) {
  const lastOfMonth = addDaysLocal(shiftMonth(month, 1) + '-01', -1);
  const monthTo = lastOfMonth < today ? lastOfMonth : today;
  const monthFrom = `${month}-01`;
  const [range, setRange] = useState({ from: monthFrom, to: monthTo });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null);
  const [list, setList] = useState('groups');
  useEffect(() => { setRange({ from: monthFrom, to: monthTo }); }, [month]);

  async function load(r = range) {
    setBusy(true); setError('');
    try { setData(await api(`/api/admin/finance?items=1&from=${r.from}&to=${r.to}`)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  useEffect(() => { load(range); }, [range.from, range.to]);
  async function quickGroup(name) {
    try { await post({ action: 'save_item_group', name }); await load(); } catch (err) { alert(err.message); }
  }
  async function removeGroup(g) {
    if (!confirm(`Xoá nhóm "${g.name}"? (Không xoá bill hay Sổ tay)`)) return;
    try { await post({ action: 'delete_item_group', id: g.id }); setOpen(null); await load(); } catch (err) { alert(err.message); }
  }

  const presets = [['month', 'Cả tháng', { from: monthFrom, to: monthTo }], ['today', 'Hôm nay', { from: today, to: today }],
    ['7', '7 ngày', { from: addDaysLocal(today, -6), to: today }]];
  const presetKey = presets.find(([, , r]) => r.from === range.from && r.to === range.to)?.[0] || '';
  const t = data?.totals;
  const soldBy = key => data.sold.find(s => s.key === key);
  const boughtBy = key => data.bought.find(b => b.key === key);
  const groupName = id => data.groups.find(g => g.id === id)?.name;

  return <section className="fin-section">
    <div className="fin-panel fin-search">
      <div className="fin-search-types" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {presets.map(([k, text, r]) => <button key={k} type="button" className={presetKey === k ? 'active' : ''} onClick={() => setRange(r)}>{text}</button>)}
      </div>
      <div className="fin-search-grid">
        <label>Từ ngày<input type="date" value={range.from} min={FIRST_MONTH + '-01'} max={range.to} onChange={e => e.target.value && setRange(r => ({ ...r, from: e.target.value }))} /></label>
        <label>Đến ngày<input type="date" value={range.to} min={range.from} max={today} onChange={e => e.target.value && setRange(r => ({ ...r, to: e.target.value }))} /></label>
      </div>
    </div>

    {error && <p className="fin-error">{error}</p>}
    {!data && !error && <p className="fin-empty">{busy ? 'Đang tính...' : ''}</p>}
    {data && <>
      <div className="fin-items-sum">
        <div><small>Bán ra (theo món)</small><b>{money(t.revenue)}</b></div>
        <div><small>Nhập vào (Sổ tay)</small><b>{money(t.cost)}</b></div>
      </div>
      {t.paperRevenue > 0 && <p className="fin-hint">Bill giấy {money(t.paperRevenue)} không có chi tiết món nên không tính ở đây.</p>}

      <nav className="fin-switch fin-items-switch" role="tablist">
        {[['groups', `Theo nhóm (${data.groups.length})`], ['sold', `Món bán (${data.sold.length})`], ['bought', `Hàng nhập (${data.bought.length})`]].map(([k, text]) =>
          <button key={k} role="tab" aria-selected={list === k} className={list === k ? 'active' : ''} onClick={() => setList(k)}>{text}</button>)}
      </nav>

      {list === 'groups' && <>
        {data.groups.length === 0 && <p className="fin-empty">Chưa có nhóm. Tạo nhóm như "Ốc hương", "Bia" để so bán ra và nhập vào của từng thứ.</p>}
        <div className="fin-search-list">
          {data.groups.map(g => <div key={g.id} className="fin-hit">
            {editing === g.id ? <GroupForm group={g} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /> : <>
              <button className="fin-hit-head" onClick={() => setOpen(open === g.id ? null : g.id)}>
                <span><b>{g.name}</b><small>Bán {g.qty} phần · {money(g.revenue)} · Nhập {money(g.cost)}{g.costRatio !== null ? ` (${pct(g.costRatio)})` : ''}</small></span>
                <b className={`fin-hit-amount ${g.profit < 0 ? 'loss' : 'gain'}`}>{g.profit < 0 ? '-' : g.profit > 0 ? '+' : ''}{money(Math.abs(g.profit))}</b>
              </button>
              {g.revenue > 0 && <div className="fin-bar" aria-hidden="true"><i className={g.costRatio > 1 ? 'over' : ''} style={{ width: `${Math.min(100, (g.costRatio || 0) * 100)}%` }} /></div>}
              {open === g.id && <div className="fin-group-detail">
                <h4>Món bán</h4>
                {g.dishes.length === 0 && <p className="fin-empty">Không có món nào khớp.</p>}
                <ul className="fin-items">{g.dishes.map(k => { const s = soldBy(k); return <li key={k}><span>{s.qty}× {s.name}{s.giftQty ? ` (+${s.giftQty} tặng)` : ''}</span><span>{money(s.revenue)}</span></li>; })}</ul>
                <h4>Hàng nhập (Sổ tay)</h4>
                {g.goods.length === 0 && <p className="fin-empty">Không có hàng nào khớp.</p>}
                <ul className="fin-items">{g.goods.map(k => { const b = boughtBy(k); return <li key={k}><span>{b.name}{b.qty ? ` · ${b.qty}` : ''} · {b.times} lần</span><span>{money(b.cost)}</span></li>; })}</ul>
                <p className="fin-hint">Từ khoá: {g.keywords.join(', ')}</p>
                <div className="fin-group-actions">
                  <button className="fin-secondary" onClick={() => setEditing(g.id)}>Sửa nhóm</button>
                  <button className="fin-secondary danger" onClick={() => removeGroup(g)}>Xoá nhóm</button>
                </div>
              </div>}
            </>}
          </div>)}
        </div>
        {data.groups.length > 0 && <p className="fin-hint">Chưa vào nhóm: bán {money(t.ungroupedRevenue)} · nhập {money(t.ungroupedCost)}</p>}
        {data.suggestions.length > 0 && <div className="fin-filter-row"><span>Gợi ý nhóm (bấm để tạo)</span>
          <div className="fin-search-tables">{data.suggestions.map(name => <button key={name} type="button" onClick={() => quickGroup(name)}>+ {name}</button>)}</div></div>}
        {editing === 'new' ? <div className="fin-panel"><GroupForm onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /></div>
          : data.groupsReady && <button className="fin-secondary" onClick={() => setEditing('new')}>+ Thêm nhóm</button>}
      </>}

      {list === 'sold' && <div className="fin-panel">
        {data.sold.length === 0 && <p className="fin-empty">Chưa bán món nào.</p>}
        {data.sold.map(s => <div key={s.key} className="fin-row static">
          <span>{s.discount ? s.name : `${s.qty}× ${s.name}`}{(s.giftQty > 0 || s.group) && <small>{s.giftQty > 0 ? `+${s.giftQty} phần tặng` : ''}{s.giftQty > 0 && s.group ? ' · ' : ''}{s.group ? `Nhóm ${groupName(s.group)}` : ''}</small>}</span>
          <b>{money(s.revenue)}</b>
        </div>)}
      </div>}

      {list === 'bought' && <div className="fin-panel">
        {data.bought.length === 0 && t.unitemized === 0 && <p className="fin-empty">Chưa có hàng nhập.</p>}
        {data.bought.map(b => <div key={b.key} className="fin-row static">
          <span>{b.name}<small>{b.qty ? `${b.qty} · ` : ''}{b.times} lần{b.group ? ` · Nhóm ${groupName(b.group)}` : ''}</small></span>
          <b>{money(b.cost)}</b>
        </div>)}
        {t.unitemized > 0 && <div className="fin-row static"><span>Phiếu Sổ tay không ghi chi tiết hàng</span><b>{money(t.unitemized)}</b></div>}
        {t.mismatch !== 0 && t.mismatch !== undefined && <div className="fin-row static"><span>⚠ Phiếu lệch tiền ({t.mismatchNotes} phiếu)<small>Tổng phiếu đã lưu khác các dòng hàng — xem Từng ngày để sửa</small></span><b>{t.mismatch > 0 ? '+' : ''}{money(t.mismatch)}</b></div>}
      </div>}
    </>}
  </section>;
}

export default function FinancePage() {
  const [month, setMonth] = useState(vnToday().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState(null);
  // Mục đang xem (Tổng quan / Từng ngày / Thêm chi) — nhớ trên máy cho lần sau.
  const [view, setView] = useState('overview');
  // Bộ lọc mở sẵn khi bấm cảnh báo ở Tổng quan → Tra cứu.
  const [searchPreset, setSearchPreset] = useState({ key: 0, filters: {} });
  const pending = useRef(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('financeView');
      if (['overview', 'days', 'items', 'add', 'search'].includes(saved)) setView(saved);
    } catch { /* trình duyệt chặn lưu trữ → dùng mặc định */ }
  }, []);
  function chooseView(next) {
    setView(next);
    try { localStorage.setItem('financeView', next); } catch { /* bỏ qua */ }
  }
  function openSearch(filters) {
    setSearchPreset(p => ({ key: p.key + 1, filters }));
    chooseView('search');
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
  const pendingCk = data?.transferAlerts;
  const monthRange = data ? { from: data.from || `${month}-01`, to: data.to || data.today } : {};

  const dayTags = d => <>
    {d.close
      ? <>
          <span className="fin-tag ok">Đã chốt sổ</span>
          {d.close.cashDiff !== null && <span className={`fin-tag ${diffClass(d.close.cashDiff)}`}>Tiền mặt: {diffText(d.close.cashDiff)}</span>}
          {Object.entries(d.close.bankDiffs).filter(([, diff]) => diff !== 0).map(([id, diff]) =>
            <span key={id} className="fin-tag bad">{accountName(id)}: {diffText(diff)}</span>)}
        </>
      : d.date < data.today && <span className="fin-tag muted">Chưa chốt sổ</span>}
    {d.mismatchNotes > 0 && <span className="fin-tag bad">⚠ {d.mismatchNotes} phiếu Sổ tay lệch tiền</span>}
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
      {[['overview', 'Tổng quan'], ['days', 'Từng ngày'], ['items', 'Món'], ['add', 'Thêm chi'], ['search', 'Tra cứu']].map(([key, text]) =>
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
        <p>{t.bills} bill{t.paperBills ? ` + ${t.paperBills} bill giấy (${money(t.paperRevenue)})` : ''} · Tiền mặt {money(t.cash)} · Chuyển khoản {money(t.transfer)}</p>
      </section>

      {today && <button className="fin-today" onClick={() => setDay(today.date)}>
        <span><b>Hôm nay</b><small>Thu {money(today.revenue)} · Chi {money(dayCost(today))}</small></span>
        <span className={today.profit < 0 ? 'loss' : 'gain'}>{today.profit < 0 ? 'Lỗ' : 'Lãi'} {money(Math.abs(today.profit))}</span>
        <ChevronRight size={18} />
      </button>}

      {(t.mismatchNotes > 0 || t.suspiciousNotes > 0) && <section className="fin-pending">
        <b>Phiếu Sổ tay cần xem lại tháng {monthText}</b>
        <button onClick={() => chooseView('days')}>⚠ {[t.mismatchNotes > 0 && `${t.mismatchNotes} phiếu lệch tiền`, t.suspiciousNotes > 0 && `${t.suspiciousNotes} phiếu giá / số lượng đáng ngờ`].filter(Boolean).join(' · ')} <ChevronRight size={16} /></button>
      </section>}

      {pendingCk && (pendingCk.missingPhoto > 0 || pendingCk.unchecked > 0) && <section className="fin-pending">
        <b>Bill chuyển khoản tháng {monthText}</b>
        {pendingCk.missingPhoto > 0 && <button onClick={() => openSearch({ ...monthRange, photo: 'missing' })}>📷 {pendingCk.missingPhoto} bill chưa có ảnh CK <ChevronRight size={16} /></button>}
        {pendingCk.unchecked > 0 && <button onClick={() => openSearch({ ...monthRange, check: 'unchecked' })}>☐ {pendingCk.unchecked} bill chưa đối chiếu <ChevronRight size={16} /></button>}
      </section>}

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

      <ZaloReportPanel status={data.zaloReport} onChanged={load} />
    </>}

    {view === 'days' && <section className="fin-section">
      {data && days.length === 0 && <p className="fin-empty">Tháng này chưa có ngày nào được tính.</p>}
      <div className="fin-days">
        {days.map(d => <button key={d.date} className="fin-day" onClick={() => setDay(d.date)}>
          <div className="fin-day-head">
            <span className="fin-day-date"><b>{dayLabel(d.date)}</b><small>{d.bills} bill{d.paperBills ? ` + ${d.paperBills} giấy` : ''} · Thu {money(d.revenue)} · Chi {money(dayCost(d))}</small></span>
            <span className={d.profit < 0 ? 'loss' : 'gain'}>{d.profit < 0 ? 'Lỗ' : 'Lãi'}<br />{money(Math.abs(d.profit))}</span>
            <ChevronRight size={16} />
          </div>
          <div className="fin-day-tags">{dayTags(d)}</div>
        </button>)}
      </div>
    </section>}

    {view === 'items' && <ItemsView month={month} today={data?.today || vnToday()} />}

    {view === 'search' && <SearchView key={searchPreset.key} accounts={accounts} preset={searchPreset.filters} />}

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
