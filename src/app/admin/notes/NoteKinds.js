'use client';
/**
 * Sổ tay — dòng "Khác" của phiếu đi chợ (xăng xe, sửa chữa, đồ dùng…, chủ quán tự tạo loại): nhóm cuối
 * trong danh sách hàng, mỗi dòng có category = id loại; thống kê tách riêng theo loại.
 */
import { categoryName, categoryOptions, lineCategory, OTHER_ID } from '@/lib/noteCategories.mjs';

export const isOtherLine = i => !!lineCategory(i);
export const newOtherLine = category => ({ _id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  name: '', price: '', qty: '', paymentStatus: 'full', creditor: '', debtAmount: '', category: category || OTHER_ID });

/** Chọn loại cho dòng nhóm Khác (loại chủ tạo, cuối cùng là "Khác"). */
export function CategorySelect({ value, categories, onChange, style }) {
  return <select className="kind-select" value={value || OTHER_ID} onChange={e => onChange(e.target.value)} style={style} aria-label="Loại">
    {categoryOptions(categories).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
  </select>;
}

/** Nhãn loại cạnh tên dòng hàng khi xem phiếu. */
export function KindTag({ item, categories }) {
  const id = lineCategory(item);
  if (!id) return null;
  return <span className="kind-tag">📦 {categoryName(id, categories)}</span>;
}
