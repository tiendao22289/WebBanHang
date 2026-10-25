'use client';
import { useEffect, useRef, useState } from 'react';
import { workforce } from '@/lib/staffApi';
import { STAFF_WARNING_TEXT, clockSummary, clockTime, punctuality, qrClockToken, spokenClock, spokenClockError, tokenFresh } from '@/lib/clockMessages.mjs';
import { speak, unlockSpeech } from '@/lib/speak';

// Quét mã chấm công ngay trong app nhân viên: mở camera sau, đọc mã QR trên máy quầy rồi vào / ra
// ca luôn — cùng đăng nhập, cùng điện thoại đã đăng ký (không phải mở trình duyệt khác như khi
// quét bằng app Camera). Đọc mã bằng BarcodeDetector nếu máy có (Android), không thì bằng jsQR.
// Quét xong đọc to "quét mã thành công / chưa thành công" — nút mở màn quét phải gọi unlockSpeech()
// lúc bấm, vì điện thoại chỉ cho trang đọc sau khi người dùng chạm.
let openCount = 0, bodyOverflow = '';

export default function QrClockScanner({ onClose }) {
  const videoRef = useRef(null);
  const [phase, setPhase] = useState('starting'); // starting | scanning | sending | done | error
  const [message, setMessage] = useState('');
  const [detail, setDetail] = useState('');
  const [warn, setWarn] = useState('');
  const [open, setOpen] = useState(null);         // ca đang mở → lần quét này là ra ca
  const [attempt, setAttempt] = useState(0);      // "Quét lại" chạy lại camera

  // Không cuộn trang phía sau khi đang quét (đóng màn quét cuối cùng mới trả lại).
  useEffect(() => {
    if (openCount++ === 0) { bodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    return () => { if (--openCount === 0) document.body.style.overflow = bodyOverflow; };
  }, []);

  useEffect(() => {
    let stream = null, timer = null, stopped = false;
    const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
    // Trạng thái hiện tại (đang trong ca chưa) + giờ làm để báo đúng giờ / trễ sau khi quét.
    const status = fetch('/api/admin/workforce?me=1', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    status.then(me => { if (!stopped && me) setOpen(me.open || null); });

    const send = async token => {
      setPhase('sending');
      setWarn('');
      try {
        const [result, me] = await Promise.all([workforce('clock', { token }), status]);
        setMessage(clockSummary(result));
        setDetail(punctuality(result.clocked, result.session, result.sessions || [], me?.rules || null, result.session?.staff_id));
        setWarn((result.warnings || []).map(w => STAFF_WARNING_TEXT[w]).filter(Boolean).join(' '));
        setPhase('done');
        speak(spokenClock(result));
        navigator.vibrate?.(80);
        // Trang Lương đang mở thì tải lại giờ công hôm nay.
        window.dispatchEvent(new Event('staff-clocked'));
      } catch (err) {
        setMessage(err.message);
        setPhase('error');
        speak(spokenClockError(err.message));
      }
    };

    (async () => {
      setPhase('starting'); setMessage(''); setDetail(''); setWarn('');
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (err) {
        if (stopped) return;
        setMessage(err?.name === 'NotAllowedError'
          ? 'Chưa cho phép dùng camera. Bấm "Quét lại" rồi chọn "Cho phép" khi điện thoại hỏi (hoặc bật quyền camera cho trang này trong Cài đặt).'
          : 'Không mở được camera trên máy này. Có thể mở app Camera của điện thoại để quét mã trên máy quầy.');
        setPhase('error');
        return;
      }
      if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play().catch(() => {});

      let detect, native = false;
      if (typeof window.BarcodeDetector === 'function') {
        try { native = (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code'); } catch { native = false; }
      }
      if (native) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        detect = async () => (await detector.detect(video))[0]?.rawValue || null;
      } else {
        const mod = await import('jsqr');
        const jsQR = mod.default || mod;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        detect = async () => {
          const w = video.videoWidth, h = video.videoHeight;
          if (!w || !h) return null;
          // Thu nhỏ khung hình cho nhanh: mã trên máy quầy to, rõ.
          const scale = Math.min(1, 640 / Math.max(w, h));
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
        };
      }
      if (stopped) return;
      setPhase('scanning');

      const tick = async () => {
        if (stopped) return;
        let text = null;
        try { text = await detect(); } catch { /* khung hình chưa sẵn sàng: đọc khung sau */ }
        if (stopped) return;
        if (text) {
          const token = qrClockToken(text);
          if (!token) setWarn('Đây không phải mã chấm công. Đưa camera vào mã QR trên máy quầy.');
          else if (!tokenFresh(token)) setWarn('Mã này đã cũ. Đợi máy quầy đổi mã rồi quét lại.');
          else { stop(); await send(token); return; }
        }
        timer = setTimeout(tick, 150);
      };
      tick();
    })();
    return stop;
  }, [attempt]);

  const live = phase === 'starting' || phase === 'scanning' || phase === 'sending';
  const button = { padding: '12px 22px', borderRadius: 12, border: 'none', fontWeight: 800, fontSize: '1rem', cursor: 'pointer' };
  return (
    <div role="dialog" aria-label="Quét mã chấm công"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#0f172a', color: 'white', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', paddingTop: 'max(14px, env(safe-area-inset-top))' }}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem' }}>📷 Quét mã chấm công</div>
        <button onClick={onClose} aria-label="Đóng" style={{ background: 'none', border: 'none', color: 'white', fontSize: '1.6rem', lineHeight: 1, cursor: 'pointer', padding: 4 }}>✕</button>
      </div>

      <div style={{ position: 'relative', flex: 1, overflow: 'hidden', display: live ? 'block' : 'none' }}>
        <video ref={videoRef} playsInline muted autoPlay style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
        {/* Khung ngắm: tối phần ngoài khung */}
        <div style={{ position: 'absolute', top: '45%', left: '50%', width: '68vmin', height: '68vmin', transform: 'translate(-50%, -50%)',
          border: '3px solid rgba(255,255,255,0.95)', borderRadius: 18, boxShadow: '0 0 0 100vmax rgba(0,0,0,0.45)' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '16px 20px', paddingBottom: 'max(20px, env(safe-area-inset-bottom))', textAlign: 'center', lineHeight: 1.5 }}>
          <div style={{ fontWeight: 700 }}>
            {phase === 'starting' ? 'Đang mở camera…' : phase === 'sending' ? 'Đang chấm công…'
              : open ? `Đang trong ca từ ${clockTime(open.clock_in)} — quét để RA CA` : 'Quét để VÀO CA'}
          </div>
          <div style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>Vào wifi quán, đưa mã QR trên máy quầy vào khung.</div>
          {warn && <div style={{ marginTop: 6, color: '#fde68a', fontSize: '0.88rem' }}>{warn}</div>}
        </div>
      </div>

      {!live && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', gap: 12 }}>
          <div style={{ fontSize: '3rem' }}>{phase === 'done' ? '✅' : '⚠️'}</div>
          <div style={{ whiteSpace: 'pre-line', fontSize: '1.1rem', fontWeight: 700, lineHeight: 1.5 }}>{message}</div>
          {detail && <div style={{ fontSize: '0.95rem', color: '#e2e8f0' }}>{detail}</div>}
          {warn && <div style={{ fontSize: '0.88rem', color: '#fde68a' }}>{warn}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            {phase === 'error' && <button onClick={() => { unlockSpeech(); setAttempt(a => a + 1); }} style={{ ...button, background: '#16a34a', color: 'white' }}>Quét lại</button>}
            <button onClick={onClose} style={{ ...button, background: phase === 'done' ? '#16a34a' : '#334155', color: 'white' }}>{phase === 'done' ? 'Xong' : 'Đóng'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
