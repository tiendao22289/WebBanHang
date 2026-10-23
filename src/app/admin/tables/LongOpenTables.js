'use client';

import { useEffect, useState } from 'react';

// Bàn có khách quá lâu (quên đóng bàn / quên thanh toán) — hiện 1 dòng cảnh báo trên lưới bàn.
export const LONG_OPEN_HOURS = 12;

export default function LongOpenTables({ tables, onOpen }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  const longOpen = (tables || [])
    .filter(t => t.status === 'occupied' && t.table_type !== 'takeaway' && !t.merged_with && t.occupied_at)
    .map(t => ({ table: t, hours: Math.floor((now - new Date(t.occupied_at).getTime()) / 3600000) }))
    .filter(x => x.hours >= LONG_OPEN_HOURS)
    .sort((a, b) => b.hours - a.hours);
  if (!longOpen.length) return null;
  return (
    <div role="alert" style={{ margin: '8px 12px 0', padding: '8px 12px', borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 13, lineHeight: 1.45 }}>
      <b>⏰ {longOpen.length} bàn mở quá {LONG_OPEN_HOURS} giờ:</b>{' '}
      {longOpen.map(({ table, hours }, i) => (
        <span key={table.id}>
          {i > 0 && ', '}
          <button type="button" onClick={() => onOpen?.(table)}
            style={{ border: 0, background: 'none', padding: 0, color: '#b45309', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', fontSize: 13 }}>
            B{table.table_number}
          </button> ({hours >= 48 ? `${Math.floor(hours / 24)} ngày` : `${hours} giờ`})
        </span>
      ))}
      . Kiểm tra: thanh toán hoặc huỷ bill rồi đóng bàn.
    </div>
  );
}
