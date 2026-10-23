'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Bỏ dấu để gõ "oc huong" vẫn ra "Ốc hương".
const fold = s => String(s || '').replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Ô tên hàng trong Sổ tay: gõ tự do như cũ, kèm danh sách món trong menu để
 * chọn nhanh — tên trùng tên món thì Sổ thu chi gom bán ra / nhập vào đúng hơn.
 * Danh sách vẽ ở <body> (fixed) vì mỗi dòng hàng Sổ tay có hiệu ứng tạo lớp
 * riêng, dòng sau sẽ đè lên danh sách nếu vẽ bên trong dòng. onChange nhận chuỗi.
 */
export default function MenuNameInput({ names = [], value, onChange, className, style = {}, placeholder }) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState(null);
  const input = useRef(null);
  const q = fold(value);
  const matches = useMemo(() => (q ? names.filter(n => fold(n).includes(q) && n !== value) : names).slice(0, 40), [names, q, value]);
  const show = open && matches.length > 0;

  useLayoutEffect(() => {
    if (!show) return undefined;
    const place = () => {
      const r = input.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const up = below < 180 && r.top > below;
      setBox({ left: r.left, width: Math.max(r.width, 200), top: up ? null : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : null,
        maxHeight: Math.min(220, (up ? r.top : below) - 12) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [show, value]);
  useEffect(() => { if (!show) setBox(null); }, [show]);

  const { flex, minWidth, width, ...inputStyle } = style;
  return <span style={{ display: 'flex', flex, minWidth, width }}>
    <input ref={input} type="text" className={className} style={{ ...inputStyle, flex: 1, width: '100%', minWidth: 0 }} placeholder={placeholder}
      value={value} autoComplete="off" enterKeyHint="next"
      onChange={e => { onChange(e.target.value); setOpen(true); }}
      onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
    {show && box && createPortal(<ul role="listbox" aria-label="Món trong menu" style={{
      position: 'fixed', left: Math.min(box.left, window.innerWidth - box.width - 8), width: box.width, top: box.top ?? 'auto', bottom: box.bottom ?? 'auto',
      maxHeight: Math.max(120, box.maxHeight), zIndex: 2000, margin: 0, padding: 4, listStyle: 'none', overflowY: 'auto',
      WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', background: 'white', border: '1px solid #d1d5db',
      borderRadius: 8, boxShadow: '0 8px 20px rgba(15, 23, 42, .18)',
    }}>
      {matches.map(name => <li key={name}>
        <button type="button" role="option" aria-selected={false}
          onMouseDown={e => e.preventDefault()} onClick={() => { onChange(name); setOpen(false); }}
          style={{ display: 'block', width: '100%', minHeight: 40, padding: '8px 10px', border: 0, borderRadius: 6, background: 'transparent', textAlign: 'left', fontSize: 15, color: '#111827' }}>
          {name}
        </button>
      </li>)}
    </ul>, document.body)}
  </span>;
}
