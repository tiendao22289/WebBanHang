'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, History, RefreshCw, ReceiptText, DoorOpen, XCircle } from 'lucide-react';
import './logs.css';

const labels = { paid: 'Đã thanh toán', cancelled: 'Đã hủy', opened: 'Mở xem bàn' };
const icons = { paid: ReceiptText, cancelled: XCircle, opened: DoorOpen };
const money = value => `${Number(value || 0).toLocaleString('vi-VN')}đ`;
const time = value => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });

export default function TableLogsPage() {
  const [table, setTable] = useState(null);
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef(null);

  async function load(selected, nextCursor = null) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    if (!nextCursor) { setEntries([]); setCursor(null); setCheckedAt(null); }
    try {
      const params = new URLSearchParams();
      if (selected) params.set('table', selected.id);
      if (nextCursor) params.set('cursor', nextCursor);
      const response = await fetch(`/api/admin/logs?${params}`, { cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { setEntries([]); setCursor(null); }
        if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
        throw new Error(result.error);
      }
      if (controller.signal.aborted) return;
      setEntries(previous => nextCursor ? [...previous, ...result.entries.filter(entry => !previous.some(old => old.id === entry.id))] : result.entries);
      setCursor(result.nextCursor);
      setCheckedAt(result.checkedAt);
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message || 'Không kết nối được máy chủ.');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  useEffect(() => {
    load(table);
    return () => pending.current?.abort();
  }, [table, refreshKey]);

  return <div className="table-logs">
    <header className="table-logs-header">
      <div><h1><History size={23} />{table ? `Lịch sử bàn ${table.number}` : 'Lịch sử các bàn'}</h1>
        <p>Thanh toán · 10 giờ | Hủy · 8 giờ | Mở xem · 6 giờ</p>
      </div>
      <button className="logs-icon-button" title="Đồng bộ lịch sử" aria-label="Đồng bộ lịch sử" disabled={busy} onClick={() => setRefreshKey(key => key + 1)}><RefreshCw size={19} className={busy ? 'logs-spin' : ''} /></button>
    </header>
    <div className="table-logs-toolbar">
      {table ? <button onClick={() => setTable(null)}><ArrowLeft size={16} />Tất cả bàn</button> : <span>{entries.length} hoạt động</span>}
      {checkedAt && <small>Cập nhật {time(checkedAt)}</small>}
    </div>
    {error && <div className="table-logs-error" role="alert">{error}<button disabled={busy} onClick={() => cursor ? load(table, cursor) : setRefreshKey(key => key + 1)}>Thử lại</button></div>}
    <div className="table-logs-list" aria-busy={busy}>
      {entries.map(entry => {
        const Icon = icons[entry.source];
        return <article className={`table-log ${entry.source}`} key={entry.id}>
          <div className="table-log-summary">
            <Icon className="table-log-icon" size={19} />
            <div className="table-log-main">
              <div className="table-log-heading"><button className="table-log-table" onClick={() => setTable({ id: entry.tableId, number: entry.tableNumber })}>Bàn {entry.tableNumber}<ChevronRight size={15} /></button><span className={`table-log-status ${entry.source}`}>{labels[entry.source]}</span></div>
              <div className="table-log-meta"><time dateTime={entry.at}>{time(entry.at)}</time><span>{entry.actor || 'Không rõ người thực hiện'}</span></div>
              {entry.billCode && <div className="table-log-code">{entry.billCode}</div>}
            </div>
            {entry.source !== 'opened' && <strong className="table-log-total">{money(entry.total)}</strong>}
          </div>
          {table && entry.items && <div className="table-log-bill">
            {entry.customer && <p>{entry.customer}{entry.paymentMethod && ` · ${entry.paymentMethod === 'cash' ? 'Tiền mặt' : 'Chuyển khoản'}`}</p>}
            {entry.items.length === 0 && <p>Không có chi tiết món.</p>}
            {entry.items.map((item, index) => <div className="table-log-item" key={item.id || index}>
              <div><span>{item.quantity} × {item.name}{item.isGift ? ' · Quà tặng' : ''}</span>{item.note && <small>{item.note}</small>}{item.addedBy && <small>Thêm bởi {item.addedBy}</small>}</div>
              <span>{money(item.unitPrice * item.quantity)}</span>
            </div>)}
          </div>}
        </article>;
      })}
      {!busy && !error && entries.length === 0 && <div className="table-logs-empty">Chưa có lịch sử{table ? ` của bàn ${table.number}` : ''} trong thời gian này.</div>}
      {busy && <div className="table-logs-empty" role="status">Đang tải lịch sử...</div>}
    </div>
    {cursor && <button className="table-logs-more" disabled={busy} onClick={() => load(table, cursor)}>Xem thêm</button>}
  </div>;
}
