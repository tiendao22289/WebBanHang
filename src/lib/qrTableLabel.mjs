/**
 * Tên bàn ghi kèm khoản thu ở trang Mã QR (/admin/qr) → finance_manual_receipts.table_label, hiện trong Sổ thu chi
 * ("20:15 · Bàn 5") và tìm được ở Tra cứu. Gõ "5" hay "ban 5" đều thành "Bàn 5"; chữ khác (Mang về, VIP 2…) giữ
 * nguyên, bỏ khoảng trắng thừa, tối đa 40 ký tự. Để trống → null (sổ hiện "Bill giấy" như trước).
 */
export const QR_TABLE_LABEL_MAX = 40;

export function qrTableLabel(value) {
  const text = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, QR_TABLE_LABEL_MAX).trim();
  if (!text) return null;
  const number = /^(?:b(?:a|à)n\s*)?0*(\d{1,4})$/i.exec(text);
  return number ? `Bàn ${number[1]}` : text;
}
