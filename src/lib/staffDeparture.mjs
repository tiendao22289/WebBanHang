/**
 * Nhân viên nghỉ việc (bảng staff_departures): qua ngày làm cuối thì không đăng
 * nhập, không chấm công được nữa và không hiện trong bảng lương các tháng sau.
 */

export const vnDay = (now = Date.now()) => new Date(now + 7 * 3600000).toISOString().slice(0, 10);

/** Đã qua ngày làm cuối chưa. Bảng chưa cài / lỗi đọc thì coi như còn làm (không khoá nhầm ai). */
export async function hasLeft(db, staffId, today = vnDay()) {
  try {
    const { data, error } = await db.from('staff_departures').select('last_day').eq('staff_id', staffId).maybeSingle();
    if (error || !data?.last_day) return false;
    return String(data.last_day).slice(0, 10) < today;
  } catch { return false; }
}

/** Còn làm trong tháng `YYYY-MM` không (nghỉ từ tháng sau trở đi thì vẫn hiện tháng này để kết toán). */
export const activeInMonth = (departure, monthKey) => !departure || String(departure.last_day).slice(0, 7) >= monthKey;
