'use client';
/**
 * Khung "Nợ cũ còn lại" trong form Tạo báo cáo / ghi chú mới: liệt kê mọi khoản
 * đang nợ của các phiếu cũ, tích khoản nào thì trả khoản đó (sửa được số tiền để
 * trả một phần), và tuỳ chọn lấy tiền dư của chuyến chợ để trả nợ.
 *
 * value: { [debtKey]: số tiền } — khoản đang chọn trả.
 */
import { useEffect, useMemo } from 'react';
import { allOpenDebts, allocateToDebts, debtKey } from '@/lib/notesDebts.mjs';

const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
const dayMonth = iso => { const d = new Date(new Date(iso).getTime() + 7 * 3600000).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)}`; };
const digits = v => String(v ?? '').replace(/\D/g, '');

export default function DebtPicker({ notes, value, onChange, surplus, useSurplus, onUseSurplus }) {
  const lines = useMemo(() => allOpenDebts(notes || []), [notes]);
  const total = lines.reduce((a, l) => a + l.left, 0);
  const chosen = Object.values(value || {}).reduce((a, v) => a + (Number(v) || 0), 0);

  // "Lấy tiền dư trả nợ": chia tiền dư vào khoản đã tích trước, rồi phiếu cũ nhất.
  useEffect(() => {
    if (!useSurplus) return;
    const preferred = Object.keys(value || {});
    const next = allocateToDebts(Math.max(0, surplus || 0), lines, preferred);
    if (JSON.stringify(next) !== JSON.stringify(value || {})) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useSurplus, surplus, lines]);

  if (!lines.length) return null;
  const toggle = line => {
    const key = debtKey(line);
    const next = { ...(value || {}) };
    if (next[key]) delete next[key]; else next[key] = line.left;
    onUseSurplus(false);
    onChange(next);
  };
  const setAmount = (line, raw) => {
    const n = Math.min(line.left, Number(digits(raw)) || 0);
    onUseSurplus(false);
    onChange({ ...(value || {}), [debtKey(line)]: n });
  };

  return (
    <div style={{ marginTop: 12, padding: '12px 14px', background: '#fef2f2', border: '1.5px solid #fca5a5', borderRadius: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, color: '#dc2626', fontSize: 13 }}>📋 Nợ cũ còn lại: {money(total)}</span>
        {chosen > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed' }}>Trả lần này: {money(chosen)}</span>}
      </div>

      {surplus > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40, padding: '6px 10px', marginBottom: 8, borderRadius: 8, background: 'white', border: '1px solid #c4b5fd', fontSize: 13, fontWeight: 700, color: '#5b21b6', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!useSurplus} onChange={e => onUseSurplus(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#7c3aed' }} />
          Lấy tiền dư {money(surplus)} trả nợ
        </label>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {lines.map(line => {
          const key = debtKey(line);
          const picked = value?.[key] !== undefined;
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: picked ? '#f5f3ff' : 'white', border: `1px solid ${picked ? '#c4b5fd' : '#fecaca'}` }}>
              <input type="checkbox" checked={picked} onChange={() => toggle(line)} style={{ width: 18, height: 18, flexShrink: 0, accentColor: '#7c3aed' }} aria-label={`Trả ${line.name}`} />
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.35 }}>
                <div style={{ fontWeight: 700, color: '#111827' }}>{line.creditor || 'Không ghi tên'} — {line.name}</div>
                <div style={{ color: '#6b7280' }}>Phiếu {dayMonth(line.created_at)}{line.writer ? ` · ${line.writer}` : ''} · còn <b style={{ color: '#dc2626' }}>{money(line.left)}</b></div>
              </div>
              {picked && (
                <input type="text" inputMode="numeric" value={Number(value[key] || 0).toLocaleString('vi-VN')} onChange={e => setAmount(line, e.target.value)}
                  style={{ width: 96, padding: '6px 8px', border: '1.5px solid #c4b5fd', borderRadius: 7, fontSize: 14, textAlign: 'right' }} aria-label="Số tiền trả" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
