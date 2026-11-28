'use client';
/**
 * Bấm link ảnh (ảnh bill Sổ tay, bill chi, ảnh làm chứng…) thì mở ảnh trong khung phủ có nút ✕,
 * thay vì mở trang ảnh trần. Trên điện thoại (app thêm vào màn hình chính) trang ảnh trần không có
 * nút quay lại nên bị kẹt. Gắn 1 lần ở layout gốc: bắt mọi thẻ <a> trỏ tới ảnh trên mọi trang.
 * Ctrl/⌘ + bấm (máy tính) vẫn mở tab mới như cũ. Nút Back / vuốt lùi cũng đóng khung (useBackClose).
 */
import { useEffect, useState } from 'react';
import { useBackClose } from '@/lib/useBackClose';

const IMAGE_LINK = /\/api\/admin\/receipts\/image|\/storage\/v1\/object\/|\.(jpe?g|png|webp|gif|heic)(\?|#|$)/i;

export function isImageLink(href) {
  return typeof href === 'string' && IMAGE_LINK.test(href);
}

export default function PhotoLinkViewer() {
  const [url, setUrl] = useState(null);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => setUrl(null);
  useBackClose(!!url, close);

  useEffect(() => {
    const onClick = e => {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest?.('a[href]');
      if (!a || a.hasAttribute('download') || a.dataset.rawLink !== undefined) return;
      const href = a.href;
      if (!isImageLink(href)) return;
      e.preventDefault();
      e.stopPropagation();
      setZoom(false); setFailed(false); setUrl(href);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (!url) return undefined;
    const onKey = e => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [url]);

  if (!url) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Xem ảnh"
      style={{ position: 'fixed', inset: 0, zIndex: 100000, background: '#0b0f17', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'calc(10px + env(safe-area-inset-top)) 12px 10px', color: '#e5e7eb', flexShrink: 0 }}>
        <span style={{ fontSize: '0.82rem', opacity: 0.8 }}>{zoom ? 'Chạm ảnh để thu nhỏ' : 'Chạm ảnh để phóng to'}</span>
        <button type="button" onClick={close} aria-label="Đóng"
          style={{ marginLeft: 'auto', width: 44, height: 44, borderRadius: 22, border: 'none', background: 'rgba(255,255,255,0.16)', color: '#fff', fontSize: '1.4rem', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
      </div>
      <div onClick={e => { if (e.target === e.currentTarget && !zoom) close(); }}
        style={{ flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch', display: zoom ? 'block' : 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 8px calc(12px + env(safe-area-inset-bottom))' }}>
        {failed
          ? <div style={{ color: '#fca5a5', textAlign: 'center', padding: 24 }}>Không tải được ảnh (link có thể đã hết hạn). Đóng rồi mở lại trang để thử lại.</div>
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={url} alt="Ảnh" onClick={() => setZoom(z => !z)} onError={() => setFailed(true)}
            style={zoom
              ? { width: '220%', maxWidth: 'none', height: 'auto', display: 'block', cursor: 'zoom-out' }
              : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', cursor: 'zoom-in' }} />}
      </div>
    </div>
  );
}
