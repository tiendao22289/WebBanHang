'use client';
import { useState, useRef, useEffect } from 'react';

// ───────────────────────────────────────────────────────────────────────────
// ChatOrderButton — Trợ lý AI Gọi Món
// Hoàn toàn độc lập, không ảnh hưởng code cũ.
// Để xoá tính năng: xoá file này và bỏ 2 dòng import/render trong order/page.jsx
// ───────────────────────────────────────────────────────────────────────────

// ── Helpers: chuẩn hoá chuỗi tiếng Việt ─────────────────────────────────
function norm(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
}

// Tìm menu item khớp nhất với đoạn text (fuzzy, không dấu + aliases)
function findMenuItem(text, menuItems) {
  const t = norm(text);
  let best = null, bestScore = 0;

  for (const item of menuItems) {
    const n = norm(item.name);

    // 1. Kiểm tra aliases trước (ưu tiên cao nhất vì admin cấu hình thủ công)
    const aliases = (item.name_aliases || '').split(',').map(a => norm(a.trim())).filter(Boolean);
    const aliasMatch = aliases.find(a => a && (t.includes(a) || a.includes(t)));
    if (aliasMatch) {
      if (aliasMatch.length > bestScore) { bestScore = aliasMatch.length + 100; best = item; }
      continue;
    }

    // 2. Tên món nằm trong text (exact substring)
    if (t.includes(n) && n.length > bestScore) {
      bestScore = n.length; best = item; continue;
    }

    // 3. Fallback: đếm từ khớp
    const nameWords = n.split(' ');
    const textWords = t.split(' ');
    const matched = nameWords.filter(w => w.length > 1 && textWords.includes(w)).length;
    const score = matched / nameWords.length;
    if (score >= 0.5 && matched > bestScore) { bestScore = matched; best = item; }
  }
  return best;
}

// Tìm lựa chọn khớp nhất với phần qualifier (sau khi bỏ tên món)
function findOption(text, menuItem) {
  if (!menuItem.options?.length) return { optionsArr: [], price: menuItem.price || 0 };
  const t = norm(text);
  const tWords = t.split(' ');

  // Thử strip tên món ra khỏi text để lấy qualifier
  // Nếu user dùng alias ngắn (vd: "hau") thì strip có thể không hoạt động → dùng full text
  const qualifier = t.replace(norm(menuItem.name), '').trim() || t;

  let bestOpt = null, bestChoice = null, bestScore = 0;
  for (const opt of menuItem.options) {
    const visibleChoices = (opt.choices || []).filter((_, i) => {
      const h = opt.hiddenChoices?.[i];
      return !(h === true || (typeof h === 'string' && new Date(h) > new Date()));
    });
    for (const choice of visibleChoices) {
      const nc = norm(choice);
      const ncWords = nc.split(' ');
      let score = 0;

      // Ưu tiên 1: qualifier chứa toàn bộ chuỗi choice (ví dụ: qualifier="xao toi", choice="xao toi")
      if (qualifier.includes(nc)) { score = nc.length * 3; }
      // Ưu tiên 2: choice chứa qualifier (ví dụ: qualifier="toi", choice="xao toi")
      else if (nc.includes(qualifier) && qualifier.length > 2) { score = qualifier.length * 2; }
      // Ưu tiên 3: word-level overlap — fix khi alias ngắn được dùng
      // ví dụ: text="hau hanh", tWords=["hau","hanh"], nc="mo hanh", ncWords=["mo","hanh"]
      // → "hanh" khớp → score > 0 → tìm được "Mỡ hành"
      if (score === 0) {
        const overlapCount = ncWords.filter(w => w.length > 1 && tWords.includes(w)).length;
        if (overlapCount > 0) score = (overlapCount / ncWords.length) * nc.length;
      }

      if (score > bestScore) { bestScore = score; bestOpt = opt; bestChoice = choice; }
    }
  }

  if (bestOpt && bestChoice) {
    const idx = bestOpt.choices.indexOf(bestChoice);
    const price = bestOpt.prices?.[idx] != null ? Number(bestOpt.prices[idx]) || (menuItem.price || 0) : (menuItem.price || 0);
    return { optionsArr: [{ name: bestOpt.name, choice: bestChoice }], price };
  }

  // Fallback: lấy lựa chọn đầu tiên visible
  const firstOpt = menuItem.options[0];
  const firstVisible = (firstOpt.choices || []).find((_, i) => {
    const h = firstOpt.hiddenChoices?.[i];
    return !(h === true || (typeof h === 'string' && new Date(h) > new Date()));
  });
  if (firstVisible) {
    const idx = firstOpt.choices.indexOf(firstVisible);
    const price = firstOpt.prices?.[idx] != null ? Number(firstOpt.prices[idx]) || (menuItem.price || 0) : (menuItem.price || 0);
    return { optionsArr: [{ name: firstOpt.name, choice: firstVisible }], price };
  }
  return { optionsArr: [], price: menuItem.price || 0 };
}

// ──────────────────────────────────────────────────────────────────────────

export default function ChatOrderButton({ menuItems, onConfirmOrder, onDirectSubmit }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([
    {
      role: 'bot',
      type: 'text',
      content: 'Xin chào! 👋 Bạn muốn gọi món gì? Cứ nhắn tự nhiên như nhắn tin nhé, ví dụ:\n"ốc hương xào trứng muối, hàu nướng mỡ hành 2"',
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [pendingOrder, setPendingOrder] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 300);
  }, [open]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', type: 'text', content: text }]);
    setLoading(true);
    setPendingOrder(null);

    try {
      // Bước 1: AI chỉ tách câu → list {text, qty} — task đơn giản, AI làm đúng 100%
      const res = await fetch('/api/chat-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();

      if (data.error) {
        setMessages(prev => [...prev, { role: 'bot', type: 'text', content: `⚠️ ${data.error}. Vui lòng thử lại!` }]);
        return;
      }

      const parsedItems = data.items || [];

      // Bước 2: Client-side matching — chính xác vì dùng dữ liệu menu thật
      const found = [];
      const notFound = [];

      for (const f of parsedItems) {
        const menuItem = findMenuItem(f.text, menuItems);
        if (!menuItem) { notFound.push(f.text); continue; }
        const { optionsArr, price } = findOption(f.text, menuItem);
        const label = optionsArr.map(o => o.choice).join(',');
        found.push({
          ...menuItem,
          price,
          quantity: f.qty || 1,
          _options: optionsArr,
          _optionKey: optionsArr.length > 0 ? `${menuItem.id}-${label}-` : null,
          _note: '',
        });
      }

      if (found.length === 0 && notFound.length === 0) {
        setMessages(prev => [...prev, { role: 'bot', type: 'text', content: 'Mình chưa hiểu bạn muốn gọi món nào. Bạn thử ghi rõ tên món hơn nhé? 😊' }]);
        return;
      }

      setPendingOrder(found.length > 0 ? found : null);
      setMessages(prev => [...prev, { role: 'bot', type: 'confirm', found, notFound }]);

    } catch {
      setMessages(prev => [...prev, { role: 'bot', type: 'text', content: '⚠️ Lỗi kết nối, vui lòng thử lại!' }]);
    } finally {
      setLoading(false);
    }
  }

  function handleConfirm() {
    if (!pendingOrder || pendingOrder.length === 0) return;
    onConfirmOrder(pendingOrder);
    setPendingOrder(null);
    setMessages(prev => [...prev, {
      role: 'bot', type: 'text',
      content: '✅ Đã thêm vào giỏ hàng! Bạn kiểm tra lại giỏ hàng và bấm **Gửi đơn** để bếp bắt đầu làm nhé! 🍽️',
    }]);
  }

  async function handleDirectSubmit() {
    if (!pendingOrder || pendingOrder.length === 0 || !onDirectSubmit) return;
    const items = pendingOrder;
    setPendingOrder(null);
    setMessages(prev => [...prev, { role: 'bot', type: 'text', content: '🚀 Đang gửi đơn cho bếp...' }]);
    try {
      await onDirectSubmit(items);
      setMessages(prev => [...prev, {
        role: 'bot', type: 'text',
        content: '✅ Đơn hàng đã được gửi cho bếp! Bếp sẽ bắt đầu làm ngay. Bạn có muốn gọi thêm món không? 😊',
      }]);
    } catch {
      setMessages(prev => [...prev, { role: 'bot', type: 'text', content: '⚠️ Gửi đơn bị lỗi. Bạn thử lại hoặc gọi nhân viên hỗ trợ nhé!' }]);
    }
  }

  function handleRetry() {
    setPendingOrder(null);
    setMessages(prev => [...prev, { role: 'bot', type: 'text', content: 'OK, bạn nhắn lại danh sách món muốn đặt nhé! 😊' }]);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            position: 'fixed', bottom: 90, left: 16, zIndex: 999,
            width: 52, height: 52, borderRadius: '50%',
            background: 'linear-gradient(135deg, #7c3aed, #4f46e5)',
            border: 'none', boxShadow: '0 4px 20px rgba(124,58,237,0.5)',
            cursor: 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '1.4rem',
            animation: 'chatBtnPulse 2.5s infinite',
          }}
          title="Trợ lý gọi món AI"
        >🤖</button>
      )}

      {open && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, top: 0,
          zIndex: 1100, display: 'flex', flexDirection: 'column',
          background: 'rgba(0,0,0,0.4)',
        }} onClick={() => setOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            marginTop: 'auto', background: '#fff',
            borderRadius: '24px 24px 0 0', display: 'flex',
            flexDirection: 'column', maxHeight: '85vh',
            boxShadow: '0 -8px 40px rgba(0,0,0,0.2)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', flexShrink: 0 }}>🤖</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: '0.95rem', color: '#111827' }}>Trợ lý Gọi Món AI</div>
                <div style={{ fontSize: '0.72rem', color: '#6b7280' }}>Nhắn tên món — AI sẽ đặt giúp bạn</div>
              </div>
              <button onClick={() => setOpen(false)} style={{ background: '#f3f4f6', border: 'none', borderRadius: '50%', width: 32, height: 32, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', color: '#6b7280' }}>✕</button>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {messages.map((msg, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 6, alignItems: 'flex-end' }}>
                  {msg.role === 'bot' && (
                    <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', marginBottom: 2 }}>🤖</div>
                  )}

                  {msg.type === 'text' && (
                    <div style={{
                      maxWidth: '78%',
                      background: msg.role === 'user' ? 'linear-gradient(135deg, #4f46e5, #7c3aed)' : '#f3f4f6',
                      color: msg.role === 'user' ? '#fff' : '#111827',
                      borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                      padding: '10px 14px', fontSize: '0.88rem', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                    }}>{msg.content}</div>
                  )}

                  {msg.type === 'confirm' && (
                    <div style={{ maxWidth: '88%', background: '#f8faff', border: '1.5px solid #e0e7ff', borderRadius: '18px 18px 18px 4px', padding: '12px 14px', fontSize: '0.88rem' }}>
                      <div style={{ fontWeight: 700, color: '#3730a3', marginBottom: 8, fontSize: '0.9rem' }}>📋 Mình ghi nhận được các món sau:</div>

                      {msg.found.map((item, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: i < msg.found.length - 1 ? '1px solid #e5e7eb' : 'none', gap: 6 }}>
                          <div>
                            <span style={{ fontWeight: 700, color: '#111827' }}>{item.quantity}x {item.name}</span>
                            {item._options?.length > 0 && (
                              <span style={{ fontSize: '0.76rem', color: '#6366f1', marginLeft: 6 }}>({item._options.map(o => o.choice).join(', ')})</span>
                            )}
                          </div>
                          <span style={{ fontWeight: 700, color: '#2563eb', fontSize: '0.82rem', flexShrink: 0 }}>
                            {(item.price * item.quantity).toLocaleString('vi-VN')}đ
                          </span>
                        </div>
                      ))}

                      {msg.notFound?.length > 0 && (
                        <div style={{ marginTop: 8, fontSize: '0.76rem', color: '#b45309', background: '#fffbeb', borderRadius: 6, padding: '4px 8px' }}>
                          ⚠️ Không tìm thấy: <b>{msg.notFound.join(', ')}</b>
                        </div>
                      )}

                      <div style={{ marginTop: 10, fontWeight: 600, fontSize: '0.82rem', color: '#374151', borderTop: '1px solid #e5e7eb', paddingTop: 8 }}>
                        Tổng: <strong style={{ color: '#2563eb' }}>{msg.found.reduce((sum, i) => sum + i.price * i.quantity, 0).toLocaleString('vi-VN')}đ</strong>
                      </div>

                      {pendingOrder && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                          {onDirectSubmit && (
                            <button onClick={handleDirectSubmit} style={{
                              width: '100%', padding: '11px',
                              background: 'linear-gradient(135deg, #16a34a, #15803d)',
                              color: 'white', border: 'none', borderRadius: 10, fontWeight: 800,
                              fontSize: '0.9rem', cursor: 'pointer',
                              boxShadow: '0 4px 12px rgba(22,163,74,0.35)',
                            }}>🚀 Gửi thẳng cho bếp</button>
                          )}
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={handleConfirm} style={{ flex: 1, padding: '9px', background: '#eff6ff', color: '#2563eb', border: '1.5px solid #bfdbfe', borderRadius: 10, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>
                              🛝 Thêm vào giỏ
                            </button>
                            <button onClick={handleRetry} style={{ flex: 1, padding: '9px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>
                              ✏️ Gọi lại
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>🤖</div>
                  <div style={{ background: '#f3f4f6', borderRadius: '18px 18px 18px 4px', padding: '12px 16px', display: 'flex', gap: 5, alignItems: 'center' }}>
                    {[0, 0.2, 0.4].map((delay, i) => (
                      <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: '#7c3aed', animation: `chatTyping 1s infinite ${delay}s` }} />
                    ))}
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div style={{ padding: '10px 12px 16px', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nhập tên món muốn đặt..."
                style={{
                  flex: 1, border: '1.5px solid #e0e7ff', borderRadius: 14,
                  padding: '10px 14px', fontSize: '0.9rem', outline: 'none',
                  resize: 'none', minHeight: 44, maxHeight: 120,
                  fontFamily: 'inherit', lineHeight: 1.5, background: '#f8faff',
                }}
                onFocus={e => e.target.style.borderColor = '#7c3aed'}
                onBlur={e => e.target.style.borderColor = '#e0e7ff'}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                style={{
                  width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
                  background: input.trim() && !loading ? 'linear-gradient(135deg, #7c3aed, #4f46e5)' : '#e5e7eb',
                  border: 'none', cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.1rem', transition: 'background 0.2s',
                }}
              >{loading ? '⏳' : '📤'}</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes chatBtnPulse {
          0%, 100% { box-shadow: 0 4px 20px rgba(124,58,237,0.5); }
          50% { box-shadow: 0 4px 28px rgba(124,58,237,0.85), 0 0 0 8px rgba(124,58,237,0.12); }
        }
        @keyframes chatTyping {
          0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </>
  );
}
