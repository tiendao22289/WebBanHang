// Thông báo lỗi cho nhân viên (mục 🔔 Thông báo lỗi trên thanh menu của nhân viên / quản lý):
// - mỗi lần bị đồng nghiệp báo lỗi mà chủ quán đã xử lý: phạt → trừ vào lương; bỏ qua → "nhắc nhở", vẫn lưu lại;
// - lương tháng đã chốt có khoản phạt: liệt kê từng lỗi + tổng tiền trừ.
// Nhân viên bấm "Tôi đã xem" từng thông báo: máy chủ ghi giờ (payroll_peer_reports.seen_at / payroll_closes.fines_seen_at),
// không bỏ được — chủ quán xem lại giờ đó khi cần đối chiếu (nhân viên không chối là không biết).
// Tên người báo và ghi chú của người báo không bao giờ đưa cho người bị báo; ảnh làm chứng thì có (chủ quán đồng ý 2026-11-11).

/** Thông báo chốt lương: các tháng chốt trong chừng này ngày gần đây. */
export const NOTICE_CLOSE_DAYS = 100;
/** Tối đa chừng này lần bị báo (mới nhất trước). */
export const NOTICE_LIMIT = 200;

const money = v => `${Math.round(Number(v) || 0).toLocaleString('vi-VN')}đ`;
const day10 = v => (v ? String(v).slice(0, 10) : null);

/**
 * Thông báo của một lần bị báo lỗi đã xử lý. violation = khoản phạt hiện tại của lần báo đó (chủ có thể sửa tiền / xoá sau);
 * null khi bỏ qua hoặc khoản phạt đã bị xoá.
 * outcome: 'fined' bị phạt có tiền · 'unpriced' ghi lỗi, tiền định sau · 'dropped' chủ đã xoá khoản phạt · 'warn' bỏ qua (nhắc nhở).
 */
export function peerNotice(report, violation = null) {
  const date = day10(report.report_date);
  const base = { kind: 'peer', key: `peer-${report.id}`, id: report.id, date, reason: report.reason, photo: report.photo || null,
    at: report.decided_at || report.created_at || null, seen_at: report.seen_at || null };
  if (report.status !== 'approved') return { ...base, outcome: 'warn', amount: 0 };
  if (report.violation_id && !violation) return { ...base, outcome: 'dropped', amount: 0 };
  const amount = Math.round(Number(violation ? violation.amount : report.amount) || 0);
  return { ...base, outcome: amount > 0 ? 'fined' : 'unpriced', amount,
    year: Number(violation?.year) || Number(date?.slice(0, 4)) || null, month: Number(violation?.month) || Number(date?.slice(5, 7)) || null };
}

/** Câu nói kết quả của một lần bị báo (thẻ thông báo của nhân viên). */
export function peerNoticeText(n) {
  if (n.outcome === 'fined') return `Bị phạt ${money(n.amount)} — trừ vào lương tháng ${n.month}/${n.year}`;
  if (n.outcome === 'unpriced') return 'Chủ quán ghi lỗi — số tiền phạt sẽ định sau';
  if (n.outcome === 'dropped') return 'Chủ quán đã bỏ khoản phạt — không trừ tiền';
  return 'Nhắc nhở — không trừ tiền';
}

/**
 * Thông báo chốt lương của một tháng: fines = các khoản phạt của tháng đó [{ id, date, reason, amount, peer, self }].
 * Tháng không có khoản phạt nào thì không có thông báo (null).
 */
export function closeNotice(close, fines = []) {
  if (!fines.length) return null;
  const list = [...fines].map(f => ({ ...f, amount: Math.round(Number(f.amount) || 0), date: day10(f.date) }))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return { kind: 'close', key: `close-${close.year}-${close.month}`, year: Number(close.year), month: Number(close.month), at: close.closed_at || null,
    seen_at: close.fines_seen_at || null, fines: list, count: list.length, total: list.reduce((a, f) => a + f.amount, 0) };
}

/** Câu tóm tắt thông báo chốt lương. */
export const closeNoticeText = n => `Lương tháng ${n.month}/${n.year} đã chốt: ${n.count} lỗi, trừ ${money(n.total)}`;

/** Chưa xem đứng trên, rồi mới nhất trước. */
export const sortNotices = list => [...list].sort((a, b) => (!!a.seen_at - !!b.seen_at) || String(b.at || '').localeCompare(String(a.at || '')));

/** Số thông báo chưa bấm "Tôi đã xem" (số đỏ trên thanh menu của nhân viên). */
export const unseenCount = list => (list || []).filter(n => n && !n.seen_at).length;

/**
 * Dựng danh sách thông báo của một người từ dữ liệu máy chủ đọc:
 * reports = lần mình bị báo đã xử lý (approved / rejected), violationsById = Map khoản phạt hiện tại,
 * closes = tháng đã chốt gần đây, finesOfClose(close) = khoản phạt của tháng đó.
 */
export function buildNotices({ reports = [], violationsById = new Map(), closes = [], finesOfClose = () => [] }) {
  const list = [
    ...reports.filter(r => r.status === 'approved' || r.status === 'rejected').map(r => peerNotice(r, r.violation_id ? violationsById.get(r.violation_id) || null : null)),
    ...closes.map(c => closeNotice(c, finesOfClose(c))).filter(Boolean),
  ];
  return sortNotices(list);
}

// Sự kiện trên window: trang Thông báo lỗi vừa bấm "Tôi đã xem" → thanh menu hỏi lại số chưa xem ngay.
export const NOTICES_REFRESH_EVENT = 'error-notices-refresh';
export const NOTICES_HREF = '/admin/payroll/loi';
