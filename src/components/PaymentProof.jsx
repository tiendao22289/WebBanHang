'use client';
// Đóng bàn bắt buộc có ảnh (màn hình CK trên ĐT khách / tiền mặt khách đưa): camera mở ngay.
// Bấm Huỷ trên camera → hỏi: chụp lại, quay lại (chưa đóng bàn), hoặc ghi lý do (vd. máy lỗi)
// rồi đóng bàn không ảnh — lý do hiện trong Sổ thu chi cho chủ quán xem.
import { useRef, useState } from 'react';
import CameraCapture, { cameraSupported } from '@/lib/CameraCapture';
import { compressImage } from '@/lib/compressImage';

const REASONS = ['Máy lỗi camera', 'Khách không cho chụp'];

export default function PaymentProof({ title, subtitle, saving, onPhoto, onSkip, onBack }) {
  const [asking, setAsking] = useState(() => !cameraSupported());
  const [reason, setReason] = useState('');
  const shot = useRef(false);
  const fileInput = useRef(null);

  async function picked(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try { onPhoto(await compressImage(file)); } catch (err) { alert(err.message); }
  }
  function retake() {
    if (cameraSupported()) { setAsking(false); return; }
    fileInput.current.click();
  }

  if (saving) {
    return <div style={overlay}>
      <div style={{ ...sheet, textAlign: 'center', fontWeight: 700, color: '#0f172a' }}>⏳ Đang lưu ảnh và đóng bàn...</div>
    </div>;
  }

  return <>
    <input ref={fileInput} type="file" accept="image/*" capture="environment" onChange={picked} hidden />
    {!asking && <CameraCapture
      title={title}
      subtitle={subtitle}
      closeText="Huỷ"
      onCapture={blob => { shot.current = true; onPhoto(blob); }}
      onClose={() => { if (!shot.current) setAsking(true); shot.current = false; }}
    />}
    {asking && <div style={overlay}>
      <div style={sheet}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', color: '#0f172a' }}>Chưa chụp ảnh</div>
        <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: 4 }}>{subtitle}</div>
        <button onClick={retake} style={{ ...button, width: '100%', marginTop: 12, background: '#2563eb', color: 'white', border: 'none' }}>📷 Chụp lại</button>
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#334155', marginTop: 14 }}>Không chụp được? Ghi lý do để vẫn đóng bàn:</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {REASONS.map(r => <button key={r} onClick={() => setReason(r)}
            style={{ ...chip, ...(reason === r ? { borderColor: '#d97706', background: '#fffbeb', color: '#92400e' } : {}) }}>{r}</button>)}
        </div>
        <input value={reason} onChange={e => setReason(e.target.value.slice(0, 200))} placeholder="Lý do (bắt buộc)"
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1.5px solid #cbd5e1', fontSize: '1rem' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={onBack} style={{ ...button, flex: 1, background: 'white', color: '#475569', border: '1.5px solid #e5e7eb' }}>Quay lại</button>
          <button onClick={() => onSkip(reason.trim())} disabled={reason.trim().length < 3}
            style={{ ...button, flex: 2, background: reason.trim().length < 3 ? '#fcd34d' : '#d97706', color: 'white', border: 'none' }}>Đóng bàn không ảnh</button>
        </div>
      </div>
    </div>}
  </>;
}

const overlay = { position: 'fixed', inset: 0, zIndex: 10060, background: 'rgba(15,23,42,.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' };
const sheet = { background: 'white', width: '100%', maxWidth: 480, borderRadius: '20px 20px 0 0', padding: '18px 16px calc(18px + env(safe-area-inset-bottom))' };
const button = { padding: '13px 10px', borderRadius: 12, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' };
const chip = { padding: '7px 12px', borderRadius: 999, border: '1px solid #d1d5db', background: 'white', color: '#374151', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' };
