'use client';
/**
 * Lớp khoá các tab nhạy cảm của chủ quán (Lương, Thống kê & Kế toán, Khách hàng, Cài đặt, Sổ thu chi):
 * đã đăng nhập vẫn phải nhập mã PIN chủ quán tự đặt. Trang bên trong chỉ được dựng sau khi máy chủ báo PIN
 * đúng (/api/admin/lock), nên chưa nhập PIN thì trang không tải số liệu.
 * Mỗi lần mở tab là mỗi lần nhập PIN (không nhớ lần trước — layout dựng lại khung này cho từng tab); nút 🔒 khoá ngay.
 */
import { useEffect, useState } from 'react';
import { Delete, Lock } from 'lucide-react';
import './pinGate.css';

const TITLES = { payroll: 'Lương nhân viên', stats: 'Thống kê & Kế toán', customers: 'Khách hàng', settings: 'Cài đặt', finance: 'Sổ thu chi', vouchers: 'Voucher' };

async function lockApi(body) {
  const response = await fetch('/api/admin/lock', body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Không kiểm tra được mã PIN.'), { status: response.status });
  return result;
}

// Các bước: 'unlock' nhập PIN · 'create' / 'create2' đặt PIN lần đầu · 'current' → 'new' → 'new2' đổi PIN ·
// 'login' → 'new' → 'new2' quên PIN (nhập mã đăng nhập tài khoản).
const PROMPTS = {
  unlock: 'Nhập mã PIN để mở', create: 'Đặt mã PIN mới (4–6 số)', create2: 'Nhập lại mã PIN mới',
  current: 'Nhập mã PIN đang dùng', new: 'Nhập mã PIN mới (4–6 số)', new2: 'Nhập lại mã PIN mới', login: 'Nhập mã đăng nhập tài khoản (PIN đăng nhập)',
};

export default function AdminPinGate({ section, children }) {
  const [state, setState] = useState(null); // { hasPin, length }
  const [unlocked, setUnlocked] = useState(false);
  const [step, setStep] = useState('unlock');
  const [digits, setDigits] = useState('');
  const [saved, setSaved] = useState({}); // { current, login, first }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function check() {
    setError('');
    try {
      const s = await lockApi();
      setState({ hasPin: s.hasPin, length: s.length });
      setStep(s.hasPin ? 'unlock' : 'create');
      if (s.wait) setError(`Nhập sai nhiều lần. Thử lại sau ${Math.ceil(s.wait / 60)} phút.`);
    } catch (err) { setError(err.message); setState(s => s || { hasPin: true }); }
  }
  useEffect(() => { check(); }, []);

  const maxLen = step === 'login' ? 12 : step === 'unlock' && state?.length ? state.length : 6;
  async function submit(value = digits) {
    if (busy) return;
    const short = step !== 'login' && value.length < 4;
    if (short) { setError('Mã PIN gồm 4 đến 6 chữ số.'); return; }
    setError('');
    const next = (s, keep = {}) => { setSaved(v => ({ ...v, ...keep })); setStep(s); setDigits(''); };
    if (step === 'create') return next('create2', { first: value });
    if (step === 'current') return next('new', { current: value });
    if (step === 'login') return next('new', { login: value });
    if (step === 'new') return next('new2', { first: value });
    if ((step === 'create2' || step === 'new2') && value !== saved.first) {
      setError('Hai lần nhập không giống nhau, nhập lại.'); next(step === 'create2' ? 'create' : 'new'); return;
    }
    setBusy(true);
    try {
      if (step === 'unlock') await lockApi({ action: 'unlock', pin: value });
      else if (saved.login) await lockApi({ action: 'reset', loginPin: saved.login, pin: value });
      else await lockApi({ action: 'set', pin: value, current: saved.current });
      setSaved({}); setDigits('');
      setState({ hasPin: true, length: value.length });
      setUnlocked(true);
    } catch (err) {
      setError(err.message); setDigits('');
      if (step !== 'unlock') { setSaved({}); setStep(state?.hasPin ? 'unlock' : 'create'); }
    } finally { setBusy(false); }
  }
  function press(key) {
    if (busy) return;
    setError('');
    if (key === 'del') { setDigits(d => d.slice(0, -1)); return; }
    if (key === 'ok') { submit(); return; }
    const value = (digits + key).slice(0, maxLen);
    setDigits(value);
    // Biết độ dài PIN đang dùng: đủ số là tự mở, khỏi bấm ✓.
    if (step === 'unlock' && state?.length && value.length === state.length) submit(value);
  }
  function lockNow() { setUnlocked(false); setStep('unlock'); setDigits(''); setError(''); }

  if (unlocked) {
    return <>
      {children}
      <button type="button" className="pin-lock-now" onClick={lockNow} title="Khoá lại ngay" aria-label="Khoá lại ngay"><Lock size={16} /></button>
    </>;
  }
  return <div className="pin-gate" role="dialog" aria-label="Nhập mã PIN">
    <div className="pin-card">
      <div className="pin-icon"><Lock size={26} /></div>
      <h2>{TITLES[section] || 'Khu vực của chủ quán'}</h2>
      <p className="pin-prompt">{state ? PROMPTS[step] : 'Đang kiểm tra...'}</p>
      <div className={`pin-dots${step === 'login' ? ' wide' : ''}`} aria-live="polite">
        {Array.from({ length: Math.max(step === 'unlock' && state?.length ? state.length : 4, digits.length) }, (_, i) =>
          <span key={i} className={i < digits.length ? 'on' : ''} />)}
      </div>
      {error && <p className="pin-error" role="alert">{error}</p>}
      <div className="pin-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map(k => (
          <button key={k} type="button" disabled={!state || busy} onClick={() => press(k)} className={k === 'ok' ? 'ok' : k === 'del' ? 'del' : ''}
            aria-label={k === 'del' ? 'Xoá' : k === 'ok' ? 'Xong' : k}>
            {k === 'del' ? <Delete size={22} /> : k === 'ok' ? '✓' : k}
          </button>
        ))}
      </div>
      {state?.hasPin && <div className="pin-links">
        {step === 'unlock'
          ? <>
              <button type="button" onClick={() => { setStep('current'); setDigits(''); setError(''); }}>Đổi mã PIN</button>
              <button type="button" onClick={() => { setStep('login'); setDigits(''); setError(''); }}>Quên mã PIN?</button>
            </>
          : <button type="button" onClick={() => { setStep('unlock'); setSaved({}); setDigits(''); setError(''); }}>Quay lại</button>}
      </div>}
      {step === 'login' && <p className="pin-note">Mã đăng nhập là mã PIN bạn dùng khi đăng nhập bằng số điện thoại.</p>}
    </div>
  </div>;
}
