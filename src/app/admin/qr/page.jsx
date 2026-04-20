'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { getActiveAccount, buildQrUrl } from '@/lib/bankAccount';
import { QrCode, RefreshCw, CheckCircle2 } from 'lucide-react';
import Swal from 'sweetalert2';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default function QrGeneratorPage() {
  const [amount, setAmount] = useState('');
  const [qrAccount, setQrAccount] = useState(null);
  const [transactionCode, setTransactionCode] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('idle'); // idle | pending | completed
  const [isGenerating, setIsGenerating] = useState(false);

  const subscriptionRef = useRef(null);

  // Lấy tài khoản ngân hàng lúc mới vào trang
  useEffect(() => {
    async function init() {
      const { account, overLimit, shouldHideStats } = await getActiveAccount();
      if (account) {
        setQrAccount({ ...account, overLimit, shouldHideStats });
      }
    }
    init();
  }, []);

  // Hủy subscription khi unmount
  useEffect(() => {
    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }
    };
  }, []);

  const generateCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  };

  const handleGenerateQR = async () => {
    let currentAccount = qrAccount;
    
    // Lấy tài khoản nếu chưa có hoặc cập nhật tài khoản mới nhất
    if (!currentAccount) {
      setIsGenerating(true);
      const { account, overLimit, shouldHideStats } = await getActiveAccount();
      if (account) {
        currentAccount = { ...account, overLimit, shouldHideStats };
        setQrAccount(currentAccount);
      }
    }

    if (!currentAccount) {
      setIsGenerating(false);
      Swal.fire('Lỗi', 'Không tìm thấy tài khoản ngân hàng hoạt động! Vui lòng kiểm tra lại kết nối mạng hoặc thiết lập tài khoản.', 'error');
      return;
    }

    const numAmount = parseInt(amount.replace(/\D/g, ''), 10) || 0;
    
    setIsGenerating(true);
    setPaymentStatus('idle');

    try {
      const newCode = generateCode();
      setTransactionCode(newCode);

      // Lưu vào payment_transactions
      const { error } = await supabase.from('payment_transactions').insert({
        transaction_code: newCode,
        order_ids: 'custom_qr',
        account_id: currentAccount.id,
        total_amount: numAmount,
        status: 'pending'
      });

      if (error) throw error;

      setPaymentStatus('pending');

      // Đăng ký lắng nghe sự kiện
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }

      subscriptionRef.current = supabase
        .channel(`payment_status_${newCode}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'payment_transactions',
            filter: `transaction_code=eq.${newCode}`,
          },
          (payload) => {
            if (payload.new && payload.new.status === 'completed') {
              setPaymentStatus('completed');
              Swal.fire({
                icon: 'success',
                title: '✅ Đã nhận tiền!',
                html: `Mã giao dịch: <b>${newCode}</b><br/>Số tiền: <b style="color:#2563eb">${numAmount.toLocaleString('vi-VN')}đ</b>`,
                timer: 4000,
                timerProgressBar: true,
                showConfirmButton: false,
                position: 'top-end',
                toast: true,
              });
            }
          }
        )
        .subscribe();

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
    if (!val) {
      setAmount('');
      return;
    }
    const num = parseInt(val, 10);
    setAmount(num.toLocaleString('vi-VN'));
  };

  const handleCancel = async () => {
    if (!transactionCode) return;
    try {
      await supabase.from('payment_transactions').update({ status: 'failed' }).eq('transaction_code', transactionCode);
      setPaymentStatus('idle');
      setTransactionCode('');
      if (subscriptionRef.current) supabase.removeChannel(subscriptionRef.current);
    } catch (err) {
      console.error(err);
    }
  };

  const handleConfirmManual = async () => {
    if (!transactionCode) return;
    const { isConfirmed } = await Swal.fire({
      title: 'Xác nhận thu tiền?',
      text: 'Bạn chắc chắn đã nhận được tiền cho mã giao dịch này chứ?',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Đã nhận',
      cancelButtonText: 'Chưa',
      confirmButtonColor: '#16a34a'
    });
    if (!isConfirmed) return;

    try {
      const numAmount = parseInt(amount.replace(/\D/g, ''), 10) || 0;
      
      // Update transaction status
      await supabase.from('payment_transactions').update({ status: 'completed' }).eq('transaction_code', transactionCode);
      
      // Record to bank daily totals
      if (qrAccount && numAmount > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const { data: existing } = await supabase.from('bank_daily_totals')
          .select('id, total_amount')
          .eq('account_id', qrAccount.id).eq('date', today).maybeSingle();
          
        if (existing) {
          await supabase.from('bank_daily_totals').update({ total_amount: existing.total_amount + numAmount }).eq('id', existing.id);
        } else {
          await supabase.from('bank_daily_totals').insert({ account_id: qrAccount.id, date: today, total_amount: numAmount });
        }
      }

      setPaymentStatus('completed');
      Swal.fire({ title: 'Thành công!', text: 'Đã xác nhận thanh toán thủ công.', icon: 'success', toast: true, position: 'top-end', showConfirmButton: false, timer: 3000 });
      if (subscriptionRef.current) supabase.removeChannel(subscriptionRef.current);

    } catch (err) {
      console.error(err);
      Swal.fire('Lỗi', err.message, 'error');
    }
  };

  return (
    <div className="page-content" style={{ background: '#f8fafc', minHeight: '100vh', padding: '20px' }}>
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        
        <div style={{ background: 'white', borderRadius: 24, padding: 24, boxShadow: '0 10px 40px rgba(0,0,0,0.05)', border: '1px solid #e2e8f0' }}>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, borderBottom: '1px solid #f1f5f9', paddingBottom: 16 }}>
            <div style={{ background: '#eff6ff', padding: 10, borderRadius: 12, color: '#2563eb' }}>
              <QrCode size={28} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800, color: '#0f172a' }}>Tạo mã QR Tùy chỉnh</h2>
              <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: '#64748b' }}>Nhập số tiền để sinh mã QR thanh toán nhanh</p>
            </div>
          </div>

          {/* Form */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, color: '#334155', marginBottom: 6 }}>
                Số tiền cần thu (VNĐ)
              </label>
              <input
                type="text"
                value={amount}
                onChange={handleAmountChange}
                placeholder="Ví dụ: 100,000"
                style={{
                  width: '100%', padding: '14px 16px', borderRadius: 12, border: '1.5px solid #cbd5e1', 
                  fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', boxSizing: 'border-box',
                  outline: 'none', transition: 'border-color 0.2s'
                }}
                onFocus={e => e.target.style.borderColor = '#3b82f6'}
                onBlur={e => e.target.style.borderColor = '#cbd5e1'}
              />
            </div>
            
            <button
              onClick={handleGenerateQR}
              disabled={isGenerating || !amount}
              style={{
                background: isGenerating || !amount ? '#94a3b8' : '#2563eb',
                color: 'white', border: 'none', borderRadius: 12, padding: '14px',
                fontSize: '1rem', fontWeight: 700, cursor: isGenerating || !amount ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'background 0.2s'
              }}
            >
              {isGenerating ? <RefreshCw className="animate-spin" size={20} /> : <QrCode size={20} />}
              Tạo mã QR
            </button>
          </div>

          {/* QR Display */}
          {paymentStatus !== 'idle' && transactionCode && qrAccount && (
            <div style={{ background: '#f8fafc', borderRadius: 16, padding: 20, border: '1px solid #e2e8f0', textAlign: 'center', animation: 'fadeIn 0.3s ease' }}>
              
              <div style={{ background: 'white', borderRadius: 12, padding: 12, display: 'inline-block', border: '1px solid #cbd5e1', marginBottom: 16 }}>
                <img
                  src={buildQrUrl(qrAccount, parseInt(amount.replace(/\D/g, ''), 10), transactionCode)}
                  alt="QR Code"
                  style={{ width: 220, height: 220, display: 'block', objectFit: 'contain' }}
                />
              </div>

              <div style={{ marginBottom: 16, background: 'white', padding: 12, borderRadius: 12, border: '1px dashed #cbd5e1' }}>
                <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#0f172a' }}>{qrAccount.bank_name}</div>
                <div style={{ fontSize: '1.4rem', letterSpacing: 1.5, fontWeight: 900, color: '#1d4ed8', marginTop: 4 }}>
                  {qrAccount.account_number}
                </div>
                <div style={{ fontSize: '0.9rem', color: '#475569', marginTop: 4, textTransform: 'uppercase', fontWeight: 700 }}>
                  {qrAccount.account_name}
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: 4 }}>Nội dung chuyển khoản (Tự động):</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#0f172a', letterSpacing: 2, background: '#e2e8f0', display: 'inline-block', padding: '4px 12px', borderRadius: 8 }}>
                  {transactionCode}
                </div>
              </div>

              {/* Status Indicator */}
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed #cbd5e1' }}>
                {paymentStatus === 'pending' ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#d97706', fontWeight: 600 }}>
                      <RefreshCw className="animate-spin" size={18} />
                      Đang chờ khách thanh toán...
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                      <button
                        onClick={handleCancel}
                        style={{ flex: 1, background: '#fff1f2', color: '#dc2626', border: '1px solid #fecdd3', padding: '12px', borderRadius: 12, fontWeight: 700, cursor: 'pointer', transition: 'background 0.2s' }}
                      >
                        Hủy mã
                      </button>
                      <button
                        onClick={handleConfirmManual}
                        style={{ flex: 2, background: '#16a34a', color: 'white', border: 'none', padding: '12px', borderRadius: 12, fontWeight: 700, cursor: 'pointer', transition: 'background 0.2s' }}
                      >
                        Xác nhận đã nhận tiền
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#16a34a', fontWeight: 700, fontSize: '1.1rem' }}>
                    <CheckCircle2 size={24} />
                    Thanh toán thành công!
                  </div>
                )}
              </div>

            </div>
          )}

        </div>
      </div>
    </div>
  );
}
