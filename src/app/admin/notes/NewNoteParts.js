'use client';
/**
 * Các phần của form "Phiếu đi chợ mới" (Sổ tay), bản gọn: mỗi dòng hàng một hàng ngang
 * (tên · giá · số lượng · Đủ/Nợ), dòng phụ nhỏ chỉ khi có thành tiền / nợ / loại Khác / cảnh báo.
 * Tiền tính bằng notesMath như máy chủ ("2,5kg" = 2,5 · "250k" = 250.000đ, bỏ trống số lượng = 1).
 */
import { X } from 'lucide-react';
import MenuNameInput from '@/lib/MenuNameInput';
import { lineWarnings, parsePrice, parseQty } from '@/lib/notesMath.mjs';
import { MAX_NOTE_PHOTOS, priceAlertText } from '@/lib/notesChecks.mjs';
import { CategorySelect, isOtherLine } from './NoteKinds';

export const vnd = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const lineTotal = i => Math.round(parsePrice(i.price) * parseQty(i.qty));
const digits = v => String(v ?? '').replace(/\D/g, '');

/** Một bước của phiếu: số thứ tự, tên, phần bên phải (số tiền / nút). */
export function Section({ step, title, aside, className = '', children }) {
  return <section className={`np-section ${className}`}>
    <div className="np-section-head">
      {step && <span className="np-step">{step}</span>}
      <b>{title}</b>
      {aside !== undefined && aside !== null && aside !== false && <span className="np-aside">{aside}</span>}
    </div>
    {children}
  </section>;
}

/** Ô tiền: chỉ nhận số, tự chấm hàng nghìn ("500000" → "500.000"). */
export function MoneyInput({ id, value, onChange, placeholder, className = '' }) {
  return <span className={`np-money ${className}`}>
    <input id={id} type="text" inputMode="numeric" placeholder={placeholder} value={value}
      onChange={e => { const raw = digits(e.target.value); onChange(raw ? Number(raw).toLocaleString('vi-VN') : ''); }} />
    <span aria-hidden="true">đ</span>
  </span>;
}

/** Tên cột nhỏ phía trên các dòng hàng. */
export const ItemsHead = () => <div className="np-cols" aria-hidden="true"><span>Tên hàng</span><span>Giá</span><span>SL</span><span>Trả</span><span /></div>;

/**
 * Một dòng hàng. Dòng trống là dòng "＋ Thêm hàng" / "＋ Thêm khác" (viền đứt): gõ tên thì tự thêm dòng
 * trống mới. Dòng có sẵn (Tiền rau, Tiền gia vị) để trống giá thì không lưu. Bấm "Đủ" / "Nợ" để đổi.
 * other: dòng nhóm Khác (xăng xe, sửa chữa…) — tên gõ tự do, dòng nhỏ bên dưới để chọn loại.
 * alert: giá cao bất thường so với các lần mua trước (notesChecks) — hiện đầu tiên, chủ cũng thấy.
 * bill: ô bill của mối cho dòng có giá { required, photo, saved, reason, onShoot, onNoBill, onClear } (BillCell).
 */
export function NoteItemRow({ item, other, alert, bill, menuNames, categories, onField, onBlur, onRemove, onCategory }) {
  const empty = !item.preset && !String(item.name || '').trim() && !String(item.price || '').trim() && !String(item.qty || '').trim();
  const total = lineTotal(item);
  const debt = item.paymentStatus === 'debt';
  const warnings = String(item.name || '').trim() ? [...(alert ? [`${priceAlertText(alert)} — chủ sẽ thấy`] : []), ...lineWarnings(item)] : [];
  // minWidth 0: ô tên co lại trong cột lưới, không đẩy ô giá / số lượng ra ngoài.
  const nameProps = { className: 'np-name', style: { minWidth: 0 }, value: item.name, placeholder: empty ? (other ? '＋ Thêm khác: xăng, sửa xe…' : '＋ Thêm hàng') : 'Tên' };
  // Dòng phụ chỉ khi cần: chọn loại (nhóm Khác), số nợ / nợ ai, cảnh báo. Thành tiền nằm ngay dưới tên.
  const sub = !empty && (other || debt || warnings.length > 0 || !!bill);
  return <div className={`np-row${empty ? ' add' : ''}${debt ? ' debt' : ''}${item.preset && !total ? ' idle' : ''}`}>
    <div className="np-line">
      <span className="np-name-cell">
        {item.preset
          ? <span className="np-name fixed">{item.name}</span>
          : other
            ? <input type="text" {...nameProps} onChange={e => onField('name', e.target.value)} />
            : <MenuNameInput names={menuNames} {...nameProps} onChange={v => onField('name', v)} />}
        {total > 0 && <small className={`np-total${debt ? ' debt' : ''}`}>{vnd(total)}{debt ? ' · nợ' : ''}</small>}
      </span>
      <input type="text" className="np-cell" placeholder="Giá" aria-label="Giá" value={item.price} onChange={e => onField('price', e.target.value)} onBlur={e => onBlur('price', e)} />
      <input type="text" className="np-cell" placeholder="SL" aria-label="Số lượng" value={item.qty} onChange={e => onField('qty', e.target.value)} onBlur={e => onBlur('qty', e)} />
      {empty
        ? <span className="np-pay-space" />
        : <button type="button" className={`np-pay${debt ? ' debt' : ''}`} aria-label={debt ? 'Đang ghi nợ, bấm để đổi thành trả đủ' : 'Đã trả đủ, bấm để ghi nợ'}
            onClick={() => onField('paymentStatus', debt ? 'full' : 'debt')}>{debt ? 'Nợ' : 'Đủ'}</button>}
      {!empty && !item.preset
        ? <button type="button" className="np-x" onClick={onRemove} aria-label={`Xoá ${item.name || 'dòng'}`}><X size={14} /></button>
        : <span className="np-x-space" />}
    </div>
    {sub && <div className="np-sub">
      {other && <CategorySelect value={item.category} categories={categories} onChange={onCategory} />}
      {debt && <>
        <input type="text" inputMode="numeric" className="np-mini-input debt" aria-label="Số tiền nợ" value={item.debtAmount || ''}
          placeholder={total > 0 ? `Nợ ${total.toLocaleString('vi-VN')}` : 'Nợ bao nhiêu'}
          onChange={e => { const n = Number(digits(e.target.value)); onField('debtAmount', !n ? '' : (total > 0 ? Math.min(n, total) : n).toLocaleString('vi-VN')); }} />
        <input type="text" className="np-mini-input" placeholder="Nợ ai?" aria-label="Nợ của ai" value={item.creditor || ''} onChange={e => onField('creditor', e.target.value)} />
      </>}
      {bill && <BillCell {...bill} />}
      {warnings.length > 0 && <span className={`np-warn${alert ? ' price' : ''}`} title={warnings.join(' · ')}>⚠ {warnings[0]}</span>}
    </div>}
  </div>;
}

/**
 * Mọi dòng hàng của phiếu trong một danh sách, chia 3 nhóm: hàng ốc (gõ thêm ở dòng "＋ Thêm hàng"),
 * rau / gia vị (dòng có sẵn), Khác (xăng xe, sửa chữa… — chọn loại ở từng dòng). Hàm on*(vị trí trong items, …).
 * priceCheck(item): cảnh báo giá cao của dòng (hoặc null). billFor(item, vị trí): ô bill của dòng (hoặc null).
 */
export function NoteItemsList({ items, menuNames, categories, onField, onBlur, onRemove, onCategory, isAdmin, priceCheck, billFor }) {
  const rows = items.map((item, idx) => ({ item, idx }));
  const groups = [
    [null, rows.filter(({ item }) => !item.preset && !isOtherLine(item))],
    ['Rau, gia vị · có mua thì ghi giá', rows.filter(({ item }) => item.preset)],
    [`Khác · xăng xe, sửa chữa, đồ dùng…${!categories.length && isAdmin ? ' (tạo loại ở tab "📦 Chi khác")' : ''}`, rows.filter(({ item }) => isOtherLine(item))],
  ];
  return <>
    <ItemsHead />
    <div className="np-items">
      {groups.map(([label, list]) => list.length > 0 && <div key={label || 'oc'} className="np-group">
        {label && <p className="np-group-label">{label}</p>}
        {list.map(({ item, idx }) => <NoteItemRow key={item._id || idx} item={item} other={isOtherLine(item)} alert={priceCheck?.(item) || null} bill={billFor?.(item, idx) || null} menuNames={menuNames} categories={categories}
          onField={(field, v) => onField(idx, field, v)} onBlur={(field, e) => onBlur(idx, field, e)}
          onRemove={() => onRemove(idx)} onCategory={v => onCategory(idx, v)} />)}
      </div>)}
    </div>
  </>;
}

/**
 * Tổng kết chuyến chợ như hoá đơn (gọn): tiền chủ giao (+ dư cũ) − tiền hàng trả ngay − nợ cũ trả lần này
 * = còn thừa trả chủ / còn thiếu nhân viên bỏ thêm. Dòng phụ: mua nợ, trả nợ bằng tiền thừa phiếu cũ.
 */
export function TripSummary({ given, carried, paid, debt, payOldDebt, fromLeftover }) {
  if (!given && !carried && !paid && !debt && !payOldDebt) return null;
  const hasMoney = given > 0 || carried > 0;
  const balance = given + carried - paid - payOldDebt;
  const newPart = given - paid - payOldDebt;
  const oldLeft = carried > 0 ? Math.max(0, carried + Math.min(0, newPart)) : 0;
  const row = (label, value, sign = '', tone = '') => <div className={`np-sum-row ${tone}`}><span>{label}</span><b>{sign}{vnd(value)}</b></div>;
  return <div className="np-sum">
    {hasMoney && row('Tiền chủ giao', given)}
    {carried > 0 && row('Dư cũ cộng vào', carried, '+ ', 'good')}
    {paid > 0 && row('Trả tiền hàng', paid, '− ')}
    {payOldDebt > 0 && row('Trả nợ cũ', payOldDebt, '− ', 'violet')}
    {hasMoney
      ? <div className={`np-sum-total ${balance >= 0 ? 'ok' : 'bad'}`}>
          <span>{balance >= 0 ? 'Còn thừa · trả lại chủ' : 'Còn thiếu · nhân viên bỏ thêm'}</span><b>{vnd(Math.abs(balance))}</b>
        </div>
      : <div className="np-sum-total"><span>Tổng tiền chi</span><b>{vnd(paid + payOldDebt)}</b></div>}
    {(carried > 0 && balance > 0) || debt > 0 || fromLeftover > 0
      ? <p className="np-sum-note">
          {[carried > 0 && balance > 0 && `Dư mới ${vnd(Math.max(0, newPart))} · dư cũ ${vnd(oldLeft)}`,
            debt > 0 && `Mua nợ ${vnd(debt)} (không trừ tiền chủ giao)`,
            fromLeftover > 0 && `Trả nợ bằng tiền thừa cũ ${vnd(fromLeftover)}`].filter(Boolean).join(' · ')}
        </p>
      : null}
  </div>;
}

/**
 * Ảnh hàng trên cân ở quán của phiếu đi chợ (bill của mối chụp ở từng dòng — BillCell). saved = link ảnh đã lưu (ô sửa phiếu),
 * photos = ảnh vừa chụp [{ url }]. Phiếu có hàng chợ mà chưa có ảnh thì bấm Lưu sẽ mở camera.
 */
export function TripPhotos({ saved = [], photos, required, onAdd, onRemove }) {
  const count = saved.length + photos.length;
  return <div className="np-photos">
    {saved.map(link => <a key={link} href={link} target="_blank" rel="noreferrer" className="np-photo"><img src={link} alt="Ảnh phiếu đã lưu" /></a>)}
    {photos.map((p, i) => <span key={p.url} className="np-photo">
      <img src={p.url} alt={`Ảnh ${i + 1}`} />
      <button type="button" className="np-photo-x" onClick={() => onRemove(i)} aria-label="Bỏ ảnh này"><X size={12} /></button>
    </span>)}
    {onAdd && count < MAX_NOTE_PHOTOS && <button type="button" className={`np-photo-add${required && !count ? ' need' : ''}`} onClick={onAdd}>📷 {count ? 'Thêm ảnh' : 'Chụp ảnh'}</button>}
    {required && !count && <p className="np-photo-hint">Bắt buộc: chụp hàng trên cân ở quán (bill của mối chụp ở từng dòng).</p>}
  </div>;
}

/**
 * Ô bill của một dòng: đã có bill (ảnh vừa chụp hoặc đã lưu — bấm để xem), ghi "không có bill" kèm lý do,
 * hoặc nút chụp (đỏ khi bắt buộc — dòng hàng ốc) và "Không có bill?" để ghi lý do.
 */
export function BillCell({ required, photo, saved, reason, onShoot, onNoBill, onClear }) {
  if (photo || saved) return <span className="np-bill-cell">
    {photo ? <a className="np-bill ok" href={photo} target="_blank" rel="noreferrer">🧾 bill ✓</a> : <span className="np-bill ok">🧾 bill ✓</span>}
    {onClear && <button type="button" className="np-bill-x" onClick={onClear} aria-label="Bỏ bill của dòng này"><X size={11} /></button>}
  </span>;
  if (reason) return <span className="np-bill-cell">
    <span className="np-bill none" title={reason}>🧾 Không bill: {reason}</span>
    <button type="button" className="np-bill-x" onClick={onClear} aria-label="Bỏ ghi không có bill"><X size={11} /></button>
  </span>;
  return <span className="np-bill-cell">
    <button type="button" className={`np-bill ${required ? 'need' : 'opt'}`} onClick={onShoot}>🧾 Chụp bill</button>
    {required && <button type="button" className="np-bill-skip" onClick={onNoBill}>Không có bill?</button>}
  </span>;
}

/** Sau khi chụp 1 tờ bill: tích các món khác cùng tờ bill đó (cùng mối) để khỏi chụp lại. */
export function BillPicker({ name, items, chosen, onToggle, onDone }) {
  return <div className="modal-overlay np-bill-pick" role="dialog" aria-label="Bill này có cả món nào">
    <div className="np-bill-pick-box">
      <b>🧾 Bill của "{name}" có cả món nào?</b>
      <p>Tích các món cùng tờ bill này (cùng mối) — khỏi chụp lại.</p>
      <div className="np-bill-pick-list">
        {items.map(i => <label key={i._id} className={chosen.includes(i._id) ? 'on' : ''}>
          <input type="checkbox" checked={chosen.includes(i._id)} onChange={() => onToggle(i._id)} />
          <span>{i.name}</span><small>{i.price}{i.qty ? ` × ${i.qty}` : ''}</small>
        </label>)}
      </div>
      <button type="button" className="btn btn-primary" onClick={onDone}>{chosen.length ? `Xong · thêm ${chosen.length} món` : 'Không có món nào khác'}</button>
    </div>
  </div>;
}
