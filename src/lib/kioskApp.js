'use client';
// Cầu nối với app iPhone "Chấm công" (thư mục ios/): app mở trang /chamcong trong khung web, gắn sẵn
// window.ChamCongApp = { version, face, model } và nhận lệnh qua window.webkit.messageHandlers.kiosk:
//   speak {text} · wake · busy {on} · face {id, mode: verify | enroll, name, prompt} · cancelFace {id}
// Xong một lần chụp mặt, app gọi window.ChamCongApp.onFace(id, result):
//   {ok: true, live: true, embeddings: [[128 số], ...]} hoặc {ok: false, reason}. Chạm đánh thức màn hình → onWake().

/** Thông tin app (null khi mở bằng trình duyệt thường). */
export function kioskApp() {
  if (typeof window === 'undefined') return null;
  const app = window.ChamCongApp;
  return app && window.webkit?.messageHandlers?.kiosk ? app : null;
}

export function toKioskApp(message) {
  try { window.webkit?.messageHandlers?.kiosk?.postMessage(message); } catch { /* không phải app */ }
}

const waiting = new Map();

/**
 * Nhờ app mở camera trước, đợi chớp mắt rồi tính dấu mặt. Trả về kết quả của app; quá `timeoutMs`
 * (app treo) thì {ok: false, reason: 'error'}.
 */
export function captureFace({ id, mode = 'verify', name = '', prompt = '' }, timeoutMs = 45000) {
  const app = kioskApp();
  if (!app?.face) return Promise.resolve({ ok: false, reason: 'camera' });
  if (!app.onFace) {
    app.onFace = (key, result) => {
      const done = waiting.get(key);
      if (!done) return;
      waiting.delete(key);
      done(result && typeof result === 'object' ? result : { ok: false, reason: 'error' });
    };
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      toKioskApp({ type: 'cancelFace', id });
      resolve({ ok: false, reason: 'error' });
    }, timeoutMs);
    waiting.set(id, result => { clearTimeout(timer); resolve(result); });
    toKioskApp({ type: 'wake' });
    toKioskApp({ type: 'face', id, mode, name, prompt });
  });
}
