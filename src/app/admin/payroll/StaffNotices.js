'use client';

// 🔔 Thông báo lỗi (mục riêng trên thanh menu của nhân viên / quản lý): các lần mình bị đồng nghiệp báo lỗi mà chủ quán đã xử lý
// (bị phạt → trừ vào lương; bỏ qua → nhắc nhở, không trừ tiền nhưng vẫn lưu) và tháng chốt lương có khoản phạt.
// Mỗi thông báo bấm "Tôi đã xem": máy chủ ghi giờ, không bỏ được — chủ quán thấy giờ đó. Không bao giờ có tên người báo.
import { useCallback, useEffect, useState } from 'react';
import { workforce } from '@/lib/staffApi';
import { NOTICES_REFRESH_EVENT, closeNoticeText, peerNoticeText, unseenCount } from '@/lib/errorNotices.mjs';
import './payroll.css';

const formatMoney = v => `${Number(v || 0).toLocaleString('vi-VN')}đ`;
const ddmm = d => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
const weekday = d => ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][new Date(`${d}T00:00:00Z`).getUTCDay()];
const dayText = d => (d ? `${weekday(d)} ${ddmm(d)}` : '');
const whenText = iso => { const d = new Date(Date.parse(iso) + 7 * 3600000).toISOString(); return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`; };
const TONE = { fined: 'bad', unpriced: 'amber', dropped: 'muted', warn: 'warn' };

export default function StaffNotices() {
  const [data, setData] = useState(null); // { ready, unseen, list }
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/workforce?notices=1', { cache: 'no-store' });
      if (r.status === 401) { window.dispatchEvent(new Event('staff-session-expired')); return; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Không tải được thông báo, thử lại.');
      setData({ ready: j.ready !== false, list: j.list || [] });
      setError('');
    } catch (err) { setError(err.message); }
  }, []);

  useEffect(() => {
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const markSeen = async n => {
    if (busy) return;
    setBusy(n.key);
    try {
      const r = await workforce('notice_seen', n.kind === 'peer' ? { kind: 'peer', id: n.id } : { kind: 'close', year: n.year, month: n.month });
      setData(d => ({ ...d, list: d.list.map(x => (x.key === n.key ? { ...x, seen_at: r.seen_at || new Date().toISOString() } : x)) }));
      // Thanh menu bớt số đỏ ngay.
      window.dispatchEvent(new Event(NOTICES_REFRESH_EVENT));
    } catch (err) { alert(err.message); }
    finally { setBusy(null); }
  };

  const list = data?.list || [];
  const unseen = unseenCount(list);
  const footer = n => (n.seen_at
    ? <div className="notice-seen">✓ Bạn đã xem lúc {whenText(n.seen_at)}</div>
    : <button type="button" className="notice-btn" disabled={busy === n.key} onClick={() => markSeen(n)}>{busy === n.key ? 'Đang lưu…' : '👁 Tôi đã xem'}</button>);

  return (
    <div className="payroll-page" style={{ maxWidth: 640, margin: '0 auto' }}>
      <div className="notice-head">
        <div className="payroll-title">🔔 Thông báo lỗi</div>
        <p>Lần bạn bị báo lỗi mà chủ quán đã xử lý, và tháng chốt lương có khoản phạt. Đọc xong bấm <b>Tôi đã xem</b> — chủ quán thấy bạn đã xem lúc nào.</p>
      </div>
      <div style={{ padding: '0 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && <div className="notice-error">{error}</div>}
        {!data && !error && <div className="empty-state">Đang tải…</div>}
        {data && !data.ready && <div className="empty-state">Mục này đang được cập nhật, thử lại sau ít phút.</div>}
        {data?.ready && !list.length && <div className="empty-state">✅ Chưa có thông báo lỗi nào.</div>}
        {unseen > 0 && <div className="notice-count">{unseen} thông báo chưa xem</div>}
        {list.map(n => (n.kind === 'peer' ? (
          <div key={n.key} className={`notice-card ${TONE[n.outcome] || ''}${n.seen_at ? '' : ' new'}`}>
            <div className="notice-top">
              <span className="notice-kind">🚩 Bị báo lỗi</span>
              <span className="notice-date">{dayText(n.date)}</span>
            </div>
            <div className="notice-reason">{n.reason}</div>
            <div className={`notice-outcome ${TONE[n.outcome] || ''}`}>{peerNoticeText(n)}</div>
            {n.photo && (
              <a href={n.photo} target="_blank" rel="noreferrer" className="notice-photo" title="Bấm để xem ảnh lớn">
                <img src={n.photo} alt="Ảnh làm chứng" />
              </a>
            )}
            {n.at && <div className="notice-meta">Chủ quán xử lý lúc {whenText(n.at)}</div>}
            {footer(n)}
          </div>
        ) : (
          <div key={n.key} className={`notice-card close${n.seen_at ? '' : ' new'}`}>
            <div className="notice-top">
              <span className="notice-kind">🔒 Chốt lương</span>
              {n.at && <span className="notice-date">{whenText(n.at)}</span>}
            </div>
            <div className="notice-reason">{closeNoticeText(n)}</div>
            <div className="notice-fines">
              {n.fines.map(f => (
                <div key={f.id}>
                  <span>{f.date ? `${dayText(f.date)} · ` : ''}{f.peer ? '🚩 ' : f.self ? '🙋 ' : ''}{f.reason}</span>
                  <b>{f.amount > 0 ? `−${formatMoney(f.amount)}` : '0đ'}</b>
                </div>
              ))}
            </div>
            <div className="notice-meta">🚩 bị đồng nghiệp báo · 🙋 bạn tự ghi. Số này đã trừ vào lương tháng {n.month}/{n.year}.</div>
            {footer(n)}
          </div>
        )))}
      </div>
    </div>
  );
}
