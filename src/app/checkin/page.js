'use client';
import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { Suspense } from 'react';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

function getExpectedToken() {
  return String(Math.floor(Date.now() / (5 * 60 * 1000)));
}

// Sum hours of all closed sessions for today
function sumHours(sessions) {
  return sessions.reduce((acc, s) => {
    if (s.clock_out) {
      const h = (new Date(s.clock_out) - new Date(s.clock_in)) / 3600000;
      return acc + Math.round(h * 10) / 10;
    }
    return acc;
  }, 0);
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function CheckinContent() {
  const params = useSearchParams();
  const token  = params.get('t');

  const [phase,    setPhase]    = useState('validate');
  const [phone,    setPhone]    = useState('');
  const [pin,      setPin]      = useState('');
  const [staff,    setStaff]    = useState(null);
  const [msg,      setMsg]      = useState('');
  const [loading,  setLoading]  = useState(false);
  const [todaySessions, setTodaySessions] = useState([]);

  useEffect(() => {
    const now  = getExpectedToken();
    const prev = String(Number(now) - 1);
    if (token === now || token === prev) {
      try {
        const saved = localStorage.getItem('staffUser');
        if (saved) { setStaff(JSON.parse(saved)); setPhase('confirm'); }
        else setPhase('login');
      } catch { setPhase('login'); }
    } else {
      setPhase('invalid');
    }
  }, [token]);

  // Load today's sessions when staff is known
  useEffect(() => {
    if (!staff) return;
    const today = new Date().toISOString().split('T')[0];
    supabase.from('attendance_sessions')
      .select('*')
      .eq('staff_id', staff.id)
      .eq('date', today)
      .order('clock_in')
      .then(({ data }) => setTodaySessions(data || []));
  }, [staff, phase]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { data } = await supabase.from('staff').select('*').eq('phone', phone).eq('pin', pin).single();
    if (data) {
      localStorage.setItem('staffUser', JSON.stringify(data));
      setStaff(data);
      setPhase('confirm');
    } else {
      setMsg('Sai số điện thoại hoặc PIN!');
    }
    setLoading(false);
  };

  const handleClockAction = async () => {
    if (!staff) return;
    setLoading(true);
    const today = new Date().toISOString().split('T')[0];

    // Fetch today's sessions fresh
    const { data: sessions } = await supabase
      .from('attendance_sessions')
      .select('*')
      .eq('staff_id', staff.id)
      .eq('date', today)
      .order('clock_in');

    const allSessions = sessions || [];
    const openSession = allSessions.find(s => !s.clock_out);

    let resultMsg = '';

    if (openSession) {
      // ── CLOCK OUT ──
      const clockOut = new Date();
      const durH = Math.round(((clockOut - new Date(openSession.clock_in)) / 3600000) * 10) / 10;
      await supabase.from('attendance_sessions')
        .update({ clock_out: clockOut.toISOString() })
        .eq('id', openSession.id);

      // Recalc total for today after close
      const closedSessions = [...allSessions.filter(s => s.id !== openSession.id && s.clock_out), { ...openSession, clock_out: clockOut.toISOString() }];
      const totalH = sumHours(closedSessions);
      const otH    = Math.max(0, Math.round((totalH - 8) * 10) / 10);

      resultMsg = `🔴 Ra ca lúc ${formatTime(clockOut)} · Ca này: ${durH}h\n✅ Tổng hôm nay: ${totalH}h${otH > 0 ? ` (tăng ca ${otH}h)` : ''}`;
    } else {
      // ── CLOCK IN ──
      await supabase.from('attendance_sessions')
        .insert({ staff_id: staff.id, date: today, clock_in: new Date().toISOString() });

      const totalSoFar = sumHours(allSessions);
      resultMsg = `🟢 Vào ca lúc ${formatTime(new Date())}\n⏱ Tổng tích luỹ hôm nay: ${totalSoFar}h`;
    }

    setMsg(resultMsg);
    setPhase('done');
    setLoading(false);
  };

  const now     = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const today   = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;

  const totalToday   = sumHours(todaySessions);
  const openSession  = todaySessions.find(s => !s.clock_out);
  const isWorking    = !!openSession;

  const box = (content) => (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#111827 0%,#1f2937 100%)', padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 20, padding: '32px 28px', maxWidth: 400, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.4)', textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 6 }}>⏰</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: 2 }}>Chấm Công</div>
        <div style={{ fontSize: '0.78rem', color: '#9ca3af', marginBottom: 20 }}>{timeStr} — {today}</div>
        {content}
      </div>
    </div>
  );

  if (phase === 'validate') return box(<div style={{ color: '#6b7280' }}>Đang kiểm tra...</div>);

  if (phase === 'invalid') return box(
    <>
      <div style={{ fontSize: 48, marginBottom: 12 }}>❌</div>
      <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 8 }}>Mã QR hết hạn!</div>
      <div style={{ fontSize: '0.85rem', color: '#6b7280' }}>Admin cần làm mới QR code. Mỗi mã có giá trị 5 phút.</div>
    </>
  );

  if (phase === 'login') return box(
    <>
      <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: 20 }}>Đăng nhập để chấm công</div>
      {msg && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: '0.85rem' }}>{msg}</div>}
      <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input type="tel" placeholder="Số điện thoại" value={phone} onChange={e => setPhone(e.target.value)} required
          style={{ padding: '12px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '1rem', outline: 'none', textAlign: 'center' }} />
        <input type="password" placeholder="Mã PIN" value={pin} onChange={e => setPin(e.target.value)} required
          style={{ padding: '12px 14px', border: '1.5px solid #e5e7eb', borderRadius: 10, fontSize: '1rem', outline: 'none', textAlign: 'center', letterSpacing: 6 }} />
        <button type="submit" disabled={loading}
          style={{ padding: '14px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '1rem', cursor: 'pointer' }}>
          {loading ? 'Đang kiểm tra...' : 'Đăng nhập & Chấm công'}
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

      {/* Status indicator */}
      <div style={{ background: isWorking ? '#dcfce7' : '#f1f5f9', borderRadius: 10, padding: '8px 14px', marginBottom: 16, fontSize: '0.82rem', fontWeight: 600, color: isWorking ? '#15803d' : '#475569' }}>
        {isWorking
          ? `🟢 Đang làm việc từ ${formatTime(openSession.clock_in)}`
          : totalToday > 0
            ? `✅ Hôm nay đã làm ${totalToday}h (${todaySessions.filter(s=>s.clock_out).length} ca)`
            : '⚪ Chưa chấm công hôm nay'}
      </div>

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
                <span style={{ color: '#16a34a', fontWeight: 600 }}>{dur ? `${dur}h` : '—'}</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 700, color: '#0f172a', marginTop: 6, paddingTop: 6, borderTop: '1.5px solid #0f172a' }}>
            <span>Tổng</span><span>{totalToday}h</span>
          </div>
        </div>
      )}

      {/* Action button */}
      <button onClick={handleClockAction} disabled={loading}
        style={{ width: '100%', padding: '16px', background: isWorking ? '#dc2626' : '#16a34a', color: 'white', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: '1.05rem', cursor: 'pointer', boxShadow: `0 4px 16px rgba(${isWorking ? '220,38,38' : '22,163,74'},0.3)`, marginBottom: 10 }}>
        {loading ? 'Đang xử lý...' : isWorking ? '🔴 Kết thúc ca' : '🟢 Bắt đầu ca'}
      </button>
      <button onClick={() => { localStorage.removeItem('staffUser'); setStaff(null); setPhase('login'); }}
        style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '0.78rem', cursor: 'pointer' }}>
        Đăng nhập tài khoản khác
      </button>
    </>
  );

  if (phase === 'done') return box(
    <>
      <div style={{ fontSize: 56, marginBottom: 10 }}>{msg.startsWith('🟢') ? '🎉' : '✅'}</div>
      <div style={{ fontWeight: 800, fontSize: '1rem', color: '#15803d', marginBottom: 8, whiteSpace: 'pre-line', lineHeight: 1.6 }}>{msg}</div>
      <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: 16 }}>Bạn có thể đóng trang này.</div>
      <button onClick={() => setPhase('confirm')}
        style={{ padding: '10px 24px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', color: '#475569' }}>
        ← Quay lại
      </button>
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
