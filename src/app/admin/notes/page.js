'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { ChefHat, FileText, CheckCircle, XCircle, LogOut, Plus, Clock, Trash2, User, CornerDownRight } from 'lucide-react';
import './notes.css';

export default function StaffNotesPage() {
  const [currentUser, setCurrentUser] = useState(null);
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // New Registration State
  const [isRegistering, setIsRegistering] = useState(false);
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPin, setRegPin] = useState('');

  const [notes, setNotes] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);

  // New Note State
  const [newNoteType, setNewNoteType] = useState('expense'); // 'expense' | 'stock' | 'repair' | 'other'
  const [newNoteContent, setNewNoteContent] = useState('');
  const [expenseItems, setExpenseItems] = useState([
    { name: '', price: '', qty: '', paymentStatus: 'full', creditor: '' }
  ]);
  const [newNoteAmount, setNewNoteAmount] = useState(0);
  const [newNoteDebt, setNewNoteDebt] = useState(0);
  
  // Modal / Review States
  const [viewingNote, setViewingNote] = useState(null);
  
  // Analytics & Filter
  const [selectedStaff, setSelectedStaff] = useState('ALL');

  // Date filter: day/month/year (empty string = not set)
  const now = new Date();
  const [filterDay, setFilterDay] = useState('');
  const [filterMonth, setFilterMonth] = useState(String(now.getMonth() + 1));
  const [filterYear, setFilterYear] = useState(String(now.getFullYear()));

  // Pay Debt State (note-level)
  const [payDebtNoteId, setPayDebtNoteId] = useState(null);
  const [payDebtAmount, setPayDebtAmount] = useState('');

  // Pay Debt State (per-item)
  const [payingItem, setPayingItem] = useState(null); // { noteId, idx }
  const [payItemInput, setPayItemInput] = useState('');
  const [expandedHistory, setExpandedHistory] = useState({}); // { 'noteId-idx': true }
  const toggleHistory = (noteId, idx) => setExpandedHistory(prev => ({ ...prev, [`${noteId}-${idx}`]: !prev[`${noteId}-${idx}`] }));

  // Employee self-service — Bảng Công
  // Staff (non-admin) always land on 'cong'; admin defaults to 'notes'
  const [activeNotesTab, setActiveNotesTab] = useState('cong');
  const [todayAttendance, setTodayAttendance] = useState(null); // today's log
  const [empRequests, setEmpRequests] = useState([]); // this month's requests
  const [empSalaryRec, setEmpSalaryRec] = useState(null);
  const [advanceForm, setAdvanceForm] = useState({ amount: '', reason: '' });
  const [absentForm, setAbsentForm] = useState({ days: '1', reason: '' });
  const [showAdvForm, setShowAdvForm] = useState(false);
  const [showAbsForm, setShowAbsForm] = useState(false);

  const fetchEmpData = async (staffId) => {
    const today = new Date().toISOString().split('T')[0];
    const m = now.getMonth() + 1; const y = now.getFullYear();
    const [attRes, reqRes] = await Promise.all([
      supabase.from('attendance_logs').select('*').eq('staff_id', staffId).eq('date', today).maybeSingle(),
      supabase.from('payroll_requests').select('*').eq('staff_id', staffId).eq('month', m).eq('year', y).order('created_at', { ascending: false }),
    ]);
    setTodayAttendance(attRes.data);
    setEmpRequests(reqRes.data || []);
  };

  const handleClockIn = async () => {
    await supabase.from('attendance_logs').insert({ staff_id: currentUser.id, clock_in: new Date().toISOString(), date: new Date().toISOString().split('T')[0] });
    fetchEmpData(currentUser.id);
  };

  const handleClockOut = async () => {
    if (!todayAttendance) return;
    const cin = new Date(todayAttendance.clock_in);
    const cout = new Date();
    const diffH = (cout - cin) / 3600000;
    const workH = Math.round(diffH * 10) / 10;
    const otH = Math.max(0, Math.round((diffH - 8) * 10) / 10);
    await supabase.from('attendance_logs').update({ clock_out: cout.toISOString(), work_hours: workH, overtime_hours: otH }).eq('id', todayAttendance.id);
    fetchEmpData(currentUser.id);
  };

  const handleSubmitAdvance = async () => {
    if (!advanceForm.amount || !advanceForm.reason) return alert('Vui lòng điền đầy đủ!');
    const m = now.getMonth() + 1; const y = now.getFullYear();
    await supabase.from('payroll_requests').insert({ staff_id: currentUser.id, request_type: 'advance', amount: Number(advanceForm.amount.replace(/\./g, '')), reason: advanceForm.reason, month: m, year: y });
    setAdvanceForm({ amount: '', reason: '' }); setShowAdvForm(false);
    fetchEmpData(currentUser.id);
    alert('Đã gửi yêu cầu ứng lương!');
  };

  const handleSubmitAbsent = async () => {
    if (!absentForm.reason) return alert('Vui lòng điền lý do!');
    const m = now.getMonth() + 1; const y = now.getFullYear();
    await supabase.from('payroll_requests').insert({ staff_id: currentUser.id, request_type: 'absent', days: Number(absentForm.days), reason: absentForm.reason, month: m, year: y });
    setAbsentForm({ days: '1', reason: '' }); setShowAbsForm(false);
    fetchEmpData(currentUser.id);
    alert('Đã gửi báo nghỉ!');
  };

  // Filter notes by date
  const filterNotesByDate = (notesList) => {
    return notesList.filter(note => {
      const d = new Date(note.created_at);
      if (filterDay) {
        return d.getDate() === parseInt(filterDay)
          && d.getMonth() + 1 === parseInt(filterMonth || d.getMonth() + 1)
          && d.getFullYear() === parseInt(filterYear || d.getFullYear());
      }
      if (filterMonth) {
        return d.getMonth() + 1 === parseInt(filterMonth)
          && d.getFullYear() === parseInt(filterYear || d.getFullYear());
      }
      if (filterYear) {
        return d.getFullYear() === parseInt(filterYear);
      }
      return true;
    });
  };

  // ── Authentication Logic ──
  useEffect(() => {
    // Check for existing session
    const savedUser = localStorage.getItem('nhahang_staff_user');
    if (savedUser) {
      setCurrentUser(JSON.parse(savedUser));
    }
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const { data, error } = await supabase
        .from('staff')
        .select('*')
        .eq('phone', phone)
        .eq('pin', pin)
        .single();

      if (error || !data) {
        setErrorMsg('Số điện thoại hoặc mã PIN không đúng!');
      } else {
        const userToSave = {
          id: data.id,
          phone: data.phone,
          full_name: data.full_name,
          role: data.role
        };
        localStorage.setItem('nhahang_staff_user', JSON.stringify(userToSave));
        setCurrentUser(userToSave);
        // Non-admin staff land on Bảng Công — pre-load their data
        if (data.role !== 'admin') {
          fetchEmpData(data.id);
        }
        
        // Update last login
        await supabase.from('staff').update({ last_login: new Date().toISOString() }).eq('id', data.id);
      }
    } catch (err) {
      setErrorMsg('Đã có lỗi xảy ra. Hãy thử lại.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    if (!regName || !regPhone || !regPin) {
      setErrorMsg('Vui lòng điền đủ thông tin.');
      setIsLoading(false);
      return;
    }

    try {
      const { data: existingUser } = await supabase
        .from('staff')
        .select('id')
        .eq('phone', regPhone)
        .single();

      if (existingUser) {
        setErrorMsg('Số điện thoại này đã được đăng ký!');
        setIsLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('staff')
        .insert([{
          full_name: regName,
          phone: regPhone,
          pin: regPin,
          role: 'staff'
        }])
        .select()
        .single();

      if (error) {
        setErrorMsg('Lỗi khi tạo tài khoản. Vui lòng thử lại.');
      } else {
        setSuccessMsg('Đăng ký thành công! Vui lòng làm mới trang và đăng nhập.');
        setIsRegistering(false);
        setPhone(regPhone);
        setRegName('');
        setRegPhone('');
        setRegPin('');
      }
    } catch (err) {
      // Supabase single() throws an error when no rows returned. This is expected if user doesn't exist.
      // So if existingUser request throws, it means user does NOT exist, which is good. We should proceed to insert inside the catch block... 
      // Actually better to handle it properly.
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('nhahang_staff_user');
    setCurrentUser(null);
    setPhone('');
    setPin('');
  };

  // ── Notes Logic ──
  const fetchNotes = async () => {
    if (!currentUser) return;

    let query = supabase
      .from('staff_notes')
      .select(`
        *,
        staff ( full_name, phone )
      `)
      .order('created_at', { ascending: false });

    // If staff, only see own notes. If admin, see all.
    if (currentUser.role !== 'admin') {
      query = query.eq('staff_id', currentUser.id);
    }

    const { data, error } = await query;
    if (!error && data) {
      setNotes(data);
    }
  };

  useEffect(() => {
    if (currentUser) {
      fetchNotes();
      
      // Subscribe to realtime changes
      const channel = supabase
        .channel('public:staff_notes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_notes' }, () => {
          fetchNotes();
        })
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [currentUser]);

  // ── Actions ──
  const formatExpenseContent = () => {
    if (newNoteType !== 'expense') return newNoteContent;
    
    // Build array from expense items
    const validItems = expenseItems.filter(item => item.name.trim() !== '');
    if (validItems.length === 0) return newNoteContent;

    return JSON.stringify({
      type: 'structured_expense',
      items: validItems,
      note: newNoteContent
    });
  };

  const parseVal = (str, isQty = false) => {
    if (!str) return 0;
    // Extract numbers, allowing decimals
    let s = str.toString().toLowerCase().trim();
    
    // Check if it has 'k' before stripping text, but ignore if it's explicitly marked as Quantity (which often has "ký")
    const isK = !isQty && s.includes('k');
    
    // Strip everything except digits and dot
    let numStr = s.replace(/[^0-9.]/g, '');
    let num = parseFloat(numStr) || 0;
    
    if (isK) {
      num = num * 1000;
    }
    return num;
  };

  const calculateTotals = () => {
    let totalPaid = 0;
    let totalDebt = 0;
    let creditors = [];
    
    expenseItems.forEach(item => {
      const price = parseVal(item.price);
      const qty = parseVal(item.qty, true) || 1; // Default to 1 if no qty specified
      const totalItemPrice = price * qty;
      
      if (item.name && totalItemPrice > 0) {
        if (item.paymentStatus === 'full') {
          totalPaid += totalItemPrice;
        } else if (item.paymentStatus === 'debt') {
          const debtAmt = item.debtAmount ? parseVal(item.debtAmount.replace(/\./g, '')) : totalItemPrice;
          const cappedDebt = Math.min(debtAmt, totalItemPrice);
          totalDebt += cappedDebt;
          totalPaid += totalItemPrice - cappedDebt;
          if (item.creditor && item.creditor.trim() !== '') {
            creditors.push(item.creditor.trim());
          }
        }
      }
    });
    
    return { 
      paid: totalPaid, 
      debt: totalDebt,
      creditors: [...new Set(creditors)].join(', ')
    };
  };

  const submitNewNote = async () => {
    const finalContent = newNoteType === 'expense' ? formatExpenseContent() : newNoteContent.trim();
    
    if (!finalContent) {
      alert('Vui lòng nhập nội dung!');
      return;
    }

    let { paid, debt } = { paid: Number(newNoteAmount || 0), debt: Number(newNoteDebt || 0) };
    if (newNoteType === 'expense' && expenseItems.some(i => i.name.trim())) {
      const totals = calculateTotals();
      paid = totals.paid;
      debt = totals.debt;
    }

    setIsLoading(true);
    const { error } = await supabase
      .from('staff_notes')
      .insert({
        staff_id: currentUser.id,
        note_type: newNoteType,
        content: finalContent,
        amount: paid,
        debt: debt,
        status: 'approved' // Auto-approve since admin approval is removed
      });

    setIsLoading(false);
    if (!error) {
      setShowAddModal(false);
      setNewNoteContent('');
      setExpenseItems([{ name: '', price: '', qty: '', paymentStatus: 'full', creditor: '', debtAmount: '' }]);
      setNewNoteAmount(0);
      setNewNoteDebt(0);
      setNewNoteType('other');
      fetchNotes(currentUser); // Refresh list
    } else {
      alert('Lỗi lưu báo cáo!');
    }
  };

  const handleDeleteNote = async (noteId) => {
    if (!confirm('Bạn có chắc chắn muốn xoá báo cáo này?')) return;
    
    const { error } = await supabase
      .from('staff_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      alert('Xoá thất bại!');
    }
  };

  // ── Helpers ──
  const handleContentKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const cursorParams = e.target.selectionStart;
      const val = newNoteContent;
      // Trích xuất văn bản trước và sau con trỏ
      const before = val.substring(0, cursorParams);
      const after = val.substring(cursorParams);
      
      // Chèn ngắt dòng và dấu trừ + khoang trắng
      setNewNoteContent(before + '\n- ' + after);
      
      // Di chuyển con trỏ sau khi render
      setTimeout(() => {
        e.target.selectionStart = e.target.selectionEnd = cursorParams + 3;
      }, 0);
    }
  };

  const handleContentChange = (e) => {
    // Nếu gõ ký tự đầu tiên, tự động thêm dấu gạch đầu dòng
    let val = e.target.value;
    if (val.length === 1 && val !== '-' && val !== '\n') {
      val = '- ' + val;
    }
    setNewNoteContent(val);
  };

  const updateExpenseItem = (index, field, value) => {
    const newItems = [...expenseItems];
    let finalValue = value;
    
    // Auto-formatting for price and qty ONLY when losing focus/blur or specific conditions?
    // Doing it onChange might interrupt typing.
    // Given the prompt "ví dụ tôi viết 100 thì bạn thêm 100k v tôi viết 5 thì bạn viết 5 kg"
    // We can auto-append when they type a space, or just let them type and we parse it.
    // For a simple real-time approach, if they type numbers we can append it on blur. 
    // Since we only have onChange right now, let's keep it simple: 
    // We'll update the state directly, but maybe we can add a simple formatting check if they click out (blur).
    // For now, let's just use the raw value.
    
    newItems[index][field] = finalValue;
    
    // If we're updating the last row and there's text, add a new empty row
    if (index === newItems.length - 1 && finalValue.trim() !== '' && field === 'name') {
      newItems.push({ name: '', price: '', qty: '', paymentStatus: 'full', creditor: '' });
    }
    
    setExpenseItems(newItems);
  };

  const handleExpenseBlur = (index, field, e) => {
    const value = e.target.value.trim();
    if (!value) return;
    
    const newItems = [...expenseItems];
    if (field === 'price') {
      // If it's just numbers, append 'k'
      if (/^\d+$/.test(value)) {
        newItems[index][field] = value + 'k';
      }
    } else if (field === 'qty') {
      // If it's just numbers, append ' ký'
      if (/^\d+(\.\d+)?$/.test(value)) {
        newItems[index][field] = value + ' ký';
      }
    }
    setExpenseItems(newItems);
  };

  const removeExpenseItem = (index) => {
    if (expenseItems.length > 1) {
      const newItems = expenseItems.filter((_, i) => i !== index);
      setExpenseItems(newItems);
    }
  };

  const handleItemPayment = async (note, itemIdx, payAmount) => {
    try {
      const data = JSON.parse(note.content);
      const item = data.items[itemIdx];
      const p = parseVal(item.price);
      const q = parseVal(item.qty, true) || 1;
      const itemTotal = p * q;
      const debtBase = item.debtAmount ? Math.min(parseVal(item.debtAmount.replace(/\./g, '')), itemTotal) : itemTotal;
      const alreadyPaid = item.paid_amount || 0;
      const remaining = debtBase - alreadyPaid;
      if (payAmount <= 0 || payAmount > remaining) return alert('Số tiền không hợp lệ!');
      data.items[itemIdx].paid_amount = alreadyPaid + payAmount;
      if (data.items[itemIdx].paid_amount >= debtBase) {
        data.items[itemIdx].paymentStatus = 'full';
      }
      // Append payment log to this item
      const tsStr = new Date().toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
      data.items[itemIdx].payment_logs = [...(item.payment_logs || []), { amount: payAmount, ts: tsStr }];
      const newContent = JSON.stringify(data);
      const totalPaid = data.items.filter(i => i.name?.trim()).reduce((sum, i) => sum + (i.paid_amount || 0), 0);
      await supabase.from('staff_notes').update({ content: newContent, paid_debt: totalPaid }).eq('id', note.id);
      setPayingItem(null); setPayItemInput('');
      // Directly update notes state so card turns green immediately
      setNotes(prev => prev.map(n => n.id === note.id ? { ...n, content: newContent, paid_debt: totalPaid } : n));
      setViewingNote(prev => prev ? { ...prev, content: newContent, paid_debt: totalPaid } : null);
    } catch { alert('Lỗi cập nhật!'); }
  };

  const handlePayDebt = async (note) => {
    const payAmount = Number(payDebtAmount);
    if (!payAmount || payAmount <= 0) return alert('Vui lòng nhập số tiền hợp lệ');
    const currentDebt = note.debt || 0;
    const currentPaid = note.paid_debt || 0;
    
    if (payAmount > (currentDebt - currentPaid)) {
      return alert('Số tiền trả không được vượt quá số dư nợ!');
    }

    setIsLoading(true);
    const newPaidDebt = currentPaid + payAmount;
    
    const timestampStr = new Date().toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const paymentLog = `[🔔 Đã trả nợ ${formatMoney(payAmount)} vào lúc ${timestampStr}]`;
    
    let newContent = note.content;
    try {
      if (newContent && newContent.startsWith('{') && newContent.includes('"type":"structured_expense"')) {
        const data = JSON.parse(newContent);
        data.note = (data.note ? data.note + '\n\n' : '') + paymentLog;
        newContent = JSON.stringify(data);
      } else {
        newContent = newContent + '\n\n' + paymentLog;
      }
    } catch {
      newContent = newContent + '\n\n' + paymentLog;
    }

    const { error } = await supabase
      .from('staff_notes')
      .update({ paid_debt: newPaidDebt, content: newContent })
      .eq('id', note.id);

    setIsLoading(false);
    if (error) {
      alert('Lỗi cập nhật!');
    } else {
      setPayDebtNoteId(null);
      setPayDebtAmount('');
      setViewingNote({...note, paid_debt: newPaidDebt, content: newContent});
      fetchNotes();
    }
  };

  // ── Render ──
  const formatMoney = (amount) => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
  };

  const renderNoteContent = (content) => {
    try {
      let jsonContent = content;
      let trailingLog = '';

      if (content && typeof content === 'string' && content.startsWith('{') && content.includes('}[')) {
        const splitIndex = content.lastIndexOf('}[');
        if (splitIndex !== -1) {
          jsonContent = content.substring(0, splitIndex + 1);
          trailingLog = '\n\n' + content.substring(splitIndex + 1);
        }
      }

      const strToParse = typeof jsonContent === 'string' ? jsonContent : '';
      if (strToParse && strToParse.startsWith('{') && strToParse.includes('"type":"structured_expense"')) {
        const data = JSON.parse(strToParse);

        // compute totals
        let grandTotal = 0, paidTotal = 0, debtTotal = 0;
        const rows = data.items.filter(i => i.name?.trim());
        rows.forEach(item => {
          const p = parseVal(item.price);
          const q = parseVal(item.qty, true) || 1;
          const t = p * q;
          grandTotal += t;
          if (item.paymentStatus === 'debt') {
            const da = item.debtAmount ? parseVal(item.debtAmount.replace(/\./g, '')) : t;
            const cappedDebt = Math.min(da, t);
            debtTotal += cappedDebt;
            paidTotal += t - cappedDebt;
          } else paidTotal += t;
        });

        return (
          <div>
            {/* Note comment */}
            {data.note && (
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '7px 10px', fontSize: '0.82rem', color: '#1e40af', fontStyle: 'italic', marginBottom: 10, whiteSpace: 'pre-wrap' }}>
                💬 {data.note}
              </div>
            )}
            {trailingLog && (
              <div style={{ color: '#92400e', fontStyle: 'italic', fontSize: '0.78rem', marginBottom: 8, whiteSpace: 'pre-wrap', padding: '6px 8px', background: '#fffbeb', borderRadius: 6 }}>{trailingLog}</div>
            )}

            {/* Desktop: HTML Table */}
            <div className="expense-desktop-table">
              <table className="expense-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', width: '4%' }}>#</th>
                    <th style={{ textAlign: 'left', width: '40%' }}>Tên món / hàng</th>
                    <th style={{ textAlign: 'right', width: '17%' }}>Đơn giá</th>
                    <th style={{ textAlign: 'center', width: '9%' }}>SL</th>
                    <th style={{ textAlign: 'right', width: '18%' }}>Thành tiền</th>
                    <th style={{ textAlign: 'center', width: '12%' }}>TT</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item, idx) => {
                    const p = parseVal(item.price);
                    const q = parseVal(item.qty, true) || 1;
                    const total = p * q;
                    const isDebt = item.paymentStatus === 'debt';
                    return (
                      <tr key={idx}>
                        <td style={{ textAlign: 'center' }}>{idx + 1}</td>
                        <td style={{ fontWeight: 600 }}>
                          {item.name}
                          {isDebt && item.creditor?.trim() && (
                            <div style={{ fontSize: '0.75rem', color: '#dc2626', fontWeight: 400, marginTop: 1 }}>👤 {item.creditor}</div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>{p > 0 ? formatMoney(p).replace('₫', '') : '—'}</td>
                        <td style={{ textAlign: 'center' }}>{item.qty || 1}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: isDebt ? '#dc2626' : undefined }}>
                          {total > 0 ? formatMoney(total).replace('₫', '') : '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isDebt ? <span className="badge-debt">Nợ</span> : <span className="badge-paid">Đủ</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'right', fontWeight: 600 }}>Tổng:</td>
                    <td style={{ textAlign: 'right', color: debtTotal > 0 ? '#dc2626' : '#111827' }}>
                      {formatMoney(grandTotal).replace('₫', '')}đ
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {debtTotal > 0 && <span className="badge-debt">Nợ</span>}
                      {debtTotal === 0 && paidTotal > 0 && <span className="badge-paid">✓ Đủ</span>}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile: Card list */}
            <div className="expense-mobile-cards">
              {rows.map((item, idx) => {
                const p = parseVal(item.price);
                const q = parseVal(item.qty, true) || 1;
                const total = p * q;
                const isDebt = item.paymentStatus === 'debt';
                const paidAmt = item.paid_amount || 0;
                const debtBase = item.debtAmount ? Math.min(parseVal(item.debtAmount.replace(/\./g, '')), total) : (isDebt ? total : 0);
                const remaining = debtBase > 0 ? Math.max(0, debtBase - paidAmt) : 0;
                const isThisPaying = payingItem?.idx === idx;
                const hasPayHistory = item.payment_logs?.length > 0;
                const debtFullyPaid = hasPayHistory && remaining <= 0;
                return (
                  <div key={idx} style={{
                    background: (isDebt && remaining > 0) ? '#fef2f2' : debtFullyPaid ? '#f0fdf4' : '#f9fafb',
                    border: `1px solid ${(isDebt && remaining > 0) ? '#fca5a5' : debtFullyPaid ? '#86efac' : '#e5e7eb'}`,
                    borderRadius: 12, padding: '10px 14px', marginBottom: 8,
                  }}>
                    {/* Top row: name + Trả nợ button — full width */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#111827' }}>{idx + 1}. {item.name}</div>
                      <div style={{ paddingLeft: 10 }}>
                        {isDebt && remaining > 0 ? (
                          <button
                            onClick={e => { e.stopPropagation(); setPayingItem(isThisPaying ? null : { idx }); setPayItemInput(''); }}
                            style={{ fontSize: '0.78rem', background: '#dc2626', color: 'white', border: 'none', borderRadius: 7, padding: '4px 10px', cursor: 'pointer', fontWeight: 700 }}
                          >
                            Trả nợ
                          </button>
                        ) : !isDebt ? (
                          <span className="badge-paid">✓ Đủ</span>
                        ) : null}
                      </div>
                    </div>
                    {item.creditor?.trim() && (
                      <div style={{ fontSize: '0.75rem', color: '#dc2626', marginTop: 2 }}>👤 {item.creditor}</div>
                    )}
                    {/* Price row full width — status pushed to far right */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                      <div style={{ fontSize: '0.78rem', color: '#6b7280' }}>
                        {p > 0 ? formatMoney(p).replace('₫', '') : '—'} × {q} = <strong>{total > 0 ? formatMoney(total) : '—'}</strong>
                      </div>
                      {(paidAmt > 0 || remaining > 0) && (
                        <div style={{ fontSize: '0.75rem', display: 'flex', gap: 5, alignItems: 'center' }}>
                          {paidAmt > 0 && <span style={{ color: '#16a34a' }}>✓ {formatMoney(paidAmt)}</span>}
                          {remaining > 0 && <span style={{ color: '#dc2626', fontWeight: 700 }}>⚠️ {formatMoney(remaining)}</span>}
                          {remaining <= 0 && paidAmt > 0 && <span style={{ color: '#16a34a', fontWeight: 700 }}>✅</span>}
                        </div>
                      )}
                    </div>

                    {/* Debt inline pay input + history — inside dashed section */}
                    {(isDebt || item.payment_logs?.length > 0) && (() => {
                      const histKey = `${viewingNote.id}-${idx}`;
                      const isExpanded = !!expandedHistory[histKey];
                      const borderColor = isDebt ? '#fca5a5' : '#d1fae5';
                      return (
                        <div style={{ marginTop: 8, borderTop: `1px dashed ${borderColor}`, paddingTop: 6 }}>
                          {item.payment_logs?.length > 0 && (
                            <div style={{ marginBottom: isThisPaying ? 6 : 0 }}>
                              <button
                                onClick={e => { e.stopPropagation(); toggleHistory(viewingNote.id, idx); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.72rem', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 3, padding: '0 0 4px 0' }}
                              >
                                🕐 {isExpanded ? 'Ẩn lịch sử' : `Lịch sử (${item.payment_logs.length})`}
                              </button>
                              {isExpanded && (
                                <div style={{ marginBottom: 6 }}>
                                  {!isDebt && <div style={{ fontSize: '0.75rem', color: '#16a34a', fontWeight: 700, marginBottom: 2 }}>✅ Đã trả đủ nợ</div>}
                                  {item.payment_logs.map((log, li) => (
                                    <div key={li} style={{ fontSize: '0.73rem', color: '#6b7280', padding: '1px 0', display: 'flex', gap: 5 }}>
                                      <span style={{ color: '#16a34a' }}>🔔</span>
                                      <span>Đã trả <strong style={{ color: '#16a34a' }}>{formatMoney(log.amount)}</strong> — {log.ts}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {isDebt && <div style={{ marginBottom: isThisPaying ? 8 : 0 }} />}

                        {isThisPaying && remaining > 0 && (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                            <input
                              type="text"
                              inputMode="numeric"
                              placeholder={`Tối đa ${remaining.toLocaleString('vi-VN')}`}
                              value={payItemInput}
                              onChange={e => {
                                const raw = e.target.value.replace(/\./g, '').replace(/[^0-9]/g, '');
                                const num = Number(raw);
                                if (num > remaining) {
                                  setPayItemInput(remaining.toLocaleString('vi-VN'));
                                  return;
                                }
                                setPayItemInput(raw ? num.toLocaleString('vi-VN') : '');
                              }}
                              style={{ flex: 1, minWidth: 130, padding: '6px 10px', border: '1.5px solid #fca5a5', borderRadius: 7, fontSize: '0.88rem', outline: 'none' }}
                              autoFocus
                            />
                            <button
                              onClick={() => {
                                const num = Number(payItemInput.replace(/\./g, ''));
                                handleItemPayment(viewingNote, idx, num);
                              }}
                              style={{ padding: '6px 14px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}
                            >
                              Xác nhận
                            </button>
                            <button
                              onClick={() => setPayingItem(null)}
                              style={{ padding: '6px 10px', background: '#f3f4f6', color: '#6b7280', border: 'none', borderRadius: 7, fontSize: '0.82rem', cursor: 'pointer' }}
                            >
                              Huỷ
                            </button>
                          </div>
                        )}
                      </div>
                        );
                    })()}

                  </div>
                );
              })}
              {/* Total row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, borderTop: '2px solid #e5e7eb', paddingTop: 8, marginTop: 4, fontSize: '0.92rem' }}>
                <span>Tổng cộng</span>
                <span style={{ color: debtTotal > 0 ? '#dc2626' : '#15803d' }}>{formatMoney(grandTotal)}</span>
              </div>
            </div>
          </div>
        );
      }
    } catch {}

    return <div style={{ color: '#374151', whiteSpace: 'pre-wrap', fontSize: '0.92rem', lineHeight: 1.6 }}>{content}</div>;
  };

  const formatDate = (isoString) => {
    const d = new Date(isoString);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const getNoteTypeLabel = (type) => {
    switch (type) {
      case 'expense': return 'Đi chợ / Chi tiêu';
      case 'stock': return 'Báo thiếu hàng';
      case 'repair': return 'Sửa chữa';
      default: return 'Khác';
    }
  };

  // If NOT logged in, show Login Screen
  if (!currentUser) {
    return (
      <div className="notes-container">
        <div className="login-overlay">
          <div className="login-card">
            <div className="login-header">
              <div className="flex justify-center mb-4 text-accent">
                <ChefHat size={48} />
              </div>
              <h2>Nhà Hàng V1</h2>
              <p>{isRegistering ? 'Tạo tài khoản nhân viên mới' : 'Đăng nhập sổ tay chấm công / sự việc'}</p>
            </div>
            
            {errorMsg && <div className="p-3 mb-4 text-red-700 bg-red-50 rounded-lg text-sm font-medium">{errorMsg}</div>}
            {successMsg && <div className="p-3 mb-4 text-green-700 bg-green-50 rounded-lg text-sm font-medium">{successMsg}</div>}

            {!isRegistering ? (
              <form className="login-form" onSubmit={handleLogin}>
                <div className="form-group centered">
                  <label>Số điện thoại</label>
                  <input 
                    type="tel" 
                    className="login-input" 
                    placeholder="0909..." 
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group centered">
                  <label>Mã PIN</label>
                  <input 
                    type="password" 
                    className="login-input" 
                    placeholder="******" 
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    required
                  />
                </div>
                
                <button type="submit" className="btn-login" disabled={isLoading}>
                  {isLoading ? 'Đang kiểm tra...' : 'Vào Sổ Tay'}
                </button>
                <div className="text-center mt-4">
                  <button type="button" onClick={() => { setIsRegistering(true); setErrorMsg(''); setSuccessMsg(''); }} className="text-blue-600 text-[15px] font-medium hover:underline">
                    Chưa có tài khoản? Tạo mới ngay
                  </button>
                </div>
              </form>
            ) : (
              <form className="login-form" onSubmit={handleRegister}>
                <div className="form-group centered">
                  <label>Họ và Tên</label>
                  <input 
                    type="text" 
                    className="login-input" 
                    placeholder="Nguyễn Văn A" 
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group centered">
                  <label>Số điện thoại</label>
                  <input 
                    type="tel" 
                    className="login-input" 
                    placeholder="0909..." 
                    value={regPhone}
                    onChange={(e) => setRegPhone(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group centered">
                  <label>Tạo Mã PIN</label>
                  <input 
                    type="text" 
                    className="login-input" 
                    placeholder="Tạo mã (VD: 1234)" 
                    value={regPin}
                    onChange={(e) => setRegPin(e.target.value)}
                    required
                  />
                </div>
                
                <button type="submit" className="btn-login" style={{ background: '#2563eb' }} disabled={isLoading}>
                  {isLoading ? 'Đang tạo...' : 'Đăng Ký Tài Khoản'}
                </button>
                <div className="text-center mt-4">
                  <button type="button" onClick={() => { setIsRegistering(false); setErrorMsg(''); setSuccessMsg(''); }} className="text-gray-500 text-[15px] font-medium hover:underline">
                    Đã có tài khoản? Quay lại đăng nhập
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Logged In ──
  const filteredByDate = filterNotesByDate(
    notes.filter(n => currentUser.role !== 'admin' || selectedStaff === 'ALL' || n.staff?.full_name === selectedStaff)
  );
  const totalSpent = filteredByDate.reduce((a, n) => a + (n.amount || 0) + (n.paid_debt || 0), 0);
  const totalDebt  = filteredByDate.reduce((a, n) => a + Math.max(0, (n.debt || 0) - (n.paid_debt || 0)), 0);
  const totalOrigDebt = filteredByDate.reduce((a, n) => a + (n.debt || 0), 0);

  // Label for current filter
  const filterLabel = filterDay
    ? `Ngày ${filterDay}/${filterMonth}/${filterYear}`
    : filterMonth
    ? `Tháng ${filterMonth}/${filterYear}`
    : filterYear ? `Năm ${filterYear}` : 'Tất cả';

  return (
    <div className="notes-container">

      {/* ── Header ── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'white', borderBottom: '1px solid #e5e7eb', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {/* User pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f3f4f6', borderRadius: 999, padding: '5px 12px 5px 5px' }}>
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#dc2626', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
            {currentUser.full_name.charAt(0)}
          </div>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#111827', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentUser.full_name}
          </span>
          <div style={{ width: 1, height: 16, background: '#d1d5db', margin: '0 2px' }} />
          <button onClick={handleLogout} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <LogOut size={15} />
          </button>
        </div>
        {/* Add button - only show on notes tab */}
        {activeNotesTab === 'notes' && (
          <button
            onClick={() => setShowAddModal(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#16a34a', color: 'white', border: 'none', borderRadius: 999, padding: '9px 18px', fontWeight: 700, fontSize: 14, cursor: 'pointer', boxShadow: '0 2px 8px rgba(22,163,74,0.25)' }}
          >
            <Plus size={16} /> Ghi chú
          </button>
        )}
      </div>

      {/* ── Tab Switcher (admin only — staff always on Bảng Công) ── */}
      {currentUser.role === 'admin' && (
        <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e5e7eb', background: 'white' }}>
          {[
            { key: 'notes', label: '📋 Sổ Tay' },
            { key: 'cong', label: '⏰ Bảng Công' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => { setActiveNotesTab(tab.key); if (tab.key === 'cong') fetchEmpData(currentUser.id); }}
              style={{ flex: 1, padding: '10px', border: 'none', background: 'none', fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer', color: activeNotesTab === tab.key ? '#dc2626' : '#6b7280', borderBottom: activeNotesTab === tab.key ? '2px solid #dc2626' : '2px solid transparent', marginBottom: -2, transition: 'all 0.15s' }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Date Filter ── */}
      <div style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb', padding: '10px 16px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', flexShrink: 0 }}>Lọc:</span>

        {/* Day dropdown */}
        <select
          value={filterDay}
          onChange={e => setFilterDay(e.target.value)}
          style={{ padding: '6px 8px', border: '1.5px solid', borderColor: filterDay ? '#2563eb' : '#d1d5db', borderRadius: 8, fontSize: 13, outline: 'none', background: filterDay ? '#eff6ff' : 'white', color: '#111827', cursor: 'pointer' }}
        >
          <option value="">Ngày</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
            <option key={d} value={String(d)}>Ngày {d}</option>
          ))}
        </select>

        {/* Month dropdown */}
        <select
          value={filterMonth}
          onChange={e => setFilterMonth(e.target.value)}
          style={{ padding: '6px 8px', border: '1.5px solid', borderColor: filterMonth ? '#2563eb' : '#d1d5db', borderRadius: 8, fontSize: 13, outline: 'none', background: filterMonth ? '#eff6ff' : 'white', color: '#111827', cursor: 'pointer' }}
        >
          <option value="">Tháng</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
            <option key={m} value={String(m)}>Tháng {m}</option>
          ))}
        </select>

        {/* Year: datalist + free input for last 10 years */}
        <input
          list="year-options"
          placeholder="Năm"
          value={filterYear}
          onChange={e => setFilterYear(e.target.value)}
          style={{ width: 82, padding: '6px 8px', border: '1.5px solid', borderColor: filterYear ? '#2563eb' : '#d1d5db', borderRadius: 8, fontSize: 13, outline: 'none', textAlign: 'center', background: filterYear ? '#eff6ff' : 'white' }}
        />
        <datalist id="year-options">
          {Array.from({ length: 10 }, (_, i) => now.getFullYear() - i).map(y => (
            <option key={y} value={String(y)} />
          ))}
        </datalist>

        <button
          onClick={() => { setFilterDay(''); setFilterMonth(String(now.getMonth() + 1)); setFilterYear(String(now.getFullYear())); }}
          style={{ fontSize: 12, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '4px 2px', whiteSpace: 'nowrap' }}
        >
          Tháng này
        </button>
        <button
          onClick={() => { setFilterDay(''); setFilterMonth(''); setFilterYear(''); }}
          style={{ fontSize: 12, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: '4px 2px' }}
        >
          Tất cả
        </button>
      </div>

      {/* ══ BẢNG CÔNG (employee only) ══ */}
      {activeNotesTab === 'cong' && currentUser.role !== 'admin' && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Chấm công */}
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
            <div style={{ fontWeight: 800, fontSize: '1rem', marginBottom: 12 }}>⏰ Chấm công hôm nay</div>
            {!todayAttendance ? (
              <button onClick={handleClockIn} style={{ width: '100%', padding: '14px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer' }}>🟢 Bắt đầu ca làm</button>
            ) : !todayAttendance.clock_out ? (
              <div>
                <div style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: 10 }}>✅ Đã vào lúc <strong>{new Date(todayAttendance.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</strong></div>
                <button onClick={handleClockOut} style={{ width: '100%', padding: '14px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 10, fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer' }}>🔴 Kết thúc ca</button>
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.85rem', color: '#6b7280' }}>Vào: <strong>{new Date(todayAttendance.clock_in).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</strong> → Ra: <strong>{new Date(todayAttendance.clock_out).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</strong></div>
                <div style={{ marginTop: 6, fontWeight: 700 }}>⏱ <span style={{ color: '#15803d' }}>{todayAttendance.work_hours}h</span>{todayAttendance.overtime_hours > 0 && <span style={{ color: '#f59e0b' }}> • Tăng ca: {todayAttendance.overtime_hours}h</span>}</div>
                <div style={{ marginTop: 4, color: '#16a34a', fontWeight: 700 }}>✅ Đã hoàn thành ca hôm nay</div>
              </div>
            )}
          </div>
          {/* Ứng lương */}
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showAdvForm ? 12 : 0 }}>
              <div style={{ fontWeight: 800 }}>💵 Xin Ứng Lương</div>
              <button onClick={() => setShowAdvForm(p => !p)} style={{ fontSize: '0.8rem', background: showAdvForm ? '#f3f4f6' : '#111827', color: showAdvForm ? '#374151' : 'white', border: 'none', borderRadius: 8, padding: '5px 12px', fontWeight: 700, cursor: 'pointer' }}>{showAdvForm ? 'Huỷ' : '+ Tạo yêu cầu'}</button>
            </div>
            {showAdvForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input type="text" inputMode="numeric" placeholder="Số tiền ứng (đ)" value={advanceForm.amount} onChange={e => { const r = e.target.value.replace(/\./g,'').replace(/\D/g,''); setAdvanceForm(p => ({ ...p, amount: r ? Number(r).toLocaleString('vi-VN') : '' })); }} style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem' }} />
                <textarea placeholder="Lý do cần ứng..." value={advanceForm.reason} onChange={e => setAdvanceForm(p => ({ ...p, reason: e.target.value }))} style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem', minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} />
                <button onClick={handleSubmitAdvance} style={{ background: '#16a34a', color: 'white', border: 'none', borderRadius: 9, padding: '11px', fontWeight: 800, cursor: 'pointer' }}>Gửi yêu cầu</button>
              </div>
            )}
          </div>
          {/* Báo nghỉ */}
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showAbsForm ? 12 : 0 }}>
              <div style={{ fontWeight: 800 }}>🏖 Báo Nghỉ</div>
              <button onClick={() => setShowAbsForm(p => !p)} style={{ fontSize: '0.8rem', background: showAbsForm ? '#f3f4f6' : '#111827', color: showAbsForm ? '#374151' : 'white', border: 'none', borderRadius: 8, padding: '5px 12px', fontWeight: 700, cursor: 'pointer' }}>{showAbsForm ? 'Huỷ' : '+ Báo nghỉ'}</button>
            </div>
            {showAbsForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input type="number" min="0.5" max="30" step="0.5" placeholder="Số ngày nghỉ" value={absentForm.days} onChange={e => setAbsentForm(p => ({ ...p, days: e.target.value }))} style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem' }} />
                <textarea placeholder="Lý do nghỉ..." value={absentForm.reason} onChange={e => setAbsentForm(p => ({ ...p, reason: e.target.value }))} style={{ padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.9rem', minHeight: 70, resize: 'vertical', fontFamily: 'inherit' }} />
                <button onClick={handleSubmitAbsent} style={{ background: '#f59e0b', color: 'white', border: 'none', borderRadius: 9, padding: '11px', fontWeight: 800, cursor: 'pointer' }}>Gửi báo nghỉ</button>
              </div>
            )}
          </div>
          {/* Lịch sử yêu cầu */}
          {empRequests.length > 0 && (
            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 18 }}>
              <div style={{ fontWeight: 800, marginBottom: 10 }}>📄 Yêu cầu tháng {now.getMonth() + 1}</div>
              {empRequests.map(r => (
                <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{r.request_type === 'advance' ? `💵 Ứng ${Number(r.amount || 0).toLocaleString('vi-VN')}đ` : `🏖 Nghỉ ${r.days} ngày`}</div>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 2 }}>{r.reason}</div>
                    {r.admin_note && <div style={{ fontSize: '0.73rem', color: '#9ca3af', marginTop: 2 }}>💬 {r.admin_note}</div>}
                  </div>
                  <span style={{ flexShrink: 0, padding: '2px 8px', borderRadius: 5, fontSize: '0.72rem', fontWeight: 700, background: r.status === 'approved' ? '#dcfce7' : r.status === 'rejected' ? '#fee2e2' : '#fef9c3', color: r.status === 'approved' ? '#15803d' : r.status === 'rejected' ? '#dc2626' : '#92400e' }}>
                    {r.status === 'pending' ? '⏳ Chờ' : r.status === 'approved' ? '✅ Duyệt' : '❌ Từ chối'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══ NOTES content ══ */}
      {(currentUser.role === 'admin' || activeNotesTab === 'notes') && (<>

      {/* ── Staff Filter (admin only) ── */}
      {currentUser.role === 'admin' && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '8px 16px', background: 'white', borderBottom: '1px solid #f3f4f6' }}>
          {['ALL', ...Array.from(new Set(notes.map(n => n.staff?.full_name).filter(Boolean)))].map(name => (
            <button
              key={name}
              onClick={() => setSelectedStaff(name)}
              style={{ flexShrink: 0, padding: '5px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1.5px solid', whiteSpace: 'nowrap',
                background: selectedStaff === name ? '#dc2626' : 'white',
                color: selectedStaff === name ? 'white' : '#374151',
                borderColor: selectedStaff === name ? '#dc2626' : '#e5e7eb' }}
            >
              {name === 'ALL' ? 'Tất cả' : name}
            </button>
          ))}
        </div>
      )}

      {/* ── Analytics Card ── */}
      <div style={{ margin: '12px 16px', borderRadius: 14, background: 'linear-gradient(135deg, #f8faff, #eef2ff)', border: '1px solid #e0e7ff', padding: '14px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FileText size={15} style={{ color: '#4f46e5' }} />
            <span style={{ fontWeight: 700, fontSize: 13, color: '#1e1b4b' }}>Thống kê · {filterLabel}</span>
          </div>
          {selectedStaff !== 'ALL' && currentUser.role === 'admin' && (
            <span style={{ fontSize: 11, background: '#e0e7ff', color: '#4338ca', padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>{selectedStaff}</span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: totalOrigDebt > 0 ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
          <div style={{ background: 'white', borderRadius: 10, padding: '10px 12px', border: '1px solid #e0e7ff' }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4, fontWeight: 500 }}>💰 Tổng đã chi</div>
            <div style={{ fontWeight: 800, color: '#16a34a', fontSize: 15, lineHeight: 1 }}>{formatMoney(totalSpent)}</div>
          </div>
          {totalOrigDebt > 0 && (
            <div style={{ background: 'white', borderRadius: 10, padding: '10px 12px', border: '1px solid #fed7aa' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4, fontWeight: 500 }}>📋 Tổng nợ ban đầu</div>
              <div style={{ fontWeight: 800, color: '#92400e', fontSize: 15, lineHeight: 1 }}>{formatMoney(totalOrigDebt)}</div>
            </div>
          )}
          <div style={{ background: totalDebt > 0 ? '#fff1f2' : 'white', borderRadius: 10, padding: '10px 12px', border: `1px solid ${totalDebt > 0 ? '#fca5a5' : '#bbf7d0'}` }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4, fontWeight: 500 }}>{totalDebt > 0 ? '⚠️ Còn nợ' : '✅ Đã trả đủ'}</div>
            <div style={{ fontWeight: 800, color: totalDebt > 0 ? '#dc2626' : '#16a34a', fontSize: 15, lineHeight: 1 }}>{formatMoney(totalDebt)}</div>
          </div>
        </div>
      </div>

      {/* ── Notes Grid ── */}
      <div style={{ padding: '0 12px 24px' }}>
        {filteredByDate.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: '#9ca3af' }}>
            <CheckCircle size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <p style={{ fontSize: 14 }}>Không có ghi chú nào trong khoảng này.</p>
          </div>
        ) : (
          <div className="notes-masonry">
            {filteredByDate.map(note => {
              const staffName = currentUser.role === 'admin' ? (note.staff?.full_name || 'Không rõ') : 'Báo cáo của bạn';
              const debtRemaining = (note.debt || 0) - (note.paid_debt || 0);
              const hasDebt = debtRemaining > 0;
              const debtCleared = note.paid_debt > 0 && debtRemaining === 0;
              const hasTable = note.note_type === 'expense' && note.content?.includes('structured_expense');

              const cardStyle = hasDebt
                ? { background: '#fef2f2', border: '1.5px solid #fca5a5' }
                : debtCleared
                ? { background: '#f0fdf4', border: '1.5px solid #86efac' }
                : { border: '1px solid #e5e7eb' };

              const noteTypeMap = {
                expense: { label: '🛒 Đi chợ / Chi tiền',       bg: '#fff7ed', color: '#ea580c', border: '#fed7aa' },
                stock:   { label: '📦 Báo thiếu nguyên liệu',   bg: '#f0f9ff', color: '#0369a1', border: '#bae6fd' },
                repair:  { label: '🔧 Yêu cầu sửa chữa',        bg: '#faf5ff', color: '#7c3aed', border: '#ddd6fe' },
                other:   { label: '📝 Ghi chú khác',             bg: '#f9fafb', color: '#374151', border: '#d1d5db' },
              };
              const typeInfo = noteTypeMap[note.note_type] || noteTypeMap.other;

              return (
                <div
                  key={note.id}
                  className={`note-card-keep${hasTable ? ' has-table' : ''}`}
                  style={cardStyle}
                  onClick={() => setViewingNote(note)}
                >
                  {/* Type label — flush top of card */}
                  <div style={{ margin: '-16px -16px 0 -16px', padding: '3px 14px', background: typeInfo.bg, borderBottom: `1px solid ${typeInfo.border}`, borderRadius: '12px 12px 0 0', fontSize: 9.5, fontWeight: 600, color: typeInfo.color }}>
                    {typeInfo.label}
                  </div>

                  {/* Card header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{staffName}</div>
                      <div style={{ fontSize: 12, color: '#0369a1', marginTop: 2, fontWeight: 700 }}>{formatDate(note.created_at)}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      {hasDebt && <span style={{ fontSize: 10, background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 6, padding: '2px 6px', fontWeight: 700, flexShrink: 0 }}>Nợ</span>}
                      {debtCleared && <span style={{ fontSize: 10, background: '#dcfce7', color: '#16a34a', border: '1px solid #86efac', borderRadius: 6, padding: '2px 6px', fontWeight: 700, flexShrink: 0 }}>✓ Xong</span>}
                    </div>
                  </div>

                  {/* Body */}
                  {note.note_type !== 'expense' ? (
                    /* Stock: always show preview, max 3 lines, tap hint if longer */
                    (() => {
                      const lines = (note.content || '').split('\n').filter(l => l.trim());
                      const isLong = lines.length > 3;
                      return (
                        <>
                          <div style={{
                            fontSize: 12.5, color: '#0c4a6e', marginTop: 4, marginBottom: 2,
                            whiteSpace: 'pre-wrap',
                            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                            overflow: 'hidden', lineHeight: 1.5,
                          }}>
                            {note.content}
                          </div>
                          {isLong && (
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>👆 Bấm để xem chi tiết</div>
                          )}
                        </>
                      );
                    })()
                  ) : (
                    <>
                      <div className="keep-body hide-on-mobile">
                        {renderNoteContent(note.content)}
                      </div>
                      {/* Mobile: tap hint always shown for non-stock */}
                      <div className="mobile-tap-hint">
                        👆 Bấm để xem chi tiết
                      </div>
                    </>
                  )}

                  {/* Footer tags - always show debt info */}
                  {(note.amount > 0 || note.debt > 0) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {(() => {
                        const totalSpentOnNote = (note.amount || 0) + (note.paid_debt || 0);
                        if (totalSpentOnNote <= 0) return null;
                        return (
                          <span className="keep-tag" style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>
                            💰 Đã chi: {formatMoney(totalSpentOnNote)}
                          </span>
                        );
                      })()}
                      {hasDebt && (
                        <span className="keep-tag" style={{ background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', fontWeight: 700 }}>⚠️ Còn nợ: {formatMoney(debtRemaining)}</span>
                      )}
                      {debtCleared && (
                        <span className="keep-tag" style={{ background: '#dcfce7', color: '#16a34a', border: '1px solid #86efac', fontWeight: 700 }}>✅ Đã trả đủ</span>
                      )}
                    </div>
                  )}

                  {/* Delete button (admin) */}
                  {currentUser.role === 'admin' && (
                    <button className="btn-delete-keep" onClick={e => { e.stopPropagation(); handleDeleteNote(note.id); }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── View Note Modal ── */}
      {viewingNote && (
        <div className="modal-overlay" onClick={() => setViewingNote(null)}>
        <div className="modal-content keep-modal" onClick={e => e.stopPropagation()} style={{
          maxWidth: '500px',
          border: (() => {
            const dr = (viewingNote.debt || 0) - (viewingNote.paid_debt || 0);
            if (dr > 0) return '2px solid #fca5a5';
            if ((viewingNote.paid_debt || 0) > 0 && dr <= 0) return '2px solid #86efac';
            return undefined;
          })()
        }}>
            <div className="modal-header" style={{ borderBottom: '1px solid #e5e7eb', paddingBottom: 12, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ fontWeight: 700, fontSize: 17, color: '#111827', margin: 0 }}>{currentUser.role === 'admin' ? (viewingNote.staff?.full_name || 'Không rõ') : 'Báo cáo của bạn'}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>{formatDate(viewingNote.created_at)}</span>
                  {(() => {
                    const tm = { expense: { label: '🛒 Đi chợ / Chi tiền', bg: '#fff7ed', color: '#ea580c', border: '#fed7aa' }, stock: { label: '📦 Báo thiếu nguyên liệu', bg: '#f0f9ff', color: '#0369a1', border: '#bae6fd' }, repair: { label: '🔧 Yêu cầu sửa chữa', bg: '#faf5ff', color: '#7c3aed', border: '#ddd6fe' }, other: { label: '📝 Ghi chú khác', bg: '#f9fafb', color: '#374151', border: '#d1d5db' } };
                    const t = tm[viewingNote.note_type] || tm.other;
                    return <span style={{ fontSize: 11, background: t.bg, color: t.color, border: `1px solid ${t.border}`, borderRadius: 6, padding: '2px 8px', fontWeight: 700 }}>{t.label}</span>;
                  })()}
                </div>
              </div>
              <button style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: 4 }} onClick={() => setViewingNote(null)}>
                <XCircle size={24} />
              </button>
            </div>
            <div className="modal-body">
              <div style={{ marginBottom: 20, padding: 16, background: 'white', borderRadius: 12, border: '1px solid #f3f4f6', overflowX: 'auto' }}>
                {renderNoteContent(viewingNote.content)}
              </div>
              {(viewingNote.amount > 0 || viewingNote.debt > 0) && (() => {
                const vDebtRemain = Math.max(0, (viewingNote.debt || 0) - (viewingNote.paid_debt || 0));
                const vHasDebt = vDebtRemain > 0;
                const vCleared = (viewingNote.paid_debt || 0) > 0 && vDebtRemain === 0;
                return (
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: 8, padding: 14, borderRadius: 10, marginBottom: 16,
                    background: vHasDebt ? '#fef2f2' : vCleared ? '#f0fdf4' : '#f9fafb',
                    border: `1.5px solid ${vHasDebt ? '#fca5a5' : vCleared ? '#86efac' : '#e5e7eb'}`
                  }}>
                    {viewingNote.amount > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 500 }}>
                        <span style={{ color: '#6b7280' }}>Thực chi:</span>
                        <span style={{ color: '#111827' }}>{formatMoney(viewingNote.amount)}</span>
                      </div>
                    )}
                    {viewingNote.paid_debt > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 500 }}>
                        <span style={{ color: '#6b7280' }}>Đã trả nợ:</span>
                        <span style={{ color: '#16a34a' }}>{formatMoney(viewingNote.paid_debt)}</span>
                      </div>
                    )}
                    {viewingNote.debt > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, paddingTop: 8, borderTop: `1px solid ${vHasDebt ? '#fca5a5' : '#86efac'}` }}>
                        <span style={{ color: vHasDebt ? '#dc2626' : '#16a34a' }}>{vHasDebt ? '⚠️ Còn nợ:' : '✅ Đã trả đủ'}</span>
                        <span style={{ color: vHasDebt ? '#dc2626' : '#16a34a' }}>{formatMoney(vDebtRemain)}</span>
                      </div>
                    )}
                  </div>
                );
              })()}
              {viewingNote.status === 'approved' && viewingNote.debt > (viewingNote.paid_debt || 0) && !payDebtNoteId && (
                <button
                  style={{ width: '100%', padding: '12px', background: '#fff', border: '1.5px solid #fca5a5', borderRadius: 10, color: '#dc2626', fontWeight: 700, cursor: 'pointer', marginBottom: 16 }}
                  onClick={() => setPayDebtNoteId(viewingNote.id)}
                >
                  Báo cáo: Đã trả phần nợ này!
                </button>
              )}
              {payDebtNoteId === viewingNote.id && (
                <div style={{ marginBottom: 16, padding: 14, border: '1.5px solid #fca5a5', background: '#fef2f2', borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, color: '#dc2626', fontSize: 13, marginBottom: 10 }}>Nhập số tiền vừa trả nợ:</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number"
                      style={{ flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, outline: 'none' }}
                      placeholder="VD: 50000"
                      value={payDebtAmount}
                      onChange={e => setPayDebtAmount(e.target.value)}
                      autoFocus
                    />
                    <button
                      style={{ background: '#16a34a', color: 'white', border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 700, cursor: 'pointer' }}
                      disabled={isLoading}
                      onClick={() => handlePayDebt(viewingNote)}
                    >
                      Lưu
                    </button>
                  </div>
                  <button style={{ fontSize: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', marginTop: 8 }} onClick={() => { setPayDebtNoteId(null); setPayDebtAmount(''); }}>Huỷ</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Add Note Modal ── */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '450px' }}>
            <div className="modal-header">
              <h3>Tạo báo cáo / ghi chú mới</h3>
              <button className="btn btn-icon btn-ghost" onClick={() => setShowAddModal(false)}><XCircle size={20} /></button>
            </div>
            <div className="modal-body">
              <div className="form-group mb-4">
                <label className="form-label">Loại báo cáo</label>
                <select className="input" value={newNoteType} onChange={e => setNewNoteType(e.target.value)}>
                  <option value="expense">Đi chợ / Chi tiền</option>
                  <option value="stock">Báo thiếu nguyên liệu</option>
                  <option value="repair">Yêu cầu sửa chữa</option>
                  <option value="other">Ghi chú khác</option>
                </select>
              </div>
              {newNoteType === 'expense' ? (
                <div className="expense-fields-container mb-4">
                  <label className="form-label mb-2 block">Chi tiết mua hàng</label>
                  <div className="flex flex-col gap-3">
                    {expenseItems.map((item, idx) => (
                      <div key={idx} className="expense-row">
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <input type="text" className="expense-input-clean" style={{ flex: 1, minWidth: 100 }}
                            placeholder={idx === expenseItems.length - 1 && !item.name ? 'Nhập tên đồ...' : 'Tên món'}
                            value={item.name} onChange={e => updateExpenseItem(idx, 'name', e.target.value)} />
                          <input type="text" className="expense-input-clean" style={{ width: 72, textAlign: 'center' }}
                            placeholder="Giá" value={item.price} onChange={e => updateExpenseItem(idx, 'price', e.target.value)} onBlur={e => handleExpenseBlur(idx, 'price', e)} />
                          <input type="text" className="expense-input-clean" style={{ width: 72, textAlign: 'center' }}
                            placeholder="SL/Ký" value={item.qty} onChange={e => updateExpenseItem(idx, 'qty', e.target.value)} onBlur={e => handleExpenseBlur(idx, 'qty', e)} />
                          {expenseItems.length > 1 && idx < expenseItems.length - 1 && (
                            <button className="btn-remove-row" onClick={() => removeExpenseItem(idx)}><XCircle size={16} /></button>
                          )}
                        </div>
                        {/* Live total per item */}
                        {(() => {
                          const p = parseVal(item.price);
                          const q = parseVal(item.qty, true) || 1;
                          const t = p * q;
                          if (t <= 0) return null;
                          const isDebtItem = item.paymentStatus === 'debt';
                          return (
                            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: isDebtItem ? '#dc2626' : '#15803d', marginTop: 3, paddingLeft: 2 }}>
                              = {formatMoney(t)} {isDebtItem ? '🔴 (Nợ)' : '✓'}
                            </div>
                          );
                        })()}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          <div className="expense-status-wrapper" style={{ flexShrink: 0 }}>
                            <label className={`status-label ${item.paymentStatus === 'full' ? 'checked-full' : ''}`}>
                              <input type="radio" name={`s-${idx}`} checked={item.paymentStatus === 'full'} onChange={() => updateExpenseItem(idx, 'paymentStatus', 'full')} /> ✓ Đủ
                            </label>
                            <label className={`status-label ${item.paymentStatus === 'debt' ? 'checked-debt' : ''}`}>
                              <input type="radio" name={`s-${idx}`} checked={item.paymentStatus === 'debt'} onChange={() => updateExpenseItem(idx, 'paymentStatus', 'debt')} /> Nợ
                            </label>
                          </div>
                          {item.paymentStatus === 'debt' && (() => {
                            const p = parseVal(item.price);
                            const q = parseVal(item.qty, true) || 1;
                            const cap = p * q;
                            return (<>
                              <input
                                type="text" inputMode="numeric"
                                className="expense-input-clean"
                                style={{ width: 100, textAlign: 'right', flexShrink: 0 }}
                                placeholder={cap > 0 ? cap.toLocaleString('vi-VN') : 'Số tiền nợ'}
                                value={item.debtAmount || ''}
                                onChange={e => {
                                  const raw = e.target.value.replace(/\./g, '').replace(/[^0-9]/g, '');
                                  const num = Number(raw);
                                  if (cap > 0 && num > cap) { updateExpenseItem(idx, 'debtAmount', cap.toLocaleString('vi-VN')); return; }
                                  updateExpenseItem(idx, 'debtAmount', raw ? num.toLocaleString('vi-VN') : '');
                                }}
                              />
                              <input type="text" className="expense-input-clean" style={{ flex: 1, minWidth: 70 }} placeholder="Nợ của ai?" value={item.creditor} onChange={e => updateExpenseItem(idx, 'creditor', e.target.value)} />
                            </>);
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                  {(calculateTotals().paid > 0 || calculateTotals().debt > 0) && (
                    <div style={{ marginTop: 12, padding: '10px 14px', background: '#fff7ed', borderRadius: 10, border: '1px solid #fed7aa', fontSize: 13 }}>
                      <div style={{ fontWeight: 700, color: '#c2410c', marginBottom: 6 }}>Tổng kết:</div>
                      <div style={{ display: 'flex', gap: 16 }}>
                        <span>Thực chi: <strong style={{ color: '#16a34a' }}>{formatMoney(calculateTotals().paid)}</strong></span>
                        <span>Nợ: <strong style={{ color: '#dc2626' }}>{formatMoney(calculateTotals().debt)}</strong></span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="form-group mb-4">
                  <label className="form-label">Chi tiết</label>
                  <textarea className="input" rows="5" placeholder="Nhập chi tiết..." value={newNoteContent} onChange={handleContentChange} onKeyDown={handleContentKeyDown} />
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '12px 16px', borderTop: '1px solid #f3f4f6' }}>
              <button className="btn btn-outline" onClick={() => setShowAddModal(false)}>Huỷ</button>
              <button className="btn btn-primary" style={{ padding: '10px 24px' }} onClick={submitNewNote} disabled={isLoading}>{isLoading ? 'Đang gửi...' : 'Gửi đi'}</button>
            </div>
          </div>
        </div>
      )}

      </>)}

    </div>
  );
}
