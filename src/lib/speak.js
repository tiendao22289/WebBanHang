'use client';
// Đọc to câu báo bằng giọng tiếng Việt của máy (Web Speech API, có sẵn trên iPhone / Android).
// Trình duyệt chỉ cho đọc sau khi người dùng đã chạm vào trang: gọi unlockSpeech() (hoặc speak) ngay
// trong lúc bấm nút — nút mở camera quét mã, nút "Bật tiếng đọc" ở máy quầy — để mở khoá các lần đọc sau.
// Trong app máy quầy (iPhone) thì app tự đọc, không cần chạm.
import { kioskApp, toKioskApp } from './kioskApp';

export const speechSupported = () => !!kioskApp() || (typeof window !== 'undefined' && 'speechSynthesis' in window);

function utter(text, volume = 1) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'vi-VN';
  const voice = window.speechSynthesis.getVoices().find(v => /^vi/i.test(v.lang));
  if (voice) u.voice = voice;
  u.volume = volume;
  return u;
}

/** Gọi trong lúc người dùng bấm: đọc một câu rỗng, không tiếng, để mở khoá đọc về sau. */
export function unlockSpeech() {
  if (kioskApp() || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try { window.speechSynthesis.speak(utter('', 0)); } catch { /* máy không cho đọc */ }
}

export function speak(text) {
  if (!text) return;
  if (kioskApp()) { toKioskApp({ type: 'speak', text }); return; }
  if (!speechSupported()) return;
  try {
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();
    // Đang đọc câu trước thì dừng; Safari bỏ qua câu đọc ngay sau cancel() nên đợi một chút.
    if (synth.speaking || synth.pending) {
      synth.cancel();
      setTimeout(() => synth.speak(utter(text)), 250);
    } else synth.speak(utter(text));
  } catch { /* máy không cho đọc: vẫn còn chữ trên màn hình */ }
}
