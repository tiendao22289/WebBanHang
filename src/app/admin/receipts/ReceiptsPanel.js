'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, Images, RefreshCw, Trash2, X } from 'lucide-react';
import { compressImage, fetchWithTimeout } from '@/lib/compressImage';
import { useBackClose } from '@/lib/useBackClose';
import CameraCapture, { cameraSupported } from '@/lib/CameraCapture';
import '../finance/finance.css';
import './receipts.css';

// Bill giấy (nhập bill giấy + ảnh CK hôm nay) — giờ là tab "Bill giấy" của trang Mã QR (/admin/qr?tab=bill).
// embedded: nằm trong trang Mã QR (tiêu đề gọn, không có nút đóng riêng).

const money = value => `${Math.round(Number(value || 0)).toLocaleString('vi-VN')}đ`;
const clock = value => new Date(value).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
const digits = value => String(value || '').replace(/\D/g, '');

async function send(form) {
  const response = await fetchWithTimeout('/api/admin/receipts', { method: 'POST', body: form, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw new Error(result.error || 'Không kết nối được máy chủ.');
  return result;
}

// Ảnh bill giấy: CHỈ chụp trực tiếp trong web (CameraCapture) — ảnh không lưu
// vào điện thoại, và không dùng lại được ảnh cũ trong máy. Ảnh chuyển khoản:
// cho chọn ảnh màn hình có sẵn (allowGallery) hoặc chụp trong web.
// Máy không mở được camera trong web (trình duyệt quá cũ) thì mới dùng camera
// của máy làm dự phòng. Trả về blob + ảnh xem trước.
function PhotoPicker({ label, value, onChange, required, allowGallery, cameraText = 'Chụp ảnh' }) {
  const fallbackCamera = useRef(null);
  const gallery = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function accept(blob) {
    if (value?.preview) URL.revokeObjectURL(value.preview);
    onChange({ blob, preview: URL.createObjectURL(blob), size: blob.size });
  }
  async function pick(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try { accept(await compressImage(file)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function openCamera() {
    setError('');
    if (cameraSupported()) setCameraOpen(true); else fallbackCamera.current.click();
  }
  return <div className="rc-photo">
    <input ref={fallbackCamera} type="file" accept="image/*" capture="environment" onChange={pick} hidden />
    {allowGallery && <input ref={gallery} type="file" accept="image/*" onChange={pick} hidden />}
    {value
      ? <div className="rc-photo-preview">
          <img src={value.preview} alt={label} draggable={false} onContextMenu={e => e.preventDefault()} />
          <div><b>{label}</b><small>{Math.round(value.size / 1024)}KB</small>
            <button type="button" className="fin-ghost" onClick={openCamera}>Chụp lại</button></div>
        </div>
      : <div className={`rc-photo-pick ${required ? 'required' : ''}`}>
          <span className="rc-photo-label">{busy ? 'Đang xử lý ảnh...' : label}{required && <small>bắt buộc · chụp trực tiếp, không lưu vào máy</small>}</span>
          <div className={allowGallery ? 'rc-photo-actions' : 'rc-photo-actions single'}>
            <button type="button" onClick={openCamera} disabled={busy}><Camera size={20} />{cameraText}</button>
            {allowGallery && <button type="button" onClick={() => gallery.current.click()} disabled={busy}><Images size={20} />Chọn ảnh có sẵn</button>}
          </div>
        </div>}
    {error && <p className="fin-error">{error}</p>}
    {cameraOpen && <CameraCapture onCapture={accept} onClose={() => setCameraOpen(false)} />}
  </div>;
}

function Viewer({ url, onClose }) {
  useBackClose(true, onClose);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <div className="rc-viewer" onClick={onClose} onContextMenu={e => e.preventDefault()} role="dialog" aria-label="Xem ảnh">
    <button className="fin-icon" aria-label="Đóng"><X size={20} /></button>
    <img src={url} alt="Ảnh bill" draggable={false} />
  </div>;
}

export default function ReceiptsPanel({ embedded = false }) {
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
      const response = await fetchWithTimeout('/api/admin/receipts', { cache: 'no-store' }, 20000);
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

  // Ảnh CK cho 1 bill: chụp màn hình ĐT khách ngay trong web (không lưu vào
  // máy) hoặc chọn ảnh có sẵn (khách gửi qua Zalo). target.bill: ảnh tờ bill
  // chụp bổ sung cho bill giấy chưa có ảnh (bill từ trang Mã QR).
  const [cameraFor, setCameraFor] = useState(null);
  async function uploadProof(target, blob) {
    setAttaching(target);
    try {
      const form = new FormData();
      form.set('action', target.bill ? 'attach_bill' : 'attach_transfer');
      form.set(target.orderId ? 'order_id' : 'receipt_id', target.orderId || target.id);
      form.set('image', blob, target.bill ? 'bill.jpg' : 'ck.jpg');
      await send(form); await load();
    } catch (err) { alert(err.message); } finally { setAttaching(null); }
  }
  function startCamera(target) { if (cameraSupported()) setCameraFor(target); else { pendingGallery.current = target; attachCapture.current.click(); } }
  function startGallery(target) { pendingGallery.current = target; attachInput.current.click(); }
  const pendingGallery = useRef(null);
  const attachCapture = useRef(null);
  async function attach(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const target = pendingGallery.current;
    pendingGallery.current = null;
    if (!file || !target) return;
    try { await uploadProof(target, await compressImage(file)); } catch (err) { alert(err.message); }
  }

  const accounts = data?.accounts || [];
  const accountName = id => accounts.find(a => a.id === id)?.name || 'Chuyển khoản';
  const transferList = [
    ...(data?.transferBills || []).map(b => ({ key: b.orderId, orderId: b.orderId, at: b.paidAt, title: `Bàn ${b.tableNumber || '?'} · ${b.customerName || 'Khách'}`, amount: b.amount, accountId: b.accountId, url: b.transferImageUrl })),
    ...(data?.paperBills || []).filter(b => b.paymentMethod === 'transfer').map(b => ({ key: b.id, id: b.id, at: b.receivedAt, title: `Bill giấy${b.tableLabel ? ` · ${b.tableLabel}` : ''}`, amount: b.amount, accountId: b.accountId, url: b.transferImageUrl })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return <div className={`finance receipts${embedded ? ' embedded' : ''}`}>
    <header className="fin-header">
      <div className="fin-title"><h1><Camera size={22} />{embedded ? 'Bill giấy hôm nay' : 'Bill giấy'}</h1>
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
        <PhotoPicker label="Ảnh chuyển khoản trên điện thoại khách (nếu có)" value={transferPhoto} onChange={setTransferPhoto} allowGallery cameraText="Chụp ĐT khách" />
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
      {(data?.paperBills || []).map(b => <div key={b.id} className="rc-ck-block">
        <div className="rc-item">
          {b.imageUrl ? <button className="rc-thumb" onClick={() => setView(b.imageUrl)} aria-label="Xem ảnh bill"><img src={b.imageUrl} alt="" /></button> : <span className="rc-thumb empty" />}
          <span className="rc-item-main">{clock(b.receivedAt)}{b.tableLabel ? ` · ${b.tableLabel}` : ''}
            <small>{b.paymentMethod === 'transfer' ? accountName(b.accountId) : 'Tiền mặt'}{b.createdByName ? ` · ${b.createdByName}` : ''}{b.imageUrl || b.transferImageUrl ? '' : ' · chưa có ảnh bill'}</small></span>
          <b>{money(b.amount)}</b>
          {/* Bill giấy đã lưu: chỉ chủ quán xoá được (nhân viên nhập sai thì báo chủ quán). */}
          {data.me?.role === 'admin' && <button className="fin-icon danger" onClick={() => remove(b)} aria-label="Xoá"><Trash2 size={16} /></button>}
        </div>
        {!b.imageUrl && !b.transferImageUrl && <div className="rc-ck-actions">
          {attaching?.key === `bill-${b.id}` ? <span className="rc-ck-busy">Đang gửi ảnh...</span> : <>
            <button className="rc-attach" onClick={() => startCamera({ key: `bill-${b.id}`, id: b.id, bill: true })}>📷 Chụp tờ bill</button>
            <button className="rc-attach done" onClick={() => startGallery({ key: `bill-${b.id}`, id: b.id, bill: true })}>Chọn ảnh có sẵn</button>
          </>}
        </div>}
      </div>)}
    </section>

    <section className="fin-panel">
      <h2>Ảnh chuyển khoản hôm nay</h2>
      <input ref={attachInput} type="file" accept="image/*" onChange={attach} hidden />
      <input ref={attachCapture} type="file" accept="image/*" capture="environment" onChange={attach} hidden />
      {data && !transferList.length && <p className="fin-empty">Chưa có bill chuyển khoản.</p>}
      {transferList.map(t => <div key={t.key} className="rc-ck-block">
        <div className="rc-item">
          {t.url ? <button className="rc-thumb" onClick={() => setView(t.url)} aria-label="Xem ảnh chuyển khoản"><img src={t.url} alt="" /></button> : <span className="rc-thumb empty" />}
          <span className="rc-item-main">{clock(t.at)} · {t.title}<small>{accountName(t.accountId)}{t.url ? ' · ✓ có ảnh CK' : ''}</small></span>
          <b>{money(t.amount)}</b>
        </div>
        {/* Đã có ảnh CK: chỉ chủ quán được chụp lại; nhân viên chỉ thêm ảnh còn thiếu. */}
        {(!t.url || data.me?.role === 'admin') && <div className="rc-ck-actions">
          {attaching?.key === t.key ? <span className="rc-ck-busy">Đang gửi ảnh...</span> : <>
            <button className="rc-attach" onClick={() => startCamera(t)}>📷 {t.url ? 'Chụp lại' : 'Chụp ĐT khách'}</button>
            <button className="rc-attach done" onClick={() => startGallery(t)}>Chọn ảnh có sẵn</button>
          </>}
        </div>}
      </div>)}
    </section>

    {view && <Viewer url={view} onClose={() => setView(null)} />}
    {cameraFor && <CameraCapture onCapture={blob => uploadProof(cameraFor, blob)} onClose={() => setCameraFor(null)} />}
  </div>;
}
