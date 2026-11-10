'use client';
/**
 * Số đơn chờ duyệt ở Lương → Yêu cầu cho biểu tượng ví trên thanh menu admin (chỉ chủ quán).
 * Hỏi máy chủ (GET /api/admin/workforce?pending=1) khi mở, mỗi phút khi tab đang hiện, khi quay lại tab, và ngay khi trang Lương
 * báo số đơn vừa đổi (duyệt / từ chối xong). Lỗi mạng thì giữ số cũ.
 */
import { useEffect, useState } from 'react';
import { PENDING_COUNT_EVENT, PENDING_REFRESH_EVENT } from './payrollPending.mjs';

const POLL_MS = 60 * 1000;
// Quay lại tab / bấm vào cửa sổ: hỏi lại nếu lần trước đã hơn 15 giây.
const FOCUS_MS = 15 * 1000;
// Trang Lương báo đổi số liên tục khi đang tải từng phần → gom lại, hỏi một lần.
const REFRESH_DELAY_MS = 800;

export function usePayrollPending(enabled) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) { setCount(0); return undefined; }
    let stopped = false, busy = false, again = false, lastAt = 0, delay = null;
    const load = async () => {
      if (busy) { again = true; return; }
      busy = true;
      lastAt = Date.now();
      try {
        const r = await fetch('/api/admin/workforce?pending=1', { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        const total = Number(j?.total);
        if (!stopped && r.ok && Number.isFinite(total)) {
          setCount(total);
          window.dispatchEvent(new CustomEvent(PENDING_COUNT_EVENT, { detail: total }));
        }
      } catch { /* mạng chập chờn: giữ số cũ, lần sau hỏi lại */ }
      finally {
        busy = false;
        if (again && !stopped) { again = false; load(); }
      }
    };
    const visible = () => document.visibilityState === 'visible';
    const onTick = () => { if (visible()) load(); };
    const onBack = () => { if (visible() && Date.now() - lastAt > FOCUS_MS) load(); };
    const onRefresh = () => { clearTimeout(delay); delay = setTimeout(load, REFRESH_DELAY_MS); };
    load();
    const timer = setInterval(onTick, POLL_MS);
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    window.addEventListener(PENDING_REFRESH_EVENT, onRefresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(delay);
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
      window.removeEventListener(PENDING_REFRESH_EVENT, onRefresh);
    };
  }, [enabled]);
  return enabled ? count : 0;
}
