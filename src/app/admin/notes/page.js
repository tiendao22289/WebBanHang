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

  // Pay Debt State
  const [payDebtNoteId, setPayDebtNoteId] = useState(null);
  const [payDebtAmount, setPayDebtAmount] = useState('');

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
          totalDebt += totalItemPrice;
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
      setExpenseItems([{ name: '', price: '', qty: '', paymentStatus: 'full', creditor: '' }]);
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

      // Recover JSON if a log was appended raw
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
        return (
          <div className="flex flex-col gap-2 w-full mt-1">
            {data.note && <div className="text-blue-600 bg-blue-50 p-2 rounded block text-sm mb-2 whitespace-pre-wrap font-medium border border-blue-100 italic">{data.note}</div>}
            {trailingLog && <div className="text-amber-700 italic text-sm mb-2 whitespace-pre-wrap">{trailingLog}</div>}
            
            <div className="flex flex-col gap-0 border-t-2 border-b-2 border-red-500 mt-2">
              <div className="flex justify-between items-center text-[11px] font-semibold text-gray-500 uppercase border-b border-red-500 bg-red-50/30">
                <div className="w-[35%] py-1.5 px-2">Tên món</div>
                <div className="w-[20%] text-right py-1.5 px-2 border-l border-red-500">Giá</div>
                <div className="w-[10%] text-center py-1.5 px-2 border-l border-red-500">SL</div>
                <div className="w-[20%] text-right py-1.5 px-2 border-l border-red-500">Tổng</div>
                <div className="w-[15%] text-center py-1.5 px-2 border-l border-red-500">Trạng thái</div>
              </div>
              
              {data.items.map((item, idx) => {
                const p = parseVal(item.price);
                const q = parseVal(item.qty, true) || 1;
                const total = p * q;
                
                return (
                  <div key={idx} className="flex justify-between items-stretch text-xs sm:text-sm border-b border-gray-100 last:border-0 bg-white hover:bg-slate-50 transition-colors">
                    <div className="w-[35%] font-bold text-[#115e59] break-words text-[13px] sm:text-[15px] py-1.5 px-2">
                      {item.name}
                    </div>
                    <div className="w-[20%] text-right text-[#ea580c] font-medium py-1.5 px-2 border-l border-red-500 flex items-center justify-end">
                      {p > 0 ? formatMoney(p).replace('₫', '') : '-'}
                    </div>
                    <div className="w-[10%] text-center text-[#9333ea] font-bold py-1.5 px-2 border-l border-red-500 flex items-center justify-center">
                      {item.qty || 1}
                    </div>
                    <div className="w-[20%] text-right text-[#be123c] font-bold text-[13px] sm:text-[15px] py-1.5 px-2 border-l border-red-500 flex items-center justify-end">
                      {total > 0 ? formatMoney(total).replace('₫', '') : '-'}
                    </div>
                    <div className="w-[15%] text-center py-1.5 px-1 border-l border-red-500 flex items-center justify-center">
                      {item.paymentStatus === 'debt' ? (
                        <span className="text-[10px] text-red-500 font-bold bg-white px-0.5 rounded whitespace-nowrap">Nợ</span>
                      ) : (
                        <span className="text-[10px] text-green-600 font-bold bg-white px-0.5 rounded whitespace-nowrap">Đủ</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      }
    } catch {}

    // Fallback for old simple text format
    return <div className="text-gray-700 whitespace-pre-wrap">{content}</div>;
  };

  const formatDate = (isoString) => {
    const date = new Date(isoString);
    return date.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
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

  // Logged In - Notes Screen
  return (
    <div className="notes-container">
      {/* Top compact Header */}
      <div className="notes-header px-4 py-3 flex justify-between items-center bg-white sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-2 bg-gray-100 rounded-full pr-3 pl-1 py-1">
          <div className="w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center font-bold text-sm">
            {currentUser.full_name.charAt(0)}
          </div>
          <span className="text-sm font-semibold text-gray-800 hidden sm:inline-block">{currentUser.full_name}</span>
          <span className="text-sm font-semibold text-gray-800 sm:hidden">{currentUser.full_name.split(' ').pop()}</span>
          <div className="w-[1px] h-4 bg-gray-300 mx-1"></div>
          <button className="text-red-500 hover:text-red-700 flex items-center justify-center p-1" onClick={handleLogout} title="Thoát">
            <LogOut size={16} />
          </button>
        </div>
        
        <button 
          className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-full text-sm font-bold shadow-sm transition-colors" 
          onClick={() => setShowAddModal(true)}
        >
          <Plus size={18} /> Ghi chú
        </button>
      </div>

      {/* Admin: Staff Filter Bar */}
      {currentUser.role === 'admin' && (
        <div className="px-4 py-2 flex gap-2 overflow-x-auto hide-scrollbar whitespace-nowrap bg-gray-50 border-b border-gray-100">
          <button 
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${selectedStaff === 'ALL' ? 'bg-primary text-white shadow-sm' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-100'}`}
            onClick={() => setSelectedStaff('ALL')}
          >
            Tất cả thẻ
          </button>
          {Array.from(new Set(notes.map(n => n.staff?.full_name).filter(Boolean))).map(name => (
            <button 
              key={name}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${selectedStaff === name ? 'bg-primary text-white shadow-sm' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-100'}`}
              onClick={() => setSelectedStaff(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Analytics Row */}
      {(() => {
        const currentMonth = new Date().getMonth();
        const currentYear = new Date().getFullYear();
        
        const filteredNotes = notes.filter(n => {
           const d = new Date(n.created_at);
           const isThisMonth = d.getMonth() === currentMonth && d.getFullYear() === currentYear;
           const isStaffMatch = selectedStaff === 'ALL' || n.staff?.full_name === selectedStaff;
           return isThisMonth && (currentUser.role !== 'admin' || isStaffMatch);
        });
        
        const totalSpent = filteredNotes.reduce((acc, n) => acc + (n.amount || 0), 0);
        const totalDebt = filteredNotes.reduce((acc, n) => acc + ((n.debt || 0) - (n.paid_debt || 0)), 0);
        
        return (
          <div className="mx-4 mt-3 mb-2 p-4 rounded-xl shadow-sm border border-slate-200" style={{ background: 'linear-gradient(135deg, #f8fafc, #f1f5f9)' }}>
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-bold text-slate-800 text-sm flex items-center gap-1.5"><FileText size={16} className="text-primary"/> Thống kê Tháng {currentMonth + 1}/{currentYear}</h3>
              {selectedStaff !== 'ALL' && currentUser.role === 'admin' && <span className="text-xs bg-slate-200 px-2 py-0.5 rounded-md text-slate-700 font-medium">{selectedStaff}</span>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white p-3 rounded-lg shadow-sm border border-slate-100">
                <div className="text-xs text-slate-500 mb-1 font-medium">Tổng thực chi</div>
                <div className="font-bold text-green-600 text-lg leading-none">{formatMoney(totalSpent)}</div>
              </div>
              <div className="bg-white p-3 rounded-lg shadow-sm border border-red-50">
                <div className="text-xs text-slate-500 mb-1 font-medium">Tổng nợ tồn</div>
                <div className="font-bold text-red-600 text-lg leading-none">{formatMoney(totalDebt)}</div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Main Content Grid - Masonry */}
      <div className="notes-content pt-2">
        {notes.length === 0 ? (
          <div className="empty-state text-center p-12 text-gray-400">
            <CheckCircle size={48} className="mx-auto mb-4 opacity-50" />
            <p>Chưa có ghi chú hoặc báo cáo nào.</p>
          </div>
        ) : (
          <div className="notes-masonry">
            {notes.filter(n => currentUser.role !== 'admin' || selectedStaff === 'ALL' || n.staff?.full_name === selectedStaff).map(note => {
              const staffName = currentUser.role === 'admin' ? (note.staff?.full_name || 'Không rõ') : 'Báo cáo của bạn';
              
              // Resolve real debt
              const debtRemaining = (note.debt || 0) - (note.paid_debt || 0);

              let cardBgClass = 'bg-white';
              if (debtRemaining > 0) cardBgClass = 'bg-red-50 border-red-200';
              else if (note.paid_debt > 0 && debtRemaining === 0) cardBgClass = 'bg-[#f0fdf4] border-green-200'; // light green

              return (
                <div key={note.id} className={`note-card-keep ${cardBgClass} transition-shadow hover:shadow-md`} onClick={() => setViewingNote(note)}>
                  <div className="keep-card-header">
                    <div className="keep-author">{staffName}</div>
                    <div className="keep-date text-[#0369a1] font-medium">{formatDate(note.created_at)}</div>
                  </div>
                  
                  <div className="keep-body">
                    {renderNoteContent(note.content)}
                  </div>
                  
                  {(note.amount > 0 || note.debt > 0) && (
                    <div className="keep-footer">
                      {note.amount > 0 && <span className="keep-tag bg-green-50 text-green-700 border-green-100 font-medium shadow-sm">Chi: {formatMoney(note.amount)}</span>}
                      {debtRemaining > 0 && <span className="keep-tag bg-red-100 text-red-700 border-red-200 font-bold shadow-sm">Nợ: {formatMoney(debtRemaining)}</span>}
                      {note.paid_debt > 0 && debtRemaining === 0 && <span className="keep-tag bg-green-100 text-green-700 border-green-200 font-bold shadow-sm">Đã trả nợ xanh</span>}
                    </div>
                  )}
                  
                  {currentUser.role === 'admin' && (
                    <button 
                      className="btn-delete-keep" 
                      onClick={(e) => { e.stopPropagation(); handleDeleteNote(note.id); }}
                      title="Xoá ghi chú"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* View Note Modal */}
      {viewingNote && (
        <div className="modal-overlay" onClick={() => setViewingNote(null)}>
          <div className="modal-content keep-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="modal-header border-b pb-3 mb-4">
              <div>
                <h3 className="text-xl font-bold text-gray-900">{currentUser.role === 'admin' ? (viewingNote.staff?.full_name || 'Không rõ') : 'Báo cáo của bạn'}</h3>
                <div className="text-sm text-gray-500 mt-1">{formatDate(viewingNote.created_at)}</div>
              </div>
              <button className="btn-icon text-gray-400 hover:text-gray-700" onClick={() => setViewingNote(null)}>
                <XCircle size={24} />
              </button>
            </div>
            
            <div className="modal-body">
              <div className="keep-modal-content mb-6 p-4 bg-white rounded-xl shadow-sm border border-gray-100">
                {renderNoteContent(viewingNote.content)}
              </div>
              
              {(viewingNote.amount > 0 || viewingNote.debt > 0) && (
                <div className="flex flex-col gap-2 p-4 bg-gray-50 rounded-lg mb-6">
                  {viewingNote.amount > 0 && (
                    <div className="flex justify-between font-medium">
                      <span className="text-gray-600">Thực chi lúc đầu:</span>
                      <span className="text-gray-800">{formatMoney(viewingNote.amount)}</span>
                    </div>
                  )}
                  {viewingNote.debt > 0 && (
                    <div className="flex justify-between font-medium pt-2 border-t border-gray-200 mt-2">
                      <span className="text-gray-600">Còn nợ:</span>
                      <span className="text-red-600 font-bold">{formatMoney((viewingNote.debt || 0) - (viewingNote.paid_debt || 0))}</span>
                    </div>
                  )}
                  {viewingNote.paid_debt > 0 && (
                    <div className="flex justify-between text-sm text-gray-500 mt-1">
                      <span>(Đã trả nợ: {formatMoney(viewingNote.paid_debt)})</span>
                    </div>
                  )}
                </div>
              )}

              {viewingNote.status === 'approved' && viewingNote.debt > (viewingNote.paid_debt || 0) && !payDebtNoteId && (
                <div className="mb-6">
                  <button 
                    className="w-full py-3 bg-red-100 text-red-700 font-bold rounded-xl shadow-sm border border-red-200 hover:bg-red-200 transition-colors"
                    onClick={() => setPayDebtNoteId(viewingNote.id)}
                  >
                    Báo cáo: Đã trả phần nợ này!
                  </button>
                </div>
              )}
              
              {payDebtNoteId === viewingNote.id && (
                <div className="mb-6 p-4 border border-red-200 bg-red-50 rounded-xl shadow-sm">
                  <h5 className="font-bold text-red-800 text-sm mb-3">Nhập số tiền bạn vừa trả nợ:</h5>
                  <div className="flex items-center gap-2">
                    <input 
                      type="number" 
                      className="input flex-1 py-2 px-3 border-gray-300 rounded-lg outline-none" 
                      placeholder="VD: 50000"
                      value={payDebtAmount}
                      onChange={(e) => setPayDebtAmount(e.target.value)}
                      autoFocus
                    />
                    <button className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg font-bold transition-colors shadow-sm" disabled={isLoading} onClick={() => handlePayDebt(viewingNote)}>Lưu Báo Cáo</button>
                  </div>
                  <button className="text-xs text-gray-500 mt-3 hover:text-gray-800 font-medium" onClick={() => { setPayDebtNoteId(null); setPayDebtAmount(''); }}>Huỷ bỏ</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Note Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '450px' }}>
            <div className="modal-header">
              <h3>Tạo báo cáo / ghi chú mới</h3>
              <button className="btn btn-icon btn-ghost" onClick={() => setShowAddModal(false)}>
                <XCircle size={20} />
              </button>
            </div>
            
            <div className="modal-body">
              <div className="form-group mb-4">
                <label className="form-label">Loại báo cáo</label>
                <select className="input" value={newNoteType} onChange={(e) => setNewNoteType(e.target.value)}>
                  <option value="expense">Đi chợ / Chi tiền</option>
                  <option value="stock">Báo thiếu nguyên liệu</option>
                  <option value="repair">Yêu cầu sửa chữa</option>
                  <option value="other">Ghi chú khác</option>
                </select>
              </div>

              {newNoteType === 'expense' ? (
                <div className="expense-fields-container mb-4">
                  <label className="form-label mb-2 block">Chi tiết mua hàng</label>
                  
                  {/* Rows */}
                  <div className="flex flex-col gap-3">
                    {expenseItems.map((item, idx) => (
                      <div key={idx} className="flex flex-col gap-2 pb-3 mb-2 border-b border-gray-100 last:border-0">
                        
                        {/* Row 1: Tên món + Giá + Ký */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-gray-400 font-bold hidden sm:inline-block">-</span>
                          
                          <input 
                            type="text" 
                            className="input flex-1 min-w-[120px] sm:min-w-[150px]" 
                            placeholder={idx === expenseItems.length - 1 && !item.name ? "Nhập tên đồ..." : "Tên món"}
                            value={item.name}
                            onChange={(e) => updateExpenseItem(idx, 'name', e.target.value)}
                            style={{ padding: '8px 12px' }}
                          />
                          
                          <input 
                            type="text" 
                            className="input w-[80px] text-center" 
                            placeholder="Giá"
                            value={item.price}
                            onChange={(e) => updateExpenseItem(idx, 'price', e.target.value)}
                            onBlur={(e) => handleExpenseBlur(idx, 'price', e)}
                            style={{ padding: '8px 12px' }}
                          />
                          
                          <input 
                            type="text" 
                            className="input w-[80px] text-center" 
                            placeholder="Ký/SL"
                            value={item.qty}
                            onChange={(e) => updateExpenseItem(idx, 'qty', e.target.value)}
                            onBlur={(e) => handleExpenseBlur(idx, 'qty', e)}
                            style={{ padding: '8px 12px' }}
                          />
                          
                          {/* Desktop: Radio buttons inline */}
                          <div className="hidden sm:flex items-center gap-3 px-2">
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input 
                                type="radio" 
                                name={`status-desk-${idx}`} 
                                checked={item.paymentStatus === 'full'} 
                                onChange={() => updateExpenseItem(idx, 'paymentStatus', 'full')}
                                className="w-4 h-4 text-primary"
                              />
                              <span className="text-sm font-medium">Đủ</span>
                            </label>
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input 
                                type="radio" 
                                name={`status-desk-${idx}`} 
                                checked={item.paymentStatus === 'debt'} 
                                onChange={() => updateExpenseItem(idx, 'paymentStatus', 'debt')}
                                className="w-4 h-4 text-red-500"
                              />
                              <span className="text-sm font-medium text-red-600">Nợ</span>
                            </label>
                          </div>

                          {expenseItems.length > 1 && idx < expenseItems.length - 1 && (
                            <button 
                              className="w-8 h-8 flex items-center justify-center rounded-md bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-500 ml-auto transition-colors"
                              onClick={() => removeExpenseItem(idx)}
                              title="Xóa dòng"
                            >
                              <XCircle size={18} />
                            </button>
                          )}
                        </div>

                        {/* Row 2: Mobile Radio + Debt Note */}
                        <div className="flex items-center gap-2 flex-wrap sm:ml-6 text-sm">
                          
                          {/* Mobile: Radio buttons */}
                          <div className="sm:hidden flex items-center gap-4 py-1">
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input 
                                type="radio" 
                                name={`status-mob-${idx}`} 
                                checked={item.paymentStatus === 'full'} 
                                onChange={() => updateExpenseItem(idx, 'paymentStatus', 'full')}
                                className="w-4 h-4 text-primary"
                              />
                              <span className="font-medium">Đủ</span>
                            </label>
                            <label className="flex items-center gap-1 cursor-pointer">
                              <input 
                                type="radio" 
                                name={`status-mob-${idx}`} 
                                checked={item.paymentStatus === 'debt'} 
                                onChange={() => updateExpenseItem(idx, 'paymentStatus', 'debt')}
                                className="w-4 h-4 text-red-500"
                              />
                              <span className="font-medium text-red-600">Nợ</span>
                            </label>
                          </div>

                          {/* Debt Note Field */}
                          {item.paymentStatus === 'debt' && (
                            <input 
                              type="text" 
                              className="input flex-1 min-w-[150px] border-red-200" 
                              placeholder="Nợ của ai?"
                              value={item.creditor}
                              onChange={(e) => updateExpenseItem(idx, 'creditor', e.target.value)}
                              style={{ padding: '6px 12px' }}
                              autoFocus
                            />
                          )}
                        </div>

                      </div>
                    ))}
                  </div>

                  {calculateTotals().paid > 0 || calculateTotals().debt > 0 ? (
                    <div className="mt-4 p-4 bg-red-50 rounded-xl border border-red-100">
                      <h4 className="font-bold text-red-800 mb-2">Tổng kết đi chợ:</h4>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>Tổng tiền hàng: <strong>{formatMoney(calculateTotals().paid + calculateTotals().debt)}</strong></div>
                        <div>Thực chi tạm: <strong className="text-green-600">{formatMoney(calculateTotals().paid)}</strong></div>
                        <div>Tổng nợ: <strong className="text-red-600">{formatMoney(calculateTotals().debt)}</strong></div>
                        {calculateTotals().creditors && (
                          <div className="col-span-2 mt-1 pt-2 border-t border-red-200">
                            Người đang thiếu Nợ: <strong className="text-red-600">{calculateTotals().creditors}</strong>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 mt-3 italic">* Dòng mới tự động hiện ra khi bạn nhập tên món.</p>
                  )}
                </div>
              ) : (
                <div className="form-group mb-4">
                  <label className="form-label">Chi tiết</label>
                  <textarea 
                    className="input" 
                    rows="4" 
                    placeholder="Nhập chi tiết cụ thể (vd: 1 ký mắm, xà bông...)"
                    value={newNoteContent}
                    onChange={handleContentChange}
                    onKeyDown={handleContentKeyDown}
                  ></textarea>
                </div>
              )}
            </div>
            
            <div className="modal-footer flex justify-end gap-3 p-4 border-t border-gray-100">
              <button className="btn btn-outline" onClick={() => setShowAddModal(false)}>Huỷ</button>
              <button className="btn btn-primary px-6" onClick={submitNewNote} disabled={isLoading}>
                {isLoading ? 'Đang gửi...' : 'Gửi đi'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
