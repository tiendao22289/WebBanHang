'use client';
/**
 * Sổ tay — 2 tab của phiếu đi chợ: "Hàng ốc" (như trước giờ) và "Khác" (xăng xe, sửa chữa, đồ dùng…,
 * chủ quán tự tạo loại). Dòng tab Khác có category = id loại; thống kê tách riêng theo loại.
 */
import { categoryName, categoryOptions, lineCategory, OTHER_ID } from '@/lib/noteCategories.mjs';
import { parsePrice, parseQty } from '@/lib/notesMath.mjs';

const lineMoney = i => Math.round(parsePrice(i.price) * parseQty(i.qty));
export const isOtherLine = i => !!lineCategory(i);
export const newOtherLine = category => ({ _id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  name: '', price: '', qty: '', paymentStatus: 'full', creditor: '', debtAmount: '', category: category || OTHER_ID });

/** Hai tab của phiếu, mỗi tab hiện số dòng + tiền đã ghi. */
export function KindTabs({ tab, onTab, items }) {
  const named = items.filter(i => String(i.name || '').trim());
  const side = other => {
    const rows = named.filter(i => isOtherLine(i) === other);
    return rows.length ? `${rows.length} dòng · ${rows.reduce((s, i) => s + lineMoney(i), 0).toLocaleString('vi-VN')}đ` : 'chưa có';
  };
  return <div className="kind-tabs" role="tablist" aria-label="Loại hàng">
    {[['oc', '🐚 Hàng ốc', side(false)], ['other', '📦 Khác', side(true)]].map(([key, label, sub]) => (
      <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => onTab(key)}>
        <b>{label}</b><small>{sub}</small>
      </button>))}
  </div>;
}

/** Chọn loại cho dòng tab Khác (loại chủ tạo, cuối cùng là "Khác"). */
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

export function OtherHint({ categories, isAdmin }) {
  return <p className="kind-hint">
    Thứ không phải hàng làm món ốc: xăng xe, sửa chữa, đồ dùng, in ấn… Chọn loại cho từng dòng, thống kê tính riêng.
    {!categories.length && (isAdmin ? ' Chưa có loại nào: tạo loại ở tab "📦 Chi khác".' : ' Chủ quán chưa tạo loại, cứ chọn "Khác".')}
  </p>;
}
