'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle, XCircle, Clock, AlertTriangle, DollarSign, Calendar, Settings, Users, RefreshCw } from 'lucide-react';
import './payroll.css';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const now = new Date();
const fmt = (n) => String(n).padStart(2, '0');
const formatMoney = (v) => Number(v || 0).toLocaleString('vi-VN') + 'Ä‘';

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
  const [loading, setLoading] = useState(false);
  const [hasSynced, setHasSynced] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
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
  const [todaySessions, setTodaySessions]  = useState([]);
  const [empReqs,        setEmpReqs]        = useState([]);
  const [showAdvForm,    setShowAdvForm]    = useState(false);
  const [showAbsForm,    setShowAbsForm]    = useState(false);
  const [advForm,        setAdvForm]        = useState({ amount: '', reason: '' });
  const [absForm,        setAbsForm]        = useState({ days: '1', reason: '' });
  const [myAllSessions,  setMyAllSessions]  = useState([]); // current month, for history

  const fetchStaffData = async (staffId) => {
    const today = new Date().toISOString().split('T')[0];
    const m = now.getMonth() + 1; const y = now.getFullYear();
    const mStart = `${y}-${fmt(m)}-01`;
    const mEnd   = m === 12 ? `${y + 1}-01-01` : `${y}-${fmt(m + 1)}-01`;
    const [todayRes, monthRes, reqRes] = await Promise.all([
      supabase.from('attendance_sessions').select('*').eq('staff_id', staffId).eq('date', today).order('clock_in'),
      supabase.from('attendance_sessions').select('*').eq('staff_id', staffId).gte('date', mStart).lt('date', mEnd).order('clock_in'),
      supabase.from('payroll_requests').select('*').eq('staff_id', staffId).eq('month', m).eq('year', y).order('created_at', { ascending: false }),
    ]);
    setTodaySessions(todayRes.data || []);
    setMyAllSessions(monthRes.data || []);
    setEmpReqs(reqRes.data || []);
  };

  const sessionsWorkHStaff = (sessions) =>
    Math.round(sessions.filter(s => s.clock_out).reduce((acc, s) => {
      return acc + (new Date(s.clock_out) - new Date(s.clock_in)) / 3600000;
    }, 0) * 10) / 10;

  const handleClockAction = async () => {
    if (!currentUser) return;
    const today = new Date().toISOString().split('T')[0];
    const { data: sessions } = await supabase.from('attendance_sessions').select('*').eq('staff_id', currentUser.id).eq('date', today).order('clock_in');
    const openSession = (sessions || []).find(s => !s.clock_out);
    if (openSession) {
      await supabase.from('attendance_sessions').update({ clock_out: new Date().toISOString() }).eq('id', openSession.id);
    } else {
      await supabase.from('attendance_sessions').insert({ staff_id: currentUser.id, date: today, clock_in: new Date().toISOString() });
    }
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

  // Search / filter state
  const [salarySearch,  setSalarySearch]  = useState('');
  const [attSearch,     setAttSearch]     = useState('');
  const [attDateFilter, setAttDateFilter] = useState('');
  const [attDayFilter,  setAttDayFilter]  = useState('');

  // Attendance edit state
  const [editingAtt, setEditingAtt] = useState(null); // { id, staff_id, date, clock_in, clock_out, work_hours, overtime_hours, note }

  const handleSaveAttEdit = async () => {
    if (!editingAtt) return;
    const orig = attendance.find(a => a.id === editingAtt.id);
    if (!orig) return;

    // Only clock_in, clock_out, note are editable (hours computed automatically)
    const updates = {};
    const fields = ['clock_in', 'clock_out', 'note'];
    const logs = [];
    fields.forEach(f => {
      const oldVal = String(orig[f] ?? '');
      const newVal = String(editingAtt[f] ?? '');
      if (oldVal !== newVal) {
        updates[f] = editingAtt[f] || null;
        logs.push({ attendance_id: orig.id, staff_id: orig.staff_id, field_name: f, old_value: oldVal, new_value: newVal });
      }
    });

    if (Object.keys(updates).length === 0) { setEditingAtt(null); return; }

    await supabase.from('attendance_sessions').update(updates).eq('id', orig.id);
    if (logs.length) await supabase.from('attendance_edit_log').insert(logs);

    setEditingAtt(null);
    fetchAll();
  };

  const [expandedSalaryStaff, setExpandedSalaryStaff] = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [staffRes, cfgRes, reqRes, vioRes, attRes] = await Promise.all([
      supabase.from('staff').select('*').order('full_name'),
      supabase.from('payroll_config').select('*'),
      supabase.from('payroll_requests').select('*, staff(full_name,phone)').order('created_at', { ascending: false }),
      supabase.from('payroll_violations').select('*, staff(full_name)').eq('month', selMonth).eq('year', selYear),
      supabase.from('attendance_sessions').select('*').gte('date', `${selYear}-${fmt(selMonth)}-01`).lt('date', selMonth === 12 ? `${selYear + 1}-01-01` : `${selYear}-${fmt(selMonth + 1)}-01`),
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
    setHasSynced(true);
    setLastSyncedAt(new Date());
    setLoading(false);
  }, [selMonth, selYear]);

  // Helper: compute total work hours for a set of sessions (closed only)
  const sessionsWorkH = (sessions) =>
    sessions.filter(s => s.clock_out).reduce((acc, s) => {
      const h = (new Date(s.clock_out) - new Date(s.clock_in)) / 3600000;
      return acc + Math.round(h * 10) / 10;
    }, 0);

  // --- Salary calculation using attendance_sessions ---
  const calcSalary = (staffId) => {
    const cfg = configs[staffId];
    const base = cfg?.base_salary || 0;
    const otRate = cfg?.overtime_rate || 25000;
    const dailyRate = base > 0 ? Math.round(base / 26) : 0;

    // Group sessions by date
    const staffSessions = attendance.filter(a => a.staff_id === staffId);
    const byDate = {};
    staffSessions.forEach(s => {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    });
    const days = Object.values(byDate);
    const workDays = days.filter(d => d.some(s => s.clock_out)).length;
    let totalWorkH = 0, otHours = 0;
    days.forEach(daySessions => {
      const dayH = Math.round(sessionsWorkH(daySessions) * 10) / 10;
      totalWorkH += dayH;
      if (dayH > 8) otHours += Math.round((dayH - 8) * 10) / 10;
    });
    totalWorkH = Math.round(totalWorkH * 10) / 10;
    otHours    = Math.round(otHours * 10) / 10;
    const otAmt = Math.round(otHours * otRate);

    const approved = requests.filter(r => r.staff_id === staffId && r.status === 'approved' && r.month === selMonth && r.year === selYear);
    const advAmt  = approved.filter(r => r.request_type === 'advance').reduce((s, r) => s + Number(r.amount || 0), 0);
    const absDays = approved.filter(r => r.request_type === 'absent').reduce((s, r) => s + Number(r.days || 0), 0);
    const absAmt  = Math.round(absDays * dailyRate);
    const vioAmt  = violations.filter(v => v.staff_id === staffId).reduce((s, v) => s + Number(v.amount || 0), 0);
    const net     = base + otAmt - advAmt - absAmt - vioAmt;
    return { base, workDays, totalWorkH, otHours, otAmt, advAmt, absDays, absAmt, vioAmt, net };
  };

  // --- Approve / Reject request ---
  const handleDecision = async (reqId, decision, adminNote = '') => {
    await supabase.from('payroll_requests').update({ status: decision, admin_note: adminNote, updated_at: new Date().toISOString() }).eq('id', reqId);
    fetchAll();
  };

  // --- Add violation ---
  const handleAddViolation = async () => {
    if (!vForm.staff_id || !vForm.amount || !vForm.reason) return alert('Vui lĂ²ng Ä‘iá»n Ä‘áº§y Ä‘á»§!');
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
    alert('ÄĂ£ lÆ°u cáº¥u hĂ¬nh!');
  };

  // --- Delete violation ---
  const handleDeleteViolation = async (id) => {
    if (!confirm('XoĂ¡ khoáº£n pháº¡t nĂ y?')) return;
    await supabase.from('payroll_violations').delete().eq('id', id);
    fetchAll();
  };

  // --- Account management ---
  const handleCreateAccount = async () => {
    if (!accForm.full_name || !accForm.phone || !accForm.pin) return setAccMsg('Vui lĂ²ng Ä‘iá»n Ä‘áº§y Ä‘á»§!');
    if (accForm.pin.length < 4) return setAccMsg('PIN cáº§n Ă­t nháº¥t 4 kĂ½ tá»±!');
    const { error } = await supabase.from('staff').insert({ full_name: accForm.full_name.trim(), phone: accForm.phone.trim(), pin: accForm.pin, role: accForm.role });
    if (error) { setAccMsg(error.message.includes('unique') ? 'â ï¸ Sá»‘ Ä‘iá»‡n thoáº¡i Ä‘Ă£ tá»“n táº¡i!' : error.message); return; }
    setAccForm({ full_name: '', phone: '', pin: '', role: 'staff' });
    setAccMsg('âœ… Táº¡o tĂ i khoáº£n thĂ nh cĂ´ng!');
    fetchAll();
    setTimeout(() => setAccMsg(''), 3000);
  };

  const handleUpdatePin = async (staffId) => {
    const newPin = editingPin[staffId];
    if (!newPin || newPin.length < 4) return alert('PIN cáº§n Ă­t nháº¥t 4 kĂ½ tá»±!');
    await supabase.from('staff').update({ pin: newPin }).eq('id', staffId);
    setEditingPin(p => ({ ...p, [staffId]: '' }));
    fetchAll();
    alert('ÄĂ£ cáº­p nháº­t PIN!');
  };

  const handleDeleteAccount = async (staffId, name) => {
    if (!confirm(`XoĂ¡ tĂ i khoáº£n "${name}"? HĂ nh Ä‘á»™ng nĂ y khĂ´ng thá»ƒ hoĂ n tĂ¡c.`)) return;
    await supabase.from('staff').delete().eq('id', staffId);
    fetchAll();
  };

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const years = [2025, 2026, 2027];

  const requestTypeMap = { advance: { label: 'đŸ’µ á»¨ng lÆ°Æ¡ng', color: '#92400e', bg: '#fef9c3' }, absent: { label: 'đŸ– BĂ¡o nghá»‰', color: '#1e40af', bg: '#dbeafe' } };

  // â”€â”€ STAFF VIEW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!currentUser) return null;

  return (
      <div className="payroll-page">
        <div className="payroll-header">
        <div className="payroll-title">{'\u{1F4B0} T\u00ednh L\u01b0\u01a1ng Nh\u00e2n Vi\u00ean'}</div>
        {currentUser && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {currentUser.role === 'admin' && (
              <button
                onClick={fetchAll}
                disabled={loading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: loading ? '#94a3b8' : '#3b82f6', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.82rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer', boxShadow: '0 2px 6px rgba(59, 130, 246, 0.25)' }}
              >
                <RefreshCw size={15} />
                {loading ? '\u0110ang \u0111\u1ed3ng b\u1ed9...' : '\u0110\u1ed3ng b\u1ed9'}
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', background: currentUser.role === 'admin' ? '#fef3c7' : '#dbeafe', borderRadius: 20, fontSize: '0.78rem', fontWeight: 700, color: currentUser.role === 'admin' ? '#92400e' : '#1d4ed8', flexShrink: 0 }}>
              <span>{currentUser.role === 'admin' ? '\u{1F451}' : '\u{1F464}'}</span>
              <span>{currentUser.full_name}</span>
              <span style={{ fontWeight: 400, opacity: 0.7 }}>? {currentUser.role === 'admin' ? 'Admin' : 'Nh\u00e2n vi\u00ean'}</span>
              <button
                onClick={() => { localStorage.removeItem('staffUser'); window.location.reload(); }}
                title={'\u0110\u0103ng xu\u1ea5t'}
                style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, padding: '2px 4px', borderRadius: 6, opacity: 0.6 }}
              >{'\u{1F6AA}'}</button>
            </div>
          </div>
        )}
      </div>

      {lastSyncedAt && (
        <div style={{ fontSize: '0.82rem', color: '#64748b', margin: '-6px 0 10px', textAlign: 'right' }}>
          {'\u0110\u00e3 \u0111\u1ed3ng b\u1ed9 l\u00fac'} {lastSyncedAt.toLocaleTimeString('vi-VN')}.
        </div>
      )}

      {/* Tabs */}
      <div className="payroll-tabs">
        {[
          { key: 'salary', label: 'đŸ“ Báº£ng LÆ°Æ¡ng' },
          { key: 'requests', label: 'đŸ“‹ YĂªu cáº§u', badge: pendingCount },
          { key: 'violations', label: 'â ï¸ Vi pháº¡m' },
          { key: 'attendance', label: 'â° Cháº¥m cĂ´ng' },
          { key: 'qr', label: 'đŸ“± QR Cháº¥m cĂ´ng' },
          { key: 'accounts', label: 'đŸ‘¤ TĂ i khoáº£n' },
          { key: 'config', label: 'â™ï¸ Cáº¥u hĂ¬nh' },
        ].map(tab => (
          <button key={tab.key} className={`payroll-tab ${activeTab === tab.key ? 'active' : ''}`} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
            {tab.badge > 0 && <span className="badge">{tab.badge}</span>}
          </button>
        ))}
      </div>

      {loading ? <div className="empty-state">{'\u0110ang t\u1ea3i...'}</div> : !hasSynced ? (
        <div className="empty-state">
          <p>{'B\u1ea5m \u0110\u1ed3ng b\u1ed9 \u0111\u1ec3 t\u1ea3i d\u1eef li\u1ec7u t\u00ednh l\u01b0\u01a1ng t\u1eeb Supabase.'}</p>
          <p className="text-sm text-muted">{'Trang s\u1ebd kh\u00f4ng t\u1ef1 t\u1ea3i d\u1eef li\u1ec7u admin cho t\u1edbi khi b\u1ea1n b\u1ea5m \u0111\u1ed3ng b\u1ed9.'}</p>
          {currentUser?.role === 'admin' && (
            <button
              onClick={fetchAll}
              disabled={loading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, padding: '9px 16px', background: loading ? '#94a3b8' : '#3b82f6', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.86rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer', boxShadow: '0 2px 6px rgba(59, 130, 246, 0.25)' }}
            >
              <RefreshCw size={15} />
              {loading ? '\u0110ang \u0111\u1ed3ng b\u1ed9...' : '\u0110\u1ed3ng b\u1ed9 ngay'}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* === Báº¢NG LÆ¯Æ NG === */}
          {activeTab === 'salary' && (() => {
            const isAdmin = currentUser?.role === 'admin';
            const filtered = staffList.filter(s => !salarySearch || s.full_name === salarySearch);
            return (
              <div>
                {/* Filter bar */}
                <div className="filter-bar">
                  <select value={salarySearch} onChange={e => setSalarySearch(e.target.value)}>
                    <option value="">đŸ‘¥ Táº¥t cáº£ nhĂ¢n viĂªn</option>
                    {staffList.map(s => <option key={s.id} value={s.full_name}>{s.full_name}</option>)}
                  </select>
                  <select value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
                    {months.map(m => <option key={m} value={m}>ThĂ¡ng {m}</option>)}
                  </select>
                  <select value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
                    {years.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>

                {/* Mobile cards */}
                <div className="mobile-cards">
                  {filtered.length === 0 && <div className="empty-state">ChÆ°a cĂ³ nhĂ¢n viĂªn</div>}
                  {filtered.map(s => {
                    const c = calcSalary(s.id);
                    return (
                      <div key={s.id} className="salary-card">
                        <div className="salary-card-header">
                          <div>
                            <div className="salary-card-name">{s.full_name}</div>
                            <div className="salary-card-phone">{s.phone}</div>
                          </div>
                          <div className={`salary-card-net ${c.net < 0 ? 'negative' : ''}`}>{formatMoney(c.net)}</div>
                        </div>
                        <div className="salary-card-body">
                          <div className="salary-card-row">
                            <span className="salary-card-label">LÆ°Æ¡ng cÆ¡ báº£n</span>
                            <span className="salary-card-value">{formatMoney(c.base)}</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">NgĂ y cĂ´ng</span>
                            <span className="salary-card-value">{c.workDays} ngĂ y</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">Tá»•ng giá» lĂ m</span>
                            <span className="salary-card-value">{c.totalWorkH}h</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">TÄƒng ca</span>
                            <span className="salary-card-value green">+{formatMoney(c.otAmt)} <small style={{fontWeight:400,color:'#94a3b8'}}>({c.otHours}h)</small></span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">á»¨ng lÆ°Æ¡ng</span>
                            <span className="salary-card-value red">-{formatMoney(c.advAmt)}</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">Nghá»‰</span>
                            <span className="salary-card-value red">-{formatMoney(c.absAmt)} <small style={{fontWeight:400,color:'#94a3b8'}}>({c.absDays}d)</small></span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">Vi pháº¡m</span>
                            <span className={`salary-card-value ${c.vioAmt > 0 ? 'red' : 'muted'}`}>{c.vioAmt > 0 ? `-${formatMoney(c.vioAmt)}` : 'â€”'}</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">Thá»±c lÄ©nh</span>
                            <span className={`salary-card-value ${c.net >= 0 ? 'green' : 'red'}`}>{formatMoney(c.net)}</span>
                          </div>
                        </div>
                        {isAdmin && (
                          <button
                            onClick={() => setExpandedSalaryStaff(expandedSalaryStaff === s.id ? null : s.id)}
                            style={{ width: '100%', marginTop: 4, padding: '7px', background: expandedSalaryStaff === s.id ? '#dbeafe' : '#f8fafc', border: '1px solid #e2e8f0', borderBottomLeftRadius: 12, borderBottomRightRadius: 12, fontSize: '0.8rem', fontWeight: 700, color: '#1d4ed8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                            {expandedSalaryStaff === s.id ? 'â–´ áº¨n cháº¥m cĂ´ng' : 'âœï¸ Sá»­a cháº¥m cĂ´ng'}
                          </button>
                        )}
                        {/* Inline attendance panel for mobile */}
                        {isAdmin && expandedSalaryStaff === s.id && (() => {
                          const staffAtts = attendance.filter(a => a.staff_id === s.id);
                          const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
                          return (
                            <div style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', borderRadius: '0 0 12px 12px', padding: '10px 14px' }}>
                              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', marginBottom: 8 }}>Cháº¥m cĂ´ng thĂ¡ng {selMonth}/{selYear}</div>
                              {staffAtts.length === 0 && <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>ChÆ°a cĂ³ báº£n ghi cháº¥m cĂ´ng</div>}
                              {staffAtts.map(a => {
                                const isEd = editingAtt?.id === a.id;
                                const tIn  = a.clock_in  ? new Date(a.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'â€”';
                                const tOut = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'ChÆ°a ra';
                                return (
                                  <div key={a.id} style={{ background: isEd ? '#eff6ff' : 'white', border: `1.5px solid ${isEd ? '#3b82f6' : '#e2e8f0'}`, borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isEd ? 8 : 0 }}>
                                      <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{a.date}</span>
                                       <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{tIn} â†’ {tOut} Â· {a.clock_out ? `${Math.round(((new Date(a.clock_out) - new Date(a.clock_in)) / 3600000) * 10) / 10}h` : '0h'}</span>
                                      {!isEd
                                        ? <button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })} style={{ fontSize: '0.72rem', padding: '2px 8px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 5, cursor: 'pointer' }}>âœï¸ Sá»­a</button>
                                        : <button onClick={() => setEditingAtt(null)} style={{ fontSize: '0.72rem', padding: '2px 8px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 5, cursor: 'pointer', color: '#dc2626' }}>âœ• Huá»·</button>
                                      }
                                    </div>
                                    {isEd && (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        {[{label:'Giá» vĂ o',key:'clock_in',type:'datetime-local'},{label:'Giá» ra',key:'clock_out',type:'datetime-local'}].map(({label,key,type})=>(
                                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ width: 65, fontSize: '0.76rem', fontWeight: 600, color: '#475569', flexShrink: 0 }}>{label}</span>
                                            <input type={type} value={editingAtt[key]||''} onChange={e=>setEditingAtt(p=>({...p,[key]:e.target.value}))} style={{ flex:1, padding:'4px 7px', border:'1.5px solid #cbd5e1', borderRadius:6, fontSize:'0.8rem' }}/>
                                          </div>
                                        ))}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          <span style={{ width: 65, fontSize: '0.76rem', fontWeight: 600, color: '#475569', flexShrink: 0 }}>Ghi chĂº</span>
                                          <input type="text" value={editingAtt.note||''} placeholder="LĂ½ do sá»­a..." onChange={e=>setEditingAtt(p=>({...p,note:e.target.value}))} style={{ flex:1, padding:'4px 7px', border:'1.5px solid #cbd5e1', borderRadius:6, fontSize:'0.8rem' }}/>
                                        </div>
                                        <button onClick={handleSaveAttEdit} style={{ padding:'7px', background:'#0f172a', color:'white', border:'none', borderRadius:7, fontWeight:700, fontSize:'0.82rem', cursor:'pointer' }}>đŸ’¾ LÆ°u thĂ y Ä‘á»•i</button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>

                {/* Desktop table */}
                <div className="desktop-table">
                  <table className="payroll-table">
                    <thead><tr>
                      <th>NhĂ¢n viĂªn</th><th>LÆ°Æ¡ng CB</th><th>NgĂ y cĂ´ng</th><th>Giá» lĂ m</th>
                      <th>TÄƒng ca</th><th>á»¨ng lÆ°Æ¡ng</th><th>Nghá»‰</th><th>Vi pháº¡m</th>
                      <th style={{color:'#16a34a'}}>Thá»±c lÄ©nh</th>
                      {isAdmin && <th></th>}
                    </tr></thead>
                    <tbody>
                      {filtered.map(s => {
                        const c = calcSalary(s.id);
                        return (
                          <React.Fragment key={s.id}>
                            <tr>
                            <td><div style={{fontWeight:700}}>{s.full_name}</div><div style={{fontSize:'0.73rem',color:'#94a3b8'}}>{s.phone}</div></td>
                            <td>{formatMoney(c.base)}</td>
                            <td>{c.workDays} ngĂ y</td>
                            <td>{c.totalWorkH}h</td>
                            <td><span style={{color:'#16a34a'}}>+{formatMoney(c.otAmt)}</span><div style={{fontSize:'0.72rem',color:'#94a3b8'}}>{c.otHours}h</div></td>
                            <td><span style={{color:'#ef4444'}}>-{formatMoney(c.advAmt)}</span></td>
                            <td><span style={{color:'#ef4444'}}>-{formatMoney(c.absAmt)}</span><div style={{fontSize:'0.72rem',color:'#94a3b8'}}>{c.absDays}d</div></td>
                            <td>{c.vioAmt > 0 ? <span style={{color:'#ef4444'}}>-{formatMoney(c.vioAmt)}</span> : <span style={{color:'#94a3b8'}}>â€”</span>}</td>
                            <td><strong style={{color: c.net >= 0 ? '#16a34a' : '#ef4444', fontSize:'0.95rem'}}>{formatMoney(c.net)}</strong></td>
                            {isAdmin && <td><button onClick={() => setExpandedSalaryStaff(expandedSalaryStaff === s.id ? null : s.id)}
                              style={{ fontSize: '0.75rem', padding: '3px 10px', background: expandedSalaryStaff === s.id ? '#dbeafe' : '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', color: '#1d4ed8', whiteSpace: 'nowrap' }}>{expandedSalaryStaff === s.id ? 'â–´ á»˜n' : 'âœï¸ Sá»­a'}</button></td>}
                          </tr>
                          {/* Inline attendance sub-panel for desktop */}
                          {isAdmin && expandedSalaryStaff === s.id && (() => {
                            const staffAtts = attendance.filter(a => a.staff_id === s.id);
                            const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
                            return (
                              <tr><td colSpan="10" style={{ padding: 0, background: '#f8fafc', borderBottom: '2px solid #3b82f6' }}>
                                <div style={{ padding: '12px 16px' }}>
                                  <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748b', marginBottom: 8 }}>Cháº¥m cĂ´ng thĂ¡ng {selMonth}/{selYear} â€” {s.full_name}</div>
                                  {staffAtts.length === 0 && <div style={{ color: '#94a3b8', fontSize: '0.82rem' }}>ChÆ°a cĂ³ báº£n ghi cháº¥m cĂ´ng</div>}
                                  {staffAtts.map(a => {
                                    const isEd = editingAtt?.id === a.id;
                                    const tIn  = a.clock_in  ? new Date(a.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'â€”';
                                    const tOut = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'ChÆ°a ra';
                                    return (
                                      <div key={a.id} style={{ background: isEd ? '#eff6ff' : 'white', border: `1px solid ${isEd ? '#3b82f6' : '#e2e8f0'}`, borderRadius: 8, padding: '8px 12px', marginBottom: 6 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                          <span style={{ fontWeight: 700, fontSize: '0.82rem', minWidth: 90 }}>{a.date}</span>
                                          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{tIn} â†’ {tOut}</span>
                                          <span style={{ fontSize: '0.8rem', color: '#16a34a', fontWeight: 600 }}>{a.clock_out ? `${Math.round(((new Date(a.clock_out) - new Date(a.clock_in)) / 3600000) * 10) / 10}h lĂ m` : 'Äang lĂ m...'}</span>

                                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                            {!isEd
                                              ? <button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })} style={{ fontSize: '0.75rem', padding: '3px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}>âœï¸ Sá»­a</button>
                                              : <button onClick={() => setEditingAtt(null)} style={{ fontSize: '0.75rem', padding: '3px 10px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', color: '#dc2626' }}>âœ• Huá»·</button>
                                            }
                                          </div>
                                        </div>
                                        {isEd && (
                                          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                                            {[{label:'Giá» vĂ o',key:'clock_in',type:'datetime-local'},{label:'Giá» ra',key:'clock_out',type:'datetime-local'}].map(({label,key,type})=>(
                                              <label key={key} style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                                {label}<input type={type} value={editingAtt[key]||''} onChange={e=>setEditingAtt(p=>({...p,[key]:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.8rem'}}/>
                                              </label>
                                            ))}

                                            <label style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                              Ghi chĂº<input type="text" value={editingAtt.note||''} placeholder="LĂ½ do sá»­a..." onChange={e=>setEditingAtt(p=>({...p,note:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.8rem'}}/>
                                            </label>
                                            <div style={{display:'flex',gap:6,alignItems:'flex-end'}}>
                                              <button onClick={handleSaveAttEdit} style={{padding:'5px 16px',background:'#0f172a',color:'white',border:'none',borderRadius:7,fontWeight:700,fontSize:'0.8rem',cursor:'pointer'}}>đŸ’¾ LÆ°u</button>
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </td></tr>
                            );
                          })()}
                          </React.Fragment>
                        );
                      })}
                      {filtered.length === 0 && <tr><td colSpan={isAdmin ? '10' : '9'} style={{textAlign:'center',color:'#94a3b8',padding:24}}>ChÆ°a cĂ³ nhĂ¢n viĂªn</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* === YĂU Cáº¦U === */}
          {activeTab === 'requests' && (
            <div className="request-list">
              {requests.length === 0 && <div className="empty-state">KhĂ´ng cĂ³ yĂªu cáº§u nĂ o</div>}
              {requests.map(req => {
                const typeInfo = requestTypeMap[req.request_type] || {};
                return (
                  <div key={req.id} className={`request-card ${req.status}`}>
                    <div className="request-info">
                      <div className="name">{req.staff?.full_name} <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>({req.staff?.phone})</span></div>
                      <div style={{ marginTop: 4 }}>
                        <span style={{ display: 'inline-block', background: typeInfo.bg, color: typeInfo.color, borderRadius: 5, padding: '2px 8px', fontSize: '0.78rem', fontWeight: 600, marginRight: 8 }}>{typeInfo.label}</span>
                        <span className={`status-badge ${req.status}`}>{req.status === 'pending' ? 'â³ Chá» duyá»‡t' : req.status === 'approved' ? 'âœ… ÄĂ£ duyá»‡t' : 'âŒ Tá»« chá»‘i'}</span>
                      </div>
                      <div className="meta" style={{ marginTop: 4 }}>
                        {req.request_type === 'advance' && <span>đŸ’µ á»¨ng: <strong>{formatMoney(req.amount)}</strong> â€” </span>}
                        {req.request_type === 'absent' && <span>đŸ—“ Nghá»‰: <strong>{req.days} ngĂ y</strong> â€” </span>}
                        ThĂ¡ng {req.month}/{req.year} â€¢ {req.reason}
                      </div>
                      {req.admin_note && <div style={{ fontSize: '0.78rem', color: '#6b7280', marginTop: 4 }}>đŸ’¬ {req.admin_note}</div>}
                    </div>
                    {req.status === 'pending' && (
                      <div className="request-actions">
                        <button className="btn-success" onClick={() => handleDecision(req.id, 'approved')}>âœ“ Duyá»‡t</button>
                        <button className="btn-danger" onClick={() => { const note = prompt('LĂ½ do tá»« chá»‘i (tuá»³ chá»n):') || ''; handleDecision(req.id, 'rejected', note); }}>âœ— Tá»« chá»‘i</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* === VI PHáº M === */}
          {activeTab === 'violations' && (
            <div>
              <div className="payroll-form">
                <h3>â• ThĂªm vi pháº¡m / khoáº£n trá»«</h3>
                <div className="form-grid">
                  <div className="form-group">
                    <label>NhĂ¢n viĂªn</label>
                    <select value={vForm.staff_id} onChange={e => setVForm(p => ({ ...p, staff_id: e.target.value }))}>
                      <option value="">-- Chá»n NV --</option>
                      {staffList.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Sá»‘ tiá»n pháº¡t (Ä‘)</label>
                    <input type="text" inputMode="numeric" placeholder="50.000" value={vForm.amount}
                      onChange={e => { const raw = e.target.value.replace(/\./g, '').replace(/\D/g, ''); setVForm(p => ({ ...p, amount: raw ? Number(raw).toLocaleString('vi-VN') : '' })); }} />
                  </div>
                  <div className="form-group">
                    <label>LĂ½ do</label>
                    <input type="text" placeholder="Äi trá»…, trang phá»¥c..." value={vForm.reason} onChange={e => setVForm(p => ({ ...p, reason: e.target.value }))} />
                  </div>
                </div>
                <button className="btn-primary" onClick={handleAddViolation}>ThĂªm khoáº£n pháº¡t</button>
              </div>

              {violations.length === 0 ? <div className="empty-state">KhĂ´ng cĂ³ vi pháº¡m nĂ o trong thĂ¡ng {selMonth}/{selYear}</div> : (
                <table className="payroll-table">
                  <thead><tr><th>NhĂ¢n viĂªn</th><th>Sá»‘ tiá»n</th><th>LĂ½ do</th><th></th></tr></thead>
                  <tbody>
                    {violations.map(v => (
                      <tr key={v.id}>
                        <td>{v.staff?.full_name}</td>
                        <td style={{ color: '#dc2626', fontWeight: 700 }}>{formatMoney(v.amount)}</td>
                        <td>{v.reason}</td>
                        <td><button className="btn-danger" style={{ fontSize: '0.75rem', padding: '4px 10px' }} onClick={() => handleDeleteViolation(v.id)}>XoĂ¡</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* === CHáº¤M CĂ”NG === */}
          {activeTab === 'attendance' && (() => {
            const filtered = attendance.filter(a => {
              const staff = staffList.find(s => s.id === a.staff_id);
              const nameOk = !attSearch || (staff?.full_name || '') === attSearch;
              const dayOk  = !attDayFilter || (a.date || '').slice(8, 10) === attDayFilter;
              return nameOk && dayOk;
            });
            return (
              <div>
                {/* Filter bar */}
                <div className="filter-bar">
                  <select value={attSearch} onChange={e => setAttSearch(e.target.value)}>
                    <option value="">đŸ‘¥ Táº¥t cáº£ nhĂ¢n viĂªn</option>
                    {staffList.map(s => <option key={s.id} value={s.full_name}>{s.full_name}</option>)}
                  </select>
                  <select value={attDayFilter} onChange={e => setAttDayFilter(e.target.value)}>
                    <option value="">NgĂ y</option>
                    {Array.from({length: 31}, (_, i) => i + 1).map(d => <option key={d} value={String(d).padStart(2,'0')}>{d}</option>)}
                  </select>
                  <select value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
                    {months.map(m => <option key={m} value={m}>ThĂ¡ng {m}</option>)}
                  </select>
                  <select value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
                    {years.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                  {(attSearch || attDayFilter) && (
                    <button onClick={() => { setAttSearch(''); setAttDayFilter(''); }}
                      style={{ fontSize: '0.8rem', color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>âœ• XoĂ¡</button>
                  )}
                </div>

                {filtered.length === 0
                  ? <div className="empty-state">KhĂ´ng cĂ³ dá»¯ liá»‡u cháº¥m cĂ´ng thĂ¡ng {selMonth}/{selYear}</div>
                  : <>
                      {/* Mobile cards */}
                      <div className="mobile-cards">
                        {filtered.map(a => {
                          const staff = staffList.find(s => s.id === a.staff_id);
                          const isEditing = editingAtt?.id === a.id;
                          const timeIn  = a.clock_in  ? new Date(a.clock_in).toLocaleTimeString('vi-VN',  { hour: '2-digit', minute: '2-digit' }) : 'â€”';
                          const timeOut = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : null;
                          // Convert timestamps to local datetime-local input format
                          const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';

                          return (
                            <div key={a.id} className="att-card" style={{ borderColor: isEditing ? '#3b82f6' : undefined }}>
                              <div className="att-card-header">
                                <span className="att-card-name">{staff?.full_name || 'â€”'}</span>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <span className="att-card-date">{a.date}</span>
                                  {!isEditing
                                    ? <button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })}
                                        style={{ fontSize: '0.75rem', padding: '2px 8px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', color: '#475569' }}>âœï¸ Sá»­a</button>
                                    : <button onClick={() => setEditingAtt(null)}
                                        style={{ fontSize: '0.75rem', padding: '2px 8px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', color: '#dc2626' }}>âœ• Huá»·</button>
                                  }
                                </div>
                              </div>

                              {isEditing ? (
                                /* â”€â”€ INLINE EDIT FORM â”€â”€ */
                                <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {[
                                    { label: 'Giá» vĂ o', key: 'clock_in',  type: 'datetime-local' },
                                    { label: 'Giá» ra',  key: 'clock_out', type: 'datetime-local' },
                                  ].map(({ label, key, type }) => (
                                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ width: 70, fontSize: '0.78rem', color: '#64748b', fontWeight: 600, flexShrink: 0 }}>{label}</span>
                                      <input type={type} value={editingAtt[key] || ''} onChange={e => setEditingAtt(p => ({ ...p, [key]: e.target.value }))}
                                        style={{ flex: 1, padding: '5px 8px', border: '1.5px solid #cbd5e1', borderRadius: 7, fontSize: '0.82rem' }} />
                                    </div>
                                  ))}
                                  {[
                                    { label: 'Giá» lĂ m', key: 'work_hours',     placeholder: 'h (vd: 8)' },
                                    { label: 'TÄƒng ca',  key: 'overtime_hours', placeholder: 'h (vd: 2)' },
                                  ].map(({ label, key, placeholder }) => (
                                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ width: 70, fontSize: '0.78rem', color: '#64748b', fontWeight: 600, flexShrink: 0 }}>{label}</span>
                                      <input type="number" step="0.1" min="0" value={editingAtt[key] ?? ''} placeholder={placeholder}
                                        onChange={e => setEditingAtt(p => ({ ...p, [key]: e.target.value }))}
                                        style={{ width: 80, padding: '5px 8px', border: '1.5px solid #cbd5e1', borderRadius: 7, fontSize: '0.82rem' }} />
                                    </div>
                                  ))}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ width: 70, fontSize: '0.78rem', color: '#64748b', fontWeight: 600, flexShrink: 0 }}>Ghi chĂº</span>
                                    <input type="text" value={editingAtt.note || ''} placeholder="LĂ½ do sá»­a..."
                                      onChange={e => setEditingAtt(p => ({ ...p, note: e.target.value }))}
                                      style={{ flex: 1, padding: '5px 8px', border: '1.5px solid #cbd5e1', borderRadius: 7, fontSize: '0.82rem' }} />
                                  </div>
                                  <button onClick={handleSaveAttEdit}
                                    style={{ padding: '8px', background: '#0f172a', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>
                                    đŸ’¾ LÆ°u thay Ä‘á»•i
                                  </button>
                                </div>
                              ) : (
                                <div className="att-card-grid">
                                  <div className="att-card-item"><span className="att-card-item-label">VĂ o</span><span className="att-card-item-value">{timeIn}</span></div>
                                  <div className="att-card-item"><span className="att-card-item-label">Ra</span><span className="att-card-item-value" style={!timeOut ? { color: '#f59e0b' } : {}}>{timeOut || 'ChÆ°a ra'}</span></div>
                                  <div className="att-card-item"><span className="att-card-item-label">Giá» lĂ m</span><span className="att-card-item-value">{a.work_hours ? `${a.work_hours}h` : 'â€”'}</span></div>
                                  <div className="att-card-item"><span className="att-card-item-label">TÄƒng ca</span><span className="att-card-item-value" style={{ color: a.overtime_hours > 0 ? '#16a34a' : '#94a3b8' }}>{a.overtime_hours > 0 ? `${a.overtime_hours}h` : 'â€”'}</span></div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Desktop table */}
                      <div className="desktop-table">
                        <table className="payroll-table">
                          <thead><tr><th>NhĂ¢n viĂªn</th><th>NgĂ y</th><th>VĂ o</th><th>Ra</th><th>Giá» lĂ m</th><th>TÄƒng ca</th><th></th></tr></thead>
                          <tbody>
                            {filtered.map(a => {
                              const staff = staffList.find(s => s.id === a.staff_id);
                              const isEditing = editingAtt?.id === a.id;
                              const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
                              return isEditing ? (
                                <tr key={a.id} style={{ background: '#eff6ff' }}>
                                  <td colSpan="7">
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, padding: '8px 4px' }}>
                                      {[{label:'Giá» vĂ o',key:'clock_in',type:'datetime-local'},{label:'Giá» ra',key:'clock_out',type:'datetime-local'}].map(({label,key,type})=>(
                                        <label key={key} style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                          {label}<input type={type} value={editingAtt[key]||''} onChange={e=>setEditingAtt(p=>({...p,[key]:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.82rem'}}/>
                                        </label>
                                      ))}
                                      {[{label:'Giá» lĂ m',key:'work_hours'},{label:'TÄƒng ca (h)',key:'overtime_hours'}].map(({label,key})=>(
                                        <label key={key} style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                          {label}<input type="number" step="0.1" min="0" value={editingAtt[key]??''} onChange={e=>setEditingAtt(p=>({...p,[key]:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.82rem',width:90}}/>
                                        </label>
                                      ))}
                                      <label style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                        Ghi chĂº<input type="text" value={editingAtt.note||''} placeholder="LĂ½ do sá»­a..." onChange={e=>setEditingAtt(p=>({...p,note:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.82rem'}}/>
                                      </label>
                                    </div>
                                    <div style={{display:'flex',gap:8,padding:'0 4px 8px'}}>
                                      <button onClick={handleSaveAttEdit} style={{padding:'6px 16px',background:'#0f172a',color:'white',border:'none',borderRadius:7,fontWeight:700,fontSize:'0.82rem',cursor:'pointer'}}>đŸ’¾ LÆ°u</button>
                                      <button onClick={()=>setEditingAtt(null)} style={{padding:'6px 14px',background:'#f1f5f9',border:'1px solid #e2e8f0',borderRadius:7,fontWeight:600,fontSize:'0.82rem',cursor:'pointer'}}>Huá»·</button>
                                    </div>
                                  </td>
                                </tr>
                              ) : (
                                <tr key={a.id}>
                                  <td>{staff?.full_name || 'â€”'}</td>
                                  <td>{a.date}</td>
                                  <td>{a.clock_in ? new Date(a.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'â€”'}</td>
                                  <td>{a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : <span style={{ color: '#f59e0b' }}>ChÆ°a ra</span>}</td>
                                  <td>{a.work_hours ? `${a.work_hours}h` : 'â€”'}</td>
                                  <td style={{ color: '#16a34a', fontWeight: 600 }}>{a.overtime_hours > 0 ? `${a.overtime_hours}h` : 'â€”'}</td>
                                  <td><button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })}
                                    style={{ fontSize: '0.75rem', padding: '3px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', color: '#475569' }}>âœï¸ Sá»­a</button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                }
              </div>
            );
          })()}

          {/* === QR CHáº¤M CĂ”NG === */}
          {activeTab === 'qr' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '20px 0' }}>
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 16, padding: 24, textAlign: 'center', maxWidth: 340, width: '100%' }}>
                <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 4 }}>đŸ“± QR Cháº¥m cĂ´ng</div>
                <div style={{ fontSize: '0.8rem', color: '#6b7280', marginBottom: 16 }}>NhĂ¢n viĂªn quĂ©t mĂ£ Ä‘á»ƒ vĂ o/ra ca</div>
                <div style={{ display: 'inline-block', padding: 12, background: 'white', border: '2px solid #111827', borderRadius: 12 }}>
                  <QRCodeSVG value={networkUrl || 'loading...'} size={200} level="M" />
                </div>
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: qrCountdown > 30 ? '#16a34a' : '#f59e0b', animation: 'pulse 1s infinite' }} />
                  <span style={{ fontSize: '0.82rem', color: '#6b7280' }}>Háº¿t háº¡n sau: <strong style={{ color: qrCountdown > 30 ? '#15803d' : '#dc2626' }}>{qrCountdown}s</strong></span>
                </div>
                <div style={{ marginTop: 10, fontSize: '0.72rem', color: '#9ca3af', wordBreak: 'break-all', background: '#f9fafb', borderRadius: 8, padding: '6px 10px' }}>
                  {networkUrl}
                </div>
              </div>
              <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 12, padding: 16, maxWidth: 340, width: '100%', fontSize: '0.82rem', color: '#0369a1' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>HÆ°á»›ng dáº«n sá»­ dá»¥ng:</div>
                <div>1ï¸âƒ£ Má»Ÿ trang nĂ y trĂªn mĂ¡y tĂ­nh / tablet táº¡i nhĂ  hĂ ng</div>
                <div style={{ marginTop: 4 }}>2ï¸âƒ£ NhĂ¢n viĂªn dĂ¹ng Ä‘iá»‡n thoáº¡i quĂ©t mĂ£ QR</div>
                <div style={{ marginTop: 4 }}>3ï¸âƒ£ ÄÄƒng nháº­p (náº¿u chÆ°a) vĂ  báº¥m <strong>XĂ¡c nháº­n cháº¥m cĂ´ng</strong></div>
                <div style={{ marginTop: 4 }}>4ï¸âƒ£ MĂ£ tá»± lĂ m má»›i má»—i 5 phĂºt â€” khĂ´ng thá»ƒ dĂ¹ng mĂ£ cÅ©</div>
              </div>
            </div>
          )}

          {/* === TĂ€I KHOáº¢N === */}
          {activeTab === 'accounts' && (
            <div>
              {/* Create form */}
              <div className="payroll-form">
                <h3>â• Táº¡o tĂ i khoáº£n nhĂ¢n viĂªn má»›i</h3>
                {accMsg && <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: accMsg.startsWith('âœ…') ? '#dcfce7' : '#fee2e2', color: accMsg.startsWith('âœ…') ? '#15803d' : '#dc2626', fontSize: '0.85rem', fontWeight: 600 }}>{accMsg}</div>}
                <div className="form-grid">
                  <div className="form-group">
                    <label>Há» vĂ  TĂªn</label>
                    <input type="text" placeholder="Nguyá»…n VÄƒn A" value={accForm.full_name} onChange={e => setAccForm(p => ({ ...p, full_name: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Sá»‘ Ä‘iá»‡n thoáº¡i</label>
                    <input type="tel" placeholder="0909123456" value={accForm.phone} onChange={e => setAccForm(p => ({ ...p, phone: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>MĂ£ PIN (â‰¥ 4 kĂ½ tá»±)</label>
                    <input type="text" placeholder="1234" maxLength={8} value={accForm.pin} onChange={e => setAccForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, '') }))} />
                  </div>
                  <div className="form-group">
                    <label>Vai trĂ²</label>
                    <select value={accForm.role} onChange={e => setAccForm(p => ({ ...p, role: e.target.value }))}>
                      <option value="staff">NhĂ¢n viĂªn</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>
                <button className="btn-primary" onClick={handleCreateAccount}>Táº¡o tĂ i khoáº£n</button>
              </div>

              {/* Staff list */}
              <div className="config-list">
                {staffList.map(s => (
                  <div key={s.id} className="config-row" style={{ flexWrap: 'wrap', gap: 10 }}>
                    <div style={{ minWidth: 140 }}>
                      <div style={{ fontWeight: 700 }}>{s.full_name}</div>
                      <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{s.phone}</div>
                      <span style={{ display: 'inline-block', marginTop: 4, fontSize: '0.7rem', fontWeight: 700, padding: '1px 7px', borderRadius: 4, background: s.role === 'admin' ? '#fef9c3' : '#f0f9ff', color: s.role === 'admin' ? '#92400e' : '#0369a1' }}>
                        {s.role === 'admin' ? 'đŸ‘‘ Admin' : 'đŸ‘¤ NV'}
                      </span>
                    </div>
                    <div className="form-group" style={{ margin: 0, flex: 1, minWidth: 140 }}>
                      <label>Äá»•i PIN má»›i</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input type="text" inputMode="numeric" maxLength={8} placeholder="PIN má»›i..." value={editingPin[s.id] || ''}
                          onChange={e => setEditingPin(p => ({ ...p, [s.id]: e.target.value.replace(/\D/g, '') }))}
                          style={{ flex: 1 }} />
                        <button className="btn-primary" style={{ padding: '6px 12px', marginTop: 0, whiteSpace: 'nowrap' }} onClick={() => handleUpdatePin(s.id)}>LÆ°u</button>
                      </div>
                    </div>
                    <button className="btn-danger" style={{ marginTop: 18, alignSelf: 'flex-end' }} onClick={() => handleDeleteAccount(s.id, s.full_name)}>XoĂ¡</button>
                  </div>
                ))}
                {staffList.length === 0 && <div className="empty-state">ChÆ°a cĂ³ nhĂ¢n viĂªn nĂ o</div>}
              </div>
            </div>
          )}

          {/* === Cáº¤U HĂŒNH === */}
          {activeTab === 'config' && (
            <div>
              <div className="payroll-form" style={{ marginBottom: 8 }}>
                <p style={{ fontSize: '0.82rem', color: '#6b7280', margin: 0 }}>đŸ’¡ Thiáº¿t láº­p lÆ°Æ¡ng cÆ¡ báº£n, giĂ¡ tÄƒng ca vĂ  ngĂ y phĂ¡t lÆ°Æ¡ng cho tá»«ng nhĂ¢n viĂªn.</p>
              </div>
              <div className="config-list">
                {staffList.map(s => {
                  const edit = configEdits[s.id] || { base_salary: 0, overtime_rate: 25000, pay_day: 5 };
                  return (
                    <div key={s.id} className="config-row">
                      <div className="staff-name">{s.full_name}<div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{s.phone}</div></div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label>LÆ°Æ¡ng cÆ¡ báº£n</label>
                        <input type="text" inputMode="numeric" value={edit.base_salary ? Number(edit.base_salary).toLocaleString('vi-VN') : ''}
                          onChange={e => { const raw = e.target.value.replace(/\./g, '').replace(/\D/g, ''); setConfigEdits(p => ({ ...p, [s.id]: { ...edit, base_salary: raw || 0 } })); }}
                          placeholder="5.000.000" />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label>GiĂ¡ tÄƒng ca/h</label>
                        <input type="number" value={edit.overtime_rate || 25000}
                          onChange={e => setConfigEdits(p => ({ ...p, [s.id]: { ...edit, overtime_rate: e.target.value } }))} />
                      </div>
                      <div className="form-group" style={{ margin: 0 }}>
                        <label>NgĂ y phĂ¡t lÆ°Æ¡ng</label>
                        <input type="number" min="1" max="31" value={edit.pay_day || 5}
                          onChange={e => setConfigEdits(p => ({ ...p, [s.id]: { ...edit, pay_day: e.target.value } }))} />
                      </div>
                      <button className="btn-primary" style={{ marginTop: 18 }} onClick={() => handleSaveConfig(s.id)}>LÆ°u</button>
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

