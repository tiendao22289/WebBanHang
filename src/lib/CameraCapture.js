'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { useBackClose } from './useBackClose';

// Chụp ảnh NGAY TRONG WEB (camera sau) — ảnh chỉ nằm tạm trong bộ nhớ rồi
// gửi thẳng lên máy chủ, KHÔNG bao giờ lưu vào thư viện ảnh của điện thoại
// (mở ứng dụng camera của máy thì một số máy Android tự lưu thêm bản sao).
// Cần HTTPS (web thật) hoặc localhost. iPhone: video phải playsInline + muted.
const MAX_SIDE = 1280;
const QUALITY = 0.7;

export function cameraSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export default function CameraCapture({ onCapture, onClose }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useBackClose(true, onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        });
        if (cancelled) { media.getTracks().forEach(t => t.stop()); return; }
        stream.current = media;
        video.current.srcObject = media;
        await video.current.play().catch(() => {});
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err?.name === 'NotAllowedError'
          ? 'Chưa cho phép dùng camera. Vào cài đặt trình duyệt, cho phép Camera cho trang này rồi thử lại.'
          : 'Không mở được camera trên máy này.');
      }
    })();
    return () => { cancelled = true; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  }, []);

  async function shoot() {
    const v = video.current;
    if (!v?.videoWidth) return;
    setBusy(true);
    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    setBusy(false);
    if (!blob) { setError('Không chụp được, thử lại.'); return; }
    onCapture(blob);
    onClose();
  }

  return <div className="cam" role="dialog" aria-label="Chụp ảnh">
    <video ref={video} playsInline muted autoPlay className="cam-video" />
    {!ready && !error && <p className="cam-msg">Đang mở camera...</p>}
    {error && <p className="cam-msg error">{error}</p>}
    <div className="cam-bar">
      <button type="button" className="cam-close" onClick={onClose} aria-label="Huỷ"><X size={24} /></button>
      <button type="button" className="cam-shoot" onClick={shoot} disabled={!ready || busy} aria-label="Chụp"><Camera size={30} /></button>
      <span className="cam-spacer" />
    </div>
  </div>;
}
