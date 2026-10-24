'use client';
// Máy quầy chấm công: điện thoại / máy tính bảng để cố định ở quầy, chỉ hiện mã QR.
// Mã đổi mỗi 30 giây và ngay khi có người vừa chấm; ai quét xong thì hiện tên vài giây.
import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

const POLL_MS = 2500;
const pad = n => String(n).padStart(2, '0');

export default function KioskPage() {
  const [state, setState] = useState('loading'); // loading | setup | ready
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [refreshAt, setRefreshAt] = useState(0);
  const [offset, setOffset] = useState(0); // giờ máy chủ - giờ máy này
  const [lastScan, setLastScan] = useState(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const tokenRef = useRef('');
  const okAt = useRef(Date.now());
  const setupRef = useRef(false); // đang chờ admin bật máy → thôi hỏi mã

  const poll = useCallback(async () => {
    if (setupRef.current) return;
    try {
      const r = await fetch(`/api/checkin/kiosk?t=${encodeURIComponent(tokenRef.current)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 && j.kiosk === false) { setupRef.current = true; setState('setup'); return; }
      if (!r.ok || !j.token) throw new Error(j.error || 'lỗi');
      okAt.current = Date.now();
      setOffline(false);
      if (j.token !== tokenRef.current) { tokenRef.current = j.token; setToken(j.token); }
      setName(j.name || '');
      setRefreshAt(Date.now() + (j.refreshInMs || 30000));
      if (j.serverTime) setOffset(Date.parse(j.serverTime) - Date.now());
      if (j.lastScan) setLastScan({ ...j.lastScan, shownAt: Date.now() });
      setState('ready');
    } catch {
      // Mất mạng lâu thì giấu mã cũ (máy chủ cũng không nhận mã quá 2 phút).
      if (Date.now() - okAt.current > 10000) setOffline(true);
    }
  }, []);

  useEffect(() => {
    poll();
    const a = setInterval(poll, POLL_MS);
    const b = setInterval(() => setNow(Date.now()), 500);
    return () => { clearInterval(a); clearInterval(b); };
  }, [poll]);

  // Giữ màn hình luôn sáng (trình duyệt nào hỗ trợ).
  useEffect(() => {
    if (state !== 'ready') return undefined;
    let lock = null;
    const ask = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { /* không hỗ trợ */ } };
    const again = () => { if (document.visibilityState === 'visible') { ask(); poll(); } };
    ask();
    document.addEventListener('visibilitychange', again);
    return () => { document.removeEventListener('visibilitychange', again); lock?.release?.().catch(() => {}); };
  }, [state, poll]);

  if (state === 'loading') return <Screen><div style={{ color: '#94a3b8' }}>Đang tải…</div></Screen>;
  if (state === 'setup') return <Setup onDone={() => { setupRef.current = false; setState('loading'); poll(); }} />;

  const url = typeof window !== 'undefined' ? `${window.location.origin}/checkin?t=${encodeURIComponent(token)}` : '';
  const t = new Date(now + offset + 7 * 3600000);
  const clock = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  const day = `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`;
  const left = Math.max(0, Math.min(1, (refreshAt - now) / 30000));
  const showScan = lastScan && now - lastScan.shownAt < 8000;

  return (
    <Screen>
      <div style={{ fontSize: 'clamp(2.2rem, 9vw, 4rem)', fontWeight: 800, letterSpacing: 2, fontVariantNumeric: 'tabular-nums' }}>{clock}</div>
      <div style={{ color: '#94a3b8', marginBottom: 18 }}>{day} · {name || 'Máy quầy'}</div>

      <div style={{ position: 'relative', background: 'white', borderRadius: 24, padding: 18, width: 'min(78vw, 60vh, 420px)', aspectRatio: '1 / 1', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {offline || !token
          ? <div style={{ color: '#b91c1c', fontWeight: 700, textAlign: 'center' }}>Mất mạng<br />đang thử lại…</div>
          : <QRCodeSVG value={url} size={512} level="M" style={{ width: '100%', height: '100%' }} />}
        {showScan && (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 24, background: lastScan.action === 'out' ? '#dc2626' : '#16a34a', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16 }}>
            <div style={{ fontSize: '3.5rem' }}>{lastScan.action === 'out' ? '👋' : '✅'}</div>
            <div style={{ fontSize: 'clamp(1.4rem, 6vw, 2.2rem)', fontWeight: 800 }}>{lastScan.name}</div>
            <div style={{ fontSize: '1.2rem', marginTop: 6 }}>{lastScan.action === 'out' ? 'Ra ca' : 'Vào ca'} lúc {new Date(Date.parse(lastScan.at) + 7 * 3600000).toISOString().slice(11, 16)}</div>
          </div>
        )}
      </div>

      <div style={{ width: 'min(78vw, 60vh, 420px)', height: 6, background: '#334155', borderRadius: 3, marginTop: 14, overflow: 'hidden' }}>
        <div style={{ width: `${left * 100}%`, height: '100%', background: '#22c55e', transition: 'width 0.5s linear' }} />
      </div>

      <div style={{ marginTop: 22, fontSize: 'clamp(1rem, 4vw, 1.3rem)', lineHeight: 1.7, textAlign: 'center' }}>
        📶 Vào <strong>wifi quán</strong> → mở app, bấm nút <strong>📷 quét mã</strong> (hoặc dùng camera điện thoại)
      </div>
      <div style={{ color: '#64748b', fontSize: '0.85rem', marginTop: 6, textAlign: 'center' }}>Mã đổi liên tục, mỗi mã chỉ dùng được 1 lần.</div>
    </Screen>
  );
}

function Screen({ children }) {
  return (
    <div style={{ minHeight: '100dvh', background: '#0f172a', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 16px', boxSizing: 'border-box', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      {children}
    </div>
  );
}

// Admin đăng nhập ngay trên máy này để bật làm máy quầy; xong máy tự đăng xuất admin.
function Setup({ onDone }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [label, setLabel] = useState('Máy quầy');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const login = await fetch('/api/admin/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) });
      const lj = await login.json().catch(() => ({}));
      if (!login.ok) throw new Error(lj.error || 'Sai số điện thoại hoặc PIN.');
      const r = await fetch('/api/checkin/kiosk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'activate', name: label }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
        throw new Error(j.error || 'Không bật được máy quầy.');
      }
      onDone();
    } catch (err) { setMsg(err.message); }
    setBusy(false);
  };

  const input = { padding: '12px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '1rem', textAlign: 'center', width: '100%', boxSizing: 'border-box' };
  return (
    <Screen>
      <form onSubmit={submit} style={{ background: 'white', color: '#0f172a', borderRadius: 20, padding: '28px 22px', width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'center' }}>
        <div style={{ fontSize: 34 }}>📱</div>
        <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>Bật máy quầy chấm công</div>
        <div style={{ fontSize: '0.85rem', color: '#64748b', lineHeight: 1.5 }}>
          Máy này sẽ chỉ hiện mã QR để nhân viên quét. Chủ quán đăng nhập để bật; xong máy tự đăng xuất, không ai vào được trang quản lý từ máy này.
          <br />Nhớ cho máy này vào <strong>wifi quán</strong>.
        </div>
        {msg && <div style={{ color: '#dc2626', fontSize: '0.85rem' }}>{msg}</div>}
        <input style={input} value={label} onChange={e => setLabel(e.target.value)} placeholder="Tên máy (vd: Máy quầy)" maxLength={60} />
        <input style={input} type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Số điện thoại admin" required />
        <input style={{ ...input, letterSpacing: 6 }} type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} placeholder="Mã PIN" required />
        <button disabled={busy} style={{ padding: 14, background: '#16a34a', color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '1rem', cursor: 'pointer' }}>
          {busy ? 'Đang bật…' : 'Bật làm máy quầy'}
        </button>
        {/* Nhân viên lỡ mở trang này trên điện thoại của mình. */}
        <div style={{ fontSize: '0.8rem', color: '#64748b', borderTop: '1px solid #e5e7eb', paddingTop: 12, lineHeight: 1.5 }}>
          Bạn là nhân viên? Không cần mở trang này: vào wifi quán, mở app bấm nút <strong>📷 quét mã</strong> (hoặc dùng camera điện thoại) quét mã QR trên máy quầy.
        </div>
      </form>
    </Screen>
  );
}
