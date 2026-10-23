'use client';
import { useEffect, useRef } from 'react';

// Khung nổi (xem ảnh, chi tiết ngày) trên điện thoại: nút Back của Android /
// vuốt lùi của iPhone phải ĐÓNG khung, không rời khỏi trang. Mỗi khung mở
// thêm một bước lịch sử; Back chỉ đóng khung TRÊN CÙNG (khung xem ảnh nằm
// trong khung chi tiết ngày). Đóng bằng nút X thì tự lùi bước đã thêm, và
// lần lùi đó được bỏ qua để không đóng nhầm khung bên dưới.
//
// Việc lùi được hoãn một nhịp: React (chế độ phát triển) gỡ rồi gắn lại
// hiệu ứng ngay lập tức — gắn lại trong nhịp đó thì giữ nguyên bước cũ,
// không thêm/lùi lịch sử lệch nhau.
function shared() {
  if (!window.__backClose) {
    const state = { stack: [], selfBacks: 0 };
    window.addEventListener('popstate', () => {
      if (state.selfBacks > 0) { state.selfBacks -= 1; return; }
      const top = state.stack[state.stack.length - 1];
      if (!top) return;
      state.stack.pop();
      top.poppedByBack = true;
      top.close();
    });
    window.__backClose = state;
  }
  return window.__backClose;
}

export function useBackClose(open, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const entryRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const state = shared();
    const pending = entryRef.current;
    if (pending?.timer) {
      // Gắn lại ngay sau khi gỡ: dùng lại bước lịch sử cũ.
      clearTimeout(pending.timer);
      pending.timer = null;
      state.stack.push(pending);
    } else {
      const entry = { close: () => closeRef.current(), poppedByBack: false, timer: null };
      entryRef.current = entry;
      state.stack.push(entry);
      window.history.pushState({ ...(window.history.state || {}), overlayDepth: state.stack.length }, '');
    }
    const entry = entryRef.current;
    return () => {
      const index = state.stack.indexOf(entry);
      if (index >= 0) state.stack.splice(index, 1);
      if (entry.poppedByBack) { entryRef.current = null; return; }
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entryRef.current = null;
        state.selfBacks += 1;
        window.history.back();
      }, 0);
    };
  }, [open]);
}
