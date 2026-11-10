'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { getShadowAccount, buildQrUrl } from '@/lib/bankAccount';
import { newLuckyRequestId } from '@/lib/luckyRewardFlow';
import { compressImage, fetchWithTimeout } from '@/lib/compressImage';
import CameraCapture, { cameraSupported } from '@/lib/CameraCapture';
import { qrTableLabel, QR_TABLE_LABEL_MAX } from '@/lib/qrTableLabel.mjs';
import { QrCode, RefreshCw, CheckCircle2, Banknote, X, Camera } from 'lucide-react';
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
//   - BẮT BUỘC có ảnh: tiền mặt = tờ bill, chuyển khoản = màn hình ĐT khách (hoặc tờ bill). Chưa có ảnh thì
//     bấm xác nhận / nhận tiền mặt là mở camera ngay; ảnh và việc ghi tiền gửi lên máy chủ cùng một lần
//     (/api/admin/receipts qr_confirm / qr_cash) — đóng camera thì chưa ghi gì.
//   - Thay tab "Bill giấy" cũ (bỏ 2026-11-10): ô "Bàn" và nút "Chụp bill" ngay trong khung. Ảnh bill chụp sẵn:
//     tiền mặt ghi luôn bằng ảnh đó; chuyển khoản vẫn mở camera chụp màn hình khách, ảnh bill gửi kèm.
//     Bill giấy cũ vẫn xem ở Sổ thu chi / Tra cứu.
// ─────────────────────────────────────────────────────────────────────────────

// images: { image: [blob, kind], bill_image?: [blob, 'bill'] }
async function postQrPayment(fields, images) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value ?? ''));
  for (const [key, [blob, kind]] of Object.entries(images)) form.set(key, blob, `${kind}.jpg`);
  const response = await fetchWithTimeout('/api/admin/receipts', { method: 'POST', body: form, cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw new Error(result.error || 'Chưa ghi được tiền, thử lại.');
  return result;
}

const TRANSFER_SHOTS = [{ key: 'ck', label: 'Màn hình khách' }, { key: 'bill', label: 'Tờ bill' }];

// Mã phiếu thu tiền mặt của MỘT lần thu: bấm lại sau lỗi mạng thì dùng lại đúng mã (máy chủ không ghi
// trùng). Chỉ dùng lại khi cùng số tiền và trong CASH_RETRY_MS kể từ lần bấm đầu; ghi xong, gõ số tiền
// mới hay quá hạn đều ra mã mới. Trước đây mã chỉ gắn với số tiền: lần trước mất phản hồi mà nhân viên
// không bấm lại thì khoản tiền mặt kế tiếp cùng số tiền dùng lại mã cũ và bị máy chủ bỏ qua.
const CASH_ATTEMPT_KEY = 'custom-cash-receipt';
const CASH_RETRY_MS = 5 * 60 * 1000;

function cashReceiptId(amount, now = Date.now()) {
  let previous = null;
  try { previous = JSON.parse(sessionStorage.getItem(CASH_ATTEMPT_KEY) || 'null'); } catch { /* stale cache */ }
  const reuse = previous?.id && previous.amount === amount && now - Number(previous.at) >= 0 && now - Number(previous.at) < CASH_RETRY_MS;
  const attempt = reuse ? previous : { id: newLuckyRequestId(), amount, at: now };
  sessionStorage.setItem(CASH_ATTEMPT_KEY, JSON.stringify(attempt));
  return attempt.id;
}

function forgetCashAttempt() {
  try { sessionStorage.removeItem(CASH_ATTEMPT_KEY); } catch { /* storage bị chặn */ }
}

export default function QrGeneratorPage() {
  const [amount, setAmount] = useState('');
  const [qrAccount, setQrAccount] = useState(null);
  const [transactionCode, setTransactionCode] = useState('');
  const [activeQr, setActiveQr] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState('idle'); // idle | pending | completed
  const [isGenerating, setIsGenerating] = useState(false);
  // Camera mở cho việc gì: { method: 'transfer' | 'cash', amount, table } = ghi tiền; { method: 'bill' } = chụp sẵn tờ bill.
  const [camera, setCamera] = useState(null);
  const [saving, setSaving] = useState(false);
  // Tên bàn + ảnh tờ bill chụp sẵn (thay tab "Bill giấy" cũ). Ảnh chỉ nằm trong trang tới lúc ghi tiền.
  const [tableLabel, setTableLabel] = useState('');
  const [billPhoto, setBillPhoto] = useState(null); // { blob, preview }
  const captureInput = useRef(null);
  const pendingShot = useRef(null);

  const router = useRouter();

  function keepBill(blob) {
    setBillPhoto(previous => {
      if (previous?.preview) URL.revokeObjectURL(previous.preview);
      return blob ? { blob, preview: URL.createObjectURL(blob) } : null;
    });
  }
  // Ghi xong một khoản: khung trống lại cho khách sau.
  function clearForm() {
    setAmount('');
    setTableLabel('');
    keepBill(null);
  }

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
    try {
      const blob = await compressImage(file);
      if (shot.method === 'bill') keepBill(blob);
      else await saveShot(shot, blob, shot.method === 'cash' ? 'bill' : 'ck');
    } catch (err) { Swal.fire('Lỗi ảnh', err.message, 'error'); }
  }

  // Ảnh vừa chụp + ghi tiền, một lần gửi.
  async function saveShot(shot, blob, kind) {
    setSaving(true);
    try {
      if (shot.method === 'cash') await saveCash(shot, blob);
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
  // Bấm "Nhận tiền mặt": đã chụp sẵn tờ bill thì ghi luôn bằng ảnh đó; chưa thì mở camera chụp tờ bill.
  const handleCashPayment = () => {
    const numAmount = parseInt(amount.replace(/\D/g, ''), 10) || 0;
    if (!Number.isSafeInteger(numAmount) || numAmount <= 0 || saving) return;
    const shot = { method: 'cash', amount: numAmount, table: qrTableLabel(tableLabel) };
    if (billPhoto) saveShot(shot, billPhoto.blob, 'bill');
    else openCamera(shot);
  };

  const saveCash = async ({ amount: numAmount, table }, blob) => {
    setIsGenerating(true);
    try {
      const money = `${numAmount.toLocaleString('vi-VN')}đ`;
      const cashFields = () => ({ action: 'qr_cash', receipt_id: cashReceiptId(numAmount), amount: numAmount, table_label: table || '' });
      const result = await postQrPayment(cashFields(), { image: [blob, 'bill'] });
      forgetCashAttempt();
      if (result.alreadyDone) {
        // Máy chủ đã có phiếu này (lần bấm trước mạng chậm, tiền đã vào sổ). Nếu thật ra là tiền của
        // khách khác cùng số tiền thì ghi bằng mã mới — không để khoản mới bị bỏ qua mà không ai biết.
        const { isConfirmed } = await Swal.fire({
          icon: 'warning',
          title: 'Khoản này đã ghi từ lần bấm trước',
          html: `<b>${money}</b> tiền mặt đã được ghi vào sổ ở lần bấm trước (lúc đó mạng chậm nên chưa báo).<br><br>`
            + `Nếu đây là tiền của <b>khách khác</b>, bấm <b>Ghi khoản mới</b>.`,
          showCancelButton: true,
          confirmButtonText: 'Ghi khoản mới',
          cancelButtonText: 'Đúng, cùng khoản đó',
          reverseButtons: true,
        });
        if (isConfirmed) {
          // Mã mới cũng là 1 lần thu: mạng lỗi rồi bấm lại thì không ghi 2 lần.
          const again = await postQrPayment(cashFields(), { image: [blob, 'bill'] });
          forgetCashAttempt();
          if (again.alreadyDone) throw new Error('Máy chủ vẫn báo đã ghi. Vui lòng báo chủ quán kiểm tra Sổ thu chi.');
        }
      }

      Swal.fire({
        icon: 'success',
        title: '✅ Nhận tiền mặt!',
        html: `Đã nhận <b style="color:#16a34a">${money}</b> tiền mặt${table ? ` · ${table.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}` : ''}.`,
        timer: 3000,
        timerProgressBar: true,
        showConfirmButton: false,
        position: 'top-end',
        toast: true,
      });

      clearForm();
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
      setActiveQr({ code: newCode, amount: numAmount, account, table: qrTableLabel(tableLabel) });
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
    forgetCashAttempt(); // gõ số tiền = lần thu mới → mã phiếu tiền mặt mới
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
    openCamera({ method: 'transfer', amount: activeQr.amount, table: activeQr.table });
  };

  // Ảnh bill chụp sẵn đi kèm ảnh màn hình khách; chọn "Tờ bill" trong camera thì ảnh mới thay ảnh chụp sẵn.
  const saveTransfer = async (blob, kind) => {
    const images = { image: [blob, kind] };
    if (kind === 'ck' && billPhoto) images.bill_image = [billPhoto.blob, 'bill'];
    const result = await postQrPayment({
      action: 'qr_confirm', code: transactionCode, amount: activeQr.amount, account_id: activeQr.account.id, kind, table_label: activeQr.table || '',
    }, images);
    setPaymentStatus('completed');
    clearForm();
    Swal.fire({
      title: result.alreadyDone ? 'Mã QR này đã xác nhận từ lần bấm trước (không ghi thêm)'
        : result.photoSaved ? 'Đã xác nhận và lưu ảnh' : 'Đã xác nhận (chưa lưu được ảnh)',
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

  // Nút chụp sẵn tờ bill (khung nhập và lúc chờ khách chuyển). Có ảnh: bấm ảnh để chụp lại, ✕ để bỏ.
  const billSlot = billPhoto
    ? <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, border: '1.5px solid #86efac', background: '#f0fdf4', borderRadius: 12, padding: 3 }}>
        <button type="button" onClick={() => openCamera({ method: 'bill' })} aria-label="Chụp lại tờ bill" disabled={saving}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '0 4px 0 0', cursor: 'pointer', color: '#166534', fontWeight: 700, fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
          <img src={billPhoto.preview} alt="" draggable={false} style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 9, display: 'block' }} />
          Đã chụp bill
        </button>
        <button type="button" onClick={() => keepBill(null)} aria-label="Bỏ ảnh tờ bill" disabled={saving}
          style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'white', border: '1px solid #bbf7d0', borderRadius: 8, cursor: 'pointer', color: '#64748b' }}>
          <X size={15} strokeWidth={2.5} />
        </button>
      </div>
    : <button type="button" onClick={() => openCamera({ method: 'bill' })} disabled={saving}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexShrink: 0, minHeight: 46, padding: '0 14px', borderRadius: 12,
          border: '1.5px dashed #93c5fd', background: '#eff6ff', color: '#1d4ed8', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <Camera size={18} /> Chụp bill
      </button>;

  const cameraTitle = camera?.method === 'bill' ? 'Chụp tờ bill'
    : camera?.method === 'cash' ? 'Chụp tờ bill để ghi tiền mặt' : 'Chụp để xác nhận đã nhận tiền';
  const cameraSubtitle = !camera ? '' : camera.method === 'bill' ? 'Ảnh gửi lên cùng lúc ghi tiền'
    : [`${camera.amount.toLocaleString('vi-VN')}đ`, camera.table, camera.method === 'cash' ? 'tiền mặt' : 'chuyển khoản',
      camera.method === 'transfer' && billPhoto ? 'đã có ảnh tờ bill' : null, 'chưa chụp thì chưa ghi tiền'].filter(Boolean).join(' · ');

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
                  <span>Đã nhận {activeQr.amount.toLocaleString('vi-VN')}đ{activeQr.table ? ` · ${activeQr.table}` : ''} · mã {activeQr.code}</span>
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
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                <input
                  type="text"
                  value={tableLabel}
                  onChange={e => setTableLabel(e.target.value)}
                  placeholder="Bàn, vd 5"
                  aria-label="Tên bàn"
                  maxLength={QR_TABLE_LABEL_MAX}
                  enterKeyHint="done"
                  autoComplete="off"
                  style={{
                    flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 12, border: '1.5px solid #cbd5e1',
                    fontSize: '1.05rem', fontWeight: 700, color: '#0f172a', boxSizing: 'border-box', outline: 'none',
                  }}
                  onFocus={e => e.target.style.borderColor = '#3b82f6'}
                  onBlur={e => e.target.style.borderColor = '#cbd5e1'}
                />
                {billSlot}
              </div>
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
                {activeQr.table && <span style={{ marginLeft: 8, verticalAlign: 'middle', fontSize: '0.95rem', fontWeight: 800, color: '#0f172a', background: '#f1f5f9', borderRadius: 8, padding: '2px 8px' }}>{activeQr.table}</span>}
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
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'center' }}>{billSlot}</div>
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
            title={cameraTitle}
            subtitle={cameraSubtitle}
            choices={camera.method === 'transfer' ? TRANSFER_SHOTS : undefined}
            closeText="Huỷ"
            onClose={() => setCamera(null)}
            onCapture={(blob, kind) => camera.method === 'bill' ? keepBill(blob) : saveShot(camera, blob, kind || 'bill')}
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
