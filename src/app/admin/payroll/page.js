'use client';
import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';
import { CheckCircle, XCircle, Clock, AlertTriangle, DollarSign, Calendar, Settings, Users } from 'lucide-react';
import './payroll.css';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const now = new Date();
const fmt = (n) => String(n).padStart(2, '0');
const formatMoney = (v) => Number(v || 0).toLocaleString('vi-VN') + 'đ';

export default function PayrollPage() {
  const [activeTab, setActiveTab] = useState('salary');
  const [staffList, setStaffList] = useState([]);
  const [configs, setConfigs] = useState({});       // { staffId: { base_salary, overtime_rate, pay_day } }
  const [requests, setRequests] = useState([]);
  const [violations, setViolations] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [selMonth, setSelMonth] = useState(now.getMonth() + 1);
  const [selYear, setSelYear] = useState(now.getFullYear());
  const [loading, setLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  // Violation form
  const [vForm, setVForm] = useState({ staff_id: '', amount: '', reason: '' });
  // Config edit state
  const [configEdits, setConfigEdits] = useState({});

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

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const years = [2025, 2026, 2027];

  const requestTypeMap = { advance: { label: '💵 Ứng lương', color: '#92400e', bg: '#fef9c3' }, absent: { label: '🏖 Báo nghỉ', color: '#1e40af', bg: '#dbeafe' } };

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
          { key: 'salary', label: '📊 Bảng Lương', icon: null },
          { key: 'requests', label: '📋 Yêu cầu', badge: pendingCount },
          { key: 'violations', label: '⚠️ Vi phạm' },
          { key: 'attendance', label: '⏰ Chấm công' },
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
