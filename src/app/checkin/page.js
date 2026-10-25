'use client';
import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { workforce } from '@/lib/staffApi';
import { shiftOf } from '@/lib/attendanceRules.mjs';
import { STAFF_WARNING_TEXT as WARNING_TEXT, clockSummary, clockTime as formatTime, hoursText, punctuality, spokenClock, spokenClockError, sumHours, tokenFresh } from '@/lib/clockMessages.mjs';
import { speak, unlockSpeech } from '@/lib/speak';
import { Suspense } from 'react';

// Trình duyệt trong Zalo / Facebook giữ cookie riêng → máy chủ tưởng là điện thoại khác.
const inAppBrowser = () => typeof navigator !== 'undefined' && /Zalo|FBAN|FBAV|Instagram|Messenger/i.test(navigator.userAgent);

const vnDate = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

function CheckinContent() {
  const params = useSearchParams();
  const token  = params.get('t');

  const [phase,    setPhase]    = useState('validate');
  const [phone,    setPhone]    = useState('');
  const [pin,      setPin]      = useState('');
  const [staff,    setStaff]    = useState(null);
  const [msg,      setMsg]      = useState('');
  const [warn,     setWarn]     = useState('');
  const [loading,  setLoading]  = useState(false);
  const [todaySessions, setTodaySessions] = useState([]);
  const [openSession, setOpenSession] = useState(null);
  const [rules, setRules] = useState(null);
  const [onTime, setOnTime] = useState('');
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(inAppBrowser()), []);

  const loadStatus = async () => {
    try {
      const r = await fetch('/api/admin/workforce?me=1', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setTodaySessions(j.sessions || []); setOpenSession(j.open || null); setRules(j.rules || null); }
    } catch { /* chỉ để hiện trạng thái, chấm công vẫn chạy được */ }
  };

  useEffect(() => {
    if (!tokenFresh(token)) { setPhase('invalid'); return; }
    (async () => {
      try {
        const r = await fetch('/api/admin/session', { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.user) { setStaff(j.user); await loadStatus(); setPhase('confirm'); }
        else setPhase('login');
      } catch { setPhase('login'); }
    })();
  }, [token]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await fetch('/api/admin/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, pin }) });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.user) {
        setStaff(result.user);
        setMsg('');
        await loadStatus();
        setPhase('confirm');
      } else {
        setMsg(result.error || 'Sai số điện thoại hoặc PIN!');
      }
    } catch { setMsg('Mạng yếu, thử lại.'); }
    setLoading(false);
  };

  const switchAccount = async () => {
    await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
    setStaff(null); setPhone(''); setPin(''); setPhase('login');
  };

  const handleClockAction = async () => {
    if (!staff) return;
    unlockSpeech(); // đang bấm nút: mở khoá đọc to kết quả
    setLoading(true);
    let result;
    try {
      result = await workforce('clock', { token });
    } catch (err) {
      setMsg(err.message);
      speak(spokenClockError(err.message));
      if (/cần đăng nhập/i.test(err.message)) { setStaff(null); setPhase('login'); }
      setLoading(false);
      return;
    }
    const allSessions = result.sessions || [];
    setTodaySessions(allSessions);
    setOpenSession(result.clocked === 'in' ? result.session : null);
    setOnTime(punctuality(result.clocked, result.session, allSessions, rules, staff.id));
    setWarn((result.warnings || []).map(w => WARNING_TEXT[w]).filter(Boolean).join(' '));
    setMsg(clockSummary(result));
    setPhase('done');
    speak(spokenClock(result));
    setLoading(false);
  };

  const now     = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today   = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;

  const totalToday = sumHours(todaySessions);
  const isWorking  = !!openSession;

  const box = (content) => (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#111827 0%,#1f2937 100%)', padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 20, padding: '32px 28px', maxWidth: 400, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.4)', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 6 }}>⏰</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: 2 }}>Chấm Công</div>
        <div style={{ fontSize: '0.78rem', color: '#9ca3af', marginBottom: 20 }}>{timeStr} — {today}</div>
        {inApp && phase !== 'invalid' && (
          <div style={{ background: '#fef3c7', color: '#92400e', borderRadius: 10, padding: '8px 12px', fontSize: '0.8rem', marginBottom: 14, textAlign: 'left' }}>
            ⚠ Bạn đang mở trong Zalo / Facebook. Lần sau hãy quét bằng nút <strong>📷 quét mã</strong> trong app nhân viên (hoặc camera điện thoại) để máy nhận đúng điện thoại của bạn.
          </div>
        )}
        {content}
      </div>
    </div>
  );

  if (phase === 'validate') return box(<div style={{ color: '#6b7280' }}>Đang kiểm tra...</div>);

  if (phase === 'invalid') return box(
    <>
      <div style={{ fontSize: 48, marginBottom: 12 }}>❌</div>
      <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>Mã QR đã cũ!</div>
      <div style={{ fontSize: '0.85rem', color: '#6b7280' }}>Quét lại mã đang hiện trên máy quầy bằng camera điện thoại. Mã đổi liên tục, ảnh chụp mã không dùng được.</div>
    </>
  );

  if (phase === 'login') return box(
    <>
      <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: 20 }}>Đăng nhập để chấm công</div>
      {msg && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: '0.85rem' }}>{msg}</div>}
      <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input type="tel" placeholder="Số điện thoại" value={phone} onChange={e => setPhone(e.target.value)} required
          style={{ padding: '12px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '1rem', outline: 'none', textAlign: 'center' }} />
        <input type="password" inputMode="numeric" placeholder="Mã PIN" value={pin} onChange={e => setPin(e.target.value)} required
          style={{ padding: '12px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '1rem', outline: 'none', textAlign: 'center', letterSpacing: 6 }} />
        <button type="submit" disabled={loading}
          style={{ padding: '14px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '1rem', cursor: 'pointer' }}>
          {loading ? 'Đang kiểm tra...' : 'Đăng nhập'}
        </button>
      </form>
    </>
  );

  if (phase === 'confirm') return box(
    <>
      {/* Avatar */}
      <div style={{ width: 60, height: 60, borderRadius: '50%', background: isWorking ? '#16a34a' : '#0f172a', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 22, margin: '0 auto 10px' }}>
        {staff?.full_name?.charAt(0)}
      </div>
      <div style={{ fontWeight: 800, fontSize: '1.1rem', marginBottom: 2 }}>{staff?.full_name}</div>
      <div style={{ fontSize: '0.78rem', color: '#9ca3af', marginBottom: 16 }}>{staff?.phone}</div>

      {msg && <div style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 10, padding: '8px 12px', fontSize: '0.85rem', marginBottom: 14 }}>{msg}</div>}

      {/* Status indicator */}
      <div style={{ background: isWorking ? '#dcfce7' : '#f1f5f9', borderRadius: 10, padding: '8px 14px', marginBottom: 16, fontSize: '0.82rem', fontWeight: 600, color: isWorking ? '#15803d' : '#475569' }}>
        {isWorking
          ? `🟢 Đang làm việc từ ${formatTime(openSession.clock_in)}`
          : totalToday > 0
            ? `✅ Hôm nay đã làm ${hoursText(totalToday)} (${todaySessions.filter(s=>s.clock_out).length} ca)`
            : '⚪ Chưa chấm công hôm nay'}
      </div>
      {rules && staff && (() => {
        const shift = shiftOf(rules, staff.id, vnDate());
        return <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: -8, marginBottom: 14 }}>🕑 Ca hôm nay: <strong>{shift.start} – {shift.end}</strong></div>;
      })()}

      {/* Today's sessions */}
      {todaySessions.length > 0 && (
        <div style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 14px', marginBottom: 16, textAlign: 'left' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Các ca hôm nay</div>
          {todaySessions.map((s, i) => {
            const dur = s.clock_out
              ? Math.round(((new Date(s.clock_out) - new Date(s.clock_in)) / 3600000) * 10) / 10
              : null;
            return (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < todaySessions.length - 1 ? '1px solid #e2e8f0' : 'none', fontSize: '0.8rem' }}>
                <span style={{ fontWeight: 600 }}>Ca {i + 1}</span>
                <span style={{ color: '#475569' }}>
                  {formatTime(s.clock_in)} → {s.clock_out ? formatTime(s.clock_out) : <span style={{ color: '#f59e0b', fontWeight: 700 }}>Đang làm</span>}
                </span>
                <span style={{ color: '#16a34a', fontWeight: 600 }}>{dur ? hoursText(dur) : '—'}</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 700, color: '#0f172a', marginTop: 6, paddingTop: 6, borderTop: '1.5px solid #0f172a' }}>
            <span>Tổng</span><span>{hoursText(totalToday)}</span>
          </div>
        </div>
      )}

      {/* Action button */}
      <button onClick={handleClockAction} disabled={loading}
        style={{ width: '100%', padding: '16px', background: isWorking ? '#dc2626' : '#16a34a', color: 'white', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: '1.05rem', cursor: 'pointer', boxShadow: `0 4px 16px rgba(${isWorking ? '220,38,38' : '22,163,74'},0.3)`, marginBottom: 10 }}>
        {loading ? 'Đang xử lý...' : isWorking ? '🔴 Kết thúc ca' : '🟢 Bắt đầu ca'}
      </button>
      <button onClick={switchAccount}
        style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '0.78rem', cursor: 'pointer' }}>
        Không phải bạn? Đăng nhập tài khoản khác
      </button>
    </>
  );

  if (phase === 'done') return box(
    <>
      <div style={{ fontSize: 56, marginBottom: 10 }}>{msg.startsWith('🟢') ? '🎉' : '✅'}</div>
      <div style={{ fontWeight: 800, fontSize: '1rem', color: '#15803d', marginBottom: 8, whiteSpace: 'pre-line', lineHeight: 1.6 }}>{msg}</div>
      {onTime && (
        <div style={{ background: onTime.startsWith('✅') ? '#dcfce7' : '#fef3c7', color: onTime.startsWith('✅') ? '#15803d' : '#92400e', borderRadius: 10, padding: '8px 12px', fontSize: '0.85rem', fontWeight: 600, marginBottom: 12 }}>
          {onTime}
        </div>
      )}
      {warn && (
        <div style={{ background: '#fef3c7', color: '#92400e', borderRadius: 10, padding: '8px 12px', fontSize: '0.8rem', marginBottom: 12, textAlign: 'left' }}>
          ⚠ {warn} Chủ quán sẽ thấy cảnh báo này. Sắp tới máy sẽ không cho chấm nếu vậy.
        </div>
      )}
      <a href="/admin/payroll" style={{ display: 'block', padding: '11px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 10, color: '#1d4ed8', fontWeight: 700, fontSize: '0.88rem', textDecoration: 'none', marginBottom: 10 }}>
        📋 Xem giờ công, xin sửa giờ, ứng lương, báo nghỉ
      </a>
      <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>Bạn có thể đóng trang này. Lần sau quét mã mới trên máy quầy.</div>
    </>
  );
}

export default function CheckinPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#111827', color: 'white' }}>Đang tải...</div>}>
      <CheckinContent />
    </Suspense>
  );
}
