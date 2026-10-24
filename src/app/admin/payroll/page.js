'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { workforce } from '@/lib/staffApi';
import { dayFlags, durationText, flagTexts, groupByWorkDay, hhmm, hoursOn, sessionHours, shiftOf, workDayOf } from '@/lib/attendanceRules.mjs';
import { LATE_FINE_MINUTES, STANDARD_DAYS, activeFineKinds, bonusCheck, computeSalary, fineSuggestions, monthTallies, usesDayPay } from '@/lib/payroll.mjs';
import { activeInMonth } from '@/lib/staffDeparture.mjs';
import QrClockScanner from '@/components/QrClockScanner';
import { CheckCircle, XCircle, Clock, AlertTriangle, DollarSign, Calendar, Settings, Users, RefreshCw } from 'lucide-react';
import './payroll.css';

const now = new Date();
const fmt = (n) => String(n).padStart(2, '0');
const formatMoney = (v) => Number(v || 0).toLocaleString('vi-VN') + 'đ';
const vnToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const ddmm = d => d.slice(8, 10) + '/' + d.slice(5, 7);
// " (02/11 – 03/11)" cho đơn báo nghỉ có ngày nghỉ.
const leaveText = l => (l ? ` (${ddmm(l.from_date)}${l.to_date !== l.from_date ? ` – ${ddmm(l.to_date)}` : ''})` : '');
const fmtNum = n => String(n).replace('.', ',');
// Supabase trả tối đa 1000 dòng mỗi lần: đọc từng trang (giờ công cả quán một tháng có thể quá 1000 lượt).
async function readAllRows(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) return { data: rows, error };
    rows.push(...(data || []));
    if (!data || data.length < 1000) return { data: rows, error: null };
  }
}
// Ô nhập tiền: chỉ giữ số, chấm hàng nghìn (50.000).
const typedMoney = v => { const raw = String(v ?? '').replace(/\./g, '').replace(/\D/g, ''); return raw ? Number(raw).toLocaleString('vi-VN') : ''; };
const shownMoney = n => (Number(n) > 0 ? Number(n).toLocaleString('vi-VN') : '');
const smallBtn = { fontSize: '0.75rem', padding: '4px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid #e2e8f0', background: '#f8fafc', fontWeight: 700, whiteSpace: 'nowrap' };
const moneyBox = { width: 110, padding: '4px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6, fontSize: '0.82rem' };

// Thưởng chuyên cần (Bảng lương): điều kiện + mức gợi ý (sửa được); người đủ điều kiện — chủ tự điền tiền rồi
// duyệt, chỉ khi đã hết tháng; người đã duyệt (bỏ được); người chưa đủ kèm lý do (vẫn thưởng được).
function BonusBox({ year, month, people, settings, monthOver, onAction }) {
  const [amounts, setAmounts] = useState({});
  const [edit, setEdit] = useState(null);
  const [extra, setExtra] = useState({});
  const s = settings || { bonus_amount: 0, bonus_min_days: 22 };
  const suggested = shownMoney(s.bonus_amount);
  const approved = people.filter(p => p.approved);
  const eligible = people.filter(p => !p.approved && p.check.eligible);
  const others = people.filter(p => !p.approved && !p.check.eligible);
  const unused = !s.bonus_amount && !approved.length;
  const amountOf = p => amounts[p.s.id] ?? suggested;
  const approve = p => (amountOf(p) ? onAction('decide_bonus', { staff_id: p.s.id, year, month, amount: amountOf(p) }) : alert('Nhập số tiền thưởng.'));
  const amountInput = p => <input style={moneyBox} inputMode="numeric" placeholder="Số tiền" value={amountOf(p)} onChange={e => setAmounts(a => ({ ...a, [p.s.id]: typedMoney(e.target.value) }))} />;
  return (
    <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '12px 14px', margin: '0 0 12px', fontSize: '0.84rem', color: '#334155', lineHeight: 1.7 }}>
      <div style={{ fontWeight: 800 }}>⭐ Thưởng chuyên cần tháng {month}/{year}</div>
      {edit ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0' }}>
          <label>Mức thưởng gợi ý <input style={moneyBox} inputMode="numeric" value={edit.bonus_amount} onChange={e => setEdit(x => ({ ...x, bonus_amount: typedMoney(e.target.value) }))} /></label>
          <label>Ít nhất <input style={{ ...moneyBox, width: 56 }} inputMode="decimal" value={edit.bonus_min_days} onChange={e => setEdit(x => ({ ...x, bonus_min_days: e.target.value }))} /> ngày công</label>
          <button style={{ ...smallBtn, background: '#111827', borderColor: '#111827', color: 'white' }} onClick={async () => { if (await onAction('save_bonus_settings', { bonus_amount: edit.bonus_amount || '0', bonus_min_days: edit.bonus_min_days })) setEdit(null); }}>Lưu</button>
          <button style={smallBtn} onClick={() => setEdit(null)}>Huỷ</button>
        </div>
      ) : (
        <div>
          Điều kiện: cả tháng <strong>không đi trễ</strong>, <strong>không quên ra ca</strong>, đủ <strong>{fmtNum(s.bonus_min_days)} ngày công</strong>.
          {' '}{s.bonus_amount ? <>Mức gợi ý <strong>{formatMoney(s.bonus_amount)}</strong>, sửa được từng người.</> : 'Chưa đặt mức thưởng gợi ý.'}
          {' '}<button style={smallBtn} onClick={() => setEdit({ bonus_amount: suggested, bonus_min_days: fmtNum(s.bonus_min_days) })}>{unused ? 'Đặt mức thưởng' : 'Sửa'}</button>
        </div>
      )}
      {!unused && (
        <>
          {!monthOver && (eligible.length
            ? <div>⏳ Hết tháng mới duyệt được. Đang giữ được: <strong>{eligible.map(p => p.s.full_name).join(', ')}</strong>.</div>
            : <div style={{ color: '#64748b' }}>⏳ Hết tháng mới duyệt được. Chưa ai giữ được điều kiện tới hôm nay.</div>)}
          {monthOver && eligible.map(p => (
            <div key={p.s.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
              <span style={{ minWidth: 120, fontWeight: 700 }}>✅ {p.s.full_name}</span>
              <span style={{ color: '#64748b' }}>{fmtNum(p.c.workUnits)} ngày công</span>
              {amountInput(p)}
              <button style={{ ...smallBtn, background: '#16a34a', borderColor: '#16a34a', color: 'white' }} onClick={() => approve(p)}>Duyệt thưởng</button>
            </div>
          ))}
          {approved.map(p => (
            <div key={p.s.id} style={{ marginTop: 4 }}>
              🎁 <strong>{p.s.full_name}</strong>: +{formatMoney(p.approved.amount)}{p.approved.decided_by ? ` (${p.approved.decided_by} duyệt)` : ''}
              {' '}<button style={smallBtn} onClick={() => onAction('remove_bonus', { staff_id: p.s.id, year, month }, `Bỏ thưởng chuyên cần của ${p.s.full_name}?`)}>Bỏ</button>
            </div>
          ))}
          {others.length > 0 && (
            <div style={{ marginTop: 4, color: '#64748b' }}>
              Chưa đủ điều kiện: {others.map((p, i) => (
                <React.Fragment key={p.s.id}>
                  {i > 0 && ' · '}{p.s.full_name} ({p.check.reasons.join(', ')})
                  {monthOver && (extra[p.s.id]
                    ? <> {amountInput(p)} <button style={smallBtn} onClick={() => approve(p)}>Thưởng</button></>
                    : <> <button style={{ ...smallBtn, padding: '1px 6px', fontWeight: 600 }} onClick={() => setExtra(x => ({ ...x, [p.s.id]: true }))}>vẫn thưởng</button></>)}
                </React.Fragment>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Gợi ý phạt từ chấm công trong tháng (trễ quá 30 phút, quên ra ca): chủ điền tiền rồi Phạt, hoặc Bỏ qua.
function FineHints({ hints, nameOf, rules, reviews, onAction }) {
  const [amounts, setAmounts] = useState({});
  const ruleOf = kind => rules.find(r => r.kind === kind);
  const keyOf = h => `${h.attendance_id}:${h.kind}`;
  // Giờ ra là giờ đang ghi: máy tự ghi khi quên ra ca, hoặc giờ đã được duyệt sửa.
  const what = h => (h.kind === 'late' ? `trễ ${durationText(h.minutes)}` : `quên bấm ra ca${h.clock_out ? ` (giờ ra đang ghi ${hhmm(h.clock_out)})` : ''}`);
  const skipped = reviews.filter(r => r.status === 'skipped');
  return (
    <div className="payroll-form" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
      <h3>🔔 Máy gợi ý phạt ({hints.length})</h3>
      <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0 0 8px' }}>Từ chấm công: đi trễ quá {LATE_FINE_MINUTES} phút, quên bấm ra ca. Máy không tự trừ tiền — bạn điền số tiền rồi bấm Phạt, hoặc Bỏ qua.</p>
      {hints.length === 0 && <div style={{ fontSize: '0.82rem', color: '#64748b' }}>Không có gợi ý nào chưa xử lý.</div>}
      {hints.map(h => {
        const rule = ruleOf(h.kind), amount = amounts[keyOf(h)] ?? shownMoney(rule?.amount);
        const reason = `${rule?.name || (h.kind === 'late' ? 'Đi trễ' : 'Quên bấm ra ca')} (${ddmm(h.day)}${h.kind === 'late' ? `, trễ ${durationText(h.minutes)}` : ''})`;
        return (
          <div key={keyOf(h)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '6px 0', borderTop: '1px solid #fde7d3', fontSize: '0.84rem' }}>
            <span style={{ fontWeight: 700, minWidth: 100 }}>{nameOf(h.staff_id)}</span>
            <span style={{ color: '#64748b', minWidth: 42 }}>{ddmm(h.day)}</span>
            <span style={{ flex: 1, minWidth: 150 }}>{what(h)}</span>
            <input style={moneyBox} inputMode="numeric" placeholder="Số tiền" value={amount} onChange={e => setAmounts(a => ({ ...a, [keyOf(h)]: typedMoney(e.target.value) }))} />
            <button style={{ ...smallBtn, background: '#dc2626', borderColor: '#dc2626', color: 'white' }}
              onClick={() => (amount ? onAction('decide_fine', { attendance_id: h.attendance_id, kind: h.kind, status: 'fined', amount, reason }) : alert('Nhập số tiền phạt.'))}>Phạt</button>
            <button style={smallBtn} onClick={() => onAction('decide_fine', { attendance_id: h.attendance_id, kind: h.kind, status: 'skipped' })}>Bỏ qua</button>
          </div>
        );
      })}
      {skipped.length > 0 && (
        <details style={{ marginTop: 8, fontSize: '0.8rem', color: '#64748b' }}>
          <summary style={{ cursor: 'pointer' }}>Đã bỏ qua ({skipped.length})</summary>
          {skipped.map(r => (
            <div key={`${r.attendance_id}:${r.kind}`} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
              <span>{nameOf(r.staff_id)} · {ddmm(r.work_day)} · {r.kind === 'late' ? 'đi trễ' : 'quên ra ca'}{r.decided_by ? ` (${r.decided_by} bỏ qua)` : ''}</span>
              <button style={{ ...smallBtn, padding: '1px 8px', fontWeight: 600 }} onClick={() => onAction('reopen_fine', { attendance_id: r.attendance_id, kind: r.kind })}>Xem lại</button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// Danh sách lỗi có sẵn: tên + tiền phạt gợi ý (trống = điền mỗi lần), ẩn / hiện. 🤖 = lỗi máy tự gợi ý từ chấm công.
function FineRules({ rules, onAction }) {
  const [edits, setEdits] = useState({});
  const [draft, setDraft] = useState({ name: '', amount: '' });
  const valueOf = r => edits[r.id] || { name: r.name, amount: shownMoney(r.amount) };
  const change = (r, patch) => setEdits(e => ({ ...e, [r.id]: { ...valueOf(r), ...patch } }));
  const save = async (r, active = r.active) => {
    const v = valueOf(r);
    if (await onAction('save_fine_rule', { id: r.id, name: v.name, amount: v.amount, active })) setEdits(e => { const next = { ...e }; delete next[r.id]; return next; });
  };
  return (
    <details className="payroll-form">
      <summary style={{ fontWeight: 800, cursor: 'pointer' }}>📋 Danh sách lỗi có sẵn ({rules.filter(r => r.active).length})</summary>
      <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '6px 0' }}>Đặt sẵn tiền phạt cho từng lỗi để ghi phạt nhanh (để trống thì điền mỗi lần). 🤖 là lỗi máy tự gợi ý từ chấm công — ẩn đi thì máy thôi gợi ý lỗi đó.</p>
      {rules.map(r => {
        const v = valueOf(r);
        return (
          <div key={r.id} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '4px 0', opacity: r.active ? 1 : 0.55 }}>
            <input value={v.name} onChange={e => change(r, { name: e.target.value })} style={{ flex: 1, minWidth: 160, padding: '5px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 }} />
            <input value={v.amount} placeholder="Tiền phạt" inputMode="numeric" onChange={e => change(r, { amount: typedMoney(e.target.value) })} style={moneyBox} />
            {r.kind && <span title="Máy tự gợi ý từ chấm công">🤖</span>}
            {edits[r.id] && <button style={{ ...smallBtn, background: '#111827', borderColor: '#111827', color: 'white' }} onClick={() => save(r)}>Lưu</button>}
            <button style={smallBtn} onClick={() => save(r, !r.active)}>{r.active ? 'Ẩn' : 'Hiện'}</button>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingTop: 8, borderTop: '1px solid #f1f5f9', marginTop: 6 }}>
        <input value={draft.name} placeholder="Thêm lỗi mới…" onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} style={{ flex: 1, minWidth: 160, padding: '5px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 }} />
        <input value={draft.amount} placeholder="Tiền phạt" inputMode="numeric" onChange={e => setDraft(d => ({ ...d, amount: typedMoney(e.target.value) }))} style={moneyBox} />
        <button style={smallBtn} onClick={async () => { if (draft.name.trim() && await onAction('save_fine_rule', { name: draft.name, amount: draft.amount })) setDraft({ name: '', amount: '' }); }}>Thêm</button>
      </div>
    </details>
  );
}

// Ở từng dòng bảng lương: kết toán người nghỉ việc trong tháng, đánh dấu đã trả lương khi đã chốt.
function PayActions({ s, c, left, onClose, onPaid, compact }) {
  if (!left && !c.locked) return null;
  const btn = { fontSize: '0.75rem', padding: '3px 10px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid #e2e8f0', background: '#f8fafc' };
  const paidDay = c.paid_at ? ddmm(new Date(Date.parse(c.paid_at) + 7 * 3600000).toISOString().slice(0, 10)) : null;
  return (
    <div style={compact
      ? { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, alignItems: 'flex-start' }
      : { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid #f1f5f9', fontSize: '0.8rem' }}>
      {left && <span style={{ color: '#9a3412', fontWeight: 600, fontSize: '0.75rem' }}>🚪 Nghỉ việc, làm đến {ddmm(left.last_day)}</span>}
      {left && !c.locked && (
        <button style={{ ...btn, background: '#fff7ed', borderColor: '#fed7aa', color: '#9a3412', fontWeight: 700 }} onClick={() => onClose(s.id, s.full_name)}>🔒 Kết toán</button>
      )}
      {c.locked && (paidDay
        ? <button style={{ ...btn, background: '#dcfce7', borderColor: '#bbf7d0', color: '#15803d', fontWeight: 700 }} title="Bấm để bỏ đánh dấu" onClick={() => onPaid(s.id, false)}>✅ Đã trả {paidDay}</button>
        : <button style={{ ...btn, color: '#1d4ed8', fontWeight: 700 }} onClick={() => onPaid(s.id, true)}>💵 Đánh dấu đã trả</button>)}
    </div>
  );
}


export default function PayrollPage() {
  const [activeTab, setActiveTab] = useState('salary');
  const [staffList, setStaffList] = useState([]);
  const [configs, setConfigs] = useState({});
  const [requests, setRequests] = useState([]);
  const [violations, setViolations] = useState([]);
  const [attendanceRows, setAttendance] = useState([]);
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

  // Quét mã chấm công ngay trong app (nút ở đây hoặc trên thanh menu): xong thì tải lại giờ công hôm nay.
  const [scanOpen, setScanOpen] = useState(false);
  useEffect(() => {
    const refresh = () => { if (currentUser && currentUser.role !== 'admin') fetchStaffData(currentUser.id); };
    window.addEventListener('staff-clocked', refresh);
    return () => window.removeEventListener('staff-clocked', refresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // Staff self-service state
  const [todaySessions, setTodaySessions]  = useState([]);
  const [empReqs,        setEmpReqs]        = useState([]);
  const [showAdvForm,    setShowAdvForm]    = useState(false);
  const [showAbsForm,    setShowAbsForm]    = useState(false);
  const [advForm,        setAdvForm]        = useState({ amount: '', reason: '' });
  const [absForm,        setAbsForm]        = useState({ from: '', to: '', reason: '' });
  const [myAllSessions,  setMyAllSessions]  = useState([]); // current month, for history

  const [myOpen,     setMyOpen]     = useState(null); // ca đang mở (có thể từ hôm qua, làm qua 12h đêm)
  const [myFixes,    setMyFixes]    = useState([]);
  const [myAuto,     setMyAuto]     = useState([]); // ca máy tự đóng vì quên ra ca
  const [fixForm,    setFixForm]    = useState(null); // { attendance_id, clock_in, clock_out, reason }
  const [myRules,    setMyRules]    = useState(null); // giờ làm + ca của mình
  const [myReviews,  setMyReviews]  = useState([]);   // chủ đã cho / không cho tính giờ ngoài ca
  const [myLeaveDays, setMyLeaveDays] = useState([]); // ngày nghỉ của các đơn báo nghỉ
  const [mySalary,   setMySalary]   = useState(null); // lương tạm tính tháng này (máy chủ tính)
  const [myFines,    setMyFines]    = useState([]);   // tiền phạt tháng này kèm lý do
  const [myMonth,    setMyMonth]    = useState({ y: now.getFullYear(), m: now.getMonth() + 1 }); // tháng của lịch sử chấm công
  const [myBonus,    setMyBonus]    = useState(null); // thưởng chuyên cần: đã trễ / quên ra ca chưa (khi chủ có dùng)
  const [sending,    setSending]    = useState('');   // đang gửi đơn nào (chặn bấm 2 lần)
  const [notice,     setNotice]     = useState(null); // { text, ok } — báo ngay trên trang thay cho hộp thoại
  const noticeTimer = React.useRef(null);
  const say = (text, ok = true) => {
    setNotice({ text, ok });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  };
  // Gửi một đơn: không cho bấm lần 2 khi đang gửi (kể cả bấm đúp thật nhanh), báo kết quả ngay trên trang.
  const sendingRef = React.useRef('');
  const send = async (key, action, body, done) => {
    if (sendingRef.current) return false;
    sendingRef.current = key;
    setSending(key);
    try {
      await workforce(action, body);
      done?.();
      fetchStaffData(currentUser.id);
      return true;
    } catch (err) { say(err.message, false); return false; }
    finally { sendingRef.current = ''; setSending(''); }
  };
  // Đăng xuất thật (xoá phiên trên máy chủ), không chỉ xoá tên lưu trong máy.
  const logout = async () => {
    await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem('staffUser');
    window.location.reload();
  };

  const fetchStaffData = async (staffId) => {
    // Tháng của hôm nay lúc tải (app để mở qua cuối tháng thì sang tháng mới).
    const today = new Date(), m = today.getMonth() + 1, y = today.getFullYear();
    setMyMonth({ y, m });
    const mStart = `${y}-${fmt(m)}-01`;
    const mEnd   = m === 12 ? `${y + 1}-01-01` : `${y}-${fmt(m + 1)}-01`;
    // Hỏi máy chủ trước: lúc đó máy tự đóng các ca quên ra ca, rồi mới đọc lịch sử tháng (không thì vẫn hiện "đang làm").
    const meRes = await fetch('/api/admin/workforce?me=1', { cache: 'no-store' }).then(r => {
      if (r.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
      return r.json();
    }).catch(() => ({}));
    const [monthRes, reqRes] = await Promise.all([
      supabase.from('attendance_sessions').select('*').eq('staff_id', staffId).gte('date', mStart).lte('date', mEnd).order('clock_in'),
      // Đơn 60 ngày gần đây (đơn báo nghỉ thuộc tháng của ngày nghỉ, có thể là tháng sau).
      supabase.from('payroll_requests').select('*').eq('staff_id', staffId).gte('created_at', new Date(Date.now() - 60 * 86400000).toISOString()).order('created_at', { ascending: false }),
    ]);
    setTodaySessions(meRes.sessions || []);
    setMyOpen(meRes.open || null);
    setMyFixes(meRes.fixes || []);
    setMyAuto(meRes.auto_closed || []);
    setMyRules(meRes.rules || null);
    setMyReviews(meRes.reviews || []);
    setMyLeaveDays(meRes.leave_days || []);
    setMySalary(meRes.salary || null);
    setMyFines(meRes.violations || []);
    setMyBonus(meRes.bonus || null);
    setMyAllSessions(monthRes.data || []);
    setEmpReqs(reqRes.data || []);
  };

  const handleSubmitFix = async () => {
    if (!fixForm?.reason?.trim()) return say('Ghi rõ lý do xin sửa giờ.', false);
    const iso = v => (v ? new Date(v).toISOString() : null);
    const ok = await send('fix', 'request_fix', { attendance_id: fixForm.attendance_id, clock_in: iso(fixForm.clock_in), clock_out: iso(fixForm.clock_out), reason: fixForm.reason },
      () => setFixForm(null));
    if (ok) say('Đã gửi đơn xin sửa giờ, chờ chủ quán duyệt.');
  };

  const handleSubmitAdvance = async () => {
    if (!advForm.amount || !advForm.reason.trim()) return say('Điền số tiền và lý do cần ứng.', false);
    const ok = await send('adv', 'request', { type: 'advance', amount: advForm.amount, reason: advForm.reason },
      () => { setAdvForm({ amount: '', reason: '' }); setShowAdvForm(false); });
    if (ok) say('Đã gửi yêu cầu ứng lương, chờ chủ quán duyệt.');
  };

  const handleSubmitAbsent = async () => {
    if (!absForm.from) return say('Chọn ngày nghỉ.', false);
    if (!absForm.reason.trim()) return say('Ghi lý do nghỉ.', false);
    const ok = await send('abs', 'request', { type: 'absent', from_date: absForm.from, to_date: absForm.to || absForm.from, reason: absForm.reason },
      () => { setAbsForm({ from: '', to: '', reason: '' }); setShowAbsForm(false); });
    if (ok) say('Đã gửi báo nghỉ, chờ chủ quán duyệt.');
  };

  // Huỷ đơn của mình khi còn chờ duyệt (lỡ gửi nhầm).
  const handleCancel = async (id, kind) => {
    if (!confirm('Huỷ đơn này?')) return;
    if (await send(`cancel-${id}`, 'cancel_request', { id, kind })) say('Đã huỷ đơn.');
  };

  // Cài chấm công: giờ làm, máy quầy, chạy thử / chặn thật, điện thoại đã đăng ký, lịch sử quét, đơn sửa giờ.
  const [checkin, setCheckin] = useState(null);
  const [hoursEdit, setHoursEdit] = useState(null); // { opening_time, closing_time, grace_minutes }
  const [shiftEdit, setShiftEdit] = useState(null); // { staff_id, start, end }
  const [onlyWarnings, setOnlyWarnings] = useState(true);
  const fetchCheckin = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/workforce?checkin=1', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setCheckin(j);
        const h = hoursOn(j.settings, vnToday());
        setHoursEdit({ opening_time: h.opening, closing_time: h.closing, grace_minutes: h.grace });
      }
    } catch { /* tab Cài chấm công hiện "đang tải" và thử lại khi đồng bộ */ }
  }, []);
  // Số lương đã chốt của tháng đang xem, ngày nghỉ của các đơn báo nghỉ, thưởng chuyên cần, danh sách lỗi,
  // gợi ý phạt đã xử lý, ngày / người ghi của khoản phạt.
  const [payrollMonth, setPayrollMonth] = useState({ closes: [], leaveDays: [], autoClosed: [], bonuses: [], bonusSettings: null, fineRules: [], fineReviews: [], violationMeta: [], monthOver: false });
  const fetchPayrollMonth = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/workforce?payroll=1&year=${selYear}&month=${selMonth}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) setPayrollMonth({ closes: j.closes || [], leaveDays: j.leaveDays || [], autoClosed: j.autoClosed || [], bonuses: j.bonuses || [],
        bonusSettings: j.bonusSettings || null, fineRules: j.fineRules || [], fineReviews: j.fineReviews || [], violationMeta: j.violationMeta || [], monthOver: !!j.monthOver, reviews: j.reviews || [] });
    } catch { /* bảng lương vẫn tính được, chỉ thiếu số đã chốt */ }
  }, [selMonth, selYear]);
  const checkinAction = async (action, body, confirmText) => {
    if (confirmText && !confirm(confirmText)) return false;
    try { await workforce(action, body); } catch (err) { alert(err.message); return false; }
    fetchCheckin();
    if (action === 'decide_fix') fetchAll();
    return true;
  };

  // Giờ làm theo ca (từ ngày bật): chỉ tính lương trong ca, giờ ngoài ca chờ chủ duyệt.
  const rules = checkin?.settings || null;
  // Lần duyệt giờ ngoài ca: của đúng tháng đang xem (máy chủ chốt bằng chính số này) + các lần gần đây.
  const reviewList = [...(checkin?.reviews || []), ...(payrollMonth.reviews || [])];
  const reviewMap = Object.fromEntries(reviewList.map(r => [r.attendance_id, r]));
  const hoursOf = s => sessionHours(s, rules, reviewMap[s.id]);
  // Các lượt thuộc ngày làm trong tháng đang xem: lượt dọn quán sau nửa đêm thuộc ca hôm trước
  // (ngày 1 tháng sau vẫn là ca cuối tháng này, ngày 1 tháng này có thể là ca cuối tháng trước).
  const attendance = attendanceRows.filter(a => workDayOf(a, rules).slice(0, 7) === `${selYear}-${fmt(selMonth)}`);
  // Ngày ghi khác ngày làm thì ghi rõ ca của ngày nào.
  const dateLabel = a => { const d = workDayOf(a, rules); return d === a.date ? a.date : `${a.date} (ca ngày ${d.slice(8, 10)}/${d.slice(5, 7)})`; };
  const hoursText = ms => `${fmtNum(Math.round(ms / 360000) / 10)} giờ`;
  // Trễ / vào sớm ở ca đầu ngày, về sớm / ở lại ở ca cuối ngày.
  // Tiền trừ vì về sớm theo từng ngày (tính một lần mỗi người mỗi lần vẽ trang).
  const earlyCuts = {};
  const earlyCutOf = (staffId, day) => (earlyCuts[staffId] ||= calcSalary(staffId).earlyList || []).find(x => x.day === day) || null;
  const rowFlags = a => {
    const wd = workDayOf(a, rules);
    const day = attendance.filter(x => x.staff_id === a.staff_id && workDayOf(x, rules) === wd).sort((x, y) => String(x.clock_in).localeCompare(String(y.clock_in)));
    const f = dayFlags(day, rules), first = day[0]?.id === a.id, last = day[day.length - 1]?.id === a.id;
    const texts = flagTexts({ late: first ? f.late : 0, early: first ? f.early : 0, leftEarly: last ? f.leftEarly : 0, stayed: last ? f.stayed : 0 });
    // Về sớm từ 30 phút (từ tháng 11): ghi số tiền bị trừ của ngày đó.
    const cut = last ? earlyCutOf(a.staff_id, wd) : null;
    if (cut) texts.push(`trừ lương ${formatMoney(cut.amount)} vì về sớm`);
    return (payrollMonth.autoClosed || []).includes(a.id) ? [...texts, 'quên ra ca (máy tự đóng)'] : texts;
  };
  const extraText = a => {
    const h = hoursOf(a), outside = h.earlyMs + h.stayMs;
    if (!outside) return '';
    const r = reviewMap[a.id];
    return `ngoài ca ${durationText(outside / 60000)}: ${r ? (r.status === 'approved' ? 'đã cho tính' : 'không tính') : 'chờ duyệt'}`;
  };

  // Violation form
  const [vForm, setVForm] = useState({ staff_id: '', date: '', rule_id: '', amount: '', reason: '' });
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
    // Ô giờ là giờ trên máy (VN) → gửi giờ chuẩn để máy chủ không lưu lệch 7 tiếng.
    const iso = v => (v ? new Date(v).toISOString() : null);
    try {
      await workforce('edit_attendance', { id: orig.id, clock_in: iso(editingAtt.clock_in), clock_out: iso(editingAtt.clock_out), note: editingAtt.note ?? '' });
    } catch (err) { return alert(err.message); }

    setEditingAtt(null);
    fetchAll();
  };

  const [expandedSalaryStaff, setExpandedSalaryStaff] = useState(null);

  const fetchAll = useCallback(async () => {
    fetchCheckin();
    fetchPayrollMonth();
    setLoading(true);
    const [staffRes, cfgRes, reqRes, vioRes, attRes] = await Promise.all([
      supabase.from('staff').select('id, full_name, phone, role, created_at, last_login').order('full_name'),
      supabase.from('payroll_config').select('*'),
      supabase.from('payroll_requests').select('*, staff(full_name,phone)').order('created_at', { ascending: false }),
      supabase.from('payroll_violations').select('*, staff(full_name)').eq('month', selMonth).eq('year', selYear),
      // Lấy cả ngày 1 tháng sau: lượt dọn quán sau nửa đêm của ca cuối tháng (lọc theo ngày làm ở dưới).
      readAllRows(() => supabase.from('attendance_sessions').select('*').gte('date', `${selYear}-${fmt(selMonth)}-01`).lte('date', selMonth === 12 ? `${selYear + 1}-01-01` : `${selYear}-${fmt(selMonth + 1)}-01`).order('clock_in')),
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
  }, [selMonth, selYear, fetchCheckin, fetchPayrollMonth]);


  // Đổi tháng / năm sau khi đã đồng bộ thì tải lại ngay: trước đây vẫn dùng giờ công tháng cũ để tính.
  useEffect(() => {
    if (hasSynced) fetchAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selMonth, selYear]);

  // Lương tháng đang xem (cùng công thức với nút "Chốt lương" trên máy chủ).
  const calcSalary = (staffId) => computeSalary({
    year: selYear, month: selMonth, staffId,
    sessions: attendance.filter(a => a.staff_id === staffId),
    config: configs[staffId] || null,
    requests: requests.filter(r => r.staff_id === staffId),
    violations: violations.filter(v => v.staff_id === staffId),
    bonuses: payrollMonth.bonuses.filter(b => b.staff_id === staffId),
    rules, reviews: reviewList,
  });
  // Trễ / quên ra ca trong tháng (theo ngày làm) → xét thưởng chuyên cần và gợi ý phạt.
  const talliesOf = staffId => monthTallies({ sessions: attendance.filter(a => a.staff_id === staffId), rules, key: `${selYear}-${fmt(selMonth)}`, autoClosed: payrollMonth.autoClosed });
  const bonusOf = staffId => bonusCheck({ year: selYear, month: selMonth, salary: calcSalary(staffId), tallies: talliesOf(staffId), departure: departureOf(staffId), settings: payrollMonth.bonusSettings });
  const approvedBonusOf = staffId => payrollMonth.bonuses.find(b => b.staff_id === staffId) || null;
  // Tháng đã chốt: hiện số đã chốt, kèm số tính lại bây giờ để thấy có gì thay đổi sau khi chốt.
  const closeOf = id => payrollMonth.closes.find(c => c.staff_id === id);
  const salaryOf = id => {
    const live = calcSalary(id), closed = closeOf(id);
    return closed ? { ...closed.snapshot, locked: true, liveNet: live.net, paid_at: closed.paid_at || null } : { ...live, locked: false };
  };
  // Kết toán riêng một người (vd. nghỉ việc giữa tháng) và đánh dấu đã trả lương.
  const closeOne = async (staffId, name) => {
    if (!confirm(`Kết toán (chốt lương) tháng ${selMonth}/${selYear} cho ${name}? Số lương lúc này sẽ được lưu lại.`)) return;
    try { await workforce('close_month', { year: selYear, month: selMonth, staff_id: staffId }); } catch (err) { return alert(err.message); }
    fetchPayrollMonth();
  };
  const markPaid = async (staffId, paid) => {
    try { await workforce('mark_paid', { year: selYear, month: selMonth, staff_id: staffId, paid }); } catch (err) { return alert(err.message); }
    fetchPayrollMonth();
  };
  // Tải bảng lương tháng đang xem ra file Excel (để in / lưu / chuyển khoản).
  const exportPayroll = async rows => {
    const XLSX = await import('xlsx');
    const head = ['Nhân viên', 'Số điện thoại', 'Lương cơ bản', 'Ngày công', 'Lương ngày công', 'Trừ về sớm', 'Giờ làm', 'Tăng ca (giờ)', 'Tiền tăng ca',
      'Thưởng chuyên cần', 'Ứng lương', 'Nghỉ có đơn (ngày)', 'Trừ nghỉ', 'Phạt', 'Thực lĩnh', 'Trạng thái', 'Nghỉ việc'];
    const data = rows.map(({ s, c }) => {
      const d = departureOf(s.id);
      return [s.full_name, s.phone, c.base, c.rule === 'days' ? c.workUnits : c.workDays, c.basePay, c.earlyAmt || 0, c.totalWorkH, c.otHours, c.otAmt,
        c.bonusAmt || 0, c.advAmt, c.absDays, c.absAmt, c.vioAmt, c.net, c.paid_at ? 'Đã trả' : c.locked ? 'Đã chốt' : 'Tạm tính',
        d ? `Làm đến ${d.last_day.split('-').reverse().join('/')}` : ''];
    });
    const sheet = XLSX.utils.aoa_to_sheet([[`Bảng lương tháng ${selMonth}/${selYear}`], [], head, ...data]);
    sheet['!cols'] = head.map((h, i) => ({ wch: i === 0 ? 22 : Math.max(10, h.length + 2) }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, `Lương ${selMonth}-${selYear}`);
    XLSX.writeFile(book, `bang-luong-${selYear}-${fmt(selMonth)}.xlsx`);
  };
  const closeMonth = async (reopen, rows = []) => {
    const label = `${selMonth}/${selYear}`;
    // Nhắc trước khi chốt những thứ sẽ nằm ngoài số chốt: ngày còn lại của tháng, giờ ngoài ca và đơn chưa duyệt.
    const lastDay = `${selYear}-${fmt(selMonth)}-${fmt(new Date(Date.UTC(selYear, selMonth, 0)).getUTCDate())}`;
    const pendingH = Math.round(rows.filter(r => !r.c.locked).reduce((a, r) => a + (r.c.pendingH || 0), 0) * 10) / 10;
    const waiting = requests.filter(r => r.status === 'pending' && r.month === selMonth && r.year === selYear).length
      + (checkin?.fixes || []).filter(f => f.status === 'pending' && attendance.some(a => a.id === f.attendance_id)).length;
    const bonusWaiting = payrollMonth.monthOver && payrollMonth.bonusSettings?.bonus_amount > 0
      ? rows.filter(r => !r.c.locked && (configs[r.s.id]?.base_salary || 0) > 0 && !approvedBonusOf(r.s.id) && bonusOf(r.s.id).eligible).length : 0;
    const notes = reopen ? [] : [
      vnToday() <= lastDay && `• Tháng ${label} chưa hết: những ngày còn lại sẽ không có trong số chốt.`,
      pendingH > 0 && `• Còn ${fmtNum(pendingH)} giờ ngoài ca chưa duyệt (chưa được tính lương).`,
      waiting > 0 && `• Còn ${waiting} đơn chờ duyệt.`,
      bonusWaiting > 0 && `• Còn ${bonusWaiting} người đủ điều kiện thưởng chuyên cần chưa duyệt.`,
      fineHints.length > 0 && `• Còn ${fineHints.length} gợi ý phạt từ chấm công chưa xử lý.`,
    ].filter(Boolean);
    const ask = reopen
      ? `Mở chốt lương tháng ${label}? Bảng sẽ tính lại theo số mới nhất cho tới khi bạn chốt lại.`
      : `Chốt lương tháng ${label}? Số lương của từng người sẽ được lưu lại; sau này có gì thay đổi, máy sẽ báo.${notes.length ? `\n\nLưu ý:\n${notes.join('\n')}` : ''}`;
    if (!confirm(ask)) return;
    let result;
    try { result = await workforce(reopen ? 'reopen_month' : 'close_month', { year: selYear, month: selMonth }); }
    catch (err) { return alert(err.message); }
    if (reopen && result?.keptPaid) alert(`Đã mở chốt. ${result.keptPaid} người đã được đánh dấu đã trả nên vẫn giữ số đã chốt; muốn tính lại người nào thì bỏ dấu "Đã trả" của người đó trước.`);
    fetchPayrollMonth();
  };

  // --- Approve / Reject request ---
  const handleDecision = async (reqId, decision, adminNote = '') => {
    try { await workforce('decide_request', { id: reqId, status: decision, admin_note: adminNote }); } catch (err) { alert(err.message); }
    fetchAll();
  };

  // --- Ghi phạt: lỗi có sẵn (điền sẵn tiền) hoặc lý do tự ghi; ngày phạt quyết định tính vào lương tháng nào ---
  const fineDateDefault = () => {
    const today = vnToday(), key = `${selYear}-${fmt(selMonth)}`;
    if (today.slice(0, 7) === key) return today;
    return today > key ? `${key}-${fmt(new Date(Date.UTC(selYear, selMonth, 0)).getUTCDate())}` : `${key}-01`;
  };
  const handleAddViolation = async () => {
    const rule = payrollMonth.fineRules.find(r => r.id === vForm.rule_id);
    const note = vForm.reason.trim();
    const reason = rule ? (note ? `${rule.name} — ${note}` : rule.name) : note;
    if (!vForm.staff_id || !vForm.amount || !reason) return alert('Chọn nhân viên, lỗi (hoặc ghi lý do) và số tiền.');
    try { await workforce('add_violation', { staff_id: vForm.staff_id, date: vForm.date || fineDateDefault(), rule_id: rule?.id || null, reason, amount: vForm.amount }); }
    catch (err) { return alert(err.message); }
    setVForm({ staff_id: '', date: '', rule_id: '', amount: '', reason: '' });
    fetchAll();
  };

  // --- Save config ---
  const handleSaveConfig = async (staffId) => {
    const edit = configEdits[staffId];
    if (!edit) return;
    try { await workforce('save_config', { staff_id: staffId, base_salary: edit.base_salary, overtime_rate: edit.overtime_rate, pay_day: edit.pay_day }); }
    catch (err) { return alert(err.message); }
    fetchAll();
    alert('Đã lưu cấu hình!');
  };

  // --- Delete violation ---
  const handleDeleteViolation = async (id, fromHint = false) => {
    if (!confirm(fromHint ? 'Xoá khoản phạt này? Gợi ý phạt sẽ hiện lại để bạn xử lý lại.' : 'Xoá khoản phạt này?')) return;
    try { await workforce('delete_violation', { id }); } catch (err) { alert(err.message); }
    fetchAll();
  };

  // --- Account management ---
  const handleCreateAccount = async () => {
    if (!accForm.full_name || !accForm.phone || !accForm.pin) return setAccMsg('Vui lòng điền đầy đủ!');
    if (accForm.pin.length < 4) return setAccMsg('PIN cần ít nhất 4 ký tự!');
    try { await workforce('create_account', { full_name: accForm.full_name, phone: accForm.phone, pin: accForm.pin, role: accForm.role }); }
    catch (err) { setAccMsg(err.message); return; }
    setAccForm({ full_name: '', phone: '', pin: '', role: 'staff' });
    setAccMsg('✅ Tạo tài khoản thành công!');
    fetchAll();
    setTimeout(() => setAccMsg(''), 3000);
  };

  const handleUpdatePin = async (staffId) => {
    const newPin = editingPin[staffId];
    if (!newPin || newPin.length < 4) return alert('PIN cần ít nhất 4 ký tự!');
    try { await workforce('set_pin', { staff_id: staffId, pin: newPin }); } catch (err) { return alert(err.message); }
    setEditingPin(p => ({ ...p, [staffId]: '' }));
    fetchAll();
    alert('Đã cập nhật PIN!');
  };

  const handleDeleteAccount = async (staffId, name) => {
    if (!confirm(`Xoá tài khoản "${name}"? Hành động này không thể hoàn tác.`)) return;
    try { await workforce('delete_account', { staff_id: staffId }); }
    catch (err) { return alert(`${err.message} Người đã có giờ công thì bấm "Cho nghỉ việc" thay vì xoá.`); }
    fetchAll();
  };

  // Nghỉ việc: qua ngày làm cuối thì không đăng nhập / chấm công được, lương tháng cuối tính tới ngày đó.
  const [departForm, setDepartForm] = useState(null); // { staff_id, name, last_day, reason }
  const departureOf = id => (checkin?.departures || []).find(d => d.staff_id === id) || null;
  // Gợi ý phạt chưa xử lý của cả quán trong tháng (người nghỉ việc trước tháng này không tính).
  const fineHints = staffList.filter(s => activeInMonth(departureOf(s.id), `${selYear}-${fmt(selMonth)}`))
    .flatMap(s => fineSuggestions({ staffId: s.id, tallies: talliesOf(s.id), reviews: payrollMonth.fineReviews, kinds: activeFineKinds(payrollMonth.fineRules) }));
  // Thưởng / phạt: gửi lên máy chủ rồi tải lại (khoản phạt đọc lại cả bảng lương).
  const payrollAction = async (action, body, confirmText) => {
    if (confirmText && !confirm(confirmText)) return false;
    try { await workforce(action, body); } catch (err) { alert(err.message); return false; }
    if (['decide_fine', 'add_violation', 'delete_violation'].includes(action)) fetchAll(); else fetchPayrollMonth();
    return true;
  };
  const handleDepart = async () => {
    if (!departForm?.last_day) return alert('Chọn ngày làm việc cuối cùng.');
    if (!confirm(`Cho ${departForm.name} nghỉ việc, làm đến hết ngày ${departForm.last_day.split('-').reverse().join('/')}?`)) return;
    try { await workforce('staff_depart', { staff_id: departForm.staff_id, last_day: departForm.last_day, reason: departForm.reason }); }
    catch (err) { return alert(err.message); }
    setDepartForm(null);
    fetchAll();
  };
  const handleReturn = async (staffId, name) => {
    if (!confirm(`Cho ${name} đi làm lại? Người này đăng nhập và chấm công lại được.`)) return;
    try { await workforce('staff_return', { staff_id: staffId }); } catch (err) { return alert(err.message); }
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
        {scanOpen && <QrClockScanner onClose={() => setScanOpen(false)} />}
        {notice && (
          <div role="status" onClick={() => setNotice(null)}
            style={{ position: 'fixed', left: 16, right: 16, bottom: 96, zIndex: 60, maxWidth: 480, margin: '0 auto', background: notice.ok ? '#15803d' : '#b91c1c', color: 'white', borderRadius: 12, padding: '12px 16px', fontSize: '0.88rem', fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.2)', textAlign: 'center' }}>
            {notice.ok ? '✅ ' : '⚠ '}{notice.text}
          </div>
        )}
        <div className="payroll-header">
          <div className="payroll-title">💰 Tính Lương của tôi</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', background: '#dbeafe', borderRadius: 20, fontSize: '0.78rem', fontWeight: 700, color: '#1d4ed8', flexShrink: 0 }}>
            <span>👤</span>
            <span>{currentUser.full_name}</span>
            <button
              onClick={logout}
              title="Đăng xuất"
              style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, padding: '2px 4px', borderRadius: 6, opacity: 0.7 }}
            >🚪</button>
          </div>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* ⏰ Chấm công hôm nay — multi-session */}
          {(() => {
            const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
            // Format duration from milliseconds → Vietnamese "X giờ Y phút Z giây"
            const fmtDurMs = (ms) => {
              if (!ms || ms < 0) return '0 giây';
              const totalSec = Math.floor(ms / 1000);
              const h   = Math.floor(totalSec / 3600);
              const m   = Math.floor((totalSec % 3600) / 60);
              const sec = totalSec % 60;
              const parts = [];
              if (h   > 0) parts.push(`${h} giờ`);
              if (m   > 0) parts.push(`${m} phút`);
              if (sec > 0 || parts.length === 0) parts.push(`${sec} giây`);
              return parts.join(' ');
            };
            const fmtDurMin = (minutes) => fmtDurMs(minutes * 60000);

            const openSession = myOpen || todaySessions.find(s => !s.clock_out);
            const isWorking   = !!openSession;
            const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
            const forgot = s => myAuto.includes(s.id);
            // Giờ tính lương theo ca của mình; giờ ngoài ca chỉ tính khi chủ cho.
            const myReviewMap = Object.fromEntries(myReviews.map(r => [r.attendance_id, r]));
            const myHours = s => sessionHours(s, myRules, myReviewMap[s.id]);
            const myExtra = s => {
              const h = myHours(s), outside = h.earlyMs + h.stayMs;
              if (!outside) return '';
              const r = myReviewMap[s.id];
              return `ngoài ca ${durationText(outside / 60000)}: ${r ? (r.status === 'approved' ? 'được tính' : 'không tính') : 'chờ chủ duyệt'}`;
            };
            const myShift = myRules && currentUser ? shiftOf(myRules, currentUser.id, vnToday()) : null;
            const pendingFix = id => myFixes.some(f => f.attendance_id === id && f.status === 'pending');
            const fixButton = s => pendingFix(s.id)
              ? <span style={{ fontSize: '0.72rem', color: '#92400e', fontWeight: 600 }}>⏳ chờ duyệt sửa giờ</span>
              : <button onClick={() => setFixForm({ attendance_id: s.id, clock_in: toLocalDT(s.clock_in), clock_out: toLocalDT(s.clock_out), reason: '' })}
                  style={{ fontSize: '0.72rem', padding: '1px 8px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}>✏️ Xin sửa giờ</button>;
            const fixFormFor = s => fixForm?.attendance_id === s.id && (
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, margin: '6px 0 8px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: '0.8rem' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>Giờ vào đúng
                  <input type="datetime-local" value={fixForm.clock_in} onChange={e => setFixForm(p => ({ ...p, clock_in: e.target.value }))} style={{ padding: '6px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 }} /></label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>Giờ ra đúng
                  <input type="datetime-local" value={fixForm.clock_out} onChange={e => setFixForm(p => ({ ...p, clock_out: e.target.value }))} style={{ padding: '6px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 }} /></label>
                <input type="text" value={fixForm.reason} placeholder="Lý do (vd: quên bấm ra ca, về lúc 23:30)" onChange={e => setFixForm(p => ({ ...p, reason: e.target.value }))} style={{ padding: '6px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={handleSubmitFix} disabled={sending === 'fix'} style={{ flex: 1, padding: 8, background: '#111827', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', opacity: sending === 'fix' ? 0.6 : 1 }}>{sending === 'fix' ? 'Đang gửi…' : 'Gửi chủ quán duyệt'}</button>
                  <button onClick={() => setFixForm(null)} style={{ padding: '8px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>Huỷ</button>
                </div>
              </div>
            );
            const closedCount = todaySessions.filter(s => s.clock_out).length;

            // Total work ms (closed sessions only)
            const totalWorkMs = todaySessions.filter(s => s.clock_out).reduce((acc, s) =>
              acc + (new Date(s.clock_out) - new Date(s.clock_in)), 0);
            const totalWorkH = Math.round((totalWorkMs / 3600000) * 10) / 10;

            // Lịch sử tháng này theo ngày làm (lượt dọn quán sau nửa đêm nằm chung ca hôm trước).
            const thisMonth = `${myMonth.y}-${fmt(myMonth.m)}`;
            const histDays = [...groupByWorkDay(myAllSessions, myRules).entries()].filter(([d]) => d.slice(0, 7) === thisMonth).sort((a, b) => b[0].localeCompare(a[0]));

            // Header status text
            const headerStatus = isWorking
              ? `🟢 Đang làm từ ${fmtTime(openSession.clock_in)}`
              : totalWorkMs > 0
                ? `✅ Đã làm ${fmtDurMs(totalWorkMs)}`
                : '⚪ Chưa bắt đầu';

            return (
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, overflow: 'hidden' }}>
                {/* Header */}
                <div style={{ background: isWorking ? '#dcfce7' : '#f1f5f9', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: '0.97rem' }}>⏰ Chấm công hôm nay</div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: isWorking ? '#15803d' : '#64748b', textAlign: 'right' }}>{headerStatus}</div>
                </div>

                <div style={{ padding: '14px 18px' }}>
                  {todaySessions.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      {todaySessions.map((s, i) => {
                        const durMs   = s.clock_out ? new Date(s.clock_out) - new Date(s.clock_in) : null;
                        const breakMs = i > 0 && todaySessions[i - 1].clock_out
                          ? new Date(s.clock_in) - new Date(todaySessions[i - 1].clock_out) : null;

                        return (
                          <React.Fragment key={s.id}>
                            {/* Break indicator */}
                            {breakMs !== null && breakMs > 0 && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0 3px 6px', fontSize: '0.73rem', color: '#94a3b8' }}>
                                <div style={{ width: 2, height: 16, background: '#e2e8f0', borderRadius: 2 }}/>
                                ☕ Ra ngoài {fmtDurMs(breakMs)}
                              </div>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: i < todaySessions.length - 1 ? '1px solid #f1f5f9' : 'none', fontSize: '0.83rem' }}>
                              <span style={{ minWidth: 36, color: '#94a3b8', fontWeight: 700, fontSize: '0.74rem' }}>Ca {i + 1}</span>
                              <div style={{ flex: 1, color: '#0f172a', fontWeight: 600 }}>
                                Vào {fmtTime(s.clock_in)}
                                {s.clock_out
                                  ? <> → Ra {fmtTime(s.clock_out)}</>
                                  : <span style={{ color: '#f59e0b', fontWeight: 700 }}> → Đang làm...</span>}
                              </div>
                              <span style={{ fontWeight: 700, color: durMs ? '#16a34a' : '#f59e0b', fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                                {durMs ? fmtDurMs(durMs) : '—'}
                              </span>
                            </div>
                          </React.Fragment>
                        );
                      })}

                      {/* Summary row */}
                      {closedCount > 0 && (() => {
                        let totalBreakMs = 0;
                        for (let i = 1; i < todaySessions.length; i++) {
                          if (todaySessions[i - 1].clock_out)
                            totalBreakMs += new Date(todaySessions[i].clock_in) - new Date(todaySessions[i - 1].clock_out);
                        }
                        // Tháng cũ: giờ quá 8 tiếng là tăng ca. Từ tháng 11 tăng ca là giờ ngoài ca chủ duyệt (hiện ở từng ca).
                        const otMs = !usesDayPay(myMonth.y, myMonth.m) && totalWorkMs > 8 * 3600000 ? totalWorkMs - 8 * 3600000 : 0;
                        return (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1.5px solid #e2e8f0', fontSize: '0.82rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#0f172a', marginBottom: 3 }}>
                              <span>⏱ Tổng giờ làm việc</span>
                              <span style={{ color: '#16a34a' }}>
                                {fmtDurMs(totalWorkMs)}
                                {otMs > 0 && <span style={{ color: '#f59e0b', fontWeight: 600 }}> (+{fmtDurMs(otMs)} tăng ca)</span>}
                              </span>
                            </div>
                            {totalBreakMs > 0 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: '0.78rem' }}>
                                <span>☕ Tổng thời gian ra ngoài</span>
                                <span>{fmtDurMs(totalBreakMs)}</span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Chấm công chỉ bằng mã QR trên máy quầy (máy chủ kiểm mã, wifi quán, điện thoại). */}
                  {isWorking && !todaySessions.some(s => s.id === openSession.id) && (
                    <div style={{ fontSize: '0.8rem', color: '#15803d', marginBottom: 8 }}>🟢 Ca bắt đầu hôm qua lúc {fmtTime(openSession.clock_in)} vẫn đang mở.</div>
                  )}
                  <button onClick={() => setScanOpen(true)}
                    style={{ width: '100%', padding: '14px', marginBottom: 10, borderRadius: 12, border: 'none', background: isWorking ? '#dc2626' : '#16a34a', color: 'white', fontWeight: 800, fontSize: '1.02rem', cursor: 'pointer' }}>
                    📷 Quét mã chấm công — {isWorking ? 'ra ca' : 'vào ca'}
                  </button>
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 14px', fontSize: '0.85rem', color: '#1e3a8a', lineHeight: 1.6 }}>
                    📶 Vào <strong>wifi quán</strong> → bấm nút trên rồi đưa camera vào mã QR trên <strong>máy quầy</strong>. Dùng app Camera của điện thoại quét cũng được.
                    {myShift && (
                      <div style={{ marginTop: 6 }}>🕑 Ca của bạn: <strong>{myShift.start} – {myShift.end}</strong> (cho lệch {hoursOn(myRules, vnToday()).grace} phút). Vào sớm / ở lại ngoài ca chỉ được tính khi chủ quán đồng ý.</div>
                    )}
                    <div style={{ fontSize: '0.76rem', color: '#64748b', marginTop: 4 }}>Quên ra ca thì máy tự tính ra ca lúc hết ca; bấm "Xin sửa giờ" để chủ quán sửa lại.</div>
                  </div>
                </div>

                {/* Monthly history (read-only) */}
                {histDays.length > 0 && (
                  <details open style={{ borderTop: '1px solid #e5e7eb' }}>
                    <summary style={{ padding: '10px 18px', fontSize: '0.82rem', fontWeight: 700, color: '#64748b', cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                      📋 Lịch sử chấm công tháng {myMonth.m} ({histDays.length} ngày)
                    </summary>
                    <div style={{ padding: '0 18px 14px' }}>
                      {histDays.map(([date, daySessions]) => {
                        const dayMs = daySessions.filter(s => s.clock_out).reduce((a, s) =>
                          a + (new Date(s.clock_out) - new Date(s.clock_in)), 0);
                        const dayCounted = daySessions.reduce((a, s) => a + myHours(s).countedMs, 0);
                        const dayWarn = flagTexts(dayFlags(daySessions, myRules));
                        return (
                          <div key={date} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: '0.79rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                              {new Date(date + 'T00:00:00').toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit' })}
                              <span style={{ marginLeft: 8, color: '#16a34a', fontWeight: 600 }}>· {dayMs === 0 && daySessions.some(s => !s.clock_out) ? 'đang làm' : fmtDurMs(dayMs)}</span>
                              {dayCounted !== dayMs && <span style={{ marginLeft: 6, color: '#0f766e', fontWeight: 600 }}>(tính lương {fmtDurMs(dayCounted)})</span>}
                              {dayWarn.length > 0 && <span style={{ marginLeft: 6, color: '#c2410c', fontWeight: 600 }}>⚠ {dayWarn.join(', ')}</span>}
                            </div>
                            {daySessions.map((s, i) => {
                              const durMs = s.clock_out ? new Date(s.clock_out) - new Date(s.clock_in) : null;
                              return (
                                <React.Fragment key={s.id}>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: '0.78rem', color: '#475569', marginLeft: 8, marginBottom: 2 }}>
                                    <span style={{ color: '#94a3b8', minWidth: 30 }}>Ca {i + 1}:</span>
                                    <span>Vào {fmtTime(s.clock_in)} → {s.clock_out ? `Ra ${fmtTime(s.clock_out)}` : '–'}</span>
                                    {durMs && <span style={{ color: '#16a34a', fontWeight: 600 }}>{fmtDurMs(durMs)}</span>}
                                    {forgot(s) && <span style={{ color: '#c2410c', fontWeight: 700 }}>⚠ quên ra ca</span>}
                                    {myExtra(s) && <span style={{ color: '#b45309' }}>⏱ {myExtra(s)}</span>}
                                    {fixButton(s)}
                                  </div>
                                  {fixFormFor(s)}
                                </React.Fragment>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}

                {myFixes.length > 0 && (
                  <div style={{ borderTop: '1px solid #e5e7eb', padding: '10px 18px 14px' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#64748b', marginBottom: 6 }}>✏️ Đơn xin sửa giờ</div>
                    {myFixes.slice(0, 8).map(f => (
                      <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.78rem', color: '#475569', padding: '3px 0' }}>
                        <span>{f.clock_in ? `Vào ${fmtTime(f.clock_in)} ` : ''}{f.clock_out ? `Ra ${fmtTime(f.clock_out)} ` : ''}— {f.reason}</span>
                        <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: f.status === 'approved' ? '#15803d' : f.status === 'rejected' ? '#dc2626' : '#92400e' }}>
                          {f.status === 'approved' ? '✅ Đã sửa' : f.status === 'rejected' ? '❌ Từ chối' : '⏳ Chờ duyệt'}
                          {f.status === 'pending' && (
                            <button onClick={() => handleCancel(f.id, 'fix')} disabled={!!sending}
                              style={{ marginLeft: 6, fontSize: '0.7rem', padding: '1px 6px', background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, color: '#64748b', cursor: 'pointer', fontWeight: 400 }}>
                              {sending === `cancel-${f.id}` ? '…' : 'Huỷ'}
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* 💰 Lương tạm tính tháng này (máy chủ tính bằng cùng công thức với bảng lương của chủ quán) */}
          {mySalary && (() => {
            const c = mySalary;
            const row = (label, value, color) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderBottom: '1px solid #f1f5f9', fontSize: '0.86rem' }}>
                <span style={{ color: '#475569' }}>{label}</span>
                <span style={{ fontWeight: 700, color: color || '#0f172a', textAlign: 'right' }}>{value}</span>
              </div>
            );
            return (
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                  <div style={{ fontWeight: 800 }}>💰 Lương tháng {c.month}/{c.year}</div>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: c.locked ? '#dcfce7' : '#fef9c3', color: c.locked ? '#15803d' : '#92400e' }}>
                    {c.paid_at ? `✅ Đã nhận lương ${ddmm(new Date(Date.parse(c.paid_at) + 7 * 3600000).toISOString().slice(0, 10))}` : c.locked ? '🔒 Đã chốt' : '⏳ Tạm tính đến hôm nay'}
                  </span>
                </div>
                {!c.base && <div style={{ fontSize: '0.8rem', color: '#b45309', marginBottom: 6 }}>Chủ quán chưa nhập lương cơ bản của bạn.</div>}
                {c.rule === 'days'
                  ? row('Ngày công', `${fmtNum(c.workUnits)} / ${c.standardDays} ngày → ${formatMoney(c.basePay)}`)
                  : <>{row('Lương cơ bản', formatMoney(c.base))}{row('Ngày công', `${c.workDays} ngày`)}</>}
                {c.earlyAmt > 0 && row(`Trừ về sớm (${c.earlyList?.length || 0} lần)`, `−${formatMoney(c.earlyAmt)}`, '#dc2626')}
                {c.earlyAmt > 0 && (
                  <div style={{ fontSize: '0.76rem', color: '#64748b', padding: '2px 0 6px', borderBottom: '1px solid #f1f5f9' }}>
                    {(c.earlyList || []).map(x => <div key={x.day}>• {ddmm(x.day)} · về sớm {durationText(x.minutes)} — −{formatMoney(x.amount)}</div>)}
                  </div>
                )}
                {row('Giờ làm', `${fmtNum(c.totalWorkH)} giờ`)}
                {row('Tăng ca', `${fmtNum(c.otHours)} giờ → +${formatMoney(c.otAmt)}`, '#15803d')}
                {c.bonusAmt > 0 && row('⭐ Thưởng chuyên cần', `+${formatMoney(c.bonusAmt)}`, '#15803d')}
                {c.pendingH > 0 && row('Ngoài ca chờ chủ duyệt', `${fmtNum(c.pendingH)} giờ (chưa tính)`, '#b45309')}
                {c.advAmt > 0 && row('Ứng lương', `−${formatMoney(c.advAmt)}`, '#dc2626')}
                {c.absDays > 0 && (c.rule === 'days'
                  ? row('Nghỉ có đơn', `${fmtNum(c.absDays)} ngày (không trừ thêm)`, '#64748b')
                  : row('Nghỉ có đơn', `−${formatMoney(c.absAmt)} (${fmtNum(c.absDays)} ngày)`, '#dc2626'))}
                {c.vioAmt > 0 && row('Phạt', `−${formatMoney(c.vioAmt)}`, '#dc2626')}
                {c.vioAmt > 0 && myFines.length > 0 && (
                  <div style={{ fontSize: '0.76rem', color: '#64748b', padding: '2px 0 6px', borderBottom: '1px solid #f1f5f9' }}>
                    {myFines.map((v, i) => <div key={i}>• {v.date ? `${ddmm(v.date)} · ` : ''}{v.reason} — {formatMoney(v.amount)}</div>)}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingTop: 10 }}>
                  <span style={{ fontWeight: 800 }}>{c.locked ? 'Thực lĩnh' : 'Thực lĩnh tạm tính'}</span>
                  <span style={{ fontWeight: 800, fontSize: '1.2rem', color: c.net >= 0 ? '#15803d' : '#dc2626' }}>{formatMoney(c.net)}</span>
                </div>
                {myBonus && !c.locked && !myBonus.approved && (
                  <div style={{ fontSize: '0.8rem', marginTop: 8, padding: '8px 10px', borderRadius: 8, background: myBonus.late || myBonus.forgot ? '#f8fafc' : '#fffbeb', color: '#475569', lineHeight: 1.5 }}>
                    {myBonus.late || myBonus.forgot
                      ? `⭐ Chuyên cần: tháng này đã ${[myBonus.late && `trễ ${myBonus.late} lần`, myBonus.forgot && `quên ra ca ${myBonus.forgot} lần`].filter(Boolean).join(', ')} nên không được xét thưởng chuyên cần.`
                      : `⭐ Chuyên cần: chưa trễ, chưa quên ra ca. Giữ tới cuối tháng và đủ ${fmtNum(myBonus.minDays)} ngày công (đang ${fmtNum(myBonus.units)}) để được chủ quán xét thưởng.`}
                  </div>
                )}
                <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
                  {c.rule === 'days'
                    ? `Lương = lương cơ bản ÷ ${c.standardDays} × số ngày đi làm (ngày làm dưới nửa ca tính nửa ngày). Về sớm từ 30 phút bị trừ lương theo giờ về sớm. Tăng ca là giờ ngoài ca chủ quán đã đồng ý.`
                    : 'Tháng này tính theo cách cũ: đủ lương cơ bản, tăng ca là giờ làm quá 8 tiếng mỗi ngày.'}
                  {!c.locked && ' Số còn thay đổi tới khi chủ quán chốt lương cuối tháng.'}
                </div>
              </div>
            );
          })()}

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
                <button onClick={handleSubmitAdvance} disabled={sending === 'adv'} style={{ background: '#16a34a', color: 'white', border: 'none', borderRadius: 9, padding: '11px', fontWeight: 800, cursor: 'pointer', opacity: sending === 'adv' ? 0.6 : 1 }}>
                  {sending === 'adv' ? 'Đang gửi…' : 'Gửi yêu cầu'}
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
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <label style={{ flex: 1, minWidth: 130, display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.8rem', color: '#475569' }}>Nghỉ từ ngày
                    <input type="date" value={absForm.from} onChange={e => setAbsForm(p => ({ ...p, from: e.target.value, to: p.to && p.to >= e.target.value ? p.to : e.target.value }))}
                      style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem' }} /></label>
                  <label style={{ flex: 1, minWidth: 130, display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.8rem', color: '#475569' }}>Đến ngày
                    <input type="date" value={absForm.to} min={absForm.from || undefined} onChange={e => setAbsForm(p => ({ ...p, to: e.target.value }))}
                      style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem' }} /></label>
                </div>
                <textarea placeholder="Lý do nghỉ..." value={absForm.reason} onChange={e => setAbsForm(p => ({ ...p, reason: e.target.value }))}
                  style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem', minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} />
                <button onClick={handleSubmitAbsent} disabled={sending === 'abs'} style={{ background: '#f59e0b', color: 'white', border: 'none', borderRadius: 9, padding: '11px', fontWeight: 800, cursor: 'pointer', opacity: sending === 'abs' ? 0.6 : 1 }}>
                  {sending === 'abs' ? 'Đang gửi…' : 'Gửi báo nghỉ'}
                </button>
              </div>
            )}
          </div>

          {/* Lịch sử yêu cầu tháng này */}
          {empReqs.length > 0 && (
            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>📄 Yêu cầu gần đây</div>
              {empReqs.map(r => (
                <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
                      {r.request_type === 'advance' ? `💵 Ứng ${Number(r.amount || 0).toLocaleString('vi-VN')}đ` : `🏖 Nghỉ ${r.days} ngày${leaveText(myLeaveDays.find(l => l.request_id === r.id))}`}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 2 }}>{r.reason}</div>
                    {r.admin_note && <div style={{ fontSize: '0.73rem', color: '#9ca3af', marginTop: 2 }}>💬 {r.admin_note}</div>}
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <span style={{ padding: '2px 8px', borderRadius: 5, fontSize: '0.72rem', fontWeight: 700,
                      background: r.status === 'approved' ? '#dcfce7' : r.status === 'rejected' ? '#fee2e2' : '#fef9c3',
                      color: r.status === 'approved' ? '#15803d' : r.status === 'rejected' ? '#dc2626' : '#92400e' }}>
                      {r.status === 'pending' ? '⏳ Chờ duyệt' : r.status === 'approved' ? '✅ Đã duyệt' : '❌ Từ chối'}
                    </span>
                    {r.status === 'pending' && (
                      <button onClick={() => handleCancel(r.id)} disabled={!!sending}
                        style={{ fontSize: '0.72rem', padding: '2px 8px', background: 'none', border: '1px solid #e2e8f0', borderRadius: 6, color: '#64748b', cursor: 'pointer' }}>
                        {sending === `cancel-${r.id}` ? 'Đang huỷ…' : 'Huỷ đơn'}
                      </button>
                    )}
                  </div>
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
        {currentUser && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {currentUser.role === 'admin' && (
              <button
                onClick={fetchAll}
                disabled={loading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: loading ? '#94a3b8' : '#3b82f6', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.82rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer', boxShadow: '0 2px 6px rgba(59, 130, 246, 0.25)' }}
              >
                <RefreshCw size={15} />
                {loading ? 'Đang đồng bộ...' : 'Đồng bộ'}
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', background: currentUser.role === 'admin' ? '#fef3c7' : '#dbeafe', borderRadius: 20, fontSize: '0.78rem', fontWeight: 700, color: currentUser.role === 'admin' ? '#92400e' : '#1d4ed8', flexShrink: 0 }}>
              <span>{currentUser.role === 'admin' ? '👑' : '👤'}</span>
              <span>{currentUser.full_name}</span>
              <span style={{ fontWeight: 400, opacity: 0.7 }}>· {currentUser.role === 'admin' ? 'Admin' : 'Nhân viên'}</span>
              <button
                onClick={logout}
                title="Đăng xuất"
                style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, padding: '2px 4px', borderRadius: 6, opacity: 0.6 }}
              >🚪</button>
            </div>
          </div>
        )}
      </div>

      {lastSyncedAt && (
        <div style={{ fontSize: '0.82rem', color: '#64748b', margin: '-6px 0 10px', textAlign: 'right' }}>
          Đã đồng bộ lúc {lastSyncedAt.toLocaleTimeString('vi-VN')}.
        </div>
      )}

      {/* Tabs */}
      <div className="payroll-tabs">
        {[
          { key: 'salary', label: '📊 Bảng Lương' },
          { key: 'requests', label: '📋 Yêu cầu', badge: pendingCount + (checkin?.fixes || []).filter(f => f.status === 'pending').length + (checkin?.extras || []).length },
          { key: 'violations', label: '⚠️ Vi phạm', badge: fineHints.length },
          { key: 'attendance', label: '⏰ Chấm công' },
          { key: 'qr', label: '📱 Cài chấm công' },
          { key: 'accounts', label: '👤 Tài khoản' },
          { key: 'config', label: '⚙️ Cấu hình' },
        ].map(tab => (
          <button key={tab.key} className={`payroll-tab ${activeTab === tab.key ? 'active' : ''}`} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
            {tab.badge > 0 && <span className="badge">{tab.badge}</span>}
          </button>
        ))}
      </div>

      {loading ? <div className="empty-state">Đang tải...</div> : !hasSynced ? (
        <div className="empty-state">
          <p>Bấm Đồng bộ để tải dữ liệu tính lương từ Supabase.</p>
          <p className="text-sm text-muted">Trang sẽ không tự tải dữ liệu admin cho tới khi bạn bấm đồng bộ.</p>
          {currentUser?.role === 'admin' && (
            <button
              onClick={fetchAll}
              disabled={loading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, padding: '9px 16px', background: loading ? '#94a3b8' : '#3b82f6', color: 'white', border: 'none', borderRadius: 10, fontSize: '0.86rem', fontWeight: 700, cursor: loading ? 'wait' : 'pointer', boxShadow: '0 2px 6px rgba(59, 130, 246, 0.25)' }}
            >
              <RefreshCw size={15} />
              {loading ? 'Đang đồng bộ...' : 'Đồng bộ ngay'}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* === BẢNG LƯƠNG === */}
          {activeTab === 'salary' && (() => {
            const isAdmin = currentUser?.role === 'admin';
            const dayPay = usesDayPay(selYear, selMonth);
            const today = vnToday(), thisMonth = `${selYear}-${fmt(selMonth)}`;
            const running = today.slice(0, 7) === thisMonth;
            // Người nghỉ việc trước tháng này không hiện; nghỉ trong tháng thì vẫn hiện để kết toán.
            const activeStaff = staffList.filter(s => activeInMonth(departureOf(s.id), thisMonth));
            const filtered = activeStaff.filter(s => !salarySearch || s.full_name === salarySearch);
            const rows = activeStaff.map(s => ({ s, c: salaryOf(s.id) }));
            const withData = rows.filter(({ c }) => c.locked || c.base || c.totalWorkH || c.advAmt || c.vioAmt || c.absDays);
            const closedCount = withData.filter(r => r.c.locked).length, fullyClosed = withData.length > 0 && closedCount === withData.length;
            const closes = payrollMonth.closes, closedAt = closes[0]?.closed_at, closedBy = closes[0]?.closed_by;
            const changed = rows.filter(x => x.c.locked && x.c.liveNet !== x.c.net);
            const leftThisMonth = s => { const d = departureOf(s.id); return d && d.last_day.slice(0, 7) === thisMonth ? d : null; };
            // Ngày công: "24 / 26" (theo ngày công) hoặc "24 ngày" (cách cũ).
            const daysText = c => (c.rule === 'days' ? `${fmtNum(c.workUnits)} / ${c.standardDays || STANDARD_DAYS} ngày` : `${c.workDays} ngày`);
            return (
              <div>
                {/* Filter bar */}
                <div className="filter-bar">
                  <select value={salarySearch} onChange={e => setSalarySearch(e.target.value)}>
                    <option value="">👥 Tất cả nhân viên</option>
                    {staffList.map(s => <option key={s.id} value={s.full_name}>{s.full_name}</option>)}
                  </select>
                  <select value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
                    {months.map(m => <option key={m} value={m}>Tháng {m}</option>)}
                  </select>
                  <select value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
                    {years.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>

                {/* Cách tính + chốt lương tháng */}
                <div style={{ background: closes.length ? '#f0fdf4' : 'white', border: `1px solid ${closes.length ? '#bbf7d0' : '#e5e7eb'}`, borderRadius: 12, padding: '12px 14px', margin: '0 0 12px', fontSize: '0.84rem', color: '#334155', lineHeight: 1.6 }}>
                  <div>
                    {dayPay
                      ? <>📐 <strong>Tính theo ngày công:</strong> lương cơ bản ÷ {STANDARD_DAYS} × số ngày đi làm (làm dư thì cộng thêm, ngày làm dưới nửa ca tính nửa ngày). Về sớm từ 30 phút: trừ lương theo giờ về sớm (lương ngày ÷ số giờ của ca). Tăng ca = giờ ngoài ca bạn đã bấm "Cho tính". Đơn báo nghỉ không trừ thêm.</>
                      : <>📐 Tháng này tính theo cách cũ: đủ lương cơ bản, tăng ca = giờ quá 8 tiếng/ngày, trừ ngày nghỉ có đơn.</>}
                  </div>
                  {isAdmin && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                      {fullyClosed
                        ? <span>🔒 <strong>Đã chốt lương tháng {selMonth}/{selYear}</strong> lúc {new Date(closedAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}{closedBy ? ` (${closedBy})` : ''}</span>
                        : closedCount > 0
                          ? <span>🔒 Đã chốt {closedCount}/{withData.length} người, còn lại chưa chốt.</span>
                          : <span>{running ? '⏳ Tháng đang chạy: số dưới đây là tạm tính đến hôm nay.' : 'Tháng này chưa chốt lương.'}</span>}
                      {!fullyClosed && <button className="btn-primary" style={{ marginTop: 0 }} onClick={() => closeMonth(false, rows)}>🔒 Chốt lương tháng {selMonth}/{selYear}{closedCount > 0 ? ' (người còn lại)' : ''}</button>}
                      {closes.length > 0 && <button className="btn-danger" style={{ marginTop: 0 }} onClick={() => closeMonth(true)}>Mở chốt{fullyClosed ? '' : ' tất cả'}</button>}
                      <button style={{ padding: '6px 12px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}
                        onClick={() => exportPayroll(rows)}>⬇️ Tải bảng lương (Excel)</button>
                    </div>
                  )}
                  {isAdmin && fullyClosed && (
                    <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#475569' }}>
                      Đã trả lương: {withData.filter(r => r.c.paid_at).length}/{withData.length} người. Trả xong người nào thì bấm "Đánh dấu đã trả" ở người đó.
                    </div>
                  )}
                  {changed.length > 0 && (
                    <div style={{ marginTop: 8, color: '#b45309' }}>
                      ⚠ Có số thay đổi sau khi chốt: {changed.map(x => `${x.s.full_name} (đã chốt ${formatMoney(x.c.net)}, nay tính ra ${formatMoney(x.c.liveNet)})`).join('; ')}. Muốn lấy số mới thì bấm Mở chốt rồi chốt lại.
                    </div>
                  )}
                </div>

                {isAdmin && dayPay && (
                  <BonusBox year={selYear} month={selMonth} settings={payrollMonth.bonusSettings} monthOver={payrollMonth.monthOver} onAction={payrollAction}
                    people={activeStaff.filter(s => (configs[s.id]?.base_salary || 0) > 0).map(s => ({ s, c: calcSalary(s.id), check: bonusOf(s.id), approved: approvedBonusOf(s.id) }))} />
                )}

                {/* Mobile cards */}
                <div className="mobile-cards">
                  {filtered.length === 0 && <div className="empty-state">Chưa có nhân viên</div>}
                  {filtered.map(s => {
                    const c = salaryOf(s.id);
                    return (
                      <div key={s.id} className="salary-card">
                        <div className="salary-card-header">
                          <div>
                            <div className="salary-card-name">{c.locked ? '🔒 ' : ''}{s.full_name}</div>
                            <div className="salary-card-phone">{s.phone}</div>
                          </div>
                          <div className={`salary-card-net ${c.net < 0 ? 'negative' : ''}`}>{formatMoney(c.net)}</div>
                        </div>
                        <div className="salary-card-body">
                          <div className="salary-card-row">
                            <span className="salary-card-label">Lương cơ bản</span>
                            <span className="salary-card-value">{formatMoney(c.base)}</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">Ngày công</span>
                            <span className="salary-card-value">{daysText(c)}{c.rule === 'days' && <> → {formatMoney(c.basePay)}</>}</span>
                          </div>
                          {c.earlyAmt > 0 && (
                            <div className="salary-card-row">
                              <span className="salary-card-label">Trừ về sớm ({c.earlyList?.length || 0} lần)</span>
                              <span className="salary-card-value red">−{formatMoney(c.earlyAmt)}</span>
                            </div>
                          )}
                          <div className="salary-card-row">
                            <span className="salary-card-label">Tổng giờ làm</span>
                            <span className="salary-card-value">{fmtNum(c.totalWorkH)} giờ</span>
                          </div>
                          {c.pendingH > 0 && (
                            <div className="salary-card-row">
                              <span className="salary-card-label">Ngoài ca chờ duyệt</span>
                              <span className="salary-card-value" style={{ color: '#b45309' }}>{fmtNum(c.pendingH)} giờ (chưa tính)</span>
                            </div>
                          )}
                          <div className="salary-card-row">
                            <span className="salary-card-label">Tăng ca</span>
                            <span className="salary-card-value green">+{formatMoney(c.otAmt)} <small style={{fontWeight:400,color:'#94a3b8'}}>({fmtNum(c.otHours)} giờ)</small></span>
                          </div>
                          {c.bonusAmt > 0 && (
                            <div className="salary-card-row">
                              <span className="salary-card-label">Thưởng chuyên cần</span>
                              <span className="salary-card-value green">+{formatMoney(c.bonusAmt)}</span>
                            </div>
                          )}
                          <div className="salary-card-row">
                            <span className="salary-card-label">Ứng lương</span>
                            <span className="salary-card-value red">-{formatMoney(c.advAmt)}</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">Nghỉ</span>
                            {c.rule === 'days'
                              ? <span className="salary-card-value muted">{c.absDays ? `${fmtNum(c.absDays)} ngày có đơn (không trừ thêm)` : '—'}</span>
                              : <span className="salary-card-value red">-{formatMoney(c.absAmt)} <small style={{fontWeight:400,color:'#94a3b8'}}>({fmtNum(c.absDays)} ngày)</small></span>}
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">Vi phạm</span>
                            <span className={`salary-card-value ${c.vioAmt > 0 ? 'red' : 'muted'}`}>{c.vioAmt > 0 ? `-${formatMoney(c.vioAmt)}` : '—'}</span>
                          </div>
                          <div className="salary-card-row">
                            <span className="salary-card-label">{c.locked ? 'Thực lĩnh (đã chốt)' : running ? 'Thực lĩnh (tạm tính)' : 'Thực lĩnh'}</span>
                            <span className={`salary-card-value ${c.net >= 0 ? 'green' : 'red'}`}>{formatMoney(c.net)}</span>
                          </div>
                          {c.locked && c.liveNet !== c.net && (
                            <div className="salary-card-row">
                              <span className="salary-card-label" style={{ color: '#b45309' }}>Nay tính ra</span>
                              <span className="salary-card-value" style={{ color: '#b45309' }}>{formatMoney(c.liveNet)}</span>
                            </div>
                          )}
                        </div>
                        {isAdmin && <PayActions s={s} c={c} left={leftThisMonth(s)} onClose={closeOne} onPaid={markPaid} />}
                        {isAdmin && (
                          <button
                            onClick={() => setExpandedSalaryStaff(expandedSalaryStaff === s.id ? null : s.id)}
                            style={{ width: '100%', marginTop: 4, padding: '7px', background: expandedSalaryStaff === s.id ? '#dbeafe' : '#f8fafc', border: '1px solid #e2e8f0', borderBottomLeftRadius: 12, borderBottomRightRadius: 12, fontSize: '0.8rem', fontWeight: 700, color: '#1d4ed8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                            {expandedSalaryStaff === s.id ? '▴ Ẩn chấm công' : '✏️ Sửa chấm công'}
                          </button>
                        )}
                        {/* Inline attendance panel for mobile */}
                        {isAdmin && expandedSalaryStaff === s.id && (() => {
                          const staffAtts = attendance.filter(a => a.staff_id === s.id);
                          const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
                          return (
                            <div style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', borderRadius: '0 0 12px 12px', padding: '10px 14px' }}>
                              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#64748b', marginBottom: 8 }}>Chấm công tháng {selMonth}/{selYear}</div>
                              {staffAtts.length === 0 && <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Chưa có bản ghi chấm công</div>}
                              {staffAtts.map(a => {
                                const isEd = editingAtt?.id === a.id;
                                const tIn  = a.clock_in  ? new Date(a.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—';
                                const tOut = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'Chưa ra';
                                return (
                                  <div key={a.id} style={{ background: isEd ? '#eff6ff' : 'white', border: `1.5px solid ${isEd ? '#3b82f6' : '#e2e8f0'}`, borderRadius: 8, padding: '8px 10px', marginBottom: 6 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isEd ? 8 : 0 }}>
                                      <span style={{ fontSize: '0.8rem', fontWeight: 700 }}>{dateLabel(a)}</span>
                                       <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{tIn} → {tOut} · {a.clock_out ? `${Math.round(((new Date(a.clock_out) - new Date(a.clock_in)) / 3600000) * 10) / 10}h` : '0h'}</span>
                                      {!isEd
                                        ? <button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })} style={{ fontSize: '0.72rem', padding: '2px 8px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 5, cursor: 'pointer' }}>✏️ Sửa</button>
                                        : <button onClick={() => setEditingAtt(null)} style={{ fontSize: '0.72rem', padding: '2px 8px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 5, cursor: 'pointer', color: '#dc2626' }}>✕ Huỷ</button>
                                      }
                                    </div>
                                    {!isEd && [...rowFlags(a), extraText(a)].some(Boolean) && (
                                      <div style={{ fontSize: '0.72rem', color: '#c2410c', marginTop: 3 }}>⚠ {[...rowFlags(a), extraText(a)].filter(Boolean).join(' · ')}</div>
                                    )}
                                    {isEd && (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        {[{label:'Giờ vào',key:'clock_in',type:'datetime-local'},{label:'Giờ ra',key:'clock_out',type:'datetime-local'}].map(({label,key,type})=>(
                                          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ width: 65, fontSize: '0.76rem', fontWeight: 600, color: '#475569', flexShrink: 0 }}>{label}</span>
                                            <input type={type} value={editingAtt[key]||''} onChange={e=>setEditingAtt(p=>({...p,[key]:e.target.value}))} style={{ flex:1, padding:'4px 7px', border:'1.5px solid #cbd5e1', borderRadius:6, fontSize:'0.8rem' }}/>
                                          </div>
                                        ))}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          <span style={{ width: 65, fontSize: '0.76rem', fontWeight: 600, color: '#475569', flexShrink: 0 }}>Ghi chú</span>
                                          <input type="text" value={editingAtt.note||''} placeholder="Lý do sửa..." onChange={e=>setEditingAtt(p=>({...p,note:e.target.value}))} style={{ flex:1, padding:'4px 7px', border:'1.5px solid #cbd5e1', borderRadius:6, fontSize:'0.8rem' }}/>
                                        </div>
                                        <button onClick={handleSaveAttEdit} style={{ padding:'7px', background:'#0f172a', color:'white', border:'none', borderRadius:7, fontWeight:700, fontSize:'0.82rem', cursor:'pointer' }}>💾 Lưu thay đổi</button>
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
                      <th>Nhân viên</th><th>Lương CB</th><th>Ngày công</th><th>Giờ làm</th>
                      <th>Tăng ca</th><th>Thưởng</th><th>Ứng lương</th><th>Nghỉ</th><th>Vi phạm</th>
                      <th style={{color:'#16a34a'}}>Thực lĩnh</th>
                      {isAdmin && <th></th>}
                    </tr></thead>
                    <tbody>
                      {filtered.map(s => {
                        const c = salaryOf(s.id);
                        return (
                          <React.Fragment key={s.id}>
                            <tr>
                            <td><div style={{fontWeight:700}}>{c.locked ? '🔒 ' : ''}{s.full_name}</div><div style={{fontSize:'0.73rem',color:'#94a3b8'}}>{s.phone}</div></td>
                            <td>{formatMoney(c.base)}</td>
                            <td>{daysText(c)}{c.rule === 'days' && <div style={{fontSize:'0.72rem',color:'#94a3b8'}}>= {formatMoney(c.basePay)}</div>}
                              {c.earlyAmt > 0 && <div style={{fontSize:'0.72rem',color:'#ef4444'}}>−{formatMoney(c.earlyAmt)} về sớm ({c.earlyList?.length || 0} lần)</div>}</td>
                            <td>{fmtNum(c.totalWorkH)} giờ{c.pendingH > 0 && <div style={{ fontSize: '0.72rem', color: '#b45309' }}>+{fmtNum(c.pendingH)} giờ ngoài ca chờ duyệt</div>}</td>
                            <td><span style={{color:'#16a34a'}}>+{formatMoney(c.otAmt)}</span><div style={{fontSize:'0.72rem',color:'#94a3b8'}}>{fmtNum(c.otHours)} giờ</div></td>
                            <td>{c.bonusAmt > 0 ? <span style={{color:'#16a34a'}}>+{formatMoney(c.bonusAmt)}</span> : <span style={{color:'#94a3b8'}}>—</span>}</td>
                            <td><span style={{color:'#ef4444'}}>-{formatMoney(c.advAmt)}</span></td>
                            <td>{c.rule === 'days'
                              ? <span style={{color:'#94a3b8'}}>{c.absDays ? `${fmtNum(c.absDays)} ngày (không trừ)` : '—'}</span>
                              : <><span style={{color:'#ef4444'}}>-{formatMoney(c.absAmt)}</span><div style={{fontSize:'0.72rem',color:'#94a3b8'}}>{fmtNum(c.absDays)} ngày</div></>}</td>
                            <td>{c.vioAmt > 0 ? <span style={{color:'#ef4444'}}>-{formatMoney(c.vioAmt)}</span> : <span style={{color:'#94a3b8'}}>—</span>}</td>
                            <td>
                              <strong style={{color: c.net >= 0 ? '#16a34a' : '#ef4444', fontSize:'0.95rem'}}>{formatMoney(c.net)}</strong>
                              {c.locked && c.liveNet !== c.net && <div style={{ fontSize: '0.72rem', color: '#b45309' }}>nay tính ra {formatMoney(c.liveNet)}</div>}
                              {!c.locked && running && <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>tạm tính</div>}
                            </td>
                            {isAdmin && <td><button onClick={() => setExpandedSalaryStaff(expandedSalaryStaff === s.id ? null : s.id)}
                              style={{ fontSize: '0.75rem', padding: '3px 10px', background: expandedSalaryStaff === s.id ? '#dbeafe' : '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', color: '#1d4ed8', whiteSpace: 'nowrap' }}>{expandedSalaryStaff === s.id ? '▴ Ẩn' : '✏️ Sửa'}</button>
                              <PayActions s={s} c={c} left={leftThisMonth(s)} onClose={closeOne} onPaid={markPaid} compact /></td>}
                          </tr>
                          {/* Inline attendance sub-panel for desktop */}
                          {isAdmin && expandedSalaryStaff === s.id && (() => {
                            const staffAtts = attendance.filter(a => a.staff_id === s.id);
                            const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
                            return (
                              <tr><td colSpan="11" style={{ padding: 0, background: '#f8fafc', borderBottom: '2px solid #3b82f6' }}>
                                <div style={{ padding: '12px 16px' }}>
                                  <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#64748b', marginBottom: 8 }}>Chấm công tháng {selMonth}/{selYear} — {s.full_name}</div>
                                  {staffAtts.length === 0 && <div style={{ color: '#94a3b8', fontSize: '0.82rem' }}>Chưa có bản ghi chấm công</div>}
                                  {staffAtts.map(a => {
                                    const isEd = editingAtt?.id === a.id;
                                    const tIn  = a.clock_in  ? new Date(a.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—';
                                    const tOut = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'Chưa ra';
                                    return (
                                      <div key={a.id} style={{ background: isEd ? '#eff6ff' : 'white', border: `1px solid ${isEd ? '#3b82f6' : '#e2e8f0'}`, borderRadius: 8, padding: '8px 12px', marginBottom: 6 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                          <span style={{ fontWeight: 700, fontSize: '0.82rem', minWidth: 90 }}>{dateLabel(a)}</span>
                                          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{tIn} → {tOut}</span>
                                          <span style={{ fontSize: '0.8rem', color: '#16a34a', fontWeight: 600 }}>{a.clock_out ? `${Math.round(((new Date(a.clock_out) - new Date(a.clock_in)) / 3600000) * 10) / 10}h làm` : 'Đang làm...'}</span>

                                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                            {!isEd
                                              ? <button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })} style={{ fontSize: '0.75rem', padding: '3px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}>✏️ Sửa</button>
                                              : <button onClick={() => setEditingAtt(null)} style={{ fontSize: '0.75rem', padding: '3px 10px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', color: '#dc2626' }}>✕ Huỷ</button>
                                            }
                                          </div>
                                        </div>
                                        {!isEd && [...rowFlags(a), extraText(a)].some(Boolean) && (
                                          <div style={{ fontSize: '0.75rem', color: '#c2410c', marginTop: 4 }}>⚠ {[...rowFlags(a), extraText(a)].filter(Boolean).join(' · ')}</div>
                                        )}
                                        {isEd && (
                                          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                                            {[{label:'Giờ vào',key:'clock_in',type:'datetime-local'},{label:'Giờ ra',key:'clock_out',type:'datetime-local'}].map(({label,key,type})=>(
                                              <label key={key} style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                                {label}<input type={type} value={editingAtt[key]||''} onChange={e=>setEditingAtt(p=>({...p,[key]:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.8rem'}}/>
                                              </label>
                                            ))}

                                            <label style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                              Ghi chú<input type="text" value={editingAtt.note||''} placeholder="Lý do sửa..." onChange={e=>setEditingAtt(p=>({...p,note:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.8rem'}}/>
                                            </label>
                                            <div style={{display:'flex',gap:6,alignItems:'flex-end'}}>
                                              <button onClick={handleSaveAttEdit} style={{padding:'5px 16px',background:'#0f172a',color:'white',border:'none',borderRadius:7,fontWeight:700,fontSize:'0.8rem',cursor:'pointer'}}>💾 Lưu</button>
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
                      {filtered.length === 0 && <tr><td colSpan={isAdmin ? '10' : '9'} style={{textAlign:'center',color:'#94a3b8',padding:24}}>Chưa có nhân viên</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* === YÊU CẦU === */}
          {activeTab === 'requests' && (
            <div className="request-list">
              {/* Giờ ngoài ca (vào sớm / ở lại) chưa tính lương, chờ chủ cho tính hoặc không. */}
              {(checkin?.extras || []).map(x => {
                const t = ts => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                return (
                  <div key={x.attendance_id} className="request-card pending">
                    <div className="request-info">
                      <div className="name">{staffList.find(s => s.id === x.staff_id)?.full_name || 'Không rõ'}</div>
                      <div style={{ marginTop: 4 }}>
                        <span style={{ display: 'inline-block', background: '#ffedd5', color: '#9a3412', borderRadius: 5, padding: '2px 8px', fontSize: '0.78rem', fontWeight: 600, marginRight: 8 }}>⏱ Giờ ngoài ca</span>
                        <span className="status-badge pending">⏳ Chờ duyệt</span>
                      </div>
                      <div className="meta" style={{ marginTop: 4, lineHeight: 1.6 }}>
                        <div>Ca ngày {x.date.split('-').reverse().join('/')}: vào {t(x.clock_in)}{x.early_minutes ? ` (sớm ${durationText(x.early_minutes)})` : ''} → ra {t(x.clock_out)}{x.stay_minutes ? ` (ở lại ${durationText(x.stay_minutes)})` : ''}</div>
                        <div>Chưa tính lương: <strong>{durationText(x.early_minutes + x.stay_minutes)}</strong></div>
                      </div>
                    </div>
                    <div className="request-actions">
                      <button className="btn-success" onClick={() => checkinAction('decide_extra', { attendance_id: x.attendance_id, status: 'approved' })}>✓ Cho tính</button>
                      <button className="btn-danger" onClick={() => checkinAction('decide_extra', { attendance_id: x.attendance_id, status: 'rejected' })}>✗ Không tính</button>
                    </div>
                  </div>
                );
              })}

              {/* Đơn xin sửa giờ chấm công (duyệt thì giờ được sửa và ghi vào nhật ký sửa). */}
              {(checkin?.fixes || []).map(f => {
                const att = (checkin.fixSessions || []).find(s => s.id === f.attendance_id);
                const t = ts => ts ? new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
                return (
                  <div key={f.id} className={`request-card ${f.status}`}>
                    <div className="request-info">
                      <div className="name">{staffList.find(s => s.id === f.staff_id)?.full_name || 'Không rõ'}</div>
                      <div style={{ marginTop: 4 }}>
                        <span style={{ display: 'inline-block', background: '#ede9fe', color: '#5b21b6', borderRadius: 5, padding: '2px 8px', fontSize: '0.78rem', fontWeight: 600, marginRight: 8 }}>✏️ Xin sửa giờ</span>
                        <span className={`status-badge ${f.status}`}>{f.status === 'pending' ? '⏳ Chờ duyệt' : f.status === 'approved' ? '✅ Đã sửa' : '❌ Từ chối'}</span>
                      </div>
                      <div className="meta" style={{ marginTop: 4, lineHeight: 1.6 }}>
                        {att && <div>Đang ghi: vào {t(att.clock_in)} → ra {att.clock_out ? t(att.clock_out) : 'chưa ra'}{(checkin.autoClosed || []).includes(att.id) ? ' (máy tự đóng vì quên ra ca)' : ''}</div>}
                        <div>Xin sửa: {f.clock_in ? `vào ${t(f.clock_in)} ` : ''}{f.clock_out ? `ra ${t(f.clock_out)}` : ''}</div>
                        <div>Lý do: {f.reason}</div>
                      </div>
                      {f.admin_note && <div style={{ fontSize: '0.78rem', color: '#6b7280', marginTop: 4 }}>💬 {f.admin_note}</div>}
                    </div>
                    {f.status === 'pending' && (
                      <div className="request-actions">
                        <button className="btn-success" onClick={() => checkinAction('decide_fix', { id: f.id, status: 'approved' })}>✓ Duyệt</button>
                        <button className="btn-danger" onClick={() => { const note = prompt('Lý do từ chối (tuỳ chọn):') || ''; checkinAction('decide_fix', { id: f.id, status: 'rejected', admin_note: note }); }}>✗ Từ chối</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {requests.length === 0 && !(checkin?.fixes || []).length && !(checkin?.extras || []).length && <div className="empty-state">Không có yêu cầu nào</div>}
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
                        {req.request_type === 'absent' && <span>🗓 Nghỉ: <strong>{fmtNum(req.days)} ngày</strong>{leaveText(payrollMonth.leaveDays.find(l => l.request_id === req.id))} — </span>}
                        Tháng {req.month}/{req.year} • {req.reason}
                      </div>
                      {/* Duyệt ứng lương: xem người này đã làm ra bao nhiêu và đã ứng bao nhiêu trong tháng. */}
                      {req.request_type === 'advance' && req.status === 'pending' && req.month === selMonth && req.year === selYear && (() => {
                        const c = calcSalary(req.staff_id);
                        // Cách cũ (tháng trước 11/2026) trả đủ lương cơ bản nên chỉ đếm ngày đi làm, không tính "đã làm ra".
                        if (c.rule !== 'days') return <div style={{ fontSize: '0.78rem', marginTop: 4, color: '#475569' }}>Tháng này đã đi làm {c.workDays} ngày · đã ứng {formatMoney(c.advAmt)}</div>;
                        const earned = c.basePay + c.otAmt, over = c.advAmt + Number(req.amount || 0) > earned;
                        return (
                          <div style={{ fontSize: '0.78rem', marginTop: 4, color: over ? '#b91c1c' : '#475569' }}>
                            Tháng này đã làm ra {formatMoney(earned)} · đã ứng {formatMoney(c.advAmt)}{over ? ' · ⚠ duyệt đơn này thì ứng quá số đã làm' : ''}
                          </div>
                        );
                      })()}
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
          {activeTab === 'violations' && (() => {
            const nameOf = id => staffList.find(s => s.id === id)?.full_name || 'Không rõ';
            const metaOf = id => payrollMonth.violationMeta.find(m => m.violation_id === id) || null;
            const activeRules = payrollMonth.fineRules.filter(r => r.active);
            const fineDate = vForm.date || fineDateDefault();
            const otherMonth = fineDate.slice(0, 7) !== `${selYear}-${fmt(selMonth)}`;
            // Mới nhất lên đầu; khoản cũ chưa có ngày nằm cuối.
            const list = violations.map(v => ({ v, m: metaOf(v.id) })).sort((a, b) => String(b.m?.fine_date || '').localeCompare(String(a.m?.fine_date || '')));
            const total = violations.reduce((a, v) => a + Number(v.amount || 0), 0);
            return (
              <div>
                <div className="filter-bar">
                  <select value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
                    {months.map(m => <option key={m} value={m}>Tháng {m}</option>)}
                  </select>
                  <select value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
                    {years.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>

                <FineHints hints={fineHints} nameOf={nameOf} rules={payrollMonth.fineRules} reviews={payrollMonth.fineReviews} onAction={payrollAction} />

                <div className="payroll-form">
                  <h3>➕ Ghi phạt</h3>
                  <div className="form-grid">
                    <div className="form-group">
                      <label>Nhân viên</label>
                      <select value={vForm.staff_id} onChange={e => setVForm(p => ({ ...p, staff_id: e.target.value }))}>
                        <option value="">-- Chọn NV --</option>
                        {staffList.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Ngày</label>
                      <input type="date" value={fineDate} onChange={e => setVForm(p => ({ ...p, date: e.target.value }))} />
                    </div>
                    <div className="form-group">
                      <label>Lỗi</label>
                      <select value={vForm.rule_id} onChange={e => { const r = activeRules.find(x => x.id === e.target.value); setVForm(p => ({ ...p, rule_id: e.target.value, amount: r?.amount ? shownMoney(r.amount) : p.amount })); }}>
                        <option value="">Lỗi khác (tự ghi lý do)</option>
                        {activeRules.map(r => <option key={r.id} value={r.id}>{r.name}{r.amount ? ` — ${formatMoney(r.amount)}` : ''}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Số tiền phạt (đ)</label>
                      <input type="text" inputMode="numeric" placeholder="50.000" value={vForm.amount} onChange={e => setVForm(p => ({ ...p, amount: typedMoney(e.target.value) }))} />
                    </div>
                    <div className="form-group">
                      <label>{vForm.rule_id ? 'Ghi chú thêm (không bắt buộc)' : 'Lý do'}</label>
                      <input type="text" placeholder={vForm.rule_id ? 'vd: bàn 12, 2 cái ly' : 'Đi trễ, trang phục...'} value={vForm.reason} onChange={e => setVForm(p => ({ ...p, reason: e.target.value }))} />
                    </div>
                  </div>
                  {otherMonth && <div style={{ fontSize: '0.78rem', color: '#b45309', marginBottom: 8 }}>Khoản này tính vào lương tháng {Number(fineDate.slice(5, 7))}/{fineDate.slice(0, 4)} (theo ngày phạt).</div>}
                  <button className="btn-primary" onClick={handleAddViolation}>Ghi phạt</button>
                </div>

                {list.length === 0 ? <div className="empty-state">Không có khoản phạt nào trong tháng {selMonth}/{selYear}</div> : (
                  <>
                    <div style={{ fontSize: '0.82rem', color: '#475569', margin: '0 0 6px' }}>Tháng {selMonth}/{selYear}: {list.length} khoản phạt, tổng <strong style={{ color: '#dc2626' }}>{formatMoney(total)}</strong></div>
                    <table className="payroll-table">
                      <thead><tr><th>Ngày</th><th>Nhân viên</th><th>Lý do</th><th>Số tiền</th><th></th></tr></thead>
                      <tbody>
                        {list.map(({ v, m }) => (
                          <tr key={v.id}>
                            <td style={{ whiteSpace: 'nowrap' }}>{m?.fine_date ? ddmm(m.fine_date) : '—'}</td>
                            <td>{v.staff?.full_name || nameOf(v.staff_id)}</td>
                            <td>{m?.kind ? '🤖 ' : ''}{v.reason}{m?.recorded_by && <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>ghi bởi {m.recorded_by}</div>}</td>
                            <td style={{ color: '#dc2626', fontWeight: 700, whiteSpace: 'nowrap' }}>{formatMoney(v.amount)}</td>
                            <td><button className="btn-danger" style={{ fontSize: '0.75rem', padding: '4px 10px' }} onClick={() => handleDeleteViolation(v.id, !!m?.kind)}>Xoá</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                <FineRules rules={payrollMonth.fineRules} onAction={payrollAction} />
              </div>
            );
          })()}

          {/* === CHẤM CÔNG === */}
          {activeTab === 'attendance' && (() => {
            const filtered = attendance.filter(a => {
              const staff = staffList.find(s => s.id === a.staff_id);
              const nameOk = !attSearch || (staff?.full_name || '') === attSearch;
              const dayOk  = !attDayFilter || workDayOf(a, rules).slice(8, 10) === attDayFilter;
              return nameOk && dayOk;
            });
            return (
              <div>
                {/* Filter bar */}
                <div className="filter-bar">
                  <select value={attSearch} onChange={e => setAttSearch(e.target.value)}>
                    <option value="">👥 Tất cả nhân viên</option>
                    {staffList.map(s => <option key={s.id} value={s.full_name}>{s.full_name}</option>)}
                  </select>
                  <select value={attDayFilter} onChange={e => setAttDayFilter(e.target.value)}>
                    <option value="">Ngày</option>
                    {Array.from({length: 31}, (_, i) => i + 1).map(d => <option key={d} value={String(d).padStart(2,'0')}>{d}</option>)}
                  </select>
                  <select value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
                    {months.map(m => <option key={m} value={m}>Tháng {m}</option>)}
                  </select>
                  <select value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
                    {years.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                  {(attSearch || attDayFilter) && (
                    <button onClick={() => { setAttSearch(''); setAttDayFilter(''); }}
                      style={{ fontSize: '0.8rem', color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>✕ Xoá</button>
                  )}
                </div>

                {filtered.length === 0
                  ? <div className="empty-state">Không có dữ liệu chấm công tháng {selMonth}/{selYear}</div>
                  : <>
                      {/* Mobile cards */}
                      <div className="mobile-cards">
                        {filtered.map(a => {
                          const staff = staffList.find(s => s.id === a.staff_id);
                          const isEditing = editingAtt?.id === a.id;
                          const timeIn  = a.clock_in  ? new Date(a.clock_in).toLocaleTimeString('vi-VN',  { hour: '2-digit', minute: '2-digit' }) : '—';
                          const timeOut = a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : null;
                          // Convert timestamps to local datetime-local input format
                          const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';

                          return (
                            <div key={a.id} className="att-card" style={{ borderColor: isEditing ? '#3b82f6' : undefined }}>
                              <div className="att-card-header">
                                <span className="att-card-name">{staff?.full_name || '—'}</span>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <span className="att-card-date">{dateLabel(a)}</span>
                                  {!isEditing
                                    ? <button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })}
                                        style={{ fontSize: '0.75rem', padding: '2px 8px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', color: '#475569' }}>✏️ Sửa</button>
                                    : <button onClick={() => setEditingAtt(null)}
                                        style={{ fontSize: '0.75rem', padding: '2px 8px', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', color: '#dc2626' }}>✕ Huỷ</button>
                                  }
                                </div>
                              </div>

                              {isEditing ? (
                                /* ── INLINE EDIT FORM ── */
                                <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {[
                                    { label: 'Giờ vào', key: 'clock_in',  type: 'datetime-local' },
                                    { label: 'Giờ ra',  key: 'clock_out', type: 'datetime-local' },
                                  ].map(({ label, key, type }) => (
                                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ width: 70, fontSize: '0.78rem', color: '#64748b', fontWeight: 600, flexShrink: 0 }}>{label}</span>
                                      <input type={type} value={editingAtt[key] || ''} onChange={e => setEditingAtt(p => ({ ...p, [key]: e.target.value }))}
                                        style={{ flex: 1, padding: '5px 8px', border: '1.5px solid #cbd5e1', borderRadius: 7, fontSize: '0.82rem' }} />
                                    </div>
                                  ))}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ width: 70, fontSize: '0.78rem', color: '#64748b', fontWeight: 600, flexShrink: 0 }}>Ghi chú</span>
                                    <input type="text" value={editingAtt.note || ''} placeholder="Lý do sửa..."
                                      onChange={e => setEditingAtt(p => ({ ...p, note: e.target.value }))}
                                      style={{ flex: 1, padding: '5px 8px', border: '1.5px solid #cbd5e1', borderRadius: 7, fontSize: '0.82rem' }} />
                                  </div>
                                  <button onClick={handleSaveAttEdit}
                                    style={{ padding: '8px', background: '#0f172a', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>
                                    💾 Lưu thay đổi
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <div className="att-card-grid">
                                    <div className="att-card-item"><span className="att-card-item-label">Vào</span><span className="att-card-item-value">{timeIn}</span></div>
                                    <div className="att-card-item"><span className="att-card-item-label">Ra</span><span className="att-card-item-value" style={!timeOut ? { color: '#f59e0b' } : {}}>{timeOut || 'Chưa ra'}</span></div>
                                    <div className="att-card-item"><span className="att-card-item-label">Có mặt</span><span className="att-card-item-value">{a.clock_out ? hoursText(hoursOf(a).totalMs) : '—'}</span></div>
                                    <div className="att-card-item"><span className="att-card-item-label">Tính lương</span><span className="att-card-item-value" style={{ color: '#16a34a' }}>{a.clock_out ? hoursText(hoursOf(a).countedMs) : '—'}</span></div>
                                  </div>
                                  {[...rowFlags(a), extraText(a)].some(Boolean) && (
                                    <div style={{ padding: '0 14px 10px', fontSize: '0.76rem', color: '#c2410c' }}>⚠ {[...rowFlags(a), extraText(a)].filter(Boolean).join(' · ')}</div>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Desktop table */}
                      <div className="desktop-table">
                        <table className="payroll-table">
                          <thead><tr><th>Nhân viên</th><th>Ngày</th><th>Vào</th><th>Ra</th><th>Có mặt</th><th>Tính lương</th><th></th></tr></thead>
                          <tbody>
                            {filtered.map(a => {
                              const staff = staffList.find(s => s.id === a.staff_id);
                              const isEditing = editingAtt?.id === a.id;
                              const toLocalDT = ts => ts ? new Date(new Date(ts) - new Date().getTimezoneOffset()*60000).toISOString().slice(0,16) : '';
                              return isEditing ? (
                                <tr key={a.id} style={{ background: '#eff6ff' }}>
                                  <td colSpan="7">
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, padding: '8px 4px' }}>
                                      {[{label:'Giờ vào',key:'clock_in',type:'datetime-local'},{label:'Giờ ra',key:'clock_out',type:'datetime-local'}].map(({label,key,type})=>(
                                        <label key={key} style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                          {label}<input type={type} value={editingAtt[key]||''} onChange={e=>setEditingAtt(p=>({...p,[key]:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.82rem'}}/>
                                        </label>
                                      ))}
                                      <label style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.78rem',fontWeight:600,color:'#475569'}}>
                                        Ghi chú<input type="text" value={editingAtt.note||''} placeholder="Lý do sửa..." onChange={e=>setEditingAtt(p=>({...p,note:e.target.value}))} style={{padding:'5px 8px',border:'1.5px solid #cbd5e1',borderRadius:6,fontSize:'0.82rem'}}/>
                                      </label>
                                    </div>
                                    <div style={{display:'flex',gap:8,padding:'0 4px 8px'}}>
                                      <button onClick={handleSaveAttEdit} style={{padding:'6px 16px',background:'#0f172a',color:'white',border:'none',borderRadius:7,fontWeight:700,fontSize:'0.82rem',cursor:'pointer'}}>💾 Lưu</button>
                                      <button onClick={()=>setEditingAtt(null)} style={{padding:'6px 14px',background:'#f1f5f9',border:'1px solid #e2e8f0',borderRadius:7,fontWeight:600,fontSize:'0.82rem',cursor:'pointer'}}>Huỷ</button>
                                    </div>
                                  </td>
                                </tr>
                              ) : (
                                <tr key={a.id}>
                                  <td>{staff?.full_name || '—'}</td>
                                  <td>{dateLabel(a)}</td>
                                  <td>{a.clock_in ? new Date(a.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                                  <td>{a.clock_out ? new Date(a.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : <span style={{ color: '#f59e0b' }}>Chưa ra</span>}</td>
                                  <td>{a.clock_out ? hoursText(hoursOf(a).totalMs) : '—'}</td>
                                  <td>
                                    <span style={{ color: '#16a34a', fontWeight: 600 }}>{a.clock_out ? hoursText(hoursOf(a).countedMs) : '—'}</span>
                                    {[...rowFlags(a), extraText(a)].some(Boolean) && <div style={{ fontSize: '0.72rem', color: '#c2410c' }}>⚠ {[...rowFlags(a), extraText(a)].filter(Boolean).join(' · ')}</div>}
                                  </td>
                                  <td><button onClick={() => setEditingAtt({ ...a, clock_in: toLocalDT(a.clock_in), clock_out: toLocalDT(a.clock_out) })}
                                    style={{ fontSize: '0.75rem', padding: '3px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', color: '#475569' }}>✏️ Sửa</button>
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

          {/* === CÀI CHẤM CÔNG: giờ làm, máy quầy, chạy thử / chặn thật === */}
          {activeTab === 'qr' && (() => {
            if (!checkin || !hoursEdit) return <div className="empty-state">Đang tải phần cài chấm công… (bấm Đồng bộ nếu lâu)</div>;
            const nameOf = id => staffList.find(s => s.id === id)?.full_name || 'Không rõ';
            const when = ts => ts ? new Date(ts).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
            const serverNow = Date.parse(checkin.now) || Date.now();
            const warnText = { other_network: 'không dùng wifi quán', unknown_device: 'máy lạ', shared_device: 'máy của người khác', admin_no_qr: 'admin chấm không quét mã' };
            const card = { background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 16, marginBottom: 14 };
            const kiosks = checkin.kiosks.filter(k => !k.revoked_at);
            const scans = checkin.scans.filter(s => !onlyWarnings || s.warnings?.length || s.action === 'blocked');
            const shortUa = ua => /iPhone/.test(ua || '') ? 'iPhone' : /iPad/.test(ua || '') ? 'iPad' : /Android/.test(ua || '') ? (String(ua).match(/;\s*([^;)]+?)\s+Build/)?.[1] || 'Android') : 'Máy khác';
            const st = checkin.settings;
            const nowHours = hoursOn(st, vnToday());
            const hoursChanged = hoursEdit.opening_time !== nowHours.opening || hoursEdit.closing_time !== nowHours.closing || Number(hoursEdit.grace_minutes) !== nowHours.grace;
            const timeInput = { padding: '4px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 };
            return (
              <div style={{ maxWidth: 760 }}>
                {/* Chấm công theo giờ internet; báo khi đồng hồ máy tính chạy web lệch (bill, báo cáo vẫn theo giờ máy). */}
                {(() => {
                  const c = checkin.clock;
                  if (!c) return null;
                  const skew = -c.offsetMs, mins = Math.round(Math.abs(skew) / 60000);
                  const bad = c.synced && Math.abs(skew) > 60000;
                  return (
                    <div style={{ ...card, padding: '10px 14px', fontSize: '0.84rem', lineHeight: 1.6, background: !c.synced || bad ? '#fff7ed' : '#f0fdf4', borderColor: !c.synced || bad ? '#fed7aa' : '#bbf7d0' }}>
                      {!c.synced
                        ? '⚠ Chưa so được giờ với internet: chấm công tạm theo giờ máy tính ở quán. Kiểm tra mạng của máy tính chạy web.'
                        : bad
                          ? <>🕒 Chấm công đang theo <strong>giờ internet</strong>. Đồng hồ máy tính chạy web ở quán đang <strong>{skew < 0 ? 'chậm' : 'nhanh'} {mins} phút</strong> — nên chỉnh lại (bật &quot;Đặt giờ tự động&quot;), vì bill và báo cáo vẫn theo giờ máy tính.</>
                          : '🕒 Chấm công theo giờ internet. Đồng hồ máy tính ở quán đúng giờ.'}
                    </div>
                  );
                })()}
                {/* Giờ làm: chỉ tính lương trong ca, ngoài ca chờ chủ duyệt */}
                <div style={card}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>🕑 Giờ làm</div>
                  <div style={{ fontSize: '0.84rem', color: '#475569', lineHeight: 1.6, marginBottom: 10 }}>
                    Nhân viên quét mã lúc nào cũng được, nhưng <strong>chỉ tính lương giờ trong ca</strong>. Vào sớm / ở lại quá số phút cho lệch là <strong>giờ ngoài ca</strong>: chưa tính, chờ bạn bấm "Cho tính" ở tab Yêu cầu.
                    Quên ra ca thì máy tính ra ca lúc hết ca.
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.86rem' }}>
                    <span>Quán mở</span>
                    <input type="time" value={hoursEdit.opening_time} onChange={e => setHoursEdit(p => ({ ...p, opening_time: e.target.value }))} style={timeInput} />
                    <span>đóng</span>
                    <input type="time" value={hoursEdit.closing_time} onChange={e => setHoursEdit(p => ({ ...p, closing_time: e.target.value }))} style={timeInput} />
                    <span>· cho lệch</span>
                    <input type="number" min="0" max="60" value={hoursEdit.grace_minutes} onChange={e => setHoursEdit(p => ({ ...p, grace_minutes: e.target.value }))} style={{ ...timeInput, width: 64 }} />
                    <span>phút</span>
                    {hoursChanged && (
                      <button className="btn-primary" style={{ marginTop: 0, padding: '5px 12px' }}
                        onClick={() => checkinAction('save_checkin_settings', { opening_time: hoursEdit.opening_time, closing_time: hoursEdit.closing_time, grace_minutes: Number(hoursEdit.grace_minutes) })}>Lưu</button>
                    )}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 8 }}>
                    Tính giờ theo ca từ ngày <strong>{st.hours_from.split('-').reverse().join('/')}</strong>; những ngày trước đó vẫn tính như cũ. Đổi giờ hay đổi ca thì áp dụng từ hôm nay, ngày đã làm giữ giờ cũ.
                  </div>

                  <div style={{ fontWeight: 700, fontSize: '0.86rem', margin: '14px 0 4px' }}>Ca riêng từng người</div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: 6 }}>Ai làm khác giờ quán (ví dụ 17:00–23:00) thì đặt riêng. Giờ hết ca trước giờ vào ca nghĩa là làm qua nửa đêm.</div>
                  {staffList.filter(s => !departureOf(s.id) || departureOf(s.id).last_day >= vnToday()).map(s => {
                    const shift = shiftOf(st, s.id, vnToday()), own = shift.own, editing = shiftEdit?.staff_id === s.id;
                    return (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid #f1f5f9', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                        <strong style={{ minWidth: 110 }}>{s.full_name}</strong>
                        {editing ? (
                          <>
                            <input type="time" value={shiftEdit.start} onChange={e => setShiftEdit(p => ({ ...p, start: e.target.value }))} style={timeInput} />
                            <span>–</span>
                            <input type="time" value={shiftEdit.end} onChange={e => setShiftEdit(p => ({ ...p, end: e.target.value }))} style={timeInput} />
                            <button className="btn-primary" style={{ marginTop: 0, padding: '5px 12px' }}
                              onClick={async () => { if (await checkinAction('save_shift', { staff_id: s.id, start_time: shiftEdit.start, end_time: shiftEdit.end })) setShiftEdit(null); }}>Lưu</button>
                            <button style={{ fontSize: '0.78rem', padding: '4px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }} onClick={() => setShiftEdit(null)}>Huỷ</button>
                          </>
                        ) : (
                          <>
                            <span style={{ color: own ? '#1d4ed8' : '#64748b' }}>{shift.start} – {shift.end}{own ? ' (ca riêng)' : ' (giờ quán)'}</span>
                            <button style={{ fontSize: '0.78rem', padding: '3px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}
                              onClick={() => setShiftEdit({ staff_id: s.id, start: shift.start, end: shift.end })}>Đặt ca riêng</button>
                            {own && <button style={{ fontSize: '0.78rem', padding: '3px 10px', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', textDecoration: 'underline' }}
                              onClick={() => checkinAction('save_shift', { staff_id: s.id, clear: true })}>Dùng giờ quán</button>}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Chế độ */}
                <div style={{ ...card, background: checkin.settings.enforce ? '#f0fdf4' : '#fffbeb', borderColor: checkin.settings.enforce ? '#bbf7d0' : '#fde68a' }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>{checkin.settings.enforce ? '🔒 Đang chặn thật' : '🧪 Đang chạy thử'}</div>
                  <div style={{ fontSize: '0.84rem', color: '#475569', lineHeight: 1.6, marginBottom: 10 }}>
                    {checkin.settings.enforce
                      ? 'Nhân viên không vào wifi quán, hoặc dùng điện thoại khác máy đã đăng ký, sẽ KHÔNG chấm được.'
                      : 'Máy chỉ ghi lại ai không dùng wifi quán / dùng máy lạ, CHƯA chặn. Chạy thử khoảng 1 tuần, xem lịch sử bên dưới không có ai bị cảnh báo oan thì bật chặn thật.'}
                    <br />Mã QR luôn đổi liên tục và mỗi mã chỉ dùng 1 lần (phần này không có chạy thử).
                  </div>
                  <button className={checkin.settings.enforce ? 'btn-danger' : 'btn-success'}
                    onClick={() => checkinAction('save_checkin_settings', { enforce: !checkin.settings.enforce }, checkin.settings.enforce ? 'Tắt chặn, quay về chạy thử?' : 'Bật chặn thật? Nhân viên không vào wifi quán hoặc dùng máy lạ sẽ không chấm được.')}>
                    {checkin.settings.enforce ? 'Quay về chạy thử' : 'Bật chặn thật'}
                  </button>
                </div>

                {/* Máy quầy */}
                <div style={card}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>📱 Máy quầy hiện mã QR</div>
                  <div style={{ fontSize: '0.84rem', color: '#475569', lineHeight: 1.7, marginBottom: 10 }}>
                    1️⃣ Lấy một điện thoại / máy tính bảng để cố định ở quầy, cắm sạc, cho vào <strong>wifi quán</strong>.<br />
                    2️⃣ Trên máy đó mở <strong>{typeof window !== 'undefined' ? window.location.host : 'ocbaokhang.online'}/chamcong</strong>, đăng nhập admin để bật. Xong máy tự đăng xuất admin.<br />
                    3️⃣ Nhân viên vào wifi quán, mở app bấm nút 📷 xanh trên thanh menu (hoặc mở camera điện thoại) quét mã trên máy quầy.
                  </div>
                  {kiosks.length === 0 && <div style={{ fontSize: '0.84rem', color: '#b45309', fontWeight: 600 }}>Chưa có máy quầy nào — nhân viên chưa chấm công được.</div>}
                  {kiosks.map(k => {
                    const online = k.last_seen_at && serverNow - Date.parse(k.last_seen_at) < 90000;
                    return (
                      <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid #f1f5f9', flexWrap: 'wrap' }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: online ? '#16a34a' : '#94a3b8' }} />
                        <div style={{ flex: 1, minWidth: 160 }}>
                          <div style={{ fontWeight: 700 }}>{k.name}</div>
                          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{online ? 'Đang mở' : `Mở lần cuối ${when(k.last_seen_at)}`} · bật ngày {when(k.created_at)}</div>
                        </div>
                        <button className="btn-danger" onClick={() => checkinAction('revoke_kiosk', { id: k.id }, `Tắt máy quầy "${k.name}"? Mã trên máy đó sẽ không dùng được nữa.`)}>Tắt máy này</button>
                      </div>
                    );
                  })}
                </div>

                {/* Điện thoại đã đăng ký */}
                <div style={card}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>🔐 Điện thoại chấm công của nhân viên</div>
                  <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 8 }}>Mỗi người một máy. Lần chấm công đầu tiên tự ghi máy đó. Nhân viên đổi / mất điện thoại thì bấm "Cho đổi máy".</div>
                  {staffList.filter(s => s.role !== 'admin' && (!departureOf(s.id) || departureOf(s.id).last_day >= vnToday())).map(s => {
                    const d = checkin.devices.find(x => x.staff_id === s.id);
                    return (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid #f1f5f9', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                        <div style={{ flex: 1, minWidth: 160 }}>
                          <strong>{s.full_name}</strong>
                          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{d ? `${shortUa(d.user_agent)} · đăng ký ${when(d.created_at)}` : 'Chưa đăng ký (lần chấm đầu sẽ tự ghi)'}</div>
                        </div>
                        {d && <button style={{ fontSize: '0.78rem', padding: '4px 10px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer' }}
                          onClick={() => checkinAction('reset_device', { staff_id: s.id }, `Cho ${s.full_name} đổi điện thoại? Lần chấm công tới sẽ ghi máy mới.`)}>Cho đổi máy</button>}
                      </div>
                    );
                  })}
                </div>

                {/* Lịch sử quét */}
                <div style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    <div style={{ fontWeight: 800 }}>📜 Lịch sử chấm công 14 ngày</div>
                    <label style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={onlyWarnings} onChange={e => setOnlyWarnings(e.target.checked)} /> Chỉ lần có cảnh báo
                    </label>
                  </div>
                  {scans.length === 0 && <div style={{ fontSize: '0.84rem', color: '#16a34a' }}>{onlyWarnings ? '✅ Không có lần nào bị cảnh báo.' : 'Chưa có ai chấm công.'}</div>}
                  {scans.slice(0, 150).map(s => (
                    <div key={s.id} style={{ display: 'flex', gap: 10, padding: '5px 0', borderTop: '1px solid #f1f5f9', fontSize: '0.82rem', flexWrap: 'wrap' }}>
                      <span style={{ color: '#64748b', minWidth: 92 }}>{when(s.created_at)}</span>
                      <strong style={{ minWidth: 90 }}>{nameOf(s.staff_id)}</strong>
                      <span style={{ fontWeight: 700, color: s.action === 'blocked' ? '#dc2626' : s.action === 'out' ? '#b45309' : '#15803d' }}>
                        {s.action === 'blocked' ? '⛔ Bị chặn' : s.action === 'out' ? 'Ra ca' : 'Vào ca'}
                      </span>
                      {s.warnings?.length > 0 && <span style={{ color: '#c2410c' }}>⚠ {s.warnings.map(w => warnText[w] || w).join(', ')}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

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
                {staffList.filter(s => !departureOf(s.id)).map(s => (
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
                    {s.id !== currentUser?.id && (
                      <button style={{ marginTop: 18, alignSelf: 'flex-end', padding: '6px 12px', background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}
                        onClick={() => setDepartForm({ staff_id: s.id, name: s.full_name, last_day: vnToday(), reason: '' })}>Cho nghỉ việc</button>
                    )}
                    <button className="btn-danger" style={{ marginTop: 18, alignSelf: 'flex-end' }} onClick={() => handleDeleteAccount(s.id, s.full_name)}>Xoá</button>
                    {departForm?.staff_id === s.id && (
                      <div style={{ flexBasis: '100%', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: '0.84rem' }}>
                        <div><strong>Cho {s.full_name} nghỉ việc.</strong> Qua ngày làm cuối, người này không đăng nhập và không chấm công được nữa; lương tháng cuối tính tới ngày đó, kết toán ở tab Bảng Lương.</div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>Ngày làm việc cuối cùng
                          <input type="date" value={departForm.last_day} onChange={e => setDepartForm(p => ({ ...p, last_day: e.target.value }))} style={{ padding: '4px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 }} /></label>
                        <input type="text" placeholder="Lý do (tuỳ chọn)" value={departForm.reason} onChange={e => setDepartForm(p => ({ ...p, reason: e.target.value }))} style={{ padding: '6px 8px', border: '1.5px solid #cbd5e1', borderRadius: 6 }} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn-danger" style={{ marginTop: 0 }} onClick={handleDepart}>Xác nhận nghỉ việc</button>
                          <button style={{ padding: '6px 12px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }} onClick={() => setDepartForm(null)}>Huỷ</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {staffList.length === 0 && <div className="empty-state">Chưa có nhân viên nào</div>}
              </div>

              {/* Đã nghỉ việc: không đăng nhập / chấm công được, vẫn giữ lịch sử và lương các tháng đã làm. */}
              {staffList.some(s => departureOf(s.id)) && (
                <div className="config-list" style={{ marginTop: 14 }}>
                  <div style={{ fontWeight: 800, fontSize: '0.9rem', padding: '4px 2px' }}>🚪 Đã nghỉ việc</div>
                  {staffList.filter(s => departureOf(s.id)).map(s => {
                    const d = departureOf(s.id);
                    return (
                      <div key={s.id} className="config-row" style={{ flexWrap: 'wrap', gap: 10, opacity: 0.85 }}>
                        <div style={{ flex: 1, minWidth: 160 }}>
                          <div style={{ fontWeight: 700 }}>{s.full_name}</div>
                          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Làm đến hết {d.last_day.split('-').reverse().join('/')}{d.reason ? ` · ${d.reason}` : ''}{d.last_day >= vnToday() ? ' (vẫn đang làm tới ngày đó)' : ''}</div>
                        </div>
                        <button style={{ padding: '6px 12px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}
                          onClick={() => handleReturn(s.id, s.full_name)}>Cho đi làm lại</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* === CẤU HÌNH === */}
          {activeTab === 'config' && (
            <div>
              <div className="payroll-form" style={{ marginBottom: 8 }}>
                <p style={{ fontSize: '0.82rem', color: '#6b7280', margin: 0 }}>💡 Thiết lập lương cơ bản (lương đủ {STANDARD_DAYS} ngày công), giá tăng ca mỗi giờ (để 0 nếu không trả tăng ca) và ngày phát lương cho từng nhân viên.</p>
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
                        <input type="number" min="0" value={edit.overtime_rate ?? 25000}
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
