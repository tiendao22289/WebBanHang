// Mã QR chuyển khoản cần thẻ ngân hàng đang bật: trang Bàn cần thẻ hiển thị (prepare_stats_payment báo
// "Chua co the A dang hoat dong" khi thẻ đó tắt) và thẻ ẩn cho bill ngoài thống kê; trang Mã QR cần thẻ ẩn.

// Câu báo cho nhân viên khi trang Bàn chưa tạo được mã QR — nói đúng lý do thay vì "kiểm tra mạng".
// Trang Bàn là trang nhân viên: không nhắc tới thẻ ẩn.
export function qrSetupProblem(error) {
  const message = String(error?.message || '');
  if (/Chua co the A dang hoat dong/i.test(message)) {
    return { title: 'Thẻ ngân hàng đang tắt',
      text: 'Thẻ nhận chuyển khoản đang bị tắt nên chưa tạo được mã QR. Vào Cài đặt → 💳 Thanh toán, bấm "▶ Bật" ở thẻ ngân hàng (hoặc báo chủ quán), rồi bấm Chuyển khoản lại.' };
  }
  if (/Khong co tai khoan nhan tien phu hop|Tai khoan QR khong con hoat dong/i.test(message)) {
    return { title: 'Chưa có thẻ nhận tiền',
      text: 'Chưa có tài khoản ngân hàng nào đang bật để nhận tiền bàn này. Báo chủ quán kiểm tra tài khoản ngân hàng trong Cài đặt, rồi bấm Chuyển khoản lại.' };
  }
  if (/Bill da thay doi|Nhom ban da thay doi|Khong tim thay ban/i.test(message)) {
    return { title: 'Bàn vừa thay đổi',
      text: 'Bàn vừa ghép / chuyển hoặc bill vừa thêm, bớt món. Xem lại bàn rồi bấm Chuyển khoản lại.' };
  }
  return { title: 'Chưa thể tạo QR', text: 'Không đọc được đầy đủ bill. Vui lòng kiểm tra mạng rồi thử lại.' };
}

// Hỏi lại trước khi tắt thẻ cuối cùng mà mã QR đang cần (cards = mọi thẻ, cả thẻ ẩn). Bật thẻ thì không hỏi.
export function cardOffWarning(card, cards = []) {
  if (!card?.is_active) return null;
  const sameKind = cards.some(c => c.id !== card.id && c.is_active && !!c.is_visible === !!card.is_visible);
  if (sameKind) return null;
  return card.is_visible
    ? 'Đây là thẻ hiển thị duy nhất đang bật. Tắt thẻ này thì trang Bàn KHÔNG tạo được mã QR chuyển khoản cho khách. Vẫn tắt?'
    : 'Đây là thẻ ẩn cuối cùng đang bật. Tắt thẻ này thì trang Mã QR và các bill ngoài thống kê ở trang Bàn KHÔNG tạo được mã QR. Vẫn tắt?';
}
