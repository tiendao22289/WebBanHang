'use client';

import { useEffect, useRef, useState } from 'react';
import { Banknote, Camera, ChevronDown, ChevronLeft, ChevronRight, CreditCard, PiggyBank, RefreshCw, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { compressImage, fetchWithTimeout } from '@/lib/compressImage';
import { useBackClose } from '@/lib/useBackClose';
import CameraCapture, { cameraSupported } from '@/lib/CameraCapture';
import { costParts } from '@/lib/ownerFinance.mjs';
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

// 'drink' (tên cũ trong DB) = chi trong ngày: nước ngọt, đá, gas… — tên khoản là label.
const KIND_LABEL = { drink: 'Chi trong ngày', salary: 'Lương', fixed: 'Chi cố định', custom: 'Chi khác' };
const NEW = '__new';

// Tên hiển thị của 1 khoản đã nhập: loại lương / mục cố định / tên tab tự tạo.
function entryTitle(entry, categories = []) {
  const own = categories.find(c => c.id === entry.category);
  if (entry.kind === 'salary') return `${own?.name || 'Lương'}: ${entry.label}`;
  if (entry.kind === 'custom') return own && entry.label !== own.name ? `${own.name}: ${entry.label}` : (own?.name || entry.label);
  if (entry.kind === 'fixed' || entry.kind === 'drink') return entry.label || KIND_LABEL[entry.kind];
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
  const title = scope === 'tab' ? 'Tên tab mới' : 'Tên mục chi cố định mới';
  const example = scope === 'tab' ? 'VD: Gas, Sửa chữa, Quảng cáo' : 'VD: Tiền rác, Thuế, Wifi';
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

// Chi trong ngày: chọn nhanh khoản hay chi (lưu là khoản "trong ngày", tên = khoản đã chọn).
const DAILY_PRESETS = ['Nước ngọt / bia', 'Đá', 'Gas', 'Rau / chợ', 'Ship / xe'];
const OTHER = '__other';
const shortDay = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Thêm chi, 2 phần: Chi trong ngày (mỗi ngày mỗi khác: nước ngọt, đá, gas… + tab tự tạo nhập theo ngày)
// và Chi cố định hàng tháng (tiền nhà, điện, nước, internet… + tab theo tháng — tự chia đều cho từng ngày).
function AddEntryForm({ data, month, mode, setMode, onSaved }) {
  // Mục/tab vừa tạo được giữ tạm ở đây cho tới khi danh sách tải lại xong —
  // không thì form chọn tab mới khi server chưa trả về, mất tên tab.
  const [created, setCreated] = useState([]);
  const loaded = data?.categories || [];
  const categories = [...loaded, ...created.filter(c => !loaded.some(x => x.id === c.id))];
  const active = scope => categories.filter(c => c.scope === scope && !c.archived);
  const dailyTabs = active('tab').filter(t => t.schedule !== 'monthly');
  const monthlyTabs = active('tab').filter(t => t.schedule === 'monthly');
  const ownFixed = active('fixed');

  const today = vnToday();
  const [date, setDate] = useState(today);
  const [pick, setPick] = useState(DAILY_PRESETS[0]); // tên khoản | 'tab:<id>' | OTHER
  const [fixedPick, setFixedPick] = useState('rent'); // mục cố định | id mục tự thêm | 'tab:<id>'
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(null); // 'tab' | 'fixed'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const daily = mode === 'daily';
  const tab = daily
    ? (pick.startsWith('tab:') ? categories.find(c => c.id === pick.slice(4)) : null)
    : (fixedPick.startsWith('tab:') ? categories.find(c => c.id === fixedPick.slice(4)) : null);
  // Tab đã bị ẩn (ở máy khác) → quay về khoản mặc định.
  useEffect(() => {
    if (!data) return;
    if (pick.startsWith('tab:') && !dailyTabs.some(t => `tab:${t.id}` === pick)) setPick(DAILY_PRESETS[0]);
    if (fixedPick.startsWith('tab:') && !monthlyTabs.some(t => `tab:${t.id}` === fixedPick)) setFixedPick('rent');
  }, [data, pick, fixedPick]);

  const dailyName = pick === OTHER ? label.trim() : tab ? tab.name : pick;
  const fixedOwn = ownFixed.find(c => c.id === fixedPick);
  const fixedName = tab ? tab.name : fixedOwn ? fixedOwn.name : (data?.fixedCategories || []).find(c => c.key === fixedPick)?.label || '';

  // Khoản trong ngày đã nhập cho ngày đang chọn (để thấy ngay, xoá nhầm được).
  const isDaily = e => e.kind === 'drink' || (e.kind === 'custom' && !categories.find(c => c.id === e.category && c.schedule === 'monthly'));
  const dayEntries = (data?.entries || []).filter(e => e.entry_date === date && isDaily(e));
  const dayTotal = dayEntries.reduce((s, e) => s + Number(e.amount || 0), 0);
  // Lần trước chi khoản này bao nhiêu (bấm để điền lại).
  const lastOf = name => [...(data?.entries || [])].filter(e => isDaily(e) && (e.label === name || categories.find(c => c.id === e.category)?.name === name))
    .sort((a, b) => String(b.entry_date).localeCompare(String(a.entry_date)) || String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  const last = daily && dailyName ? lastOf(dailyName) : null;

  function choose(next) {
    if (daily) setPick(next); else setFixedPick(next);
    setLabel(''); setAdding(null); setError(''); setSaved('');
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError(''); setSaved('');
    try {
      const body = daily
        ? (tab ? { kind: 'custom', category: tab.id, label: tab.name } : { kind: 'drink', label: dailyName })
        : (tab ? { kind: 'custom', category: tab.id, label: tab.name } : { kind: 'fixed', category: fixedPick, label: '' });
      if (daily && !body.label) throw new Error('Ghi khoản chi là gì (vd: Đá, Gas).');
      const { entry } = await post({ action: 'add', ...body, entry_date: date, month, amount: Number(digits(amount)), note });
      setAmount(''); setNote(''); if (pick === OTHER) setLabel('');
      setSaved(`✓ Đã thêm ${entryTitle(entry, categories)} · ${money(entry.amount)}${daily ? ` ngày ${shortDay(date)}` : ''}`);
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function remove(entry) {
    if (!confirm(`Xoá "${entryTitle(entry, categories)}" ${money(entry.amount)}?`)) return;
    try { await post({ action: 'delete', id: entry.id }); onSaved(); } catch (err) { alert(err.message); }
  }

  async function archive(category, after) {
    if (!confirm(`Ẩn "${category.name}"? Các khoản đã nhập vẫn được giữ và vẫn tính vào sổ.`)) return;
    try { await post({ action: 'archive_category', id: category.id }); after(); onSaved(); } catch (err) { alert(err.message); }
  }

  const perDay = data?.daysInMonth ? Math.round((data.fixedMonthTotal || 0) / data.daysInMonth) : 0;

  return <form className="fin-form" onSubmit={save}>
    <div className="fin-mode" role="tablist" aria-label="Loại chi">
      <button type="button" role="tab" aria-selected={daily} className={daily ? 'active' : ''} onClick={() => { setMode('daily'); setError(''); setSaved(''); }}>
        📅 Chi trong ngày<small>Mỗi ngày mỗi khác</small></button>
      <button type="button" role="tab" aria-selected={!daily} className={!daily ? 'active' : ''} onClick={() => { setMode('monthly'); setError(''); setSaved(''); }}>
        🏠 Chi cố định<small>Hàng tháng, chia đều</small></button>
    </div>

    {daily && <>
      <div className="fin-filter-row">
        <span>Ngày</span>
        <div className="fin-search-tables">
          {[[today, 'Hôm nay'], [shiftDay(today, -1), 'Hôm qua']].map(([d, t]) =>
            <button key={d} type="button" aria-pressed={date === d} className={date === d ? 'active' : ''} onClick={() => setDate(d)}>{t}</button>)}
          <input type="date" className="fin-date-pick" value={date} min={data?.startDate} max={today} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Chọn ngày khác" />
        </div>
      </div>
      <div className="fin-filter-row">
        <span>Chi gì</span>
        <div className="fin-search-tables fin-wrap">
          {DAILY_PRESETS.map(p => <button key={p} type="button" aria-pressed={pick === p} className={pick === p ? 'active' : ''} onClick={() => choose(p)}>{p}</button>)}
          {dailyTabs.map(t => <button key={t.id} type="button" aria-pressed={pick === `tab:${t.id}`} className={pick === `tab:${t.id}` ? 'active' : ''} onClick={() => choose(`tab:${t.id}`)}>{t.name}</button>)}
          <button type="button" aria-pressed={pick === OTHER} className={pick === OTHER ? 'active' : ''} onClick={() => choose(OTHER)}>Khác…</button>
          <button type="button" className="fin-chip-add" onClick={() => { setAdding(adding === 'tab' ? null : 'tab'); setError(''); }}>+ Thêm loại</button>
        </div>
      </div>
      {adding === 'tab' && <NewCategory scope="tab" onCancel={() => setAdding(null)}
        onDone={category => { setCreated(prev => [...prev, category]); setAdding(null); onSaved();
          if (category.schedule === 'monthly') { setMode('monthly'); setFixedPick(`tab:${category.id}`); } else setPick(`tab:${category.id}`); }} />}
    </>}

    {!daily && <>
      <div className="fin-fields">
        <label className="fin-wide">Mục<select value={fixedPick} onChange={e => e.target.value === NEW ? setAdding('fixed') : choose(e.target.value)}>
          {(data?.fixedCategories || []).map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          {ownFixed.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          {monthlyTabs.map(t => <option key={t.id} value={`tab:${t.id}`}>{t.name}</option>)}
          <option value={NEW}>+ Thêm mục mới...</option>
        </select></label>
      </div>
      {adding === 'fixed' && <NewCategory scope="fixed" onCancel={() => setAdding(null)}
        onDone={category => { setCreated(prev => [...prev, category]); setAdding(null); onSaved(); setFixedPick(category.id); }} />}
    </>}

    <div className="fin-fields">
      {daily && pick === OTHER && <label className="fin-wide">Nội dung<input value={label} onChange={e => setLabel(e.target.value)} placeholder="VD: Than, Khăn giấy, Sửa ống nước" maxLength={120} /></label>}
      <label>Số tiền<input inputMode="numeric" value={amount ? Number(digits(amount)).toLocaleString('vi-VN') : ''}
        onChange={e => setAmount(digits(e.target.value))} placeholder="0" enterKeyHint="done" required /></label>
      <label>Ghi chú<input value={note} onChange={e => setNote(e.target.value)} placeholder="Không bắt buộc" /></label>
    </div>
    {last && !amount && <button type="button" className="fin-link fin-last" onClick={() => setAmount(String(Math.round(Number(last.amount))))}>
      Lần trước ({shortDay(last.entry_date)}): {money(last.amount)} · bấm để điền</button>}

    {!daily && <p className="fin-hint">Ghi cho cả tháng {month.slice(5)}/{month.slice(0, 4)}, tự chia đều cho từng ngày{perDay ? ` (đang ≈ ${money(perDay)}/ngày)` : ''}.</p>}
    {error && <p className="fin-error">{error}</p>}
    {saved && <p className="fin-saved" role="status">{saved}</p>}
    <button className="fin-primary" disabled={busy}>{busy ? 'Đang lưu...' : daily ? `Thêm chi ngày ${shortDay(date)}${dailyName ? `: ${dailyName}` : ''}` : `Thêm ${fixedName.toLowerCase() || 'chi cố định'}`}</button>
    {tab && <button type="button" className="fin-link" onClick={() => archive(tab, () => (daily ? setPick(DAILY_PRESETS[0]) : setFixedPick('rent')))}>Ẩn loại "{tab.name}"</button>}
    {!daily && fixedOwn && <button type="button" className="fin-link" onClick={() => archive(fixedOwn, () => setFixedPick('rent'))}>Ẩn mục "{fixedOwn.name}"</button>}

    {daily && <div className="fin-daylist">
      <div className="fin-daylist-head"><b>Đã chi ngày {shortDay(date)}</b><b>{money(dayTotal)}</b></div>
      {dayEntries.length === 0 && <p className="fin-empty">Chưa có khoản nào.</p>}
      {dayEntries.map(entry => <div key={entry.id} className="fin-row static">
        <span>{entryTitle(entry, categories)}{entry.note && <small>{entry.note}</small>}</span>
        <span className="fin-row-end"><b>{money(entry.amount)}</b>
          <button type="button" className="fin-icon danger" onClick={() => remove(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
      </div>)}
    </div>}
    <p className="fin-hint">Lương không nhập ở đây: Sổ thu chi tự tính theo chấm công ở trang Lương. Đi chợ / nhập hàng ghi ở Sổ tay.</p>
  </form>;
}

// Chênh lệch chốt sổ: dương = thừa, âm = thiếu so với sổ.
const diffText = diff => diff === 0 ? 'Khớp ✓' : diff > 0 ? `Thừa ${money(diff)}` : `Thiếu ${money(-diff)}`;
const diffClass = diff => diff === 0 ? 'ok' : 'bad';
const dayCost = d => d.purchases + d.drinks + d.salary + d.fixedShare + d.customTotal;
// "Trong ngày 350k · Nhập hàng 1,2tr · Lương 900k · Cố định 300k" (bỏ nhóm 0đ).
const costLine = (d, categories) => {
  const p = costParts(d, categories);
  return [['Trong ngày', p.daily], ['Nhập hàng', p.purchases], ['Lương', p.salary], ['Cố định', p.fixed]]
    .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${money(v)}`).join(' · ');
};

// Nhóm gập/mở: tiêu đề + số đếm / tổng tiền luôn hiện, bấm để xem chi tiết.
function Fold({ title, sub, initial = false, children }) {
  const [open, setOpen] = useState(initial);
  return <section className="fin-fold">
    <button type="button" className="fin-fold-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <b>{title}</b><span>{sub}</span><ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
    </button>
    {open && <div className="fin-fold-body">{children}</div>}
  </section>;
}

function CloseForm({ detail, accounts, onSaved }) {
  const saved = detail.close;
  const [cash, setCash] = useState(saved?.cash_counted ?? '');
  const [bank, setBank] = useState(() => Object.fromEntries(Object.entries(saved?.bank_counted || {}).map(([k, v]) => [k, String(v)])));
  const [note, setNote] = useState(saved?.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const canClose = detail.date >= detail.startDate && detail.date <= detail.today;
  // Tài khoản có tiền trong sổ hôm đó + tài khoản đang hiện trong cài đặt.
  const accountIds = [...new Set([...Object.keys(detail.dayByAccount || {}), ...accounts.map(a => a.id)])].filter(id => id !== 'unknown');
  const name = id => { const a = accounts.find(x => x.id === id); return a ? cardLabel(a) : 'Tài khoản khác'; };

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

  const diffs = detail.closeDiff;
  const status = !saved ? 'Chưa chốt · bấm để đếm tiền két và nhập số thật'
    : [`Đã chốt ${clock(saved.closed_at)}`, diffs?.cashDiff != null ? `tiền mặt ${diffText(diffs.cashDiff).toLowerCase()}` : null,
      ...Object.entries(diffs?.bankDiffs || {}).filter(([, d]) => d !== 0).map(([id, d]) => `${name(id).split(' · ')[0]} ${diffText(d).toLowerCase()}`)].filter(Boolean).join(' · ');
  return <form className={`fin-close${saved ? '' : ' todo'}`} onSubmit={save}>
    <button type="button" className="fin-close-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <b>Chốt sổ cuối ngày</b><small>{status}</small><ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
    </button>
    {open && <>
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
    </>}
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

function DayDetail({ date, summary, accounts, categories, onClose, onChanged }) {
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

  const cardName = id => { const a = accounts.find(x => x.id === id); return a ? cardLabel(a) : 'Chuyển khoản'; };
  // Lương nhập tay kiểu cũ không còn tính (lương lấy theo chấm công).
  const typed = (detail?.entries || []).filter(e => e.kind !== 'salary');
  return <div className="fin-overlay" onClick={onClose}>
    <div className="fin-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={`Chi tiết ${dayLabel(date)}`}>
      <header><h2>{dayLabel(date)}</h2><button className="fin-icon" onClick={onClose} aria-label="Đóng"><X size={20} /></button></header>
      {error && <p className="fin-error">{error}</p>}
      {!detail && !error && <p className="fin-empty">Đang tải...</p>}
      {detail && <>
        {/* Gọn: tổng ngày trên cùng → chốt sổ (thu gọn) → từng nhóm gập/mở, có số đếm và tổng tiền. */}
        {summary && <div className="fin-daysum">
          <div className="fin-daysum-nums">
            <div><small>Thu</small><b>{money(summary.revenue)}</b></div>
            <div><small>Chi</small><b>{money(dayCost(summary))}</b></div>
            <div><small>{summary.profit < 0 ? 'Lỗ' : 'Lãi'}</small><b className={summary.profit < 0 ? 'loss' : 'gain'}>{money(Math.abs(summary.profit))}</b></div>
          </div>
          <div className="fin-daysum-money">
            <span>💵 Tiền mặt {money(summary.cash)}</span>
            {Object.entries(summary.byAccount || {}).map(([id, amount]) => <span key={id}>💳 {cardName(id)} {money(amount)}</span>)}
          </div>
          {dayCost(summary) > 0 && <div className="fin-daysum-money"><span>Chi: {costLine(summary, categories)}</span></div>}
          {summary.salary > 0 && <div className="fin-daysum-money"><span>👷 Lương theo chấm công (đã trừ vào chi)</span></div>}
        </div>}

        <CloseForm detail={detail} accounts={accounts} onSaved={async () => { await load(); onChanged(); }} />

        <Fold title="Bill đã thu" sub={`${detail.bills.length} bill · ${money(detail.bills.reduce((s, b) => s + Number(b.amount || 0), 0))}`} initial={detail.bills.length <= 6}>
          {detail.bills.length === 0 && <p className="fin-empty">Chưa có bill.</p>}
          {detail.bills.map(bill => {
            const isOpen = open === bill.order_id;
            const transfer = bill.payment_method === 'transfer';
            const photo = bill.transfer_image_url || bill.cash_image_url;
            return <div key={bill.order_id} className="fin-bill">
              {photo
                ? <button className="fin-bill-photo" onClick={() => setView(photo)} aria-label={transfer ? 'Xem ảnh CK' : 'Xem ảnh tiền mặt'}><img src={photo} alt="" draggable={false} /></button>
                : transfer
                  ? <button className="fin-bill-photo add" onClick={() => startCamera({ order_id: bill.order_id })} disabled={!!attaching} aria-label="Chụp ảnh CK"><Camera size={18} /><small>Chụp</small></button>
                  : <span className="fin-bill-photo none"><Banknote size={18} /></span>}
              <button className="fin-bill-main" onClick={() => setOpen(isOpen ? null : bill.order_id)} aria-expanded={isOpen}>
                <b>{clock(bill.paid_at)} · Bàn {bill.table_number || '?'}</b>
                <small>{bill.customer_name || 'Khách'} · {transfer ? cardName(bill.account_id) : 'Tiền mặt'}{bill.photo_skip_reason ? ' · ⚠ không ảnh' : ''}</small>
              </button>
              <div className="fin-bill-end"><b>{money(bill.amount)}</b></div>
              {isOpen && <div className="fin-bill-more">
                {bill.photo_skip_reason && <p className="fin-warn">⚠ Đóng bàn không ảnh: {bill.photo_skip_reason}{bill.photo_by ? ` (${bill.photo_by})` : ''}</p>}
                {transfer && <span className="fin-hit-add">
                  <button className="fin-ck-add primary" onClick={() => startCamera({ order_id: bill.order_id })} disabled={!!attaching}>📷 {bill.transfer_image_url ? 'Chụp lại ảnh CK' : 'Chụp ảnh CK'}</button>
                  <button className="fin-ck-add" onClick={() => startAttach({ order_id: bill.order_id })} disabled={!!attaching}>Chọn ảnh có sẵn</button>
                </span>}
                <ul className="fin-items">{(bill.items || []).map((item, i) =>
                  <li key={i}><span>{item.quantity}× {item.name || 'Món'}{item.is_gift ? ' (tặng)' : ''}</span><span>{money(item.unit_price * item.quantity)}</span></li>)}</ul>
              </div>}
            </div>;
          })}
        </Fold>

        {(detail.paperBills || []).length > 0 && <Fold title="Bill giấy" sub={`${detail.paperBills.length} bill · ${money(detail.paperBills.reduce((s, b) => s + b.amount, 0))}`} initial={detail.paperBills.length <= 6}>
          {detail.paperBills.map(b => {
            const isOpen = open === b.id;
            const photo = b.imageUrl || b.transferImageUrl;
            return <div key={b.id} className="fin-bill">
              {photo
                ? <button className="fin-bill-photo" onClick={() => setView(photo)} aria-label="Xem ảnh bill"><img src={photo} alt="" draggable={false} /></button>
                : !b.imagesPurged
                  ? <button className="fin-bill-photo add" onClick={() => startCamera({ action: 'attach_bill', receipt_id: b.id })} disabled={!!attaching} aria-label="Chụp ảnh bill"><Camera size={18} /><small>Chụp</small></button>
                  : <span className="fin-bill-photo none" title="Ảnh đã xoá sau 3 tháng"><Banknote size={18} /></span>}
              <button className="fin-bill-main" onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen}>
                <b>{clock(b.receivedAt)} · {b.tableLabel || 'Bill giấy'}</b>
                <small>{b.paymentMethod === 'transfer' ? cardName(b.accountId) : 'Tiền mặt'}{b.createdByName ? ` · ${b.createdByName}` : ''}</small>
              </button>
              <div className="fin-bill-end"><b>{money(b.amount)}</b></div>
              {isOpen && <div className="fin-bill-more">
                {b.note && <p>{b.note}</p>}
                {b.imageUrl && b.transferImageUrl && <button className="fin-hit-photo" onClick={() => setView(b.transferImageUrl)}><img src={b.transferImageUrl} alt="" draggable={false} /><span>Ảnh CK</span></button>}
                <span className="fin-hit-add">
                  {!b.imagesPurged && <button className="fin-ck-add" onClick={() => startAttach({ action: 'attach_bill', receipt_id: b.id })} disabled={!!attaching}>Chọn ảnh bill</button>}
                  {b.paymentMethod === 'transfer' && <button className="fin-ck-add primary" onClick={() => startCamera({ receipt_id: b.id })} disabled={!!attaching}>📷 {b.transferImageUrl ? 'Chụp lại ảnh CK' : 'Chụp ảnh CK'}</button>}
                  <button className="fin-ck-add danger" onClick={() => removePaper(b)}><Trash2 size={14} /> Xoá bill giấy</button>
                </span>
              </div>}
            </div>;
          })}
        </Fold>}

        <Fold title="Đi chợ / nhập hàng (Sổ tay)" sub={detail.notes.length ? `${detail.notes.length} phiếu · ${money(detail.notes.reduce((s, n) => s + n.cost, 0))}` : 'Không có phiếu'} initial>
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
        </Fold>

        <Fold title="Khoản tự nhập" sub={typed.length ? `${typed.length} khoản · ${money(typed.reduce((s, e) => s + Number(e.amount || 0), 0))}` : 'Chưa có (nhập ở tab Thêm chi)'} initial>
          {typed.map(entry => <div key={entry.id} className="fin-row static">
            <span>{entryTitle(entry, categories)}{entry.note && <small>{entry.note}</small>}</span>
            <span className="fin-row-end"><b>{money(entry.amount)}</b>
              <button className="fin-icon danger" onClick={() => remove(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
          </div>)}
        </Fold>
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
// Khoảng ngày chọn nhanh ở Tra cứu; 'custom' = tự chọn 2 ô ngày.
const RANGES = [['today', 'Hôm nay'], ['yesterday', 'Hôm qua'], ['7d', '7 ngày'], ['month', 'Tháng này'], ['custom', 'Tự chọn']];
function rangeDates(key, today) {
  const monthStart = today.slice(0, 8) + '01';
  if (key === 'today') return { from: today, to: today };
  if (key === 'yesterday') { const d = addDaysLocal(today, -1); return { from: d, to: d }; }
  if (key === 'month') return { from: monthStart < FIRST_MONTH + '-01' ? FIRST_MONTH + '-01' : monthStart, to: today };
  return { from: addDaysLocal(today, -6), to: today };
}
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
  const [more, setMore] = useState(false);
  const [customRange, setCustomRange] = useState(false);
  useBackClose(!!view, () => setView(null));
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
  const rangeKey = customRange ? 'custom'
    : RANGES.slice(0, 4).map(([k]) => k).find(k => { const r = rangeDates(k, today); return r.from === from && r.to === to; }) || 'custom';
  function pickRange(key) {
    setCustomRange(key === 'custom');
    if (key !== 'custom') search(null, rangeDates(key, today));
  }
  // Bộ lọc đang bật trong "Lọc thêm" (để không quên khi đã thu gọn).
  const moreCount = (account ? 1 : 0) + (photo !== 'all' ? 1 : 0) + (check !== 'all' ? 1 : 0);
  return <section className="fin-section">
    {/* Gọn: chọn nhanh khoảng ngày · 1 hàng tìm bàn / số tiền · loại bill · "Lọc thêm" (thẻ, ảnh, đối chiếu, bàn). */}
    <form className="fin-panel fin-search" onSubmit={search}>
      <div className="fin-seg" role="radiogroup" aria-label="Khoảng ngày">
        {RANGES.map(([k, t]) => <button key={k} type="button" role="radio" aria-checked={rangeKey === k}
          className={rangeKey === k ? 'active' : ''} onClick={() => pickRange(k)}>{t}</button>)}
      </div>
      {rangeKey === 'custom' && <div className="fin-search-dates">
        <input type="date" aria-label="Từ ngày" value={from} min={FIRST_MONTH + '-01'} max={to} onChange={e => e.target.value && set({ from: e.target.value })} />
        <span>→</span>
        <input type="date" aria-label="Đến ngày" value={to} min={from} max={today} onChange={e => e.target.value && set({ to: e.target.value })} />
      </div>}
      <div className="fin-search-row">
        <input value={table} onChange={e => set({ table: e.target.value })} placeholder="Số bàn" aria-label="Bàn" inputMode="text" enterKeyHint="search" />
        <input inputMode="numeric" value={amount ? Number(digits(amount)).toLocaleString('vi-VN') : ''} onChange={e => set({ amount: digits(e.target.value) })}
          placeholder="Số tiền" aria-label="Số tiền" enterKeyHint="search" />
        <button className="fin-search-go" disabled={busy}><Search size={17} />{busy ? '...' : 'Tìm'}</button>
      </div>
      <div className="fin-search-types" role="radiogroup" aria-label="Loại bill">
        {[['all', 'Tất cả'], ['transfer', 'Chuyển khoản'], ['cash', 'Tiền mặt'], ['paper', 'Bill giấy']].map(([k, t]) =>
          <button key={k} type="button" role="radio" aria-checked={type === k} className={type === k ? 'active' : ''} onClick={() => search(null, { type: k })}>{t}</button>)}
      </div>
      <button type="button" className={`fin-more${moreCount ? ' on' : ''}`} onClick={() => setMore(m => !m)} aria-expanded={more}>
        <SlidersHorizontal size={15} /><span>Lọc thêm{moreCount ? ` · đang bật ${moreCount}` : ': thẻ, ảnh, đối chiếu, bàn'}</span>
        <ChevronDown size={15} style={{ transform: more ? 'rotate(180deg)' : 'none' }} />
      </button>
      {more && <>
        {accounts.length > 0 && <Chips label="Thẻ" value={account} options={[['', 'Mọi thẻ'], ...accounts.map(a => [a.id, cardLabel(a)])]}
          onPick={id => search(null, { account: id })} />}
        <Chips label="Ảnh" value={photo} options={[['all', 'Tất cả'], ['has', 'Có ảnh'], ['missing', 'Chưa có ảnh CK']]} onPick={k => search(null, { photo: k })} />
        <Chips label="Đối chiếu" value={check} options={[['all', 'Tất cả'], ['unchecked', 'Chưa đối chiếu'], ['checked', 'Đã đối chiếu']]} onPick={k => search(null, { check: k })} />
        {result?.tables?.length > 0 && <Chips label="Bàn có bill" value={result.tables.find(t => t.name.toLowerCase() === normTable)?.name || (normTable ? null : '')}
          options={[['', 'Tất cả bàn'], ...result.tables.map(t => [t.name, <>{/^\d/.test(t.name) ? `Bàn ${t.name}` : t.name}<small>{t.count}</small></>])]}
          onPick={name => search(null, { table: name })} />}
      </>}
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
          const photo = r.transferImageUrl || r.cashImageUrl || r.billImageUrl;
          return <div key={`${r.kind}-${r.id}`} className={`fin-bill${r.verifiedAt ? ' verified' : ''}`}>
            {photo
              ? <button className="fin-bill-photo" onClick={() => setView(photo)} aria-label={r.transferImageUrl ? 'Xem ảnh CK' : r.cashImageUrl ? 'Xem ảnh tiền mặt' : 'Xem ảnh bill'}><img src={photo} alt="" draggable={false} /></button>
              : ckMissing
                ? <button className="fin-bill-photo add" onClick={() => startCamera(r)} disabled={saving === r.id} aria-label="Chụp ảnh CK"><Camera size={18} /><small>Chụp</small></button>
                : <span className="fin-bill-photo none" title={r.imageExpired ? 'Ảnh đã xoá sau 3 tháng' : ''}>{r.method === 'transfer' ? <CreditCard size={18} /> : <Banknote size={18} />}</span>}
            <button className="fin-bill-main" onClick={() => setOpen(isOpen ? null : `${r.kind}-${r.id}`)} aria-expanded={isOpen}>
              <b>{clock(r.at)} · {r.kind === 'paper' && !/^\d/.test(r.table || '') ? (r.table || 'Bill giấy') : `Bàn ${r.table || '?'}`}</b>
              <small>{r.kind === 'paper' ? 'Bill giấy' : (r.customer || 'Khách')} · {r.method === 'transfer' ? cardName(r.accountId) : 'Tiền mặt'}{r.skipReason ? ' · ⚠ không ảnh' : ''}</small>
            </button>
            <div className="fin-bill-end">
              <b>{money(r.amount)}</b>
              {r.method === 'transfer' && <button className={`fin-bill-check${r.verifiedAt ? ' on' : ''}`} onClick={() => toggleVerify(r)} disabled={saving === r.id} aria-pressed={!!r.verifiedAt}>
                {r.verifiedAt ? '✓ Đã đối chiếu' : 'Đối chiếu'}</button>}
            </div>
            {isOpen && <div className="fin-bill-more">
              {r.by && <p>Người nhập: {r.by}</p>}
              {r.skipReason && <p className="fin-warn">⚠ Đóng bàn không ảnh: {r.skipReason}{r.photoBy ? ` (${r.photoBy})` : ''}</p>}
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
  const [custom, setCustom] = useState(false);
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

  const yesterday = addDaysLocal(today, -1);
  const presets = [['today', 'Hôm nay', { from: today, to: today }], ['yesterday', 'Hôm qua', { from: yesterday, to: yesterday }],
    ['7', '7 ngày', { from: addDaysLocal(today, -6), to: today }], ['month', 'Cả tháng', { from: monthFrom, to: monthTo }], ['custom', 'Tự chọn', null]];
  const presetKey = custom ? 'custom' : presets.find(([, , r]) => r && r.from === range.from && r.to === range.to)?.[0] || 'custom';
  const t = data?.totals;
  const soldBy = key => data.sold.find(s => s.key === key);
  const boughtBy = key => data.bought.find(b => b.key === key);
  const groupName = id => data.groups.find(g => g.id === id)?.name;

  return <section className="fin-section">
    <div className="fin-panel fin-search">
      <div className="fin-seg" role="radiogroup" aria-label="Khoảng ngày">
        {presets.map(([k, text, r]) => <button key={k} type="button" role="radio" aria-checked={presetKey === k} className={presetKey === k ? 'active' : ''}
          onClick={() => { setCustom(k === 'custom'); if (r) setRange(r); }}>{text}</button>)}
      </div>
      {presetKey === 'custom' && <div className="fin-search-dates">
        <input type="date" aria-label="Từ ngày" value={range.from} min={FIRST_MONTH + '-01'} max={range.to} onChange={e => e.target.value && setRange(r => ({ ...r, from: e.target.value }))} />
        <span>→</span>
        <input type="date" aria-label="Đến ngày" value={range.to} min={range.from} max={today} onChange={e => e.target.value && setRange(r => ({ ...r, to: e.target.value }))} />
      </div>}
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
  // Thêm chi: 'daily' (chi trong ngày) | 'monthly' (chi cố định hàng tháng).
  const [addMode, setAddMode] = useState('daily');
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
  const shortAccount = id => { const a = accounts.find(x => x.id === id); return a ? cardLabel(a) : 'Không rõ tài khoản'; };
  const days = [...(data?.days || [])].reverse();
  // Tab tự tạo: đang dùng, hoặc đã ẩn nhưng tháng này còn tiền (để tổng vẫn khớp).
  const customTabs = (data?.categories || []).filter(c => c.scope === 'tab' && (!c.archived || data?.totals?.custom?.[c.id]));
  const totalCost = t ? t.purchases + t.drinks + t.salary + t.fixedShare + t.customTotal : 0;
  // Các khoản chi của tháng — dòng 0đ của tab tự tạo thì ẩn cho gọn.
  const costRows = t ? [
    { key: 'purchases', name: 'Nhập hàng (Sổ tay)', amount: t.purchases },
    { key: 'drinks', name: 'Chi trong ngày', sub: 'nước ngọt, đá, gas… nhập ở Thêm chi', amount: t.drinks },
    { key: 'salary', name: 'Lương (theo chấm công)', amount: t.salary,
      sub: !data.wagesReady ? 'Chưa đọc được chấm công, thử tải lại' : t.salaryExtra ? `gồm thưởng − phạt cả tháng ${t.salaryExtra > 0 ? '+' : '-'}${money(Math.abs(t.salaryExtra))}` : '' },
    { key: 'fixed', name: 'Chi cố định (chia đều mỗi ngày)', amount: t.fixedShare, sub: data.fixedMonthTotal ? `cả tháng ${money(data.fixedMonthTotal)}, đã tính tới hôm nay` : '' },
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
            <span key={id} className="fin-tag bad">{shortAccount(id)}: {diffText(diff)}</span>)}
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

      {today && <button className="fin-day fin-day-today" onClick={() => setDay(today.date)}>
        <div className="fin-day-head">
          <span className="fin-day-date"><b>Hôm nay</b><small>{today.bills} bill{today.paperBills ? ` + ${today.paperBills} bill giấy` : ''} · bấm để xem bill, chốt sổ</small></span>
          <ChevronRight size={18} />
        </div>
        <div className="fin-day-nums">
          <span><small>Thu</small>{money(today.revenue)}</span>
          <span><small>Chi</small>{money(dayCost(today))}</span>
          <span className={today.profit < 0 ? 'loss' : 'gain'}><small>{today.profit < 0 ? 'Lỗ' : 'Lãi'}</small>{money(Math.abs(today.profit))}</span>
        </div>
      </button>}

      {/* Mọi việc cần xem lại trong tháng, gom 1 chỗ; bấm là mở đúng danh sách. */}
      {((t.mismatchNotes > 0 || t.suspiciousNotes > 0) || (pendingCk && (pendingCk.missingPhoto > 0 || pendingCk.unchecked > 0))) && <section className="fin-pending">
        <b>Cần xem lại tháng {monthText}</b>
        {pendingCk?.missingPhoto > 0 && <button onClick={() => openSearch({ ...monthRange, photo: 'missing' })}>📷 {pendingCk.missingPhoto} bill chuyển khoản chưa có ảnh <ChevronRight size={16} /></button>}
        {pendingCk?.unchecked > 0 && <button onClick={() => openSearch({ ...monthRange, check: 'unchecked' })}>☐ {pendingCk.unchecked} bill chuyển khoản chưa đối chiếu <ChevronRight size={16} /></button>}
        {(t.mismatchNotes > 0 || t.suspiciousNotes > 0) && <button onClick={() => chooseView('days')}>⚠ {[t.mismatchNotes > 0 && `${t.mismatchNotes} phiếu Sổ tay lệch tiền`, t.suspiciousNotes > 0 && `${t.suspiciousNotes} phiếu Sổ tay giá / số lượng đáng ngờ`].filter(Boolean).join(' · ')} <ChevronRight size={16} /></button>}
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
            <span className="fin-day-date"><b>{dayLabel(d.date)}</b><small>{d.bills} bill{d.paperBills ? ` + ${d.paperBills} bill giấy` : ''}</small></span>
            <ChevronRight size={16} />
          </div>
          {/* 3 cột thẳng hàng giữa các ngày để so nhanh. */}
          <div className="fin-day-nums">
            <span><small>Thu</small>{money(d.revenue)}</span>
            <span><small>Chi</small>{money(dayCost(d))}</span>
            <span className={d.profit < 0 ? 'loss' : 'gain'}><small>{d.profit < 0 ? 'Lỗ' : 'Lãi'}</small>{money(Math.abs(d.profit))}</span>
          </div>
          {dayCost(d) > 0 && <p className="fin-day-cost">Chi: {costLine(d, data?.categories || [])}</p>}
          <div className="fin-day-tags">{dayTags(d)}</div>
        </button>)}
      </div>
    </section>}

    {view === 'items' && <ItemsView month={month} today={data?.today || vnToday()} />}

    {view === 'search' && <SearchView key={searchPreset.key} accounts={accounts} preset={searchPreset.filters} />}

    {view === 'add' && <section className="fin-section">
      <AddEntryForm data={data} month={month} mode={addMode} setMode={setAddMode} onSaved={load} />
      {addMode === 'monthly' && data && !data.fixedEntries?.length && month > '2026-10' && <button className="fin-secondary" onClick={copyFixed} disabled={busy}>
        Chép chi cố định từ tháng trước
      </button>}
      {addMode === 'monthly' && data?.fixedEntries?.length > 0 && <details className="fin-fixed" open>
        <summary>Chi cố định tháng {monthText}<b>{money(data.fixedMonthTotal)}</b></summary>
        {data.fixedEntries.map(entry => <div key={entry.id} className="fin-row static">
          <span>{entry.label}{entry.note && <small>{entry.note}</small>}</span>
          <span className="fin-row-end"><b>{money(entry.amount)}</b>
            <button className="fin-icon danger" onClick={() => removeFixed(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
        </div>)}
      </details>}
      {addMode === 'monthly' && data?.customMonthlyEntries?.length > 0 && <details className="fin-fixed" open>
        <summary>Khoản theo tháng {monthText}</summary>
        {data.customMonthlyEntries.map(entry => <div key={entry.id} className="fin-row static">
          <span>{entryTitle(entry, data.categories)}{entry.note && <small>{entry.note}</small>}</span>
          <span className="fin-row-end"><b>{money(entry.amount)}</b>
            <button className="fin-icon danger" onClick={() => removeFixed(entry)} aria-label="Xoá"><Trash2 size={16} /></button></span>
        </div>)}
      </details>}
    </section>}

    {day && <DayDetail date={day} summary={data?.days?.find(d => d.date === day)} accounts={accounts} categories={data?.categories || []} onClose={() => setDay(null)} onChanged={load} />}
  </div>;
}
