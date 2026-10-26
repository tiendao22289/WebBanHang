// Lời nhắn khi camera trong web không mở được (CameraCapture) — tách riêng để kiểm tra bằng test.
/** Lời nhắn khi không mở được camera (kèm mã lỗi để báo lại cho người sửa). */
export function cameraErrorText(err, userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const inApp = /zalo|FBAN|FBAV|Instagram|Line\//i.test(userAgent);
  const fallback = 'bấm "Dùng camera của máy" bên dưới để chụp';
  const text = {
    NotAllowedError: inApp
      ? `Trình duyệt trong Zalo / Facebook không cho trang dùng camera. Mở trang bằng Chrome, hoặc ${fallback}.`
      : `Chưa cho phép camera. Bấm biểu tượng ổ khoá cạnh địa chỉ web → Quyền → Camera → Cho phép, rồi tải lại trang. Hoặc ${fallback}.`,
    NotFoundError: `Không tìm thấy camera trên máy này. Thử ${fallback}.`,
    NotReadableError: `Camera đang bị ứng dụng khác dùng (camera, gọi video…). Tắt ứng dụng đó rồi thử lại, hoặc ${fallback}.`,
  }[err?.name === 'SecurityError' ? 'NotAllowedError' : err?.name === 'AbortError' ? 'NotReadableError' : err?.name];
  return `${text || `Không mở được camera trong trang, ${fallback}.`} (mã lỗi: ${err?.name || 'không rõ'})`;
}
