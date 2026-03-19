'use client';
import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { Suspense } from 'react';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Token = floor(now / 5min) — same logic as admin QR
function getExpectedToken() {
  return String(Math.floor(Date.now() / (5 * 60 * 1000)));
}

function CheckinContent() {
  const params = useSearchParams();
  const token = params.get('t');

  const [phase, setPhase] = useState('validate'); // validate | login | done | invalid
  const [phone, setPhone] = useState('');
  const [pin, setPin]     = useState('');
  const [staff, setStaff] = useState(null);
  const [msg, setMsg]     = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Accept current window and previous window (10 min grace)
    const now = getExpectedToken();
    const prev = String(Math.floor(Date.now() / (5 * 60 * 1000)) - 1);
    if (token === now || token === prev) {
      // Check localStorage for saved session
      const saved = localStorage.getItem('staffUser');
      if (saved) {
        try {
          const u = JSON.parse(saved);
          setStaff(u);
          setPhase('confirm');
        } catch { setPhase('login'); }
      } else {
        setPhase('login');
      }
    } else {
      setPhase('invalid');
    }
  }, [token]);

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

  const handleClockIn = async () => {
    if (!staff) return;
    setLoading(true);
    const today = new Date().toISOString().split('T')[0];
    // Check if already clocked in today
    const { data: existing } = await supabase
      .from('attendance_logs')
      .select('*')
      .eq('staff_id', staff.id)
      .eq('date', today)
      .maybeSingle();

    if (existing && !existing.clock_out) {
      // Clock out
      const cin = new Date(existing.clock_in);
      const cout = new Date();
      const diffH = (cout - cin) / 3600000;
      const workH = Math.round(diffH * 10) / 10;
      const otH   = Math.max(0, Math.round((diffH - 8) * 10) / 10);
      await supabase.from('attendance_logs').update({ clock_out: cout.toISOString(), work_hours: workH, overtime_hours: otH }).eq('id', existing.id);
      setMsg(`✅ Đã kết thúc ca! Làm ${workH}h${otH > 0 ? ` (tăng ca ${otH}h)` : ''}`);
    } else if (existing && existing.clock_out) {
      setMsg('⚠️ Bạn đã hoàn thành ca hôm nay rồi!');
    } else {
      // Clock in
      await supabase.from('attendance_logs').insert({ staff_id: staff.id, clock_in: new Date().toISOString(), date: today });
      setMsg('✅ Đã vào ca! Chúc bạn làm việc tốt 🎉');
    }
    setPhase('done');
    setLoading(false);
  };

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const box = (content) => (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#111827 0%,#1f2937 100%)', padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 20, padding: '32px 28px', maxWidth: 380, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.4)', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>⏰</div>
        <div style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: 4 }}>Chấm Công</div>
        <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: 24 }}>{timeStr} — {today}</div>
        {content}
      </div>
    </div>
  );

  const today = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;

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
      <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#dc2626', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24, margin: '0 auto 12px' }}>
        {staff?.full_name?.charAt(0)}
      </div>
      <div style={{ fontWeight: 800, fontSize: '1.1rem', marginBottom: 4 }}>{staff?.full_name}</div>
      <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: 24 }}>{staff?.phone}</div>
      <button onClick={handleClockIn} disabled={loading}
        style={{ width: '100%', padding: '16px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 12, fontWeight: 800, fontSize: '1.1rem', cursor: 'pointer', boxShadow: '0 4px 16px rgba(22,163,74,0.3)' }}>
        {loading ? 'Đang xử lý...' : '🟢 Xác nhận Chấm công'}
      </button>
      <button onClick={() => { localStorage.removeItem('staffUser'); setStaff(null); setPhase('login'); }}
        style={{ marginTop: 12, background: 'none', border: 'none', color: '#9ca3af', fontSize: '0.8rem', cursor: 'pointer' }}>
        Đăng nhập tài khoản khác
      </button>
    </>
  );

  if (phase === 'done') return box(
    <>
      <div style={{ fontSize: 60, marginBottom: 12 }}>🎉</div>
      <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#15803d', marginBottom: 8 }}>{msg}</div>
      <div style={{ fontSize: '0.82rem', color: '#9ca3af' }}>Bạn có thể đóng trang này.</div>
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
