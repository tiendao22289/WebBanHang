'use client';
// Đọc to câu báo bằng giọng tiếng Việt của máy (Web Speech API, có sẵn trên iPhone / Android).
// Trình duyệt chỉ cho đọc sau khi người dùng đã chạm vào trang: gọi unlockSpeech() (hoặc speak) ngay
// trong lúc bấm nút — nút mở camera quét mã, nút "Bật tiếng đọc" ở máy quầy — để mở khoá các lần đọc sau.
// Trong app máy quầy (iPhone) thì app tự đọc, không cần chạm.
import { kioskApp, toKioskApp } from './kioskApp';

export const speechSupported = () => !!kioskApp() || (typeof window !== 'undefined' && 'speechSynthesis' in window);

// Giọng tiếng Việt của máy (iPhone / Android có sẵn; máy tính Windows chỉ có khi đã cài thêm giọng Việt,
// hoặc mở bằng trình duyệt Edge). Danh sách giọng tải chậm: rỗng = chưa biết.
const voices = () => window.speechSynthesis.getVoices() || [];
const viVoice = () => voices().find(v => /^vi/i.test(v.lang)) || null;

/**
 * true = đọc được tiếng Việt; false = máy chỉ có giọng nước khác (không đọc, kẻo đọc tiếng Việt bằng giọng Anh); null = chưa biết.
 * App máy quầy đọc bằng giọng của iPhone, cùng danh sách giọng với khung web trong app: iPhone chưa tải giọng Việt thì app
 * đọc bằng giọng Anh. Khung web không có speechSynthesis thì để app tự đọc (chưa biết).
 */
export function vietnameseVoice() {
  if (typeof window === 'undefined') return false;
  if (!('speechSynthesis' in window)) return kioskApp() ? null : false;
  return voices().length ? !!viVoice() : null;
}

function utter(text, volume = 1) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'vi-VN';
  const voice = viVoice();
  if (voice) u.voice = voice;
  u.volume = volume;
  return u;
}

/** Gọi trong lúc người dùng bấm: đọc một câu rỗng, không tiếng, để mở khoá đọc về sau. */
export function unlockSpeech() {
  if (kioskApp() || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try { window.speechSynthesis.speak(utter('', 0)); } catch { /* máy không cho đọc */ }
}

// Android tải danh sách giọng chậm (lần đầu rỗng → máy đọc bằng giọng mặc định, thường là tiếng Anh): đợi tối đa 2 giây.
function whenVoices() {
  if (voices().length) return Promise.resolve();
  return new Promise(resolve => {
    const synth = window.speechSynthesis;
    const done = () => { synth.removeEventListener?.('voiceschanged', done); resolve(); };
    synth.addEventListener?.('voiceschanged', done);
    setTimeout(done, 2000);
  });
}

export function speak(text) {
  if (!text) return;
  if (kioskApp()) {
    if (vietnameseVoice() !== false) toKioskApp({ type: 'speak', text });
    return;
  }
  if (!speechSupported()) return;
  const say = () => {
    // Chỉ đọc bằng giọng tiếng Việt: máy không có giọng Việt thì thôi (giọng Anh đọc câu tiếng Việt nghe sai); chữ vẫn
    // hiện trên màn hình.
    if (!viVoice()) return;
    try {
      const synth = window.speechSynthesis;
      if (synth.paused) synth.resume();
      // Đang đọc câu trước thì dừng; Safari bỏ qua câu đọc ngay sau cancel() nên đợi một chút.
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(() => synth.speak(utter(text)), 250);
      } else synth.speak(utter(text));
    } catch { /* máy không cho đọc: vẫn còn chữ trên màn hình */ }
  };
  if (voices().length) say(); else whenVoices().then(say);
}
