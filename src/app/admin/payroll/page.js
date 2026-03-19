'use client';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle, XCircle, Clock, AlertTriangle, DollarSign, Calendar, Settings, Users } from 'lucide-react';
import './payroll.css';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const now = new Date();
const fmt = (n) => String(n).padStart(2, '0');
const formatMoney = (v) => Number(v || 0).toLocaleString('vi-VN') + 'đ';

// Returns token that changes every 5 minutes
function getQRToken() { return String(Math.floor(Date.now() / (5 * 60 * 1000))); }
// Seconds left in current 5-min window
function secsLeft() { return 300 - (Math.floor(Date.now() / 1000) % 300); }

export default function PayrollPage() {
  const [activeTab, setActiveTab] = useState('salary');
  const [staffList, setStaffList] = useState([]);
  const [configs, setConfigs] = useState({});
  const [requests, setRequests] = useState([]);
  const [violations, setViolations] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [loading, setLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [currentUser, setCurrentUser] = useState(null);
  const router = useRouter();

  // Read current user from localStorage (set by admin layout)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('staffUser');
      if (saved) {
        const u = JSON.parse(saved);
        setCurrentUser(u);
        if (u.role !== 'admin') fetchStaffData(u.id);
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Staff self-service state
  const [todayAtt,    setTodayAtt]    = useState(null);
  const [empReqs,     setEmpReqs]     = useState([]);
  const [showAdvForm, setShowAdvForm] = useState(false);
  const [showAbsForm, setShowAbsForm] = useState(false);
  const [advForm,     setAdvForm]     = useState({ amount: '', reason: '' });
  const [absForm,     setAbsForm]     = useState({ days: '1', reason: '' });

  const fetchStaffData = async (staffId) => {
    const today = new Date().toISOString().split('T')[0];
    const m = now.getMonth() + 1; const y = now.getFullYear();
    const [attRes, reqRes] = await Promise.all([
      supabase.from('attendance_logs').select('*').eq('staff_id', staffId).eq('date', today).maybeSingle(),
      supabase.from('payroll_requests').select('*').eq('staff_id', staffId).eq('month', m).eq('year', y).order('created_at', { ascending: false }),
    ]);
    setTodayAtt(attRes.data);
    setEmpReqs(reqRes.data || []);
  };

  const handleClockIn = async () => {
    if (!currentUser) return;
    await supabase.from('attendance_logs').insert({ staff_id: currentUser.id, clock_in: new Date().toISOString(), date: new Date().toISOString().split('T')[0] });
    fetchStaffData(currentUser.id);
  };

  const handleClockOut = async () => {
    if (!todayAtt) return;
    const diffH = (new Date() - new Date(todayAtt.clock_in)) / 3600000;
    const workH = Math.round(diffH * 10) / 10;
    const otH   = Math.max(0, Math.round((diffH - 8) * 10) / 10);
    await supabase.from('attendance_logs').update({ clock_out: new Date().toISOString(), work_hours: workH, overtime_hours: otH }).eq('id', todayAtt.id);
    fetchStaffData(currentUser.id);
  };

  const handleSubmitAdvance = async () => {
    if (!advForm.amount || !advForm.reason) return alert('Vui long dien day du!');
    const m = now.getMonth() + 1; const y = now.getFullYear();
    await supabase.from('payroll_requests').insert({ staff_id: currentUser.id, request_type: 'advance', amount: Number(advForm.amount.replace(/\./g, '')), reason: advForm.reason, month: m, year: y });
    setAdvForm({ amount: '', reason: '' }); setShowAdvForm(false);
    fetchStaffData(currentUser.id);
    alert('Da gui yeu cau ung luong!');
  };

  const handleSubmitAbsent = async () => {
    if (!absForm.reason) return alert('Vui long dien ly do!');
    const m = now.getMonth() + 1; const y = now.getFullYear();
    await supabase.from('payroll_requests').insert({ staff_id: currentUser.id, request_type: 'absent', days: Number(absForm.days), reason: absForm.reason, month: m, year: y });
    setAbsForm({ days: '1', reason: '' }); setShowAbsForm(false);
    fetchStaffData(currentUser.id);
    alert('Da gui bao nghi!');
  };

  // QR state
  const [qrToken, setQrToken] = useState(getQRToken());
  const [qrCountdown, setQrCountdown] = useState(secsLeft());
  const [networkUrl, setNetworkUrl] = useState('');

  useEffect(() => {
    // Detect network URL for QR
    const host = window.location.hostname;
    const port = window.location.port;
    setNetworkUrl(`http://${host}${port ? ':' + port : ''}/checkin?t=${qrToken}`);
  }, [qrToken]);

  useEffect(() => {
    const interval = setInterval(() => {
      const secs = secsLeft();
      setQrCountdown(secs);
      const newToken = getQRToken();
      if (newToken !== qrToken) setQrToken(newToken);
    }, 1000);
    return () => clearInterval(interval);
  }, [qrToken]);

  // Violation form
  const [vForm, setVForm] = useState({ staff_id: '', amount: '', reason: '' });
  // Config edit state
  const [configEdits, setConfigEdits] = useState({});
  // Account management
  const [accForm, setAccForm] = useState({ full_name: '', phone: '', pin: '', role: 'staff' });
  const [editingPin, setEditingPin] = useState({}); // { staffId: newPin }
  const [accMsg, setAccMsg] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [staffRes, cfgRes, reqRes, vioRes, attRes] = await Promise.all([
      supabase.from('staff').select('*').order('full_name'),
      supabase.from('payroll_config').select('*'),
      supabase.from('payroll_requests').select('*, staff(full_name,phone)').order('created_at', { ascending: false }),
      supabase.from('payroll_violations').select('*, staff(full_name)').eq('month', selMonth).eq('year', selYear),
      supabase.from('attendance_logs').select('*').gte('date', `${selYear}-${fmt(selMonth)}-01`).lt('date', selMonth === 12 ? `${selYear + 1}-01-01` : `${selYear}-${fmt(selMonth + 1)}-01`),
    ]);
    setStaffList(staffRes.data || []);
    const cfgMap = {};
    (cfgRes.data || []).forEach(c => { cfgMap[c.staff_id] = c; });
    setConfigs(cfgMap);
    const edits = {};
    (cfgRes.data || []).forEach(c => { edits[c.staff_id] = { base_salary: c.base_salary, overtime_rate: c.overtime_rate, pay_day: c.pay_day }; });
    setConfigEdits(edits);
    setRequests(reqRes.data || []);
    setPendingCount((reqRes.data || []).filter(r => r.status === 'pending').length);
    setViolations(vioRes.data || []);
    setAttendance(attRes.data || []);
    setLoading(false);
  }, [selMonth, selYear]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // --- Salary calculation ---
  const calcSalary = (staffId) => {
    const cfg = configs[staffId];
    const base = cfg?.base_salary || 0;
    const otRate = cfg?.overtime_rate || 25000;
    const dailyRate = base > 0 ? Math.round(base / 26) : 0;

    const otHours = attendance.filter(a => a.staff_id === staffId).reduce((s, a) => s + Number(a.overtime_hours || 0), 0);
    const otAmt = Math.round(otHours * otRate);

    const approved = requests.filter(r => r.staff_id === staffId && r.status === 'approved' && r.month === selMonth && r.year === selYear);
    const advAmt = approved.filter(r => r.request_type === 'advance').reduce((s, r) => s + Number(r.amount || 0), 0);
    const absDays = approved.filter(r => r.request_type === 'absent').reduce((s, r) => s + Number(r.days || 0), 0);
    const absAmt = Math.round(absDays * dailyRate);

    const vioAmt = violations.filter(v => v.staff_id === staffId).reduce((s, v) => s + Number(v.amount || 0), 0);

    const net = base + otAmt - advAmt - absAmt - vioAmt;
    return { base, otHours, otAmt, advAmt, absDays, absAmt, vioAmt, net };
  };

  // --- Approve / Reject request ---
  const handleDecision = async (reqId, decision, adminNote = '') => {
    await supabase.from('payroll_requests').update({ status: decision, admin_note: adminNote, updated_at: new Date().toISOString() }).eq('id', reqId);
    fetchAll();
  };

  // --- Add violation ---
  const handleAddViolation = async () => {
    if (!vForm.staff_id || !vForm.amount || !vForm.reason) return alert('Vui lòng điền đầy đủ!');
    await supabase.from('payroll_violations').insert({ staff_id: vForm.staff_id, amount: Number(vForm.amount.replace(/\./g, '')), reason: vForm.reason, month: selMonth, year: selYear });
    setVForm({ staff_id: '', amount: '', reason: '' });
    fetchAll();
  };

  // --- Save config ---
  const handleSaveConfig = async (staffId) => {
    const edit = configEdits[staffId];
    if (!edit) return;
    const payload = { staff_id: staffId, base_salary: Number(edit.base_salary) || 0, overtime_rate: Number(edit.overtime_rate) || 25000, pay_day: Number(edit.pay_day) || 5, updated_at: new Date().toISOString() };
    const existing = configs[staffId];
    if (existing) {
      await supabase.from('payroll_config').update(payload).eq('staff_id', staffId);
    } else {
      await supabase.from('payroll_config').insert(payload);
    }
    fetchAll();
    alert('Đã lưu cấu hình!');
  };

  // --- Delete violation ---
  const handleDeleteViolation = async (id) => {
    if (!confirm('Xoá khoản phạt này?')) return;
    await supabase.from('payroll_violations').delete().eq('id', id);
    fetchAll();
  };

  // --- Account management ---
  const handleCreateAccount = async () => {
    if (!accForm.full_name || !accForm.phone || !accForm.pin) return setAccMsg('Vui lòng điền đầy đủ!');
    if (accForm.pin.length < 4) return setAccMsg('PIN cần ít nhất 4 ký tự!');
    const { error } = await supabase.from('staff').insert({ full_name: accForm.full_name.trim(), phone: accForm.phone.trim(), pin: accForm.pin, role: accForm.role });
    if (error) { setAccMsg(error.message.includes('unique') ? '⚠️ Số điện thoại đã tồn tại!' : error.message); return; }
    setAccForm({ full_name: '', phone: '', pin: '', role: 'staff' });
    setAccMsg('✅ Tạo tài khoản thành công!');
    fetchAll();
    setTimeout(() => setAccMsg(''), 3000);
  };

  const handleUpdatePin = async (staffId) => {
    const newPin = editingPin[staffId];
    if (!newPin || newPin.length < 4) return alert('PIN cần ít nhất 4 ký tự!');
    await supabase.from('staff').update({ pin: newPin }).eq('id', staffId);
    setEditingPin(p => ({ ...p, [staffId]: '' }));
    fetchAll();
    alert('Đã cập nhật PIN!');
  };

  const handleDeleteAccount = async (staffId, name) => {
    if (!confirm(`Xoá tài khoản "${name}"? Hành động này không thể hoàn tác.`)) return;
    await supabase.from('staff').delete().eq('id', staffId);
    fetchAll();
  };

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const years = [2025, 2026, 2027];

  const requestTypeMap = { advance: { label: '💵 Ứng lương', color: '#92400e', bg: '#fef9c3' }, absent: { label: '🏖 Báo nghỉ', color: '#1e40af', bg: '#dbeafe' } };

  // ── STAFF VIEW ──────────────────────────────────────────────────────────────
  if (currentUser && currentUser.role !== 'admin') {
    const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : null;
    return (
      <div className="payroll-page">
        <div className="payroll-header">
          <div className="payroll-title">💰 Tính Lương của tôi</div>
          <div style={{ fontSize: '0.82rem', color: '#6b7280' }}>Tháng {now.getMonth() + 1}/{now.getFullYear()}</div>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Chấm công */}
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
            <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 12 }}>⏰ Chấm công hôm nay</div>
            {!todayAtt ? (
              <button onClick={handleClockIn} style={{ width: '100%', padding: '14px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer' }}>
                🟢 Bắt đầu ca làm
              </button>
            ) : !todayAtt.clock_out ? (
              <div>
                <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: 10 }}>
                  ✅ Đã vào lúc <strong>{fmtTime(todayAtt.clock_in)}</strong>
                </div>
                <button onClick={handleClockOut} style={{ width: '100%', padding: '14px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer' }}>
                  🔴 Kết thúc ca
                </button>
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                  Vào: <strong>{fmtTime(todayAtt.clock_in)}</strong> → Ra: <strong>{fmtTime(todayAtt.clock_out)}</strong>
                </div>
                <div style={{ marginTop: 6, fontWeight: 700 }}>
                  ⏱ <span style={{ color: '#15803d' }}>{todayAtt.work_hours}h làm việc</span>
                  {todayAtt.overtime_hours > 0 && <span style={{ color: '#f59e0b' }}> • Tăng ca: {todayAtt.overtime_hours}h</span>}
                </div>
                <div style={{ marginTop: 4, color: '#16a34a', fontWeight: 700 }}>✅ Hoàn thành ca hôm nay</div>
              </div>
            )}
          </div>

          {/* Ứng lương */}
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showAdvForm ? 12 : 0 }}>
              <div style={{ fontWeight: 800 }}>💵 Xin Ứng Lương</div>
              <button onClick={() => setShowAdvForm(p => !p)} style={{ fontSize: '0.8rem', background: showAdvForm ? '#f3f4f6' : '#111827', color: showAdvForm ? '#374151' : 'white', border: 'none', borderRadius: 8, padding: '5px 12px', fontWeight: 700, cursor: 'pointer' }}>
                {showAdvForm ? 'Huỷ' : '+ Tạo yêu cầu'}
              </button>
            </div>
            {showAdvForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input type="text" inputMode="numeric" placeholder="Số tiền ứng (đ)" value={advForm.amount}
                  onChange={e => { const r = e.target.value.replace(/\./g, '').replace(/\D/g, ''); setAdvForm(p => ({ ...p, amount: r ? Number(r).toLocaleString('vi-VN') : '' })); }}
                  style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem' }} />
                <textarea placeholder="Lý do cần ứng..." value={advForm.reason} onChange={e => setAdvForm(p => ({ ...p, reason: e.target.value }))}
                  style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem', minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} />
                <button onClick={handleSubmitAdvance} style={{ background: '#16a34a', color: 'white', border: 'none', borderRadius: 9, padding: '11px', fontWeight: 800, cursor: 'pointer' }}>
                  Gửi yêu cầu
                </button>
              </div>
            )}
          </div>

          {/* Báo nghỉ */}
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showAbsForm ? 12 : 0 }}>
              <div style={{ fontWeight: 800 }}>🏖 Báo Nghỉ</div>
              <button onClick={() => setShowAbsForm(p => !p)} style={{ fontSize: '0.8rem', background: showAbsForm ? '#f3f4f6' : '#111827', color: showAbsForm ? '#374151' : 'white', border: 'none', borderRadius: 8, padding: '5px 12px', fontWeight: 700, cursor: 'pointer' }}>
                {showAbsForm ? 'Huỷ' : '+ Báo nghỉ'}
              </button>
            </div>
            {showAbsForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input type="number" min="0.5" max="30" step="0.5" placeholder="Số ngày nghỉ" value={absForm.days}
                  onChange={e => setAbsForm(p => ({ ...p, days: e.target.value }))}
                  style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem' }} />
                <textarea placeholder="Lý do nghỉ..." value={absForm.reason} onChange={e => setAbsForm(p => ({ ...p, reason: e.target.value }))}
                  style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem', minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} />
                <button onClick={handleSubmitAbsent} style={{ background: '#f59e0b', color: 'white', border: 'none', borderRadius: 9, padding: '11px', fontWeight: 800, cursor: 'pointer' }}>
                  Gửi báo nghỉ
                </button>
              </div>
            )}
          </div>

          {/* Lịch sử yêu cầu tháng này */}
          {empReqs.length > 0 && (
            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>📄 Yêu cầu tháng {now.getMonth() + 1}</div>
              {empReqs.map(r => (
                <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
                      {r.request_type === 'advance' ? `💵 Ứng ${Number(r.amount || 0).toLocaleString('vi-VN')}đ` : `🏖 Nghỉ ${r.days} ngày`}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 2 }}>{r.reason}</div>
                    {r.admin_note && <div style={{ fontSize: '0.73rem', color: '#9ca3af', marginTop: 2 }}>💬 {r.admin_note}</div>}
                  </div>
                  <span style={{ flexShrink: 0, padding: '2px 8px', borderRadius: 5, fontSize: '0.72rem', fontWeight: 700,
                    background: r.status === 'approved' ? '#dcfce7' : r.status === 'rejected' ? '#fee2e2' : '#fef9c3',
                    color: r.status === 'approved' ? '#15803d' : r.status === 'rejected' ? '#dc2626' : '#92400e' }}>
                    {r.status === 'pending' ? '⏳ Chờ' : r.status === 'approved' ? '✅ Duyệt' : '❌ Từ chối'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── ADMIN VIEW ───────────────────────────────────────────────────────────────
  return (
    <div className="payroll-page">
      <div className="payroll-header">
        <div className="payroll-title">💰 Tính Lương Nhân Viên</div>
        <div className="month-selector">
          <select value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
            {months.map(m => <option key={m} value={m}>Tháng {m}</option>)}
          </select>
          <select value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="payroll-tabs">
        {[
          { key: 'salary', label: '📊 Bảng Lương' },
          { key: 'requests', label: '📋 Yêu cầu', badge: pendingCount },
          { key: 'violations', label: '⚠️ Vi phạm' },
          { key: 'attendance', label: '⏰ Chấm công' },
          { key: 'qr', label: '📱 QR Chấm công' },
          { key: 'accounts', label: '👤 Tài khoản' },
          { key: 'config', label: '⚙️ Cấu hình' },
        ].map(tab => (
          <button key={tab.key} className={`payroll-tab ${activeTab === tab.key ? 'active' : ''}`} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
            {tab.badge > 0 && <span className="badge">{tab.badge}</span>}
          </button>
        ))}
      </div>

      {loading ? <div className="empty-state">Đang tải...</div> : (
        <>
          {/* === BẢNG LƯƠNG === */}
          {activeTab === 'salary' && (
            <div>
              <table className="payroll-table">
                <thead>
                  <tr>
                    <th>Nhân viên</th>
                    <th>Lương cơ bản</th>
                    <th>Tăng ca</th>
                    <th>Ứng lương</th>
                    <th>Nghỉ</th>
                    <th>Vi phạm</th>
                    <th style={{ color: '#15803d' }}>Thực lĩnh</th>
                  </tr>
                </thead>
                <tbody>
                  {staffList.map(s => {
                    const c = calcSalary(s.id);
                    return (
                      <tr key={s.id}>
                        <td><div style={{ fontWeight: 700 }}>{s.full_name}</div><div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{s.phone}</div></td>
                        <td>{formatMoney(c.base)}</td>
                        <td><span style={{ color: '#15803d' }}>+{formatMoney(c.otAmt)}</span><div style={{ fontSize: '0.72rem', color: '#9ca3af' }}>{c.otHours}h</div></td>
                        <td><span style={{ color: '#dc2626' }}>-{formatMoney(c.advAmt)}</span></td>
                        <td><span style={{ color: '#dc2626' }}>-{formatMoney(c.absAmt)}</span><div style={{ fontSize: '0.72rem', color: '#9ca3af' }}>{c.absDays} ngày</div></td>
                        <td><span style={{ color: '#dc2626' }}>-{formatMoney(c.vioAmt)}</span></td>
                        <td><strong style={{ color: c.net >= 0 ? '#15803d' : '#dc2626', fontSize: '1rem' }}>{formatMoney(c.net)}</strong></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {staffList.length === 0 && <div className="empty-state">Chưa có nhân viên nào</div>}
            </div>
          )}

          {/* === YÊU CẦU === */}
          {activeTab === 'requests' && (
            <div className="request-list">
              {requests.length === 0 && <div className="empty-state">Không có yêu cầu nào</div>}
              {requests.map(req => {
                const typeInfo = requestTypeMap[req.request_type] || {};
                return (
                  <div key={req.id} className={`request-card ${req.status}`}>
                    <div className="request-info">
                      <div className="name">{req.staff?.full_name} <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>({req.staff?.phone})</span></div>
                      <div style={{ marginTop: 4 }}>
                        <span style={{ display: 'inline-block', background: typeInfo.bg, color: typeInfo.color, borderRadius: 5, padding: '2px 8px', fontSize: '0.78rem', fontWeight: 600, marginRight: 8 }}>{typeInfo.label}</span>
                        <span className={`status-badge ${req.status}`}>{req.status === 'pending' ? '⏳ Chờ duyệt' : req.status === 'approved' ? '✅ Đã duyệt' : '❌ Từ chối'}</span>
                      </div>
                      <div className="meta" style={{ marginTop: 4 }}>
                        {req.request_type === 'advance' && <span>💵 Ứng: <strong>{formatMoney(req.amount)}</strong> — </span>}
                        {req.request_type === 'absent' && <span>🗓 Nghỉ: <strong>{req.days} ngày</strong> — </span>}
                        Tháng {req.month}/{req.year} • {req.reason}
                      </div>
                      {req.admin_note && <div style={{ fontSize: '0.78rem', color: '#6b7280', marginTop: 4 }}>💬 {req.admin_note}</div>}
                    </div>
                    {req.status === 'pending' && (
                      <div className="request-actions">
                        <button className="btn-success" onClick={() => handleDecision(req.id, 'approved')}>✓ Duyệt</button>
                        <button className="btn-danger" onClick={() => { const note = prompt('Lý do từ chối (tuỳ chọn):') || ''; handleDecision(req.id, 'rejected', note); }}>✗ Từ chối</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* === VI PHẠM === */}
          {activeTab === 'violations' && (
            <div>
              <div className="payroll-form">
                <h3>➕ Thêm vi phạm / khoản trừ</h3>
                <div className="form-grid">
                  <div className="form-group">
                    <label>Nhân viên</label>
                    <select value={vForm.staff_id} onChange={e => setVForm(p => ({ ...p, staff_id: e.target.value }))}>
                      <option value="">-- Chọn NV --</option>
                      {staffList.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Số tiền phạt (đ)</label>
                    <input type="text" inputMode="numeric" placeholder="50.000" value={vForm.amount}
                      onChange={e => { const raw = e.target.value.replace(/\./g, '').replace(/\D/g, ''); setVForm(p => ({ ...p, amount: raw ? Number(raw).toLocaleString('vi-VN') : '' })); }} />
                  </div>
                  <div className="form-group">
                    <label>Lý do</label>
                    <input type="text" placeholder="Đi trễ, trang phục..." value={vForm.reason} onChange={e => setVForm(p => ({ ...p, reason: e.target.value }))} />
                  </div>
                </div>
                <button className="btn-primary" onClick={handleAddViolation}>Thêm khoản phạt</button>
              </div>

              {violations.length === 0 ? <div className="empty-state">Không có vi phạm nào trong tháng {selMonth}/{selYear}</div> : (
                <table className="payroll-table">
                  <thead><tr><th>Nhân viên</th><th>Số tiền</th><th>Lý do</th><th></th></tr></thead>
                  <tbody>
                    {violations.map(v => (
                      <tr key={v.id}>
                        <td>{v.staff?.full_name}</td>
                        <td style={{ color: '#dc2626', fontWeight: 700 }}>{formatMoney(v.amount)}</td>
                        <td>{v.reason}</td>
                        <td><button className="btn-danger" style={{ fontSize: '0.75rem', padding: '4px 10px' }} onClick={() => handleDeleteViolation(v.id)}>Xoá</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* === CHẤM CÔNG === */}
          {activeTab === 'attendance' && (
            <div>
              {/* Summary cards per employee */}
              {staffList.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
                  {staffList.map(s => {
                    const logs = attendance.filter(a => a.staff_id === s.id);
                    const days   = logs.filter(a => a.clock_out).length;
                    const totalH = Math.round(logs.reduce((sum, a) => sum + Number(a.work_hours || 0), 0) * 10) / 10;
                    const otH    = Math.round(logs.reduce((sum, a) => sum + Number(a.overtime_hours || 0), 0) * 10) / 10;
                    const otRate = configs[s.id]?.overtime_rate || 25000;
                    const otAmt  = Math.round(otH * otRate);
                    if (logs.length === 0) return null;
                    return (
                      <div key={s.id} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 18px', minWidth: 200, flex: '1 1 200px' }}>
                        <div style={{ fontWeight: 800, marginBottom: 8, fontSize: '0.92rem' }}>{s.full_name}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.83rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#6b7280' }}>Ngày công</span>
                            <strong>{days} ngày</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#6b7280' }}>Tổng giờ làm</span>
                            <strong>{totalH}h</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#6b7280' }}>Tăng ca</span>
                            <strong style={{ color: '#15803d' }}>{otH}h</strong>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #f3f4f6', paddingTop: 6, marginTop: 2 }}>
                            <span style={{ color: '#6b7280' }}>Tiền tăng ca</span>
                            <strong style={{ color: '#15803d' }}>+{formatMoney(otAmt)}</strong>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {attendance.length === 0 ? <div className="empty-state">Không có dữ liệu chấm công tháng {selMonth}/{selYear}</div> : (
                <table className="payroll-table">
                  <thead><tr><th>Nhân viên</th><th>Ngày</th><th>Vào</th><th>Ra</th><th>Giờ làm</th><th>Tăng ca</th></tr></thead>
                  <tbody>
                    {attendance.map(a => {
                      const staff = staffList.find(s => s.id === a.staff_id);
                      return (
                        <tr key={a.id}>
                          <td>{staff?.full_name || '—'}</td>
                          <td>{a.date}</td>
                          <td>{a.clock_in ? new Date(a.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                          <td>{a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : <span style={{ color: '#f59e0b' }}>Chưa ra</span>}</td>
                          <td>{a.work_hours ? `${a.work_hours}h` : '—'}</td>
                          <td style={{ color: '#15803d', fontWeight: 600 }}>{a.overtime_hours > 0 ? `${a.overtime_hours}h` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* === QR CHẤM CÔNG === */}
          {activeTab === 'qr' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '20px 0' }}>
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 16, padding: 24, textAlign: 'center', maxWidth: 340, width: '100%' }}>
                <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 4 }}>📱 QR Chấm công</div>
                <div style={{ fontSize: '0.8rem', color: '#6b7280', marginBottom: 16 }}>Nhân viên quét mã để vào/ra ca</div>
                <div style={{ display: 'inline-block', padding: 12, background: 'white', border: '2px solid #111827', borderRadius: 12 }}>
                  <QRCodeSVG value={networkUrl || 'loading...'} size={200} level="M" />
                </div>
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: qrCountdown > 30 ? '#16a34a' : '#f59e0b', animation: 'pulse 1s infinite' }} />
                  <span style={{ fontSize: '0.82rem', color: '#6b7280' }}>Hết hạn sau: <strong style={{ color: qrCountdown > 30 ? '#15803d' : '#dc2626' }}>{qrCountdown}s</strong></span>
                </div>
                <div style={{ marginTop: 10, fontSize: '0.72rem', color: '#9ca3af', wordBreak: 'break-all', background: '#f9fafb', borderRadius: 8, padding: '6px 10px' }}>
                  {networkUrl}
                </div>
              </div>
              <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 12, padding: 16, maxWidth: 340, width: '100%', fontSize: '0.82rem', color: '#0369a1' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Hướng dẫn sử dụng:</div>
                <div>1️⃣ Mở trang này trên máy tính / tablet tại nhà hàng</div>
                <div style={{ marginTop: 4 }}>2️⃣ Nhân viên dùng điện thoại quét mã QR</div>
                <div style={{ marginTop: 4 }}>3️⃣ Đăng nhập (nếu chưa) và bấm <strong>Xác nhận chấm công</strong></div>
                <div style={{ marginTop: 4 }}>4️⃣ Mã tự làm mới mỗi 5 phút — không thể dùng mã cũ</div>
              </div>
            </div>
          )}

          {/* === TÀI KHOẢN === */}
          {activeTab === 'accounts' && (
            <div>
              {/* Create form */}
              <div className="payroll-form">
                <h3>➕ Tạo tài khoản nhân viên mới</h3>
                {accMsg && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: accMsg.startsWith('✅') ? '#dcfce7' : '#fee2e2', color: accMsg.startsWith('✅') ? '#15803d' : '#dc2626', fontSize: '0.85rem', fontWeight: 600 }}>{accMsg}</div>}
                <div className="form-grid">
                  <div className="form-group">
                    <label>Họ và Tên</label>
                    <input type="text" placeholder="Nguyễn Văn A" value={accForm.full_name} onChange={e => setAccForm(p => ({ ...p, full_name: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Số điện thoại</label>
                    <input type="tel" placeholder="0909123456" value={accForm.phone} onChange={e => setAccForm(p => ({ ...p, phone: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Mã PIN (≥ 4 ký tự)</label>
                    <input type="text" placeholder="1234" maxLength={8} value={accForm.pin} onChange={e => setAccForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, '') }))} />
                  </div>
                  <div className="form-group">
                    <label>Vai trò</label>
                    <select value={accForm.role} onChange={e => setAccForm(p => ({ ...p, role: e.target.value }))}>
                      <option value="staff">Nhân viên</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>
                <button className="btn-primary" onClick={handleCreateAccount}>Tạo tài khoản</button>
              </div>

              {/* Staff list */}
              <div className="config-list">
                {staffList.map(s => (
                  <div key={s.id} className="config-row" style={{ flexWrap: 'wrap', gap: 10 }}>
                    <div style={{ minWidth: 140 }}>
                      <div style={{ fontWeight: 700 }}>{s.full_name}</div>
                      <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{s.phone}</div>
                      <span style={{ display: 'inline-block', marginTop: 4, fontSize: '0.7rem', fontWeight: 700, padding: '1px 7px', borderRadius: 4, background: s.role === 'admin' ? '#fef9c3' : '#f0f9ff', color: s.role === 'admin' ? '#92400e' : '#0369a1' }}>
                        {s.role === 'admin' ? '👑 Admin' : '👤 NV'}
                      </span>
                    </div>
                    <div className="form-group" style={{ margin: 0, flex: 1, minWidth: 140 }}>
                      <label>Đổi PIN mới</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input type="text" inputMode="numeric" maxLength={8} placeholder="PIN mới..." value={editingPin[s.id] || ''}
                          onChange={e => setEditingPin(p => ({ ...p, [s.id]: e.target.value.replace(/\D/g, '') }))}
                          style={{ flex: 1 }} />
                        <button className="btn-primary" style={{ padding: '6px 12px', marginTop: 0, whiteSpace: 'nowrap' }} onClick={() => handleUpdatePin(s.id)}>Lưu</button>
                      </div>
                    </div>
                    <button className="btn-danger" style={{ marginTop: 18, alignSelf: 'flex-end' }} onClick={() => handleDeleteAccount(s.id, s.full_name)}>Xoá</button>
                  </div>
                ))}
                {staffList.length === 0 && <div className="empty-state">Chưa có nhân viên nào</div>}
              </div>
            </div>
          )}

          {/* === CẤU HÌNH === */}
          {activeTab === 'config' && (
            <div>
              <div className="payroll-form" style={{ marginBottom: 8 }}>
                <p style={{ fontSize: '0.82rem', color: '#6b7280', margin: 0 }}>💡 Thiết lập lương cơ bản, giá tăng ca và ngày phát lương cho từng nhân viên.</p>
              </div>
              <div className="config-list">
                {staffList.map(s => {
                  const edit = configEdits[s.id] || { base_salary: 0, overtime_rate: 25000, pay_day: 5 };
                  return (
                    <div key={s.id} className="config-row">
                      <div className="staff-name">{s.full_name}<div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{s.phone}</div></div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label>Lương cơ bản</label>
                        <input type="text" inputMode="numeric" value={edit.base_salary ? Number(edit.base_salary).toLocaleString('vi-VN') : ''}
                          onChange={e => { const raw = e.target.value.replace(/\./g, '').replace(/\D/g, ''); setConfigEdits(p => ({ ...p, [s.id]: { ...edit, base_salary: raw || 0 } })); }}
                          placeholder="5.000.000" />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label>Giá tăng ca/h</label>
                        <input type="number" value={edit.overtime_rate || 25000}
                          onChange={e => setConfigEdits(p => ({ ...p, [s.id]: { ...edit, overtime_rate: e.target.value } }))} />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label>Ngày phát lương</label>
                        <input type="number" min="1" max="31" value={edit.pay_day || 5}
                          onChange={e => setConfigEdits(p => ({ ...p, [s.id]: { ...edit, pay_day: e.target.value } }))} />
                      </div>
                      <button className="btn-primary" style={{ marginTop: 18 }} onClick={() => handleSaveConfig(s.id)}>Lưu</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
