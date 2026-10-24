'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { getShadowAccount, buildQrUrl } from '@/lib/bankAccount';
import { newLuckyRequestId } from '@/lib/luckyRewardFlow';
import { compressImage, fetchWithTimeout } from '@/lib/compressImage';
import CameraCapture, { cameraSupported } from '@/lib/CameraCapture';
import { QrCode, RefreshCw, CheckCircle2, Banknote, X } from 'lucide-react';
import Swal from 'sweetalert2';

// ─────────────────────────────────────────────────────────────────────────────
// Cổng QR Tùy chỉnh — chuyển khoản dùng thẻ ẨN; tiền mặt có phiếu thu riêng.
//
// NGUYÊN TẮC:
//   - Tuyệt đối không chạm vào thẻ Hiển thị (is_active = true).
//   - Chỉ chuyển khoản mới vào bank_daily_totals của thẻ Ẩn.
//   - Không có bill nào (order) được tạo / cập nhật qua cổng này.
//     → Không ảnh hưởng gì đến sổ sách thống kê / báo cáo S2a-HKD.
//   - Sổ thu chi vẫn tính đủ: DB tự ghi mỗi lần thu thành 1 bill giấy
//     (owner_finance.sql, capture_qr_page_receipt).
//   - BẮT BUỘC chụp tờ bill hoặc màn hình ĐT khách: bấm xác nhận / nhận tiền mặt
//     là mở camera ngay; ảnh và việc ghi tiền gửi lên máy chủ cùng một lần
//     (/api/admin/receipts qr_confirm / qr_cash) — đóng camera thì chưa ghi gì.
// ─────────────────────────────────────────────────────────────────────────────

async function postQrPayment(fields, blob, kind) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  form.set('image', blob, `${kind}.jpg`);
  const response = await fetchWithTimeout('/api/admin/receipts', { method: 'POST', body: form, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw new Error(result.error || 'Chưa ghi được tiền, thử lại.');
  return result;
}

const TRANSFER_SHOTS = [{ key: 'ck', label: 'Màn hình khách' }, { key: 'bill', label: 'Tờ bill' }];

export default function QrGeneratorPage() {
  const [amount, setAmount] = useState('');
  const [qrAccount, setQrAccount] = useState(null);
  const [transactionCode, setTransactionCode] = useState('');
  const [activeQr, setActiveQr] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState('idle'); // idle | pending | completed
  const [isGenerating, setIsGenerating] = useState(false);
  // Camera mở cho lần thu nào: { method: 'transfer' | 'cash', amount }
  const [camera, setCamera] = useState(null);
  const [saving, setSaving] = useState(false);
  const captureInput = useRef(null);
  const pendingShot = useRef(null);

  const router = useRouter();

  // Máy không mở được camera trong web → dùng ứng dụng camera của máy.
  function openCamera(shot) {
    if (cameraSupported()) setCamera(shot);
    else { pendingShot.current = shot; captureInput.current.click(); }
  }
  async function picked(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    const shot = pendingShot.current;
    pendingShot.current = null;
    if (!file || !shot) return;
    try { await saveShot(shot, await compressImage(file), shot.method === 'cash' ? 'bill' : 'ck'); }
    catch (err) { Swal.fire('Lỗi ảnh', err.message, 'error'); }
  }

  // Ảnh vừa chụp + ghi tiền, một lần gửi.
  async function saveShot(shot, blob, kind) {
    setSaving(true);
    try {
      if (shot.method === 'cash') await saveCash(shot.amount, blob);
      else await saveTransfer(blob, kind);
    } catch (err) {
      console.error(err);
      Swal.fire('Chưa ghi được tiền', err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  // Lấy thẻ ẨN lúc mới vào trang
  useEffect(() => {
    async function init() {
      const { account } = await getShadowAccount();
      if (account) setQrAccount(account);
    }
    init();
  }, []);

  const generateCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  };

  // ─── Tiền mặt tạo phiếu thu riêng, không làm tăng số dư chuyển khoản ────
  // Bấm "Nhận tiền mặt" → mở camera chụp tờ bill; chụp xong mới ghi tiền.
  const handleCashPayment = () => {
    const numAmount = parseInt(amount.replace(/\D/g, ''), 10) || 0;
    if (!Number.isSafeInteger(numAmount) || numAmount <= 0) return;
    openCamera({ method: 'cash', amount: numAmount });
  };

  const saveCash = async (numAmount, blob) => {
    setIsGenerating(true);
    try {
      const attemptKey = 'custom-cash-receipt';
      let previous = null;
      try { previous = JSON.parse(sessionStorage.getItem(attemptKey) || 'null'); } catch { /* stale cache */ }
      const receiptId = previous?.amount === numAmount ? previous.id : newLuckyRequestId();
      sessionStorage.setItem(attemptKey, JSON.stringify({ id: receiptId, amount: numAmount }));
      await postQrPayment({ action: 'qr_cash', receipt_id: receiptId, amount: numAmount }, blob, 'bill');
      sessionStorage.removeItem(attemptKey);

      Swal.fire({
        icon: 'success',
        title: '✅ Nhận tiền mặt!',
        html: `Đã nhận <b style="color:#16a34a">${numAmount.toLocaleString('vi-VN')}đ</b> tiền mặt.`,
        timer: 3000,
        timerProgressBar: true,
        showConfirmButton: false,
        position: 'top-end',
        toast: true,
      });

      setAmount('');
      setPaymentStatus('idle');
      setTransactionCode('');
      setActiveQr(null);
    } finally {
      setIsGenerating(false);
    }
  };

  // ─── Tạo mã QR cho thẻ ẨN ────────────────────────────────────────────────
  const handleGenerateQR = async () => {
    if (paymentStatus === 'pending' || isGenerating) return;
    setIsGenerating(true);

    // Luôn lấy thẻ Ẩn mới nhất
    const { account } = await getShadowAccount();
    if (!account) {
      setIsGenerating(false);
      Swal.fire('Lỗi', 'Không tìm thấy thẻ ngân hàng phù hợp! Vui lòng thêm thẻ phụ trong phần Cài đặt.', 'error');
      return;
    }
    const numAmount = parseInt(amount.replace(/\D/g, ''), 10) || 0;
    if (!Number.isSafeInteger(numAmount) || numAmount <= 0) {
      setIsGenerating(false);
      Swal.fire('Số tiền không hợp lệ', 'Vui lòng nhập số tiền lớn hơn 0.', 'error');
      return;
    }

    try {
      const newCode = generateCode();
      const { error: insertError } = await supabase.from('payment_transactions').insert({
        transaction_code: newCode,
        order_ids: 'shadow_qr',
        account_id: account.id,
        total_amount: numAmount,
        status: 'pending',
      });
      if (insertError) throw insertError;

      // Keep the QR tied to the amount and account saved with this transaction.
      setActiveQr({ code: newCode, amount: numAmount, account });
      setTransactionCode(newCode);
      setPaymentStatus('pending');

    } catch (err) {
      console.error(err);
      Swal.fire('Lỗi', 'Không thể tạo mã QR: ' + err.message, 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  // Format số tiền khi nhập
  const handleAmountChange = (e) => {
    let val = e.target.value.replace(/\D/g, '');
    if (!val) { setAmount(''); return; }
    setAmount(parseInt(val, 10).toLocaleString('vi-VN'));
  };

  const handleCancel = async () => {
    if (!transactionCode) return;
    try {
      const { data: cancelled, error } = await supabase.from('payment_transactions')
        .update({ status: 'failed' })
        .eq('transaction_code', transactionCode)
        .eq('status', 'pending')
        .select('transaction_code') // bảng thật không có cột id
        .maybeSingle();
      if (error) throw error;
      if (!cancelled) throw new Error('Mã QR đã đổi trạng thái. Vui lòng đối soát giao dịch.');
      setPaymentStatus('idle');
      setTransactionCode('');
      setActiveQr(null);
    } catch (err) {
      console.error(err);
      Swal.fire('Chưa huỷ được mã', 'Không lưu được trạng thái huỷ. Vui lòng kiểm tra mạng rồi thử lại.', 'error');
    }
  };

  // Bấm "Xác nhận đã nhận tiền" → mở camera ngay (màn hình CK của khách hoặc tờ bill).
  const handleConfirmManual = () => {
    if (!transactionCode || !activeQr || saving) return;
    openCamera({ method: 'transfer', amount: activeQr.amount });
  };

  const saveTransfer = async (blob, kind) => {
    const result = await postQrPayment({
      action: 'qr_confirm', code: transactionCode, amount: activeQr.amount, account_id: activeQr.account.id, kind,
    }, blob, kind);
    setPaymentStatus('completed');
    Swal.fire({
      title: result.photoSaved ? 'Đã xác nhận và lưu ảnh' : 'Đã xác nhận (chưa lưu được ảnh)',
      icon: result.photoSaved ? 'success' : 'warning', toast: true, position: 'top-end', showConfirmButton: false, timer: 3000,
    });
  };

  // Gọn cho điện thoại: lúc chờ khách chuyển thì ẩn ô nhập (không dùng được), mã QR + số tiền +
  // 2 nút nằm trọn một màn hình phía trên thanh menu; thanh toán xong chỉ còn một dòng báo.
  const waiting = paymentStatus === 'pending' && activeQr;
  const paid = paymentStatus === 'completed' && activeQr;
  const formOff = isGenerating || !amount || waiting;
  const actionButton = (on, color) => ({
    flex: 1, background: on ? color : '#cbd5e1', color: 'white', border: 'none', borderRadius: 12, padding: '13px 8px',
    fontSize: '0.98rem', fontWeight: 700, cursor: on ? 'pointer' : 'not-allowed',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap',
  });

  return (
    <div className="page-content" style={{ background: '#f8fafc', padding: 12 }}>
      <div style={{ maxWidth: 460, margin: '0 auto' }}>

        <div style={{ background: 'white', borderRadius: 20, padding: 14, boxShadow: '0 10px 40px rgba(0,0,0,0.05)', border: '1px solid #e2e8f0' }}>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ background: '#eff6ff', padding: 7, borderRadius: 10, color: '#2563eb', display: 'flex' }}>
              <QrCode size={20} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: '#0f172a' }}>Tạo mã QR tuỳ chỉnh</h2>
              <p style={{ margin: '1px 0 0', fontSize: '0.78rem', color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {qrAccount ? `${qrAccount.bank_name} · ${qrAccount.account_number}` : 'Nhập số tiền để tạo mã QR'}
              </p>
            </div>
            <button
              onClick={() => router.push('/admin/tables')}
              style={{ background: '#f1f5f9', border: 'none', borderRadius: '50%', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#64748b', flexShrink: 0 }}
              title="Đóng"
            >
              <X size={18} strokeWidth={2.5} />
            </button>
          </div>

          {!waiting && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {paid && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', borderRadius: 12, padding: '10px 12px', fontWeight: 700 }}>
                  <CheckCircle2 size={20} style={{ flexShrink: 0 }} />
                  <span>Đã nhận {activeQr.amount.toLocaleString('vi-VN')}đ · mã {activeQr.code}</span>
                </div>
              )}
              <input
                type="text"
                inputMode="numeric"
                value={amount}
                onChange={handleAmountChange}
                placeholder="Số tiền cần thu, vd 100.000"
                aria-label="Số tiền cần thu (VNĐ)"
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: 12, border: '1.5px solid #cbd5e1',
                  fontSize: '1.15rem', fontWeight: 700, color: '#0f172a', boxSizing: 'border-box', outline: 'none',
                }}
                onFocus={e => e.target.style.borderColor = '#3b82f6'}
                onBlur={e => e.target.style.borderColor = '#cbd5e1'}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleGenerateQR} disabled={formOff} style={actionButton(!formOff, '#2563eb')}>
                  {isGenerating ? <RefreshCw className="animate-spin" size={18} /> : <QrCode size={18} />}
                  Tạo mã QR
                </button>
                <button onClick={handleCashPayment} disabled={formOff} style={actionButton(!formOff, '#16a34a')}>
                  <Banknote size={18} />
                  Nhận tiền mặt
                </button>
              </div>
            </div>
          )}

          {waiting && (
            <div style={{ textAlign: 'center', animation: 'fadeIn 0.3s ease' }}>
              <img
                src={buildQrUrl(activeQr.account, activeQr.amount, activeQr.code)}
                alt="QR Code"
                style={{ width: 'min(200px, 52vw)', aspectRatio: '1', display: 'block', margin: '0 auto', objectFit: 'contain', border: '1px solid #e2e8f0', borderRadius: 12, padding: 6, background: 'white' }}
              />
              <div style={{ marginTop: 8, color: '#b91c1c', fontSize: '1.45rem', fontWeight: 900, lineHeight: 1.2 }}>
                {activeQr.amount.toLocaleString('vi-VN')}đ
              </div>
              <div style={{ marginTop: 6, background: '#f8fafc', borderRadius: 12, border: '1px dashed #cbd5e1', padding: '8px 10px' }}>
                <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#1d4ed8', letterSpacing: 1 }}>
                  {activeQr.account.bank_name} · {activeQr.account.account_number}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#475569', textTransform: 'uppercase', fontWeight: 700 }}>{activeQr.account.account_name}</div>
                <div style={{ marginTop: 4, fontSize: '0.85rem', color: '#64748b' }}>
                  Nội dung CK: <b style={{ fontSize: '1.05rem', color: '#0f172a', letterSpacing: 2 }}>{transactionCode}</b>
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: '#d97706', fontWeight: 600, fontSize: '0.9rem' }}>
                <RefreshCw className="animate-spin" size={15} />
                Đang chờ khách chuyển khoản...
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={handleCancel}
                  style={{ flex: 1, background: '#fff1f2', color: '#dc2626', border: '1px solid #fecdd3', padding: '13px 8px', borderRadius: 12, fontWeight: 700, cursor: 'pointer' }}
                >
                  Hủy mã
                </button>
                <button
                  onClick={handleConfirmManual}
                  disabled={saving}
                  style={{ flex: 2, background: '#16a34a', color: 'white', border: 'none', padding: '13px 8px', borderRadius: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  📷 Xác nhận đã nhận tiền
                </button>
              </div>
            </div>
          )}

          <input ref={captureInput} type="file" accept="image/*" capture="environment" onChange={picked} hidden />
          {camera && <CameraCapture
            title={camera.method === 'cash' ? 'Chụp tờ bill để ghi tiền mặt' : 'Chụp để xác nhận đã nhận tiền'}
            subtitle={`${camera.amount.toLocaleString('vi-VN')}đ · ${camera.method === 'cash' ? 'tiền mặt' : 'chuyển khoản'} · chưa chụp thì chưa ghi tiền`}
            choices={camera.method === 'cash' ? undefined : TRANSFER_SHOTS}
            closeText="Huỷ"
            onClose={() => setCamera(null)}
            onCapture={(blob, kind) => saveShot(camera, blob, kind || 'bill')}
          />}
          {saving && <div style={{ position: 'fixed', inset: 0, zIndex: 1900, background: 'rgba(15,23,42,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: 'white', borderRadius: 16, padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, color: '#0f172a' }}>
              <RefreshCw className="animate-spin" size={20} /> Đang lưu ảnh và ghi tiền...
            </div>
          </div>}

        </div>
      </div>
    </div>
  );
}
