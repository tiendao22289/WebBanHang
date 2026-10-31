'use client';

import { useEffect, useState } from 'react';
import {
  calcVoucherDiscount, voucherValueText, shortDay, lastUseDay, money, normalizeVoucherCode,
  redeemFailText, VOUCHER_SOURCES,
} from '@/lib/voucher.mjs';

// Dùng voucher ở trang Bàn: mã của SĐT trên bill hiện sẵn (khách chỉ cần đọc SĐT lúc gọi món),
// hoặc gõ mã khách đưa. Trừ tiền + chốt "đã dùng" ở máy chủ (SQL redeem_voucher, xem lib/voucher.mjs).

async function postVoucher(body) {
  const res = await fetch('/api/admin/vouchers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
  });
  if (res.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Chưa kết nối được máy chủ, thử lại giúp nhé.');
  return data;
}

/**
 * Công tắc voucher (Admin > Voucher) + mã còn dùng được của các SĐT trên bill đang mở.
 * Tắt thì trang Bàn ẩn thanh "Khách có voucher" và nút nhập mã. refreshKey đổi → hỏi lại.
 */
export function useTableVouchers(phones, refreshKey, active = true) {
  const key = [...new Set((phones || []).filter(Boolean))].sort().join(',');
  const [state, setState] = useState({ on: false, list: [] });
  useEffect(() => {
    if (!active) { setState(s => ({ ...s, list: [] })); return undefined; }
    let alive = true;
    postVoucher({ action: 'lookup', phones: key ? key.split(',') : [] })
      .then(d => { if (alive) setState({ on: !!d.on, list: d.vouchers || [] }); })
      .catch(() => { if (alive) setState(s => ({ ...s, list: [] })); }); // mạng lỗi: giữ trạng thái công tắc
    return () => { alive = false; };
  }, [key, refreshKey, active]);
  return state;
}

const visitText = c => {
  if (!c) return 'Khách mới';
  const parts = [`Đã ghé ${c.visit_count || 0} lần`];
  if (c.last_visit_at) {
    const d = new Date(new Date(c.last_visit_at).getTime() + 7 * 3600000).toISOString().slice(0, 10);
    parts.push(`lần gần nhất ${shortDay(d)}`);
  }
  return parts.join(' · ');
};

/** Thanh nhỏ trên tổng tiền: "Khách có voucher …" — bấm để mở bảng dùng mã. */
export function VoucherBanner({ vouchers, onOpen }) {
  if (!vouchers?.length) return null;
  const v = vouchers[0];
  return (
    // Cả thanh là nút bấm; chừa mép phải cho nút "+" thêm món nổi phía trên.
    <button onClick={onOpen}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 64px 8px 10px', marginBottom: 6,
        border: '1.5px dashed #f59e0b', background: '#fffbeb', borderRadius: 10, cursor: 'pointer', textAlign: 'left' }}>
      <span style={{ fontSize: '1.2rem' }}>🎟️</span>
      <span style={{ flex: 1, fontSize: '0.8rem', color: '#92400e', lineHeight: 1.35 }}>
        <b>Khách có voucher giảm {voucherValueText(v)}</b>
        {vouchers.length > 1 ? ` (+${vouchers.length - 1} mã)` : ''}
        <span style={{ display: 'block', color: '#b45309' }}>{v.customer?.name || v.customer_name || 'Khách'} · hạn đến hết {shortDay(lastUseDay(v.valid_until))}</span>
        <span style={{ display: 'block', fontWeight: 800, color: '#d97706' }}>Bấm để dùng ›</span>
      </span>
    </button>
  );
}

export default function VoucherRedeemDialog({ tableNumber, orderIds, discountBase, billTotal, vouchers, onClose, onApplied }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);   // mã đang gửi
  const [problem, setProblem] = useState('');

  async function redeem(raw) {
    const normal = normalizeVoucherCode(raw);
    if (!normal) { setProblem('Mã gồm 6 ký tự sau chữ BK, ví dụ BK-7K3P9X.'); return; }
    if (!orderIds.length) { setProblem('Bàn chưa có bill để trừ voucher.'); return; }
    setBusy(normal); setProblem('');
    try {
      const r = await postVoucher({ action: 'redeem', code: normal, orderIds });
      if (r.ok) onApplied(r);
      else setProblem(redeemFailText(r));
    } catch (e) {
      setProblem(e.message);
    } finally {
      setBusy(null);
    }
  }

  const input = { flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 10, border: '1.5px solid #e5e7eb', fontSize: '1rem',
    letterSpacing: 1, textTransform: 'uppercase', boxSizing: 'border-box' };

  return (
    <div onClick={() => !busy && onClose()}
      style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(2px)', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 380, padding: 18, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: '1.02rem', color: '#0f172a' }}>🎟️ Dùng voucher — Bàn {tableNumber}</div>
          <button onClick={onClose} disabled={!!busy} style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#94a3b8' }}>✕</button>
        </div>

        {vouchers.length > 0 && (
          <>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#374151', marginBottom: 6 }}>Khách trên bàn có voucher — kiểm tra đúng tên khách rồi bấm Dùng:</div>
            {vouchers.map(v => {
              const reduce = calcVoucherDiscount(discountBase, v, billTotal);
              const short = Number(v.min_bill) > 0 && discountBase < Number(v.min_bill);
              return (
                <div key={v.id} style={{ border: '1.5px solid #fde68a', background: '#fffbeb', borderRadius: 12, padding: '10px 12px', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                    <b style={{ color: '#92400e', fontSize: '0.98rem' }}>Giảm {voucherValueText(v)}</b>
                    <span style={{ fontSize: '0.68rem', fontWeight: 800, color: '#b45309', background: '#fef3c7', borderRadius: 6, padding: '2px 6px' }}>{VOUCHER_SOURCES[v.source] || 'Voucher'}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#374151', marginTop: 4 }}>
                    👤 <b>{v.customer?.name || v.customer_name || 'Khách'}</b> · SĐT …{String(v.customer_phone || '').slice(-3)}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#6b7280' }}>{visitText(v.customer)}</div>
                  <div style={{ fontSize: '0.74rem', color: '#6b7280' }}>
                    Mã {v.code} · hạn đến hết {shortDay(lastUseDay(v.valid_until))}{Number(v.min_bill) > 0 ? ` · bill từ ${money(v.min_bill)}` : ''}
                  </div>
                  {short ? (
                    <div style={{ fontSize: '0.78rem', color: '#b91c1c', fontWeight: 700, marginTop: 6 }}>Chưa đủ: tiền món {money(discountBase)} / cần {money(v.min_bill)}</div>
                  ) : reduce <= 0 ? (
                    <div style={{ fontSize: '0.78rem', color: '#b91c1c', fontWeight: 700, marginTop: 6 }}>Bill không còn tiền để giảm thêm.</div>
                  ) : (
                    <button onClick={() => redeem(v.code)} disabled={!!busy}
                      style={{ width: '100%', marginTop: 8, padding: '10px', border: 'none', borderRadius: 10, background: '#16a34a', color: 'white', fontWeight: 800, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                      {busy === v.code ? 'Đang trừ…' : `Dùng — bill giảm ${money(reduce)}`}
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}

        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#374151', margin: vouchers.length ? '10px 0 6px' : '0 0 6px' }}>
          {vouchers.length ? 'Hoặc nhập mã khách đưa:' : 'Nhập mã voucher khách đưa:'}
        </div>
        <form onSubmit={e => { e.preventDefault(); redeem(code); }} style={{ display: 'flex', gap: 8 }}>
          <input value={code} onChange={e => { setCode(e.target.value); setProblem(''); }} placeholder="BK-7K3P9X"
            autoCapitalize="characters" autoComplete="off" spellCheck={false} style={input} />
          <button type="submit" disabled={!!busy || !code.trim()}
            style={{ padding: '10px 14px', border: 'none', borderRadius: 10, background: '#d97706', color: 'white', fontWeight: 800, cursor: 'pointer', opacity: (busy || !code.trim()) ? 0.6 : 1 }}>
            {busy && !vouchers.some(v => v.code === busy) ? 'Đang…' : 'Dùng mã'}
          </button>
        </form>
        <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 6 }}>Tiền món hiện tại: {money(discountBase)} · mỗi bill dùng 1 voucher</div>

        {problem && (
          <div role="alert" style={{ marginTop: 10, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 10, padding: '9px 11px', fontSize: '0.84rem', fontWeight: 600 }}>
            {problem}
          </div>
        )}
      </div>
    </div>
  );
}
