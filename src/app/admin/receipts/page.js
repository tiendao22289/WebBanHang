'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, Trash2, X } from 'lucide-react';
import { compressImage } from '@/lib/compressImage';
import '../finance/finance.css';
import './receipts.css';

const money = value => `${Math.round(Number(value || 0)).toLocaleString('vi-VN')}đ`;
const clock = value => new Date(value).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
const digits = value => String(value || '').replace(/\D/g, '');

async function send(form) {
  const response = await fetch('/api/admin/receipts', { method: 'POST', body: form, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw new Error(result.error || 'Không kết nối được máy chủ.');
  return result;
}

// Nút chụp / chọn ảnh: mở camera sau trên điện thoại, nén ảnh rồi trả về blob + ảnh xem trước.
function PhotoPicker({ label, value, onChange, required }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function pick(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      const blob = await compressImage(file);
      if (value?.preview) URL.revokeObjectURL(value.preview);
      onChange({ blob, preview: URL.createObjectURL(blob), size: blob.size });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <div className="rc-photo">
    <input ref={input} type="file" accept="image/*" capture="environment" onChange={pick} hidden />
    {value
      ? <div className="rc-photo-preview">
          <img src={value.preview} alt={label} />
          <div><b>{label}</b><small>{Math.round(value.size / 1024)}KB</small>
            <button type="button" className="fin-ghost" onClick={() => input.current.click()}>Chụp lại</button></div>
        </div>
      : <button type="button" className={`rc-photo-button ${required ? 'required' : ''}`} onClick={() => input.current.click()} disabled={busy}>
          <Camera size={22} />{busy ? 'Đang xử lý ảnh...' : label}{required && <small>bắt buộc</small>}
        </button>}
    {error && <p className="fin-error">{error}</p>}
  </div>;
}

function Viewer({ url, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <div className="rc-viewer" onClick={onClose} role="dialog" aria-label="Xem ảnh">
    <button className="fin-icon" aria-label="Đóng"><X size={20} /></button>
    <img src={url} alt="Ảnh bill" />
  </div>;
}

export default function ReceiptsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [transferPhoto, setTransferPhoto] = useState(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [account, setAccount] = useState('');
  const [tableLabel, setTableLabel] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [formError, setFormError] = useState('');
  const [view, setView] = useState(null);
  const [attaching, setAttaching] = useState(null);
  const attachInput = useRef(null);

  async function load() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/receipts', { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
      if (!response.ok) throw new Error(result.error || 'Không tải được dữ liệu.');
      setData(result);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);

  async function save(event) {
    event.preventDefault();
    setFormError(''); setSaved('');
    if (!photo) { setFormError('Chụp ảnh tờ bill giấy trước khi lưu.'); return; }
    if (!(Number(digits(amount)) > 0)) { setFormError('Nhập số tiền tổng của bill.'); return; }
    if (method === 'transfer' && !account) { setFormError('Chọn thẻ nhận tiền.'); return; }
    setSaving(true);
    try {
      const form = new FormData();
      form.set('action', 'create_paper');
      form.set('amount', digits(amount));
      form.set('method', method);
      if (method === 'transfer') form.set('account_id', account);
      form.set('table_label', tableLabel);
      form.set('note', note);
      form.set('image', photo.blob, 'bill.jpg');
      if (method === 'transfer' && transferPhoto) form.set('transfer_image', transferPhoto.blob, 'ck.jpg');
      await send(form);
      setSaved(`✓ Đã lưu bill giấy ${money(digits(amount))}${tableLabel ? ` · ${tableLabel}` : ''}`);
      setPhoto(null); setTransferPhoto(null); setAmount(''); setTableLabel(''); setNote('');
      load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  async function remove(bill) {
    if (!confirm(`Xoá bill giấy ${money(bill.amount)}${bill.tableLabel ? ` (${bill.tableLabel})` : ''}?`)) return;
    try {
      const form = new FormData(); form.set('action', 'delete_paper'); form.set('id', bill.id);
      await send(form); load();
    } catch (err) { alert(err.message); }
  }

  function startAttach(target) { setAttaching(target); attachInput.current.click(); }
  async function attach(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !attaching) return;
    try {
      const blob = await compressImage(file);
      const form = new FormData();
      form.set('action', 'attach_transfer');
      form.set(attaching.orderId ? 'order_id' : 'receipt_id', attaching.orderId || attaching.id);
      form.set('image', blob, 'ck.jpg');
      await send(form); load();
    } catch (err) { alert(err.message); } finally { setAttaching(null); }
  }

  const accounts = data?.accounts || [];
  const accountName = id => accounts.find(a => a.id === id)?.name || 'Chuyển khoản';
  const transferList = [
    ...(data?.transferBills || []).map(b => ({ key: b.orderId, orderId: b.orderId, at: b.paidAt, title: `Bàn ${b.tableNumber || '?'} · ${b.customerName || 'Khách'}`, amount: b.amount, accountId: b.accountId, url: b.transferImageUrl })),
    ...(data?.paperBills || []).filter(b => b.paymentMethod === 'transfer').map(b => ({ key: b.id, id: b.id, at: b.receivedAt, title: `Bill giấy${b.tableLabel ? ` · ${b.tableLabel}` : ''}`, amount: b.amount, accountId: b.accountId, url: b.transferImageUrl })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return <div className="finance receipts">
    <header className="fin-header">
      <div className="fin-title"><h1><Camera size={22} />Bill giấy</h1>
        <p>Hôm nay {data?.today ? `${data.today.slice(8)}/${data.today.slice(5, 7)}` : ''}</p></div>
      <div className="fin-header-tools">
        <button className="fin-icon" onClick={load} disabled={busy} aria-label="Tải lại"><RefreshCw size={18} className={busy ? 'fin-spin' : ''} /></button>
      </div>
    </header>

    {error && <p className="fin-error">{error}</p>}

    <form className="fin-panel rc-form" onSubmit={save}>
      <h2>Nhập bill giấy</h2>
      <PhotoPicker label="Chụp ảnh tờ bill" value={photo} onChange={p => { setPhoto(p); setFormError(''); setSaved(''); }} required />
      <label className="rc-field">Số tiền tổng
        <input inputMode="numeric" enterKeyHint="done" placeholder="0" value={amount ? Number(digits(amount)).toLocaleString('vi-VN') : ''}
          onChange={e => setAmount(digits(e.target.value))} />
      </label>
      <div className="fin-choice" role="radiogroup" aria-label="Cách trả">
        {[['cash', 'Tiền mặt'], ['transfer', 'Chuyển khoản']].map(([key, text]) =>
          <button key={key} type="button" role="radio" aria-checked={method === key} className={method === key ? 'active' : ''} onClick={() => setMethod(key)}>{text}</button>)}
      </div>
      {method === 'transfer' && <>
        <div className="rc-accounts" role="radiogroup" aria-label="Thẻ nhận tiền">
          {accounts.map(a => <button key={a.id} type="button" role="radio" aria-checked={account === a.id} className={account === a.id ? 'active' : ''}
            onClick={() => setAccount(a.id)}>{a.name}{a.last4 && <small>…{a.last4}</small>}</button>)}
        </div>
        <PhotoPicker label="Ảnh chuyển khoản (nếu có)" value={transferPhoto} onChange={setTransferPhoto} />
      </>}
      <label className="rc-field">Bàn / ghi chú
        <input value={tableLabel} onChange={e => setTableLabel(e.target.value)} placeholder="VD: Bàn 5" maxLength={40} />
      </label>
      <label className="rc-field">Ghi chú thêm
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Không bắt buộc" maxLength={200} />
      </label>
      {formError && <p className="fin-error">{formError}</p>}
      {saved && <p className="fin-saved" role="status">{saved}</p>}
      <button className="fin-primary" disabled={saving}>{saving ? 'Đang lưu...' : 'Lưu bill giấy'}</button>
    </form>

    <section className="fin-panel">
      <h2>Bill giấy hôm nay ({data?.paperBills?.length || 0})</h2>
      {data && !data.paperBills.length && <p className="fin-empty">Chưa có bill giấy.</p>}
      {(data?.paperBills || []).map(b => <div key={b.id} className="rc-item">
        {b.imageUrl ? <button className="rc-thumb" onClick={() => setView(b.imageUrl)} aria-label="Xem ảnh bill"><img src={b.imageUrl} alt="" /></button> : <span className="rc-thumb empty" />}
        <span className="rc-item-main">{clock(b.receivedAt)}{b.tableLabel ? ` · ${b.tableLabel}` : ''}
          <small>{b.paymentMethod === 'transfer' ? accountName(b.accountId) : 'Tiền mặt'}{b.createdByName ? ` · ${b.createdByName}` : ''}</small></span>
        <b>{money(b.amount)}</b>
        {(b.mine || data.me?.role === 'admin') && <button className="fin-icon danger" onClick={() => remove(b)} aria-label="Xoá"><Trash2 size={16} /></button>}
      </div>)}
    </section>

    <section className="fin-panel">
      <h2>Ảnh chuyển khoản hôm nay</h2>
      <input ref={attachInput} type="file" accept="image/*" onChange={attach} hidden />
      {data && !transferList.length && <p className="fin-empty">Chưa có bill chuyển khoản.</p>}
      {transferList.map(t => <div key={t.key} className="rc-item">
        {t.url ? <button className="rc-thumb" onClick={() => setView(t.url)} aria-label="Xem ảnh chuyển khoản"><img src={t.url} alt="" /></button> : <span className="rc-thumb empty" />}
        <span className="rc-item-main">{clock(t.at)} · {t.title}<small>{accountName(t.accountId)}</small></span>
        <b>{money(t.amount)}</b>
        <button className={t.url ? 'rc-attach done' : 'rc-attach'} onClick={() => startAttach(t)} disabled={attaching?.key === t.key}>
          {attaching?.key === t.key ? '...' : t.url ? 'Đổi ảnh' : '📷 Thêm'}
        </button>
      </div>)}
    </section>

    {view && <Viewer url={view} onClose={() => setView(null)} />}
  </div>;
}
