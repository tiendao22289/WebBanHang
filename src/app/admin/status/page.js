'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Cpu, RefreshCw, Download, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import './status.css';

const labels = { healthy: 'Healthy', warning: 'Cần kiểm tra', error: 'Lỗi' };
const logLabels = { website: 'Website', printing: 'PrintAgent', tunnel: 'Cloudflare Tunnel', proxy: 'Local Proxy', startup: 'Khởi động Windows', recovery: 'Script phục hồi' };
function Badge({ state }) {
  const Icon = state === 'healthy' ? CheckCircle2 : state === 'warning' ? AlertTriangle : XCircle;
  return <span className={`status-badge ${state}`}><Icon size={15} />{labels[state] || state}</span>;
}
function duration(seconds = 0) {
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export default function StatusPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('website');
  const [logs, setLogs] = useState('');
  const [logBusy, setLogBusy] = useState(false);
  const checking = useRef(false);

  const refresh = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    try {
      const response = await fetch('/api/admin/status', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { setData(null); setLogs(''); }
        if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
        throw new Error(result.error);
      }
      setData(result); setError('');
    } catch (err) { setError(err.message || 'Không kết nối được máy chủ.'); }
    finally { setBusy(false); checking.current = false; }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      setLogBusy(true);
      setLogs('');
      try {
        const response = await fetch(`/api/admin/status?log=${encodeURIComponent(source)}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        if (!cancelled) {
          setLogs(response.ok ? result.log : result.error);
          if (response.status === 401) window.dispatchEvent(new Event('staff-session-expired'));
        }
      } catch { if (!cancelled) setLogs('Không đọc được log.'); }
      finally { if (!cancelled) setLogBusy(false); }
    }
    load();
    return () => { cancelled = true; controller.abort(); };
  }, [source, data]);

  function download() {
    const url = URL.createObjectURL(new Blob([logs], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${source.replace(':', '-')}.log`; link.click();
    URL.revokeObjectURL(url);
  }

  const healthy = data?.services.filter(service => service.state === 'healthy').length || 0;
  return <section className="system-status">
    <header className="status-header">
      <div><h1><Activity size={24} />Trạng thái hệ thống</h1><p>{data ? `Kiểm tra lúc ${new Date(data.checkedAt).toLocaleString('vi-VN')}` : 'Chưa có kết quả kiểm tra'}</p></div>
      <div className="status-actions">
        <button onClick={refresh} disabled={busy} title="Kiểm tra lại"><RefreshCw size={17} className={busy ? 'status-spin' : ''} />{busy ? 'Đang kiểm tra' : 'Kiểm tra lại'}</button></div>
    </header>
    {error && <div role="alert" className="status-error">{error}{data && ' Kết quả bên dưới là lần kiểm tra trước.'}</div>}
    {data && <>
      <div className="status-summary"><span><strong>{healthy}/{data.services.length}</strong> dịch vụ healthy</span><span>Máy chủ: {duration(data.host.uptime)}</span><span className="status-cpu" title="Mức sử dụng CPU toàn máy chủ, lấy mẫu khoảng 1 giây"><Cpu size={16} aria-hidden="true" />CPU: {Number.isFinite(data.host.cpuUsagePercent) ? `${data.host.cpuUsagePercent.toFixed(1)}%` : 'Chưa đo được'} · {data.host.cpuCount} luồng</span><span>RAM: {((data.host.memoryTotal - data.host.memoryFree) / 1024 ** 3).toFixed(1)} / {(data.host.memoryTotal / 1024 ** 3).toFixed(1)} GB</span>{data.agent && <span>PrintAgent: {duration(data.agent.uptime)}</span>}</div>
      <div className="status-table-wrap"><table><thead><tr><th>Dịch vụ</th><th>Trạng thái</th><th>Chi tiết</th><th>Log</th></tr></thead><tbody>
        {data.services.map(service => <tr key={service.id}><td>{service.name}</td><td><Badge state={service.state} /></td><td>{service.detail}</td><td>{data.logSources.includes(service.id) && <button onClick={() => { setSource(service.id); document.getElementById('system-logs')?.scrollIntoView({ behavior: 'smooth' }); }}>Xem log</button>}</td></tr>)}
      </tbody></table></div>
      <h2>Máy in</h2>
      <div className="status-table-wrap"><table><thead><tr><th>Máy in</th><th>Trạng thái</th><th>Kết nối</th></tr></thead><tbody>{data.printers.map((printer, index) => <tr key={index}><td>{printer.name}</td><td><Badge state={printer.state} /></td><td>{printer.detail}</td></tr>)}</tbody></table></div>
      <h2>Cronjob</h2>
      <div className="status-table-wrap"><table><thead><tr><th>Job</th><th>Lịch</th><th>Đang bật</th><th>Lần chạy gần nhất</th><th>Thời gian</th></tr></thead><tbody>{data.cron.map(job => <tr key={job.jobid}><td>{job.jobname}</td><td><code>{job.schedule}</code></td><td>{job.active ? 'Có' : 'Không'}</td><td>{job.status || 'Chưa có lịch sử'}</td><td>{job.start_time ? new Date(job.start_time).toLocaleString('vi-VN') : '—'}</td></tr>)}</tbody></table></div>
      <section id="system-logs" className="status-logs"><div className="status-log-toolbar"><h2>Log</h2><select aria-label="Nguồn log" value={source} onChange={event => setSource(event.target.value)}>{data.logSources.map(value => <option key={value} value={value}>{logLabels[value] || value}</option>)}</select><button onClick={download} disabled={logBusy || !logs} title="Tải log"><Download size={18} /></button></div><pre aria-busy={logBusy}>{logBusy ? 'Đang tải log...' : logs || '(Chưa có log)'}</pre></section>
    </>}
  </section>;
}
