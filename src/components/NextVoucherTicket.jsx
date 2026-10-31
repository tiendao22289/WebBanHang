'use client';

import { useEffect, useState } from 'react';
import { voucherValueText, shortDay, firstUseDay, lastUseDay, money, normalizeVoucherCode } from '@/lib/voucher.mjs';

// Voucher trên trang gọi món:
//  - Vé "Quà cho lần ghé tới": mã tặng khi bill vừa thanh toán (orderId) hoặc mã trúng vòng xoay (spinId).
//    Vé hiện ra là mã được lưu trong máy khách (localStorage) để lần sau bấm dùng luôn.
//  - Ô "Nhập mã voucher" trong bảng "Món đã gọi": khách tự nhập mã → máy chủ trừ thẳng vào bill
//    (/api/voucher/redeem, cùng SQL redeem_voucher với trang Bàn).

const SAVED_KEY = 'my_vouchers';
const DEVICE_KEY = 'voucher_device_key';
let memoryKey = null;

// Chìa khoá riêng của máy khách: đăng ký cho mỗi bill TRƯỚC khi gửi món, sau này chỉ máy này
// xem được mã "lần sau" của bill (mã bill đọc được bằng khoá công khai nên không bí mật).
function newDeviceKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function deviceVoucherKey() {
  try {
    let key = localStorage.getItem(DEVICE_KEY);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key || '')) { key = newDeviceKey(); localStorage.setItem(DEVICE_KEY, key); }
    return key;
  } catch {
    return (memoryKey ||= newDeviceKey());
  }
}
/** Gọi trước khi gửi món. Lỗi / chậm thì bỏ qua: chỉ mất vé trên máy, mã vẫn qua Zalo / nhân viên. */
export async function bindOrderToDevice(orderId, tableId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    await fetch('/api/voucher/bind', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: ctrl.signal,
      body: JSON.stringify({ orderId, tableId, key: deviceVoucherKey() }),
    });
  } catch { /* bỏ qua */ } finally {
    clearTimeout(timer);
  }
}
/** Công tắc voucher chung (Admin > Voucher). Lỗi mạng → coi như tắt (ẩn ô nhập mã). */
export async function fetchVoucherSwitch() {
  try {
    const res = await fetch('/api/voucher/status', { cache: 'no-store' });
    return !!(await res.json()).on;
  } catch { return false; }
}
/** refreshKey đổi → hỏi lại (mở bảng "Món đã gọi" là thấy ngay chủ quán vừa bật / tắt). */
export function useVoucherSwitch(refreshKey) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchVoucherSwitch().then(v => { if (alive) setOn(v); });
    return () => { alive = false; };
  }, [refreshKey]);
  return on;
}

const KEEP = ['code', 'discount_type', 'discount_value', 'max_discount', 'min_bill', 'valid_from', 'valid_until'];

/** Mã đã lưu trong máy khách, còn hạn. Bộ nhớ bị chặn thì coi như không có. */
export function savedVouchers(nowMs = Date.now()) {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(list) ? list.filter(v => v?.code && Date.parse(v.valid_until) > nowMs) : [];
  } catch { return []; }
}
function writeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 5))); } catch { /* bộ nhớ đầy / bị chặn */ }
}
function saveVoucher(v) {
  if (!v?.code) return;
  writeSaved([Object.fromEntries(KEEP.map(k => [k, v[k]])), ...savedVouchers().filter(x => x.code !== v.code)]);
}
function forgetVoucher(code) {
  writeSaved(savedVouchers().filter(x => x.code !== code));
}

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
        const res = await fetch(`/api/voucher/mine?${q}`, { cache: 'no-store', headers: { 'x-voucher-key': deviceVoucherKey() } });
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
  useEffect(() => { if (voucher?.status !== 'used') saveVoucher(voucher); }, [voucher]);
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
        Lần tới ghé quán, gọi món xong Quý khách bấm <b>📋 Đã gọi → Nhập mã</b> là bill tự giảm.
        Mã đã được lưu trên điện thoại này{voucher.sent_at ? ' và gửi vào Zalo của Quý khách' : ''} — 📸 chụp màn hình lại cho chắc nhé!
      </div>
    </div>
  );
}

/** Vé voucher trúng vòng xoay (trong bảng vòng xoay). */
export function WheelVoucher({ spinId }) {
  const voucher = useNextVoucher({ spinId });
  if (!voucher) return <div style={{ fontWeight: 600, color: '#64748b' }}>Đang lấy mã voucher…</div>;
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

/**
 * Ô "Nhập mã voucher" trong bảng "Món đã gọi". Hiện khi khách đang có bill mở và bill chưa dùng voucher.
 * Mã đã lưu trong máy (vé lần trước) hiện sẵn thành nút "Dùng".
 */
export function CustomerVoucherBox({ tableId, orderId, onApplied }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState([]);
  useEffect(() => { setSaved(savedVouchers().filter(v => Date.parse(v.valid_from) <= Date.now())); }, []);
  if (!tableId || !orderId) return null;

  async function apply(raw) {
    const normal = normalizeVoucherCode(raw);
    if (!normal) { setProblem('Mã gồm chữ BK và 6 ký tự, ví dụ BK-7K3P9X.'); return; }
    setBusy(normal); setProblem('');
    try {
      const res = await fetch('/api/voucher/redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-voucher-key': deviceVoucherKey() }, cache: 'no-store',
        body: JSON.stringify({ code: normal, tableId, orderId }),
      });
      const r = await res.json().catch(() => ({}));
      if (r.ok) {
        forgetVoucher(normal);
        setCode('');
        onApplied?.(r);
      } else {
        if (['used', 'cancelled', 'expired'].includes(r.reason)) {
          forgetVoucher(normal);
          setSaved(list => list.filter(v => v.code !== normal));
        }
        setProblem(r.message || 'Chưa áp được mã, Quý khách thử lại nhé.');
      }
    } catch {
      setProblem('Mạng chập chờn, Quý khách thử lại giúp quán nhé.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ border: '1.5px dashed #f59e0b', background: '#fffbeb', borderRadius: 14, padding: '10px 12px', marginBottom: 12 }}>
      <div style={{ fontWeight: 800, color: '#9a3412', fontSize: '0.92rem', marginBottom: 6 }}>🎟️ Có mã voucher? Nhập để giảm thẳng vào bill</div>
      {saved.map(v => (
        <button key={v.code} onClick={() => apply(v.code)} disabled={!!busy}
          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6,
            padding: '9px 12px', border: 'none', borderRadius: 10, background: '#16a34a', color: 'white', fontWeight: 800, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
          <span>{busy === v.code ? 'Đang áp mã…' : `Dùng mã ${v.code}`}</span>
          <span style={{ fontSize: '0.82rem' }}>−{voucherValueText(v)}</span>
        </button>
      ))}
      <form onSubmit={e => { e.preventDefault(); apply(code); }} style={{ display: 'flex', gap: 8 }}>
        <input value={code} onChange={e => { setCode(e.target.value); setProblem(''); }} placeholder="BK-7K3P9X"
          autoCapitalize="characters" autoComplete="off" spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: '9px 11px', borderRadius: 10, border: '1.5px solid #fed7aa', fontSize: '1rem',
            letterSpacing: 1, textTransform: 'uppercase', background: 'white', boxSizing: 'border-box' }} />
        <button type="submit" disabled={!!busy || !code.trim()}
          style={{ padding: '9px 14px', border: 'none', borderRadius: 10, background: '#d97706', color: 'white', fontWeight: 800,
            cursor: 'pointer', opacity: (busy || !code.trim()) ? 0.6 : 1 }}>
          {busy && !saved.some(v => v.code === busy) ? 'Đang…' : 'Áp mã'}
        </button>
      </form>
      {problem && <div role="alert" style={{ marginTop: 8, color: '#b91c1c', fontSize: '0.84rem', fontWeight: 600 }}>{problem}</div>}
      <div style={{ marginTop: 6, fontSize: '0.72rem', color: '#a16207' }}>Voucher giảm % tính trên món đã gọi lúc nhập mã — gọi xong rồi hãy nhập nhé.</div>
    </div>
  );
}
