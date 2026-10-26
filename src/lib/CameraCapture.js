'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { useBackClose } from './useBackClose';
import { compressImage } from './compressImage';
import { cameraErrorText } from './cameraErrors.mjs';
import './cameraCapture.css';

// Chụp ảnh NGAY TRONG WEB (camera sau) — ảnh chỉ nằm tạm trong bộ nhớ rồi
// gửi thẳng lên máy chủ, KHÔNG bao giờ lưu vào thư viện ảnh của điện thoại
// (mở ứng dụng camera của máy thì một số máy Android tự lưu thêm bản sao).
// Cần HTTPS (web thật) hoặc localhost. iPhone: video phải playsInline + muted.
// Không mở được camera trong web (máy Android lỗi, trình duyệt trong Zalo chặn…) thì có nút
// "Dùng camera của máy" để chụp bằng ứng dụng camera — vẫn chụp được, không bị kẹt.
const MAX_SIDE = 1280;
const QUALITY = 0.7;

// Thử lần lượt: ảnh nét (1920×1440) → camera sau bất kỳ → camera bất kỳ. Một số máy Android báo lỗi
// (NotReadableError / OverconstrainedError) với yêu cầu độ phân giải dù chỉ là "ideal".
const ATTEMPTS = [
  { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
  { facingMode: { ideal: 'environment' } },
  true,
];
// Lỗi do quyền / không có camera: thử cách khác cũng vậy, dừng luôn.
const FINAL = ['NotAllowedError', 'SecurityError', 'NotFoundError'];

export function cameraSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

async function openCamera() {
  if (!cameraSupported()) throw Object.assign(new Error('no camera api'), { name: 'NoCameraApi' });
  let last;
  for (const video of ATTEMPTS) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: false, video }); } catch (err) {
      last = err;
      if (FINAL.includes(err?.name)) break;
      // Camera vừa được trang / ứng dụng khác nhả ra: chờ một chút rồi thử cách tiếp theo.
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  throw last;
}

// choices: [{ key, label }] → chọn đang chụp gì (vd. màn hình khách / tờ bill); onCapture(blob, key).
export default function CameraCapture({ onCapture, onClose, title, subtitle, closeText, choices }) {
  const video = useRef(null);
  const nativeInput = useRef(null);
  const [choice, setChoice] = useState(choices?.[0]?.key);
  const stream = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useBackClose(true, onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const media = await openCamera();
        if (cancelled) { media.getTracks().forEach(t => t.stop()); return; }
        stream.current = media;
        video.current.srcObject = media;
        await video.current.play().catch(() => {});
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        console.warn('[camera]', err?.name, err?.message);
        setError(cameraErrorText(err));
      }
    })();
    return () => { cancelled = true; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  }, []);

  async function shoot() {
    const v = video.current;
    if (!v?.videoWidth) { setError(cameraErrorText({ name: 'NoPicture' })); return; }
    setBusy(true);
    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    setBusy(false);
    if (!blob) { setError('Không chụp được, thử lại.'); return; }
    onCapture(blob, choice);
    onClose();
  }

  // Ảnh chụp bằng ứng dụng camera của máy (khi camera trong web không mở được).
  async function picked(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try { const blob = await compressImage(file); onCapture(blob, choice); onClose(); }
    catch (err) { setError(err.message || 'Không đọc được ảnh, chụp lại.'); }
    finally { setBusy(false); }
  }

  return <div className="cam" role="dialog" aria-label={title || 'Chụp ảnh'}>
    {title && <div className="cam-title">{title}{subtitle && <small>{subtitle}</small>}</div>}
    {choices && <div className="cam-choices" role="radiogroup" aria-label="Chụp gì">
      {choices.map(c => <button key={c.key} type="button" role="radio" aria-checked={choice === c.key}
        className={choice === c.key ? 'active' : ''} onClick={() => setChoice(c.key)}>{c.label}</button>)}
    </div>}
    <video ref={video} playsInline muted autoPlay className="cam-video" />
    <input ref={nativeInput} type="file" accept="image/*" capture="environment" onChange={picked} hidden />
    {!ready && !error && <p className="cam-msg">Đang mở camera...</p>}
    {error && <div className="cam-msg error">
      <p>{error}</p>
      <button type="button" className="cam-native" onClick={() => nativeInput.current?.click()} disabled={busy}>
        <Camera size={20} /> {busy ? 'Đang xử lý ảnh...' : 'Dùng camera của máy'}
      </button>
    </div>}
    <div className="cam-bar">
      <button type="button" className="cam-close" onClick={onClose} aria-label={closeText || 'Huỷ'}><X size={22} />{closeText}</button>
      <button type="button" className="cam-shoot" onClick={shoot} disabled={!ready || busy} aria-label="Chụp"><Camera size={30} /></button>
      <span className="cam-spacer" />
    </div>
  </div>;
}
