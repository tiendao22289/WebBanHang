'use client';

import { useEffect, useState } from 'react';
import { voucherValueText, shortDay, firstUseDay, lastUseDay, money } from '@/lib/voucher.mjs';

// Vé "Quà lần sau" trên trang gọi món: mã tặng khi bill vừa thanh toán (orderId)
// hoặc mã trúng vòng xoay (spinId). Không có mã thì không hiện gì.
// Thanh toán xong máy chủ mới tạo mã, nên hỏi lại vài lần cho kịp.
export function useNextVoucher({ orderId, spinId }) {
  const [voucher, setVoucher] = useState(null);
  useEffect(() => {
    if (!orderId && !spinId) { setVoucher(null); return undefined; }
    let alive = true;
    let timer = null;
    let tries = 0;
    const ask = async () => {
      tries++;
      try {
        const q = spinId ? `spinId=${encodeURIComponent(spinId)}` : `orderId=${encodeURIComponent(orderId)}`;
        const res = await fetch(`/api/voucher/mine?${q}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (data.voucher) { setVoucher(data.voucher); return; }
      } catch { /* mạng chập chờn — hỏi lại */ }
      if (alive && tries < 5) timer = setTimeout(ask, 2000);
    };
    ask();
    return () => { alive = false; clearTimeout(timer); };
  }, [orderId, spinId]);
  return voucher;
}

export function VoucherTicket({ voucher, onClose }) {
  if (!voucher) return null;
  return (
    <div style={{ position: 'relative', background: 'linear-gradient(135deg,#fff7ed,#fffbeb)', border: '2px dashed #f59e0b',
      borderRadius: 16, padding: '14px 16px', color: '#7c2d12', textAlign: 'left' }}>
      {onClose && (
        <button onClick={onClose} aria-label="Đóng"
          style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', fontSize: '1.1rem', color: '#c2410c', cursor: 'pointer' }}>✕</button>
      )}
      <div style={{ fontSize: '0.78rem', fontWeight: 800, letterSpacing: 0.5, color: '#c2410c' }}>🎟️ QUÀ CHO LẦN GHÉ TỚI</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 900, color: '#9a3412', margin: '2px 0 6px' }}>Giảm {voucherValueText(voucher)}</div>
      <div style={{ display: 'inline-block', background: 'white', border: '1.5px solid #fdba74', borderRadius: 10,
        padding: '5px 12px', fontSize: '1.15rem', fontWeight: 900, letterSpacing: 2, color: '#0f172a' }}>{voucher.code}</div>
      <div style={{ fontSize: '0.82rem', marginTop: 8, lineHeight: 1.5 }}>
        Dùng từ <b>{shortDay(firstUseDay(voucher.valid_from))}</b> đến hết <b>{shortDay(lastUseDay(voucher.valid_until))}</b>
        {Number(voucher.min_bill) > 0 && <>, cho bill từ <b>{money(voucher.min_bill)}</b></>}.
      </div>
      <div style={{ fontSize: '0.8rem', marginTop: 4, color: '#9a3412' }}>
        Lần sau khi tính tiền, Quý khách <b>đọc số điện thoại</b> hoặc đưa mã cho nhân viên nha.
        {voucher.sent_at ? ' Mã cũng đã gửi vào Zalo của Quý khách.' : ' 📸 Chụp màn hình lại để giữ mã nhé!'}
      </div>
    </div>
  );
}

/** Vé voucher trúng vòng xoay (trong bảng vòng xoay). */
export function WheelVoucher({ spinId }) {
  const voucher = useNextVoucher({ spinId });
  if (!voucher) return <div style={{ fontWeight: 600, color: '#64748b' }}>Mã voucher đã gửi vào Zalo của Quý khách.</div>;
  return <VoucherTicket voucher={voucher} />;
}

/** Thanh toán xong: vé nổi ở đáy màn hình, giữ tới khi khách bấm ✕. */
export default function PaidNextVoucher({ orderId, onClose }) {
  const voucher = useNextVoucher({ orderId });
  if (!voucher) return null;
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 96, maxWidth: 500, margin: '0 auto',
      padding: '12px 12px calc(12px + env(safe-area-inset-bottom, 0px))', background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(2px)' }}>
      <div style={{ textAlign: 'center', color: 'white', fontWeight: 800, marginBottom: 8 }}>✅ Thanh toán xong — cảm ơn Quý khách! Quán tặng quà nè 🥰</div>
      <VoucherTicket voucher={voucher} onClose={onClose} />
    </div>
  );
}
