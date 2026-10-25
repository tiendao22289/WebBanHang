'use client';
// Máy quầy chấm công: điện thoại / máy tính bảng để cố định ở quầy, chỉ hiện mã QR.
// Mã đổi mỗi 30 giây và ngay khi có người vừa chấm; ai quét xong thì hiện tên vài giây và đọc to
// "quét mã thành công" (hoặc "chưa thành công" khi bị chặn vì khác wifi / máy lạ).
// Mở trong app iPhone "Chấm công" (thư mục ios/): quét xong thì máy quầy so mặt người đứng trước máy
// (chớp mắt, đúng mặt mới ghi giờ); chủ quán chạm nhanh 5 lần vào đồng hồ (hoặc giữ tay 2 giây) để lấy mặt mẫu.
import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { KIOSK_FAIL_TEXT, spokenFace, spokenKiosk } from '@/lib/clockMessages.mjs';
import { FACE_MISS_TEXT } from '@/lib/faceCheck.mjs';
import { speak, speechSupported } from '@/lib/speak';
import { captureFace, kioskApp, toKioskApp } from '@/lib/kioskApp';

const POLL_MS = 2500;
// App: chạm đánh thức màn hình thì giữ sáng thêm 20 giây cho kịp mở app quét (app tự tối sau 10 giây không ai chạm).
const WAKE_HOLD_MS = 20000;
const pad = n => String(n).padStart(2, '0');
const hhmmVn = iso => new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(11, 16);
const warnBox = { background: '#7c2d12', color: '#fed7aa', borderRadius: 10, padding: '8px 12px', margin: '-8px 0 14px', fontSize: '0.88rem', textAlign: 'center', maxWidth: 440, lineHeight: 1.5 };

// Thẻ báo đè lên mã QR: lượt quét (được / bị chặn) hoặc so mặt (đang so / đúng / sai / chờ duyệt / chưa so được).
function noticeView(n) {
  if (n.kind === 'face') {
    if (n.stage === 'look') return { tint: '#4338ca', icon: '👀', line: 'Nhìn vào camera và chớp mắt', badge: 'Đang so mặt…' };
    const at = n.at ? ` lúc ${hhmmVn(n.at)}` : '';
    if (n.result === 'ok') return { tint: n.clocked === 'out' ? '#2563eb' : '#16a34a', icon: n.clocked === 'out' ? '👋' : '✅', line: `${n.clocked === 'out' ? 'Ra ca' : 'Vào ca'}${at}`, badge: 'Đúng mặt' };
    if (n.result === 'wrong') return { tint: '#dc2626', icon: '❌', line: 'Sai mặt — lượt này không tính', badge: 'Quét lại mã' };
    if (n.result === 'review') return { tint: '#ea580c', icon: '⏳', line: `Sai mặt 3 lần — đã ghi giờ ${n.clocked === 'out' ? 'ra' : 'vào'} ca${at}`, badge: 'Chờ chủ quán duyệt' };
    return { tint: '#b45309', icon: '⚠️', line: `Chưa so được mặt${FACE_MISS_TEXT[n.reason] ? `: ${FACE_MISS_TEXT[n.reason].toLowerCase()}` : ''}`, badge: 'Quét lại mã' };
  }
  if (!n.ok) return { tint: '#dc2626', icon: '❌', line: KIOSK_FAIL_TEXT[n.reason] || 'Xem lại trên điện thoại', badge: 'Chưa thành công — quét lại' };
  return { tint: n.action === 'out' ? '#2563eb' : '#16a34a', icon: n.action === 'out' ? '👋' : '✅', line: `${n.action === 'out' ? 'Ra ca' : 'Vào ca'} lúc ${hhmmVn(n.at)}`, badge: 'Quét mã thành công' };
}

export default function KioskPage() {
  const [state, setState] = useState('loading'); // loading | setup | ready
  const [mode, setMode] = useState('qr'); // qr | enroll (chủ quán lấy mặt mẫu, chỉ trong app)
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [refreshAt, setRefreshAt] = useState(0);
  const [offset, setOffset] = useState(0); // giờ máy chủ - giờ máy này
  const [computerClock, setComputerClock] = useState(null); // đồng hồ máy tính chạy web - giờ internet (null = chưa so được)
  const [notice, setNotice] = useState(null); // thẻ báo đang hiện (xem noticeView) + shownAt
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
  const app = useRef(null); // app iPhone (null = trình duyệt)
  const [inApp, setInApp] = useState(false);
  const modeRef = useRef('qr');
  const faceBusy = useRef(false);
  const faceSeen = useRef([]);
  const busyUntil = useRef(0);
  const busySent = useRef(null);
  const pressTimer = useRef(null);
  const clockTaps = useRef([]);
  const pollRef = useRef(null);

  const show = useCallback(n => {
    setNotice({ ...n, shownAt: Date.now() });
    toKioskApp({ type: 'wake' });
  }, []);

  // Có người quét mã mà máy quầy là app: mở camera so mặt, gửi dấu mặt cho máy chủ, báo và đọc kết quả.
  const runFace = useCallback(async fc => {
    faceBusy.current = true;
    faceSeen.current = [...faceSeen.current, fc.id].slice(-20);
    show({ kind: 'face', stage: 'look', name: fc.name, clocked: fc.clocked });
    speak(`${fc.name}, nhìn vào camera và chớp mắt.`);
    const shot = await captureFace({ id: fc.id, mode: 'verify', name: fc.name, prompt: 'Nhìn vào camera và chớp mắt' });
    let answer;
    try {
      const r = await fetch('/api/checkin/kiosk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shot.ok ? { action: 'face_verify', id: fc.id, embeddings: shot.embeddings } : { action: 'face_verify', id: fc.id, reason: shot.reason || 'error' }) });
      answer = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(answer.error);
    } catch { answer = { result: 'expired', reason: 'error' }; }
    const n = { kind: 'face', ...answer, name: answer.name || fc.name, clocked: answer.clocked || fc.clocked };
    show(n);
    speak(spokenFace(n));
    faceBusy.current = false;
    pollRef.current?.();
  }, [show]);

  const poll = useCallback(async () => {
    if (setupRef.current) return;
    try {
      const version = app.current?.face ? `&app=${encodeURIComponent(app.current.version || '1')}` : '';
      const r = await fetch(`/api/checkin/kiosk?t=${encodeURIComponent(tokenRef.current)}${version}`, { cache: 'no-store' });
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
        show({ kind: 'scan', ...n });
        speak(spokenKiosk(n));
      }
      // Lượt quét chờ so mặt (đang lấy mặt mẫu thì để sau: lượt đó chờ được 1 phút).
      const fc = j.faceCheck;
      if (fc && !faceBusy.current && modeRef.current === 'qr' && !faceSeen.current.includes(fc.id)) runFace(fc);
      setState('ready');
    } catch {
      // Mất mạng lâu thì giấu mã cũ (máy chủ cũng không nhận mã quá 2 phút).
      if (Date.now() - okAt.current > 10000) setOffline(true);
    }
  }, [runFace, show]);
  pollRef.current = poll;

  useEffect(() => {
    app.current = kioskApp();
    setInApp(!!app.current);
    if (app.current) {
      // Chạm đánh thức màn hình: lấy mã mới ngay, giữ sáng thêm một lúc cho người đó quét.
      app.current.onWake = () => { busyUntil.current = Date.now() + WAKE_HOLD_MS; pollRef.current?.(); };
    }
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

  // App: máy quầy không giữ đăng nhập chủ quán (lỡ tắt app giữa lúc lấy mặt mẫu).
  useEffect(() => {
    if (state === 'ready' && inApp) fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
  }, [state, inApp]);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const showScan = !!notice && (notice.stage === 'look' ? faceBusy.current : now - notice.shownAt < 8000);

  // App: đang báo kết quả / so mặt / lấy mặt mẫu / vừa chạm đánh thức → không cho màn hình tối.
  useEffect(() => {
    if (!inApp) return;
    const want = mode === 'enroll' || faceBusy.current || showScan || now < busyUntil.current;
    if (want !== busySent.current) { busySent.current = want; toKioskApp({ type: 'busy', on: want }); }
  }, [inApp, mode, now, showScan]);

  if (state === 'loading') return <Screen><div style={{ color: '#94a3b8' }}>Đang tải…</div></Screen>;
  if (state === 'setup') return <Setup onDone={() => { setupRef.current = false; setState('loading'); poll(); }} />;
  if (mode === 'enroll') return <FaceEnroll onExit={() => setMode('qr')} />;

  const url = typeof window !== 'undefined' ? `${window.location.origin}/checkin?t=${encodeURIComponent(token)}` : '';
  const t = new Date(now + offset + 7 * 3600000);
  const clock = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  const day = `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`;
  const left = Math.max(0, Math.min(1, (refreshAt - now) / 30000));
  const view = showScan ? noticeView(notice) : null;
  const turnOnVoice = () => { speak('Đã bật tiếng đọc'); setVoice(true); };
  // Chủ quán chạm nhanh 5 lần vào đồng hồ trong 3 giây, hoặc giữ tay 2 giây (chỉ trong app) → lấy mặt mẫu.
  // iPhone hay huỷ lần giữ tay (tưởng là chọn chữ) nên chạm 5 lần là cách chắc chắn.
  const tapClock = () => {
    if (!app.current?.face) return;
    const at = Date.now();
    clockTaps.current = [...clockTaps.current.filter(x => at - x < 3000), at];
    if (clockTaps.current.length >= 5) { clockTaps.current = []; setMode('enroll'); }
  };
  const pressStart = () => {
    if (!app.current?.face) return;
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setMode('enroll'), 2000);
  };
  const pressEnd = () => clearTimeout(pressTimer.current);

  return (
    <Screen still>
      <div onClick={tapClock} onPointerDown={pressStart} onPointerUp={pressEnd} onPointerLeave={pressEnd} onPointerCancel={pressEnd}
        style={{ fontSize: 'clamp(2.2rem, 9vw, 4rem)', fontWeight: 800, letterSpacing: 2, fontVariantNumeric: 'tabular-nums', touchAction: 'manipulation', cursor: 'default' }}>{clock}</div>
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
        {view && (
          <div style={{ position: 'absolute', inset: 0, borderRadius: 24, background: view.tint, color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16 }}>
            <div style={{ fontSize: '3.5rem' }}>{view.icon}</div>
            <div style={{ fontSize: 'clamp(1.4rem, 6vw, 2.2rem)', fontWeight: 800 }}>{notice.name}</div>
            <div style={{ fontSize: '1.15rem', marginTop: 6, lineHeight: 1.4 }}>{view.line}</div>
            <div style={{ marginTop: 10, padding: '4px 12px', borderRadius: 999, background: 'rgba(255,255,255,0.2)', fontWeight: 700 }}>{view.badge}</div>
          </div>
        )}
      </div>

      <div style={{ width: 'min(78vw, 60vh, 420px)', height: 6, background: '#334155', borderRadius: 3, marginTop: 14, overflow: 'hidden' }}>
        <div style={{ width: `${left * 100}%`, height: '100%', background: '#22c55e', transition: 'width 0.5s linear' }} />
      </div>

      <div style={{ marginTop: 22, fontSize: 'clamp(1rem, 4vw, 1.3rem)', lineHeight: 1.7, textAlign: 'center' }}>
        📶 Vào <strong>wifi quán</strong> → mở app, bấm nút <strong>📷 quét mã</strong> (hoặc dùng camera điện thoại)
        {inApp && <><br />👀 Quét xong <strong>nhìn vào camera máy này và chớp mắt</strong></>}
      </div>
      <div style={{ color: '#64748b', fontSize: '0.85rem', marginTop: 6, textAlign: 'center' }}>Mã đổi liên tục, mỗi mã chỉ dùng được 1 lần.</div>
      {/* Điện thoại / máy tính bảng chỉ cho trang đọc to sau khi có người chạm vào trang một lần (mỗi lần mở lại app). App thì tự đọc. */}
      {!inApp && speechSupported() && !voice && (
        <button type="button" onClick={turnOnVoice}
          style={{ marginTop: 14, padding: '10px 18px', borderRadius: 999, border: '1.5px solid #f59e0b', background: 'transparent', color: '#fbbf24', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' }}>
          🔊 Chạm để bật tiếng đọc tên
        </button>
      )}
    </Screen>
  );
}

// still: màn mã QR không cho chọn chữ / hiện menu khi giữ tay (máy quầy không có gì để chọn; còn ô nhập
// ở màn đăng nhập thì vẫn phải gõ được nên không đặt ở đó).
function Screen({ children, still = false }) {
  const noSelect = still ? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } : {};
  return (
    <div onContextMenu={still ? e => e.preventDefault() : undefined}
      style={{ minHeight: '100dvh', background: '#0f172a', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 16px', boxSizing: 'border-box', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', ...noSelect }}>
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

// Chủ quán lấy mặt mẫu ngay trên máy quầy (app): đăng nhập admin → chọn người → người đó nhìn camera, chớp
// mắt → máy chủ lưu dấu mặt (không lưu ảnh). Bấm Xong (hoặc 3 phút không bấm gì) thì đăng xuất chủ quán.
function FaceEnroll({ onExit }) {
  const [step, setStep] = useState('login'); // login | list
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState([]);
  const [dup, setDup] = useState(null); // mặt giống mặt mẫu người khác: { person, shot, text }
  const lastUse = useRef(Date.now());
  const touch = () => { lastUse.current = Date.now(); };
  const json = { 'Content-Type': 'application/json' };

  const exit = useCallback(async () => {
    await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
    onExit();
  }, [onExit]);

  useEffect(() => {
    const t = setInterval(() => { if (Date.now() - lastUse.current > 180000) exit(); }, 5000);
    return () => clearInterval(t);
  }, [exit]);

  const load = async () => {
    const r = await fetch('/api/admin/workforce?faces=1', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Không tải được danh sách nhân viên.');
    setPeople((j.staff || []).filter(p => !p.departed));
  };

  const login = async e => {
    e.preventDefault();
    touch(); setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/admin/session', { method: 'POST', headers: json, body: JSON.stringify({ phone, pin }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Sai số điện thoại hoặc PIN.');
      if (j.user?.role !== 'admin') {
        await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
        throw new Error('Chỉ chủ quán (admin) lấy mặt mẫu được.');
      }
      setPin('');
      await load();
      setStep('list');
    } catch (err) { setMsg(err.message); }
    setBusy(false);
  };

  const save = async (person, shot, force = false) => {
    const r = await fetch('/api/admin/workforce', { method: 'POST', headers: json, body: JSON.stringify({ action: 'face_enroll', staff_id: person.id, embeddings: shot.embeddings, force }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && j.duplicate) { setDup({ person, shot, text: j.error }); return; }
    if (!r.ok) throw new Error(j.error || 'Không lưu được mặt mẫu.');
    setMsg(`✅ Đã lưu mặt mẫu của ${person.full_name}.`);
    speak(`Đã lưu mặt mẫu của ${person.full_name}.`);
    await load();
  };

  const enroll = async person => {
    touch(); setBusy(true); setMsg(''); setDup(null);
    try {
      const shot = await captureFace({ id: `enroll-${person.id}-${Date.now()}`, mode: 'enroll', name: person.full_name, prompt: 'Nhìn thẳng vào camera và chớp mắt' }, 60000);
      touch();
      if (!shot.ok) throw new Error(`Chưa lấy được mặt${FACE_MISS_TEXT[shot.reason] ? `: ${FACE_MISS_TEXT[shot.reason].toLowerCase()}` : ''}. Thử lại.`);
      await save(person, shot);
    } catch (err) { setMsg(err.message); }
    setBusy(false);
  };

  const input = { padding: '12px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '1rem', textAlign: 'center', width: '100%', boxSizing: 'border-box' };
  const card = { background: 'white', color: '#0f172a', borderRadius: 20, padding: '22px 18px', width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12 };
  const button = { padding: '10px 14px', borderRadius: 10, border: 'none', fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer' };

  if (step === 'login') return (
    <Screen>
      <form onSubmit={login} onPointerDown={touch} style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 34 }}>🙂</div>
        <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>Lấy mặt mẫu nhân viên</div>
        <div style={{ fontSize: '0.85rem', color: '#64748b', lineHeight: 1.5 }}>Chủ quán đăng nhập để lấy mặt mẫu. Máy chỉ lưu dấu mặt (dãy số), không lưu ảnh.</div>
        {msg && <div style={{ color: '#dc2626', fontSize: '0.85rem' }}>{msg}</div>}
        <input style={input} type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Số điện thoại admin" required />
        <input style={{ ...input, letterSpacing: 6 }} type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} placeholder="Mã PIN" required />
        <button disabled={busy} style={{ ...button, padding: 14, background: '#16a34a', color: 'white' }}>{busy ? 'Đang kiểm tra…' : 'Đăng nhập'}</button>
        <button type="button" onClick={exit} style={{ ...button, background: '#f1f5f9', color: '#334155' }}>Quay lại mã QR</button>
      </form>
    </Screen>
  );

  return (
    <Screen>
      <div onPointerDown={touch} style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>Lấy mặt mẫu</div>
          <button onClick={exit} style={{ ...button, background: '#0f172a', color: 'white' }}>Xong</button>
        </div>
        <div style={{ fontSize: '0.85rem', color: '#64748b', lineHeight: 1.5 }}>
          Người cần lấy mặt đứng trước máy, nhìn thẳng camera, đủ sáng, bỏ khẩu trang, rồi chớp mắt. Lấy lại thì mặt mẫu cũ bị thay.
        </div>
        {msg && <div style={{ fontSize: '0.9rem', fontWeight: 700, color: msg.startsWith('✅') ? '#15803d' : '#dc2626' }}>{msg}</div>}
        {dup && (
          <div style={{ background: '#fef3c7', borderRadius: 12, padding: 12, fontSize: '0.88rem', lineHeight: 1.5 }}>
            ⚠ {dup.text}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button disabled={busy} onClick={async () => { touch(); setBusy(true); const d = dup; setDup(null); try { await save(d.person, d.shot, true); } catch (err) { setMsg(err.message); } setBusy(false); }}
                style={{ ...button, background: '#b45309', color: 'white' }}>Vẫn lưu cho {dup.person.full_name}</button>
              <button onClick={() => { touch(); setDup(null); }} style={{ ...button, background: '#e2e8f0', color: '#334155' }}>Huỷ</button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '60dvh', overflowY: 'auto' }}>
          {people.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{p.full_name}</div>
                <div style={{ fontSize: '0.8rem', color: p.face ? '#15803d' : '#b45309' }}>
                  {p.face ? `✅ Có mặt mẫu · ${new Date(Date.parse(p.face.created_at) + 7 * 3600000).toISOString().slice(0, 10).split('-').reverse().slice(0, 2).join('/')}` : 'Chưa có mặt mẫu'}
                </div>
              </div>
              <button disabled={busy} onClick={() => enroll(p)} style={{ ...button, background: p.face ? '#e2e8f0' : '#16a34a', color: p.face ? '#334155' : 'white' }}>
                📷 {p.face ? 'Lấy lại' : 'Lấy mặt'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Screen>
  );
}
