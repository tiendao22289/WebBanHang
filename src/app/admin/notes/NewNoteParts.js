'use client';
/**
 * Các phần của form "Phiếu đi chợ mới" (Sổ tay): khung từng bước, một dòng hàng, tổng kết chuyến chợ.
 * Tiền tính bằng notesMath như máy chủ ("2,5kg" = 2,5 · "250k" = 250.000đ, bỏ trống số lượng = 1).
 */
import { X } from 'lucide-react';
import MenuNameInput from '@/lib/MenuNameInput';
import { lineWarnings, parsePrice, parseQty } from '@/lib/notesMath.mjs';
import { CategorySelect } from './NoteKinds';

export const vnd = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const lineTotal = i => Math.round(parsePrice(i.price) * parseQty(i.qty));
const digits = v => String(v ?? '').replace(/\D/g, '');

/** Một bước của phiếu: số thứ tự, tên, số tiền bên phải. */
export function Section({ step, title, aside, hint, children }) {
  return <section className="np-section">
    <div className="np-section-head">
      {step && <span className="np-step">{step}</span>}
      <b>{title}</b>
      {aside !== undefined && aside !== null && <span className="np-aside">{aside}</span>}
    </div>
    {hint && <p className="np-hint">{hint}</p>}
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

/**
 * Một dòng hàng. Dòng trống (chưa gõ gì) là dòng "＋ Thêm hàng": chỉ có ô tên, gõ tên thì hiện giá / số
 * lượng và tự thêm dòng trống mới. Dòng có sẵn (Tiền rau, Tiền gia vị) chỉ cần giá; để trống thì không lưu.
 */
export function NoteItemRow({ item, no, other, menuNames, categories, onField, onBlur, onRemove, onCategory }) {
  const empty = !item.preset && !String(item.name || '').trim() && !String(item.price || '').trim() && !String(item.qty || '').trim();
  const total = lineTotal(item);
  const debt = item.paymentStatus === 'debt';
  const warnings = String(item.name || '').trim() ? lineWarnings(item) : [];
  const nameProps = { className: 'np-name', value: item.name, placeholder: empty ? (other ? '＋ Thêm: đổ xăng, sửa xe…' : '＋ Thêm hàng: gõ tên…') : 'Tên hàng' };
  return <div className={`np-item${empty ? ' add' : ''}${debt ? ' debt' : ''}${item.preset && !total ? ' idle' : ''}`}>
    {other && !empty && <CategorySelect value={item.category} categories={categories} onChange={onCategory} />}
    <div className="np-item-top">
      {no ? <span className="np-no">{no}</span> : null}
      {item.preset
        ? <span className="np-name fixed">{item.name}</span>
        : other
          ? <input type="text" {...nameProps} onChange={e => onField('name', e.target.value)} />
          : <MenuNameInput names={menuNames} {...nameProps} onChange={v => onField('name', v)} />}
      {total > 0 && <b className={`np-total${debt ? ' debt' : ''}`}>{vnd(total)}</b>}
      {!empty && !item.preset && <button type="button" className="np-x" onClick={onRemove} aria-label={`Xoá ${item.name || 'dòng'}`}><X size={16} /></button>}
    </div>
    {!empty && <div className={`np-item-grid${item.preset ? ' preset' : ''}`}>
      <input type="text" className="np-input" placeholder="Giá" aria-label="Giá" value={item.price} onChange={e => onField('price', e.target.value)} onBlur={e => onBlur('price', e)} />
      {!item.preset && <input type="text" className="np-input" placeholder="SL / Ký" aria-label="Số lượng" value={item.qty} onChange={e => onField('qty', e.target.value)} onBlur={e => onBlur('qty', e)} />}
      <span className="np-seg" role="radiogroup" aria-label="Trả tiền">
        <button type="button" role="radio" aria-checked={!debt} className={!debt ? 'on' : ''} onClick={() => onField('paymentStatus', 'full')}>Đủ</button>
        <button type="button" role="radio" aria-checked={debt} className={debt ? 'on debt' : ''} onClick={() => onField('paymentStatus', 'debt')}>Nợ</button>
      </span>
    </div>}
    {debt && <div className="np-debt">
      <input type="text" inputMode="numeric" className="np-input" aria-label="Số tiền nợ" value={item.debtAmount || ''}
        placeholder={total > 0 ? `Nợ ${total.toLocaleString('vi-VN')}` : 'Số tiền nợ'}
        onChange={e => { const n = Number(digits(e.target.value)); onField('debtAmount', !n ? '' : (total > 0 ? Math.min(n, total) : n).toLocaleString('vi-VN')); }} />
      <input type="text" className="np-input" placeholder="Nợ của ai?" aria-label="Nợ của ai" value={item.creditor || ''} onChange={e => onField('creditor', e.target.value)} />
    </div>}
    {warnings.map(w => <p key={w} className="np-warn">⚠ {w}</p>)}
  </div>;
}

/**
 * Tổng kết chuyến chợ như hoá đơn: tiền chủ giao (+ dư cũ) − tiền hàng trả ngay − nợ cũ trả lần này
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
    {carried > 0 && row('Tiền dư cũ cộng vào', carried, '+ ', 'good')}
    {paid > 0 && row('Trả tiền hàng', paid, '− ')}
    {payOldDebt > 0 && row('Trả nợ cũ', payOldDebt, '− ', 'violet')}
    {hasMoney
      ? <div className={`np-sum-total ${balance >= 0 ? 'ok' : 'bad'}`}>
          <span>{balance >= 0 ? 'Còn thừa · trả lại chủ' : 'Còn thiếu · nhân viên bỏ thêm'}</span><b>{vnd(Math.abs(balance))}</b>
        </div>
      : <div className="np-sum-total"><span>Tổng tiền chi</span><b>{vnd(paid + payOldDebt)}</b></div>}
    {carried > 0 && balance > 0 && <p className="np-sum-note">Dư mới {vnd(Math.max(0, newPart))} · dư cũ {vnd(oldLeft)}</p>}
    {debt > 0 && <p className="np-sum-note bad">Mua nợ {vnd(debt)} (tiền hàng {vnd(paid + debt)}) — không trừ vào tiền chủ giao</p>}
    {fromLeftover > 0 && <p className="np-sum-note good">Trả nợ bằng tiền thừa phiếu cũ {vnd(fromLeftover)}</p>}
  </div>;
}
