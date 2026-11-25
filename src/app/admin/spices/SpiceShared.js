'use client';
/**
 * Phần dùng chung trang nhân viên (/admin/spices) và trang chủ gia vị (/giavi/<mã>):
 * nhãn kiểm hàng từng món (Đủ / Thiếu / Dư / Sai hàng) và thẻ đối soát một ngày.
 */
import { useState } from 'react';
import { CHECK_LABELS, shortTime } from '@/lib/spiceOrders.mjs';

export const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
export const qtyText = q => String(Math.round((Number(q) || 0) * 1000) / 1000).replace('.', ',');
const ICON = { ok: '✅', short: '➖', over: '➕', wrong: '⚠️' };
const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const dayLabel = date => {
  const [y, m, d] = date.split('-');
  return `${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${d}/${m}${y !== String(new Date().getFullYear()) ? `/${y}` : ''}`;
};

/** Nhãn kiểm hàng của một dòng đã nhận: "➖ Thiếu 0,5 kg" / "⚠️ Sai hàng: ớt xanh". */
export function CheckBadge({ check, diff = 0, unit = '', note = '' }) {
  if (!check) return null;
  const amount = check === 'short' || check === 'over' ? ` ${qtyText(Math.abs(diff))}${unit ? ` ${unit}` : ''}` : '';
  return <span className={`sp-check ${check}`}>{ICON[check]} {CHECK_LABELS[check]}{amount}{note ? `: ${note}` : ''}</span>;
}

/** Phần gập / mở bằng nút thường. */
export function Fold({ head, initial = false, className = 'sp-fold', plain = false, children }) {
  const [open, setOpen] = useState(initial);
  return <div className={className}>
    <button type="button" className={`sp-fold-btn${plain ? ' plain' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="sp-grow">{head}</span><span className="sp-fold-tag">{open ? 'Ẩn' : 'Xem'}</span>
    </button>
    {open && children}
  </div>;
}

/**
 * Thẻ đối soát một ngày (supplierDays): từng đơn, từng món gọi / nhận / đủ-thiếu-dư-sai, tiền; quán trả trong ngày,
 * nợ tới hết ngày (balance null = người xem không được thấy). onShare: nút gửi Zalo.
 */
export function DayCard({ day, initial = false, onShare = null, onRecheck = null }) {
  const { short, over, wrong } = day.counts;
  const issues = short + over + wrong;
  const head = <span className="sp-day-head">
    <span className="sp-b">{dayLabel(day.date)}</span>
    <span className="sp-mute"> · {day.orders.length} đơn</span>
    {issues > 0 ? <span className="sp-check wrong" style={{ marginLeft: 6 }}>{[short && `${short} thiếu`, over && `${over} dư`, wrong && `${wrong} sai`].filter(Boolean).join(' · ')}</span>
      : day.orders.length > 0 && <span className="sp-check ok" style={{ marginLeft: 6 }}>Đủ hết</span>}
    <span className="sp-money sp-day-total">{money(day.total)}</span>
  </span>;
  return <Fold className="sp-card" plain initial={initial} head={head}>
    {day.orders.map((o, k) => <div key={o.id} className="sp-day-order">
      <div className="sp-mute sp-small">Đơn {k + 1}: gọi {shortTime(o.created_at)}{o.created_by_name ? ` (${o.created_by_name})` : ''} · nhận {shortTime(o.received_at)}{o.received_by_name ? ` (${o.received_by_name})` : ''}</div>
      <table className="sp-stat">
        <thead><tr><th>Món</th><th>Gọi</th><th>Nhận</th><th>Tiền</th></tr></thead>
        <tbody>{o.lines.map((l, i) => <tr key={i} className={l.check !== 'ok' ? 'warn' : ''}>
          <td>{l.name}<div><CheckBadge check={l.check} diff={l.diff} unit={l.unit} note={l.note} /></div></td>
          <td>{qtyText(l.qty)} {l.unit}</td>
          <td>{qtyText(l.got)} {l.unit}</td>
          <td className="sp-money">{l.price === null ? <span className="nop">chưa giá</span> : money(l.amount)}</td>
        </tr>)}</tbody>
      </table>
      {o.receive_note && <div className="sp-note staff">📝 Ghi chú nhận: {o.receive_note}</div>}
      {o.supplier_note && <div className="sp-note supplier">💬 Chủ gia vị: {o.supplier_note}</div>}
      <div className="sp-row between" style={{ marginTop: 6 }}><span className="sp-mute">Tiền đơn</span><span className="sp-money">{money(o.total)}</span></div>
      {onRecheck && <div style={{ textAlign: 'right' }}><button type="button" className="sp-btn ghost" onClick={() => onRecheck(o.id)}>Kiểm lại đơn này</button></div>}
    </div>)}
    {day.payments.map((p, i) => <div key={i} className="sp-row between sp-day-pay"><span>💵 Quán trả ({p.method === 'transfer' ? 'CK' : 'tiền mặt'}){p.note ? ` · ${p.note}` : ''}</span><span className="sp-money">−{money(p.amount)}</span></div>)}
    {day.waiting > 0 && <p className="sp-mute">⚠️ {day.waiting} đơn còn món chưa có giá.</p>}
    <div className="sp-total"><span>Tổng nhận ngày này</span><span className="sp-money">{money(day.total)}</span></div>
    {day.balance !== null && day.balance !== undefined && <div className="sp-row between" style={{ marginTop: 4 }}>
      <span className="sp-b">Quán còn nợ tới hết ngày</span><span className="sp-money" style={{ color: 'var(--sp-bad)' }}>{money(day.balance)}</span></div>}
    {onShare && <div className="sp-btns"><button type="button" className="sp-btn zalo block" onClick={() => onShare(day)}>📤 Gửi đối soát ngày này qua Zalo</button></div>}
  </Fold>;
}
