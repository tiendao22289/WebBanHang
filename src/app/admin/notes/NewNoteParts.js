'use client';
/**
 * Các phần của form "Phiếu đi chợ mới" (Sổ tay), bản gọn: mỗi dòng hàng một hàng ngang
 * (tên · giá · số lượng · Đủ/Nợ), dòng phụ nhỏ chỉ khi có thành tiền / nợ / loại Khác / cảnh báo.
 * Tiền tính bằng notesMath như máy chủ ("2,5kg" = 2,5 · "250k" = 250.000đ, bỏ trống số lượng = 1).
 */
import { X } from 'lucide-react';
import MenuNameInput from '@/lib/MenuNameInput';
import { lineWarnings, parsePrice, parseQty } from '@/lib/notesMath.mjs';
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
 */
export function NoteItemRow({ item, other, menuNames, categories, onField, onBlur, onRemove, onCategory }) {
  const empty = !item.preset && !String(item.name || '').trim() && !String(item.price || '').trim() && !String(item.qty || '').trim();
  const total = lineTotal(item);
  const debt = item.paymentStatus === 'debt';
  const warnings = String(item.name || '').trim() ? lineWarnings(item) : [];
  // minWidth 0: ô tên co lại trong cột lưới, không đẩy ô giá / số lượng ra ngoài.
  const nameProps = { className: 'np-name', style: { minWidth: 0 }, value: item.name, placeholder: empty ? (other ? '＋ Thêm khác: xăng, sửa xe…' : '＋ Thêm hàng') : 'Tên' };
  // Dòng phụ chỉ khi cần: chọn loại (nhóm Khác), số nợ / nợ ai, cảnh báo. Thành tiền nằm ngay dưới tên.
  const sub = !empty && (other || debt || warnings.length > 0);
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
      {warnings.length > 0 && <span className="np-warn" title={warnings.join(' · ')}>⚠ {warnings[0]}</span>}
    </div>}
  </div>;
}

/**
 * Mọi dòng hàng của phiếu trong một danh sách, chia 3 nhóm: hàng ốc (gõ thêm ở dòng "＋ Thêm hàng"),
 * rau / gia vị (dòng có sẵn), Khác (xăng xe, sửa chữa… — chọn loại ở từng dòng). Hàm on*(vị trí trong items, …).
 */
export function NoteItemsList({ items, menuNames, categories, onField, onBlur, onRemove, onCategory, isAdmin }) {
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
        {list.map(({ item, idx }) => <NoteItemRow key={item._id || idx} item={item} other={isOtherLine(item)} menuNames={menuNames} categories={categories}
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
