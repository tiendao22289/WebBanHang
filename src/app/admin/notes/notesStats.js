'use client';
/**
 * Phần tính toán của trang Sổ tay (tách riêng cho trang cũ gọn):
 *  - LineHint: thành tiền + cảnh báo dưới mỗi dòng hàng khi đang gõ.
 *  - notesSummary: ô thống kê theo khoảng ngày đang lọc, có tính từng lần trả nợ.
 */
import { lineWarnings, parsePrice, parseQty } from '@/lib/notesMath.mjs';
export { filterRange, notesSummary } from '@/lib/notesSummary.mjs';

export function LineHint({ item }) {
  const total = Math.round(parsePrice(item.price) * parseQty(item.qty));
  const warnings = String(item.name || '').trim() ? lineWarnings(item) : [];
  if (total <= 0 && !warnings.length) return null;
  const debt = item.paymentStatus === 'debt';
  return (
    <>
      {total > 0 && (
        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: debt ? '#dc2626' : '#15803d', marginTop: 3, paddingLeft: 2 }}>
          = {total.toLocaleString('vi-VN')} ₫ {debt ? '🔴 (Nợ)' : '✓'}
        </div>
      )}
      {warnings.map(w => (
        <div key={w} style={{ fontSize: '0.74rem', color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '3px 6px', marginTop: 3 }}>⚠ {w}</div>
      ))}
    </>
  );
}

