/**
 * Chấm công bằng mã QR trên máy quầy — phần dùng chung cho trang /checkin (mở bằng camera
 * điện thoại) và nút "Quét mã chấm công" trong app nhân viên: đọc mã quét được, kiểm mã còn
 * mới, câu báo sau khi vào / ra ca. Máy chủ mới là nơi kiểm chữ ký, wifi, điện thoại.
 */
import { dayFlags, durationText, shiftOf, workDayOf } from './attendanceRules.mjs';
import { DAY_PAY_FROM, EARLY_CUT_MINUTES } from './payroll.mjs';

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
