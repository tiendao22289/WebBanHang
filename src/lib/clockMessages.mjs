/**
 * Chấm công bằng mã QR trên máy quầy — phần dùng chung cho trang /checkin (mở bằng camera
 * điện thoại) và nút "Quét mã chấm công" trong app nhân viên: đọc mã quét được, kiểm mã còn
 * mới, câu báo sau khi vào / ra ca. Máy chủ mới là nơi kiểm chữ ký, wifi, điện thoại.
 */
import { dayFlags, durationText, shiftOf, workDayOf } from './attendanceRules.mjs';
import { DAY_PAY_FROM, EARLY_CUT_MINUTES } from './payroll.mjs';
import { FACE_MISS_TEXT } from './faceCheck.mjs';

// Mã QR trên máy quầy có dạng "<giờ tạo>.<máy quầy>.<số riêng>.<chữ ký>", hết hạn sau 2 phút — máy chủ
// kiểm bằng đồng hồ của chính nó. Điện thoại chỉ loại mã rõ ràng là cũ (ảnh chụp mã từ hôm trước), vì
// đồng hồ máy chủ ở quán và điện thoại có thể lệch nhau vài phút (đã gặp máy chủ chậm 9 phút).
const STALE_MS = 60 * 60 * 1000;
export function tokenFresh(token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return false;
  const issued = parseInt(parts[0], 36) * 1000;
  return Number.isFinite(issued) && now - issued < STALE_MS;
}

/**
 * Mã chấm công trong chữ đọc được từ mã QR: đường link …/checkin?t=… của máy quầy; mã khác (mã gọi
 * món trên bàn, wifi…) thì null. Không bắt trùng tên miền (www hay không): máy chủ mới kiểm chữ ký mã.
 */
export function qrClockToken(text) {
  try {
    const url = new URL(String(text || '').trim());
    if (!/^https?:$/.test(url.protocol) || url.pathname !== '/checkin') return null;
    return url.searchParams.get('t') || null;
  } catch {
    return null;
  }
}

export const STAFF_WARNING_TEXT = {
  other_network: 'Lần này điện thoại không dùng wifi quán.',
  unknown_device: 'Lần này bạn chấm bằng điện thoại khác máy đã đăng ký.',
  shared_device: 'Điện thoại này đã đăng ký chấm công cho người khác.',
};

// Tổng giờ các lượt đã ra ca (làm tròn 0,1 giờ mỗi lượt).
export function sumHours(sessions) {
  return (sessions || []).reduce((acc, s) => {
    if (!s.clock_out) return acc;
    return acc + Math.round((new Date(s.clock_out) - new Date(s.clock_in)) / 360000) / 10;
  }, 0);
}

// "2,6 giờ" (dấu phẩy như cách viết số ở Việt Nam).
export const hoursText = h => `${String(Math.round(h * 10) / 10).replace('.', ',')} giờ`;

export function clockTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Câu báo sau khi quét (kết quả của action clock): vào / ra ca lúc mấy giờ, tổng giờ hôm nay. */
export function clockSummary(result) {
  const sessions = result.sessions || [];
  if (result.clocked === 'out') {
    const durH = Math.round((new Date(result.at) - new Date(result.session.clock_in)) / 360000) / 10;
    return `🔴 Ra ca lúc ${clockTime(result.at)} · Ca này: ${hoursText(durH)}\n✅ Tổng hôm nay: ${hoursText(sumHours(sessions))}`;
  }
  return `🟢 Vào ca lúc ${clockTime(result.at)}\n⏱ Tổng tích luỹ hôm nay: ${hoursText(sumHours(sessions))}`;
}

// ── Câu đọc to sau khi quét (giọng tiếng Việt của máy): không biểu tượng, giờ Việt Nam đọc "14 giờ 05".
export function spokenTime(ts) {
  const t = new Date(Date.parse(ts) + 7 * 3600000);
  return `${t.getUTCHours()} giờ ${String(t.getUTCMinutes()).padStart(2, '0')}`;
}
const plainText = s => String(s || '').replace(/[^\p{L}\p{N}\s.,:;!?()/%+-]/gu, '').replace(/\s+/g, ' ').trim();

/** Điện thoại nhân viên: kết quả của action clock. */
export const spokenClock = result => `Quét mã thành công. ${result.clocked === 'out' ? 'Ra' : 'Vào'} ca lúc ${spokenTime(result.at)}.`;
/** Điện thoại nhân viên: máy chủ từ chối (câu lỗi của máy chủ, vd. chưa vào wifi quán). */
export const spokenClockError = message => `Quét mã chưa thành công. ${plainText(message)}`;

// Máy quầy: lượt quét bị chặn (đang bật chặn thật trong trang Lương) — lý do ngắn để hiện / đọc.
export const KIOSK_FAIL_TEXT = {
  other_network: 'Điện thoại chưa vào wifi quán',
  shared_device: 'Điện thoại này đã đăng ký cho người khác',
  unknown_device: 'Không phải điện thoại đã đăng ký',
};
/** Máy quầy: {ok, name, action, at} khi chấm được, {ok: false, name, reason} khi bị chặn. */
export function spokenKiosk(n) {
  if (!n.ok) return `${n.name}, quét mã chưa thành công. ${KIOSK_FAIL_TEXT[n.reason] || 'Xem lại trên điện thoại'}.`;
  return `${n.name}, quét mã thành công. ${n.action === 'out' ? 'Ra' : 'Vào'} ca lúc ${spokenTime(n.at)}.`;
}

// ── So mặt ở máy quầy (app): kết quả một lượt quét — máy quầy đọc to, điện thoại hiện chữ.
/** r = trả lời face_verify của máy chủ: {result: ok | wrong | review | expired, name, clocked, at, reason}. */
export function spokenFace(r) {
  if (r.result === 'ok') return `${r.name}, đúng mặt. ${r.clocked === 'out' ? 'Ra' : 'Vào'} ca lúc ${spokenTime(r.at)}.`;
  if (r.result === 'wrong') return `${r.name}, sai mặt. Lượt này không tính. Quét lại mã.`;
  if (r.result === 'review') return `${r.name}, sai mặt ba lần. Đã ghi giờ, chờ chủ quán duyệt.`;
  const why = FACE_MISS_TEXT[r.reason];
  return `${r.name}, chưa so được mặt.${why ? ` ${why}.` : ''} Quét lại mã.`;
}

/** Điện thoại nhân viên chờ máy quầy so mặt: câu báo khi không được tính (sai mặt / hết giờ). Đúng mặt thì null. */
export function faceWaitText(r) {
  if (r.status === 'ok' || r.status === 'review') return null;
  if (r.status === 'wrong') return `❌ Sai mặt — lượt này không tính.
Quét lại mã trên máy quầy và nhìn thẳng vào camera.${r.tries_left ? ` Sai thêm ${r.tries_left} lần thì máy vẫn ghi giờ nhưng chờ chủ quán duyệt.` : ''}`;
  if (r.status === 'expired') return `⚠️ Máy quầy chưa so được mặt${FACE_MISS_TEXT[r.reason] ? ` (${FACE_MISS_TEXT[r.reason].toLowerCase()})` : ''}.
Quét lại mã trên máy quầy.`;
  return 'Không tìm thấy lượt quét này. Quét lại mã trên máy quầy.';
}

// Đúng giờ / trễ / sớm so với ca của người đó, báo ngay sau khi quét (chỉ từ ngày tính giờ theo ca).
export function punctuality(clocked, session, sessions, rules, staffId) {
  if (!rules || !session || !(String(session.date) >= rules.hours_from)) return '';
  const day = (sessions || []).some(s => s.id === session.id) ? sessions : [session];
  // Ca của ngày làm: vào lại sau nửa đêm để dọn quán vẫn so với ca hôm trước.
  const f = dayFlags(day, rules), shift = shiftOf(rules, staffId, workDayOf(session, rules));
  if (clocked === 'in') {
    if (f.late) return `⏰ Trễ ${durationText(f.late)} so với ca ${shift.start}.`;
    if (f.early) return `🌅 Vào sớm ${durationText(f.early)}: giờ trước ${shift.start} chỉ được tính khi chủ quán đồng ý.`;
    return `✅ Đúng giờ (ca ${shift.start} – ${shift.end}).`;
  }
  if (f.leftEarly) {
    // Từ tháng 11 về sớm từ 30 phút bị trừ lương theo giờ về sớm.
    const cut = f.leftEarly >= EARLY_CUT_MINUTES && workDayOf(session, rules).slice(0, 7) >= DAY_PAY_FROM;
    return `⏰ Về sớm ${durationText(f.leftEarly)} so với giờ hết ca ${shift.end}.${cut ? ' Về sớm từ 30 phút bị trừ lương theo giờ về sớm.' : ''}`;
  }
  if (f.stayed) return `🌙 Ở lại ${durationText(f.stayed)} sau ca: giờ này chờ chủ quán duyệt mới được tính.`;
  return '✅ Ra ca đúng giờ.';
}
