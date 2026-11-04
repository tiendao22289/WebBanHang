'use client';
// Báo cáo thu chi gửi qua Zalo OA mỗi ngày tới chủ quán: liên kết Zalo, bật / tắt, giờ gửi, mục trong báo cáo, gửi thử.
// Nằm ở trang Cài đặt (trước đây ở tab Tháng của Sổ thu chi). Tự đọc trạng thái từ /api/admin/finance?zalo=1.
import { useEffect, useState } from 'react';
import '@/app/admin/finance/finance.css';

const clock = value => new Date(value).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
const stamp = iso => { const d = new Date(Date.parse(iso) + 7 * 3600000).toISOString(); return `${clock(iso)} ${d.slice(8, 10)}/${d.slice(5, 7)}`; };
// Giờ gửi báo cáo Zalo: mốc 30 phút trong ngày.
const SEND_TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Không kết nối được máy chủ.'), { result });
  return result;
}
const post = body => api('/api/admin/finance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function ZaloReportPanel() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  async function refresh() {
    setLoadError('');
    try { setState((await api('/api/admin/finance?zalo=1')).zaloReport || null); }
    catch (err) { setLoadError(err.message); }
  }
  useEffect(() => { refresh(); }, []);

  async function act(action) {
    if (action === 'zalo_unlink' && !confirm('Ngừng gửi báo cáo Zalo?')) return;
    setBusy(action); setMessage('');
    try {
      const res = await post({ action });
      setState(res.zaloReport);
      if (action === 'zalo_test') setMessage('✓ Đã gửi, mở Zalo để xem.');
    } catch (err) {
      if (err.result?.zaloReport) setState(err.result.zaloReport);
      setMessage(err.message);
    } finally { setBusy(''); }
  }
  async function toggleSection(key) {
    const sections = { ...(state.sections || {}), [key]: !(state.sections?.[key] !== false) };
    setBusy('sections'); setMessage('');
    try { setState((await post({ action: 'zalo_set_sections', sections })).zaloReport); }
    catch (err) { setMessage(err.message); } finally { setBusy(''); }
  }
  async function setTime(time) {
    setBusy('time'); setMessage('');
    try { setState((await post({ action: 'zalo_set_time', time })).zaloReport); setMessage(`✓ Sẽ gửi lúc ${time} mỗi ngày.`); }
    catch (err) { setMessage(err.message); } finally { setBusy(''); }
  }
  async function setEnabled(enabled) {
    setBusy('enabled'); setMessage('');
    try { setState((await post({ action: 'zalo_set_enabled', enabled })).zaloReport); setMessage(enabled ? '✓ Đã bật gửi Zalo.' : '✓ Đã tắt gửi Zalo. Vẫn xem được ở trang Thống kê nhanh.'); }
    catch (err) { setMessage(err.message); } finally { setBusy(''); }
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(`BC ${state.linkCode}`); setMessage('Đã chép, dán vào Zalo.'); } catch { /* trình duyệt chặn → tự gõ */ }
  }

  // Khung "finance fin-embed": dùng chung kiểu chữ / nút của Sổ thu chi nhưng không lấy lề, nền của trang đó.
  return <div className="finance fin-embed">
    <section className="fin-panel fin-zalo">
      <h2>📩 Báo cáo Zalo hằng ngày</h2>
      {!state && <p className="fin-zalo-hint">{loadError ? `Không tải được: ${loadError}` : 'Đang tải…'}</p>}
      {state && (state.linkCode ? <>
        <p>Mở Zalo, nhắn cho <b>OA của quán</b> đúng nội dung:</p>
        <button className="fin-zalo-code" onClick={copyCode} aria-label="Chép mã">BC {state.linkCode}</button>
        <p className="fin-zalo-hint">Mã dùng trong 30 phút. Nhắn xong bấm “Kiểm tra”.</p>
        <div className="fin-zalo-actions">
          <button className="fin-primary" onClick={refresh}>Kiểm tra</button>
        </div>
      </> : state.linked > 0 ? <>
        <label className="fin-zalo-switch"><input type="checkbox" checked={state.enabled !== false} disabled={!!busy} onChange={e => setEnabled(e.target.checked)} /> Gửi báo cáo qua Zalo mỗi ngày</label>
        {state.enabled === false
          ? <p className="fin-zalo-hint">Đang tắt — không gửi Zalo, Zalo đã liên kết vẫn giữ nguyên.</p>
          : <p className="fin-zalo-ok">✓ Đang gửi tới {state.linked} Zalo · khoảng {state.sendAt || '08:00'} gửi số liệu {Number(String(state.sendAt || '08:00').slice(0, 2)) < 12 ? 'ngày hôm qua' : 'hôm nay'}.</p>}
        <label className="fin-zalo-time">Giờ gửi
          <select value={state.sendAt || '08:00'} disabled={!!busy} onChange={e => setTime(e.target.value)}>
            {SEND_TIMES.map(t => <option key={t} value={t}>{t}{Number(t.slice(0, 2)) < 12 ? ' — số hôm qua' : ' — số hôm nay'}</option>)}
          </select>
        </label>
        <div className="fin-zalo-sections" role="group" aria-label="Mục trong báo cáo">
          {[['loss', '🔍 Thất thoát (bill huỷ, món bớt, giảm giá, tặng)'], ['staff', '👥 Nhân viên (chấm công, chờ duyệt)'], ['compare', '📈 So sánh, món bán chạy'], ['notes', '🛒 Sổ tay chi tiết']].map(([key, text]) => (
            <label key={key}><input type="checkbox" checked={state.sections?.[key] !== false} disabled={!!busy} onChange={() => toggleSection(key)} /> {text}</label>
          ))}
        </div>
        {state.lastSentAt && <p className="fin-zalo-hint">Lần gửi gần nhất: {stamp(state.lastSentAt)}</p>}
        {state.lastError && <p className="fin-warn">⚠ Lần gần nhất Zalo không gửi được. Mở Zalo, nhắn “ok” cho OA của quán rồi bấm “Gửi thử”. Zalo chỉ cho OA nhắn lại người vừa nhắn mình trong vài ngày.</p>}
        <div className="fin-zalo-actions">
          <button className="fin-primary" onClick={() => act('zalo_test')} disabled={!!busy}>{busy === 'zalo_test' ? 'Đang gửi...' : 'Gửi thử số hôm nay'}</button>
          <button className="fin-secondary" onClick={() => act('zalo_link_code')} disabled={!!busy}>Thêm Zalo khác</button>
          <button className="fin-secondary danger" onClick={() => act('zalo_unlink')} disabled={!!busy}>Ngừng gửi</button>
        </div>
      </> : <>
        <p>Nhận tổng kết thu chi, lệch két, bill CK chưa có ảnh / chưa đối chiếu qua Zalo mỗi sáng — không cần mở web.</p>
        <div className="fin-zalo-actions">
          <button className="fin-primary" onClick={() => act('zalo_link_code')} disabled={!!busy}>Liên kết Zalo</button>
        </div>
      </>)}
      {message && !(state?.lastError && state?.linked > 0 && !message.startsWith('✓')) && <p className="fin-zalo-hint" role="status">{message}</p>}
      <p className="fin-zalo-hint"><a href="/thongke" target="_blank" rel="noopener">Mở trang Thống kê nhanh (/thongke) ↗</a> — đọc báo cáo trên điện thoại, xem lại ngày cũ.</p>
    </section>
  </div>;
}
