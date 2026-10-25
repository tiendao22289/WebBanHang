'use client';
// Máy quầy chấm công: điện thoại / máy tính bảng để cố định ở quầy, chỉ hiện mã QR.
// Mã đổi mỗi 30 giây và ngay khi có người vừa chấm; ai quét xong thì hiện tên vài giây và đọc to
// "quét mã thành công" (hoặc "chưa thành công" khi bị chặn vì khác wifi / máy lạ).
import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { KIOSK_FAIL_TEXT, spokenKiosk } from '@/lib/clockMessages.mjs';
import { speak, speechSupported } from '@/lib/speak';

const POLL_MS = 2500;
const pad = n => String(n).padStart(2, '0');
const warnBox = { background: '#7c2d12', color: '#fed7aa', borderRadius: 10, padding: '8px 12px', margin: '-8px 0 14px', fontSize: '0.88rem', textAlign: 'center', maxWidth: 440, lineHeight: 1.5 };

export default function KioskPage() {
  const [state, setState] = useState('loading'); // loading | setup | ready
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [refreshAt, setRefreshAt] = useState(0);
  const [offset, setOffset] = useState(0); // giờ máy chủ - giờ máy này
  const [computerClock, setComputerClock] = useState(null); // đồng hồ máy tính chạy web - giờ internet (null = chưa so được)
  const [notice, setNotice] = useState(null); // lượt quét vừa rồi: {ok, name, action, at, reason, shownAt}
  const seen = useRef([]); // lượt đã báo (máy chủ trả lại vài lần, chỉ báo một lần)
  const [voice, setVoice] = useState(false); // đã chạm để bật tiếng đọc chưa (trình duyệt bắt chạm một lần)
  const [offline, setOffline] = useState(false);
  // Màn hình vừa tắt rồi bật lại (iPhone tự khoá): mã đang hiện có thể đã hết hạn → che đi tới khi có mã mới.
  const [stale, setStale] = useState(false);
  const lastTick = useRef(Date.now());
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
      setStale(false);
      if (j.token !== tokenRef.current) { tokenRef.current = j.token; setToken(j.token); }
      setName(j.name || '');
      setRefreshAt(Date.now() + (j.refreshInMs || 30000));
      if (j.serverTime) setOffset(Date.parse(j.serverTime) - Date.now());
      setComputerClock(Number.isFinite(j.computerClockMs) ? j.computerClockMs : null);
      const fresh = [
        j.lastScan && { ...j.lastScan, ok: true, key: `ok|${j.lastScan.name}|${j.lastScan.at}` },
        j.lastFail && { ...j.lastFail, ok: false, key: `fail|${j.lastFail.id}` },
      ].filter(n => n && !seen.current.includes(n.key)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      if (fresh.length) {
        seen.current = [...seen.current, ...fresh.map(n => n.key)].slice(-20);
        const n = fresh[fresh.length - 1];
        setNotice({ ...n, shownAt: Date.now() });
        speak(spokenKiosk(n));
      }
      setState('ready');
    } catch {
      // Mất mạng lâu thì giấu mã cũ (máy chủ cũng không nhận mã quá 2 phút).
      if (Date.now() - okAt.current > 10000) setOffline(true);
    }
  }, []);

  useEffect(() => {
    poll();
    const a = setInterval(poll, POLL_MS);
    const b = setInterval(() => {
      const t = Date.now();
      // Đồng hồ trang nhảy cóc = máy vừa ngủ (màn hình tắt): lấy mã mới ngay, che mã cũ nếu đã lâu.
      if (t - lastTick.current > 5000) { if (t - okAt.current > 20000) setStale(true); poll(); }
      lastTick.current = t;
      setNow(t);
    }, 500);
    return () => { clearInterval(a); clearInterval(b); };
  }, [poll]);

  // Giữ màn hình luôn sáng (trình duyệt nào hỗ trợ).
  useEffect(() => {
    if (state !== 'ready') return undefined;
    let lock = null;
    const ask = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { /* không hỗ trợ */ } };
    const again = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - okAt.current > 20000) setStale(true);
      ask(); poll();
    };
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
  const showScan = notice && now - notice.shownAt < 8000;
  const tint = !notice ? '' : !notice.ok ? '#dc2626' : notice.action === 'out' ? '#2563eb' : '#16a34a';
  const turnOnVoice = () => { speak('Đã bật tiếng đọc'); setVoice(true); };

  return (
    <Screen>
      <div style={{ fontSize: 'clamp(2.2rem, 9vw, 4rem)', fontWeight: 800, letterSpacing: 2, fontVariantNumeric: 'tabular-nums' }}>{clock}</div>
      <div style={{ color: '#94a3b8', marginBottom: 18 }}>{day} · {name || 'Máy quầy'}</div>
      {/* Chấm công đã theo giờ internet; máy tính chạy web lệch giờ thì nhắc chủ chỉnh (bill, báo cáo vẫn theo giờ máy). */}
      {computerClock !== null && Math.abs(computerClock) > 2 * 60000 && (
        <div style={warnBox}>
          ⚠ Đồng hồ máy tính chạy web ở quán đang {computerClock < 0 ? 'chậm' : 'nhanh'} {Math.round(Math.abs(computerClock) / 60000)} phút.
          Chấm công đã tự lấy giờ internet nên vẫn đúng; nên chỉnh lại giờ máy tính (bật &quot;Đặt giờ tự động&quot;) cho bill và báo cáo.
        </div>
      )}
      {/* Chưa so được với internet: giờ máy chủ lệch điện thoại này nhiều thì giờ chấm công có thể sai. */}
      {computerClock === null && Math.abs(offset) > 2 * 60000 && (
        <div style={warnBox}>
          ⚠ Giờ máy chủ quán đang {offset < 0 ? 'chậm' : 'nhanh'} {Math.round(Math.abs(offset) / 60000)} phút so với điện thoại này.
          Chỉnh giờ máy tính chạy web ở quán (bật &quot;Đặt giờ tự động&quot;) để giờ chấm công đúng.
        </div>
      )}

      <div style={{ position: 'relative', background: 'white', borderRadius: 24, padding: 18, width: 'min(78vw, 60vh, 420px)', aspectRatio: '1 / 1', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {offline || !token
          ? <div style={{ color: '#b91c1c', fontWeight: 700, textAlign: 'center' }}>Mất mạng<br />đang thử lại…</div>
          : stale ? <div style={{ color: '#475569', fontWeight: 700, textAlign: 'center' }}>Đang lấy mã mới…</div>
          : <QRCodeSVG value={url} size={512} level="M" style={{ width: '100%', height: '100%' }} />}
        {showScan && (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 24, background: tint, color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16 }}>
            <div style={{ fontSize: '3.5rem' }}>{!notice.ok ? '❌' : notice.action === 'out' ? '👋' : '✅'}</div>
            <div style={{ fontSize: 'clamp(1.4rem, 6vw, 2.2rem)', fontWeight: 800 }}>{notice.name}</div>
            {notice.ok
              ? <div style={{ fontSize: '1.2rem', marginTop: 6 }}>{notice.action === 'out' ? 'Ra ca' : 'Vào ca'} lúc {new Date(Date.parse(notice.at) + 7 * 3600000).toISOString().slice(11, 16)}</div>
              : <div style={{ fontSize: '1.1rem', marginTop: 6, lineHeight: 1.4 }}>{KIOSK_FAIL_TEXT[notice.reason] || 'Xem lại trên điện thoại'}</div>}
            <div style={{ marginTop: 10, padding: '4px 12px', borderRadius: 999, background: 'rgba(255,255,255,0.2)', fontWeight: 700 }}>
              {notice.ok ? 'Quét mã thành công' : 'Chưa thành công — quét lại'}
            </div>
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
      {/* Điện thoại / máy tính bảng chỉ cho trang đọc to sau khi có người chạm vào trang một lần (mỗi lần mở lại app). */}
      {speechSupported() && !voice && (
        <button type="button" onClick={turnOnVoice}
          style={{ marginTop: 14, padding: '10px 18px', borderRadius: 999, border: '1.5px solid #f59e0b', background: 'transparent', color: '#fbbf24', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' }}>
          🔊 Chạm để bật tiếng đọc tên
        </button>
      )}
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
