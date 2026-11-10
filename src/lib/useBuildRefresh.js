'use client';
import { useEffect, useId } from 'react';
import {
  CHECK_EVERY_MS, FETCH_GAP_MS, NOTICE_MS, RECHECK_SAFE_MS, hasUnsentText, isEditing, isOverlay,
  parseAttempt, reloadDecision, reloadHoldLabels, setReloadHold,
} from './buildRefresh.mjs';

// Tab admin mở cả ngày tự lấy bản mới sau khi "Đưa lên" (luật chờ / tải ở src/lib/buildRefresh.mjs).
// Gắn một lần ở src/app/admin/layout.js. Trang có việc đang dở mà trang tự biết (giỏ nháp, đang thanh
// toán) thì gọi useReloadHold(true, 'lý do') để giữ.

const CURRENT = process.env.NEXT_PUBLIC_BUILD_ID || '';
const ATTEMPT_KEY = 'build_reload_attempt';
const MODAL_SELECTOR = '.swal2-container, dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input'];

const readAttempt = () => { try { return parseAttempt(sessionStorage.getItem(ATTEMPT_KEY)); } catch { return null; } };
const saveAttempt = build => { try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ build, at: Date.now() })); } catch { } };

// Khung / Swal đang mở: có phần tử khung đang hiện, hoặc giữa màn hình có lớp fixed phủ gần hết màn hình.
function modalOpen() {
  for (const el of document.querySelectorAll(MODAL_SELECTOR)) {
    if (el.closest('[data-reload-safe]')) continue;
    if (el.getClientRects().length > 0) return true;
  }
  const w = window.innerWidth, h = window.innerHeight;
  for (const el of document.elementsFromPoint(w / 2, h / 2)) {
    if (el === document.body || el === document.documentElement || el.closest('[data-reload-safe]')) continue;
    if (isOverlay(getComputedStyle(el), el.getBoundingClientRect(), w, h)) return true;
  }
  return false;
}

function showNotice() {
  const el = document.createElement('div');
  el.textContent = 'Có bản mới — đang tải lại…';
  el.setAttribute('role', 'status');
  el.setAttribute('data-reload-safe', '');
  Object.assign(el.style, {
    position: 'fixed', left: '50%', bottom: 'calc(84px + env(safe-area-inset-bottom, 0px))', transform: 'translateX(-50%)',
    zIndex: '2147483647', background: '#0f172a', color: 'white', padding: '10px 18px', borderRadius: '999px',
    fontSize: '0.9rem', fontWeight: '700', boxShadow: '0 8px 24px rgba(15,23,42,0.35)', pointerEvents: 'none',
  });
  document.body.appendChild(el);
  return el;
}

export function useBuildRefresh() {
  useEffect(() => {
    if (!CURRENT) return undefined;
    let latest = null;
    let lastFetch = 0;
    let fetching = false;
    let lastActivity = Date.now();
    let safeTimer = null;
    let notice = null;
    let lastReason = '';
    let stopped = false;
    const touched = new Set(); // ô người dùng đã gõ (ô trang tự điền sẵn không tính)

    const log = reason => {
      if (reason === lastReason) return;
      lastReason = reason;
      console.info(`[bản mới] ${latest} (đang chạy ${CURRENT}): ${reason}`);
    };

    function cancelNotice() {
      if (!notice) return;
      clearTimeout(notice.timer);
      notice.el.remove();
      notice = null;
      schedule();
    }

    function schedule() {
      clearTimeout(safeTimer);
      if (!stopped) safeTimer = setTimeout(evaluate, RECHECK_SAFE_MS);
    }

    function decide() {
      return reloadDecision({
        current: CURRENT, latest, hidden: document.visibilityState === 'hidden',
        modalOpen: modalOpen(), editing: isEditing(document.activeElement), unsentText: hasUnsentText(touched),
        holds: reloadHoldLabels(), idleMs: Date.now() - lastActivity, lastAttempt: readAttempt(),
      });
    }

    function evaluate() {
      clearTimeout(safeTimer);
      if (stopped || notice) return;
      const decision = decide();
      if (decision.action === 'none') return;
      if (decision.action === 'wait') { log(`chờ — ${decision.reason}`); schedule(); return; }
      log('tải lại');
      if (document.visibilityState === 'hidden') { reload(); return; }
      // Báo vài giây rồi xem lại lần cuối; ai chạm / gõ trong lúc báo thì thôi, chờ lượt sau.
      notice = { el: showNotice(), timer: setTimeout(() => {
        notice.el.remove();
        notice = null;
        if (decide().action === 'reload') reload();
        else schedule();
      }, NOTICE_MS) };
    }

    function reload() {
      stopped = true;
      saveAttempt(latest);
      window.location.reload();
    }

    async function fetchLatest(force = false) {
      if (stopped || fetching || (!force && Date.now() - lastFetch < FETCH_GAP_MS)) return;
      fetching = true;
      lastFetch = Date.now();
      try {
        const response = await fetch('/api/version', { cache: 'no-store' });
        const body = response.ok ? await response.json() : null;
        if (typeof body?.buildId === 'string') latest = body.buildId;
      } catch { /* mất mạng / máy chủ đang khởi động lại: giữ mã cũ, lượt sau hỏi lại */ }
      finally { fetching = false; }
      evaluate();
    }

    const onActivity = event => {
      lastActivity = Date.now();
      if (event.type === 'input' && event.isTrusted && event.target instanceof Element) {
        for (const el of touched) if (!el.isConnected) touched.delete(el); // khung đã đóng: bỏ, khỏi giữ phần tử cũ cả ngày
        touched.add(event.target);
      }
      if (notice) cancelNotice(); // có người ở máy (kể cả rê chuột) → thôi, đợi để yên lại
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchLatest();
      else evaluate(); // vừa rời tab: lúc tốt để tải nếu không có gì dở
    };
    const onFocus = () => fetchLatest();

    const opts = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, opts);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    const interval = setInterval(() => fetchLatest(true), CHECK_EVERY_MS);
    fetchLatest(true);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(safeTimer);
      if (notice) { clearTimeout(notice.timer); notice.el.remove(); notice = null; }
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, opts);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}

/** Trang đang có việc dở (giỏ nháp có món, đang thanh toán…) → không tự tải bản mới tới khi xong. */
export function useReloadHold(active, label) {
  const id = useId();
  useEffect(() => {
    if (!active) return undefined;
    setReloadHold(id, label, true);
    return () => setReloadHold(id, label, false);
  }, [active, id, label]);
}
