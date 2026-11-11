'use client';
/**
 * Một con số trên thanh menu admin lấy từ máy chủ, tự cập nhật: hỏi khi mở, mỗi phút khi tab đang hiện, khi quay lại tab
 * (cách lần trước ≥ 15 giây) và 800 ms sau sự kiện refreshEvent (trang vừa đổi số). Lỗi mạng thì giữ số cũ.
 * pick(json) → số; countEvent: phát số mới lên window cho trang đang mở so với số của nó.
 * Dùng cho: số đơn chờ duyệt trên ví của chủ quán (usePayrollPending), số thông báo lỗi chưa xem của nhân viên.
 */
import { useEffect, useState } from 'react';

const POLL_MS = 60 * 1000;
const FOCUS_MS = 15 * 1000;
const REFRESH_DELAY_MS = 800;

export function usePolledCount(url, enabled, { pick, refreshEvent, countEvent } = {}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled || !url) { setCount(0); return undefined; }
    let stopped = false, busy = false, again = false, lastAt = 0, delay = null;
    const load = async () => {
      if (busy) { again = true; return; }
      busy = true;
      lastAt = Date.now();
      try {
        const r = await fetch(url, { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        const n = Number(pick ? pick(j) : j?.total);
        if (!stopped && r.ok && Number.isFinite(n)) {
          setCount(n);
          if (countEvent) window.dispatchEvent(new CustomEvent(countEvent, { detail: n }));
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
    if (refreshEvent) window.addEventListener(refreshEvent, onRefresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(delay);
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
      if (refreshEvent) window.removeEventListener(refreshEvent, onRefresh);
    };
  // pick là hàm cố định của nơi gọi; đổi url / bật tắt mới cần hỏi lại.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled, refreshEvent, countEvent]);
  return enabled ? count : 0;
}
