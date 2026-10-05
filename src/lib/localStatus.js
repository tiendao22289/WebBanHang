import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { cpus, freemem, totalmem, uptime } from 'node:os';
import { connect } from 'node:net';
import { statusDatabase } from './statusAuth';
import { redactLog } from './statusSession.mjs';
import { sampleCpuUsage } from './hostCpu.mjs';

const run = promisify(execFile);
const isDev = process.env.APP_ENV === 'dev';
const directory = isDev ? 'C:\\Tool\\SupabaseDev' : 'C:\\Tool\\SupabaseLocal';
const composeArgs = ['-d', 'Ubuntu-24.04', '-u', 'root', '--cd', isDev ? '/opt/webbanhang-supabase-dev' : '/opt/webbanhang-supabase', '--exec', 'docker', 'compose'];
const options = { timeout: 12000, maxBuffer: 256 * 1024, windowsHide: true };
const containers = {
  db: 'PostgreSQL', rest: 'Data API', auth: 'Auth', realtime: 'Realtime', storage: 'Storage',
  studio: 'Studio', meta: 'Postgres Meta', functions: 'Edge Functions', imgproxy: 'Image Proxy',
  supavisor: 'Connection Pooler', 'api-gw': 'API Gateway',
};
const files = isDev ? { website: ['website.log', 'website-error.log'] } : {
  website: ['website.log', 'website-error.log'], printing: ['print-agent.log', 'print-agent-error.log'],
  tunnel: ['named-tunnel-stdout.log', 'named-tunnel.log'], proxy: ['tunnel-proxy.log', 'tunnel-proxy-error.log'],
  startup: ['autostart.log'], recovery: ['check-services.log'],
};
export const LOG_SOURCES = [
  ...Object.keys(files), ...Object.keys(containers).map(name => `supabase:${name}`),
];

async function command(args) { return (await run('wsl.exe', [...composeArgs, ...args], options)).stdout.trim(); }
async function databaseQuery(sql) { return command(['exec', '-T', 'db', 'psql', '-U', isDev ? 'supabase_admin' : 'postgres', '-d', 'postgres', '-Atc', sql]); }
function item(id, name, state, detail) { return { id, name, state, detail }; }
async function httpHealth(id, name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    await response.body?.cancel();
    return item(id, name, response.ok ? 'healthy' : 'error', `HTTP ${response.status}`);
  } catch { return item(id, name, 'error', 'Không phản hồi'); }
}
function tcp(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

let cached;
let pending;
export async function getLocalStatus() {
  if (cached && Date.now() - cached.at < 15000) return cached.value;
  if (pending) return pending;
  pending = collect().then(value => { cached = { at: Date.now(), value }; return value; }).finally(() => { pending = null; });
  return pending;
}

async function collect() {
  const services = await Promise.all([
    httpHealth('website', 'Website Next.js', isDev ? 'http://127.0.0.1:3001/' : 'http://127.0.0.1:3000/'),
    ...(!isDev ? [
      httpHealth('proxy', 'Local Proxy', 'http://127.0.0.1:3005/'),
      httpHealth('public', 'ocbaokhang.online', 'https://ocbaokhang.online/'),
    ] : []),
  ]);
  let agent = null;
  let cron = [];
  let printers = [];
  let cpuUsagePercent = null;
  await Promise.all([
    (async () => { cpuUsagePercent = await sampleCpuUsage(); })(),
    (async () => {
      try {
        const text = await command(['ps', '--all', '--format', 'json']);
        const rows = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        const seen = new Set();
        for (const row of rows) {
          seen.add(row.Service);
          services.push(item(`supabase:${row.Service}`, containers[row.Service] || row.Service,
            row.State === 'running' && row.Health === 'healthy' ? 'healthy' : row.State === 'running' && !row.Health ? 'warning' : 'error',
            `${row.State} / ${row.Health || 'Không có healthcheck'}`));
        }
        if (!rows.length) services.push(item('docker', 'Supabase / Docker', 'error', 'Không có container đang chạy'));
        for (const name of Object.keys(containers)) {
          if (!seen.has(name)) services.push(item(`supabase:${name}`, containers[name], 'error', 'Thiếu container'));
        }
      } catch { services.push(item('docker', 'Supabase / WSL / Docker', 'error', 'Không đọc được trạng thái container')); }
    })(),
    (async () => {
      if (isDev) return;
      try {
        const response = await fetch('http://127.0.0.1:3003/api/status', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
        if (!response.ok) throw new Error();
        agent = await response.json();
        services.push(item('printing', 'PrintAgent', agent.ok && agent.realtimeMode !== 'disconnected' ? (agent.realtimeMode === 'realtime' ? 'healthy' : 'warning') : 'error',
          `${agent.realtimeMode} · Lịch sử: đã in ${agent.printed}, lỗi ${agent.failed}`));
      } catch { services.push(item('printing', 'PrintAgent', 'error', 'Không phản hồi')); }
    })(),
    (async () => {
      try {
        const text = await databaseQuery("SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT j.jobid,j.jobname,j.schedule,j.active,r.status,r.start_time,r.end_time FROM cron.job j LEFT JOIN LATERAL (SELECT status,start_time,end_time FROM cron.job_run_details WHERE jobid=j.jobid ORDER BY start_time DESC LIMIT 1) r ON true ORDER BY j.jobid) t;");
        cron = JSON.parse(text);
        const bad = cron.some(job => !job.active || job.status === 'failed');
        services.push(item('cron', 'pg_cron', cron.length && !bad ? 'healthy' : 'warning', `${cron.filter(job => job.active).length}/${cron.length} job đang bật`));
        const count = await databaseQuery("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';");
        services.push(item('rpc', 'Database Functions (RPC)', Number(count) > 0 ? 'healthy' : 'warning', `${count} hàm public · Kiểm tra catalog, không gọi hàm ghi dữ liệu`));
      } catch { services.push(item('cron', 'pg_cron / RPC', 'error', 'Không đọc được PostgreSQL')); }
    })(),
    (async () => {
      try {
        if (isDev) {
          const { data, error } = await statusDatabase().from('printers').select('name,is_active,type');
          if (error) throw error;
          printers = (data || []).map(printer => ({ name: printer.name, state: 'warning', detail: 'DEV: không kết nối máy in thật' }));
          return;
        }
        const ps = "$ports=@{}; Get-PrinterPort | ForEach-Object { $ports[$_.Name]=$_.PrinterHostAddress }; @(Get-Printer | ForEach-Object { [pscustomobject]@{name=$_.Name;host=$ports[$_.PortName];status=[string]$_.PrinterStatus} }) | ConvertTo-Json -Compress";
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', ps], options);
        const inventory = JSON.parse(stdout || '[]');
        const { data, error } = await statusDatabase().from('printers').select('id,name,type,interface,is_active').eq('is_active', true);
        if (error) throw error;
        printers = await Promise.all((data || []).map(async printer => {
          const windows = inventory.find(row => row.name === printer.interface);
          const parsed = /^tcp:\/\/([\d.]+)(?::(\d+))?$/.exec(printer.interface || '');
          const host = windows?.host || parsed?.[1];
          const online = host ? await tcp(host, Number(parsed?.[2] || 9100)) : null;
          return { name: printer.name, interface: printer.interface, host, state: online === true ? 'healthy' : online === false ? 'error' : 'warning', detail: host ? `${host}:9100 · ${online ? 'Kết nối được' : 'Không kết nối được'}` : windows ? `Spooler: ${windows.status}` : 'Chưa kiểm tra được kết nối' };
        }));
      } catch { printers = [{ name: 'Máy in', state: 'error', detail: 'Không đọc được cấu hình / Windows Spooler' }]; }
    })(),
    (async () => {
      if (isDev) return;
      try {
        const ps = "@(Get-CimInstance Win32_Process -Filter \"Name = 'cloudflared.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('C:\\Tool\\SupabaseLocal\\named-tunnel.token') }).Count";
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', ps], options);
        services.push(item('tunnel', 'Cloudflare Tunnel', Number(stdout.trim()) > 0 ? 'healthy' : 'error', Number(stdout.trim()) > 0 ? 'Tiến trình đang chạy; xem domain để kiểm tra đầu cuối' : 'Tiến trình đã tắt'));
      } catch { services.push(item('tunnel', 'Cloudflare Tunnel', 'error', 'Không đọc được tiến trình')); }
    })(),
  ]);
  return { environment: isDev ? 'dev' : 'prod', checkedAt: new Date().toISOString(), services, cron, printers,
    agent: agent && { uptime: agent.uptime, printed: agent.printed, failed: agent.failed, realtimeMode: agent.realtimeMode },
    host: { uptime: uptime(), memoryTotal: totalmem(), memoryFree: freemem(), cpuCount: cpus().length, cpuUsagePercent },
    logSources: LOG_SOURCES,
  };
}

async function tailFile(file) {
  let handle;
  try {
    handle = await open(`${directory}\\${file}`, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 48 * 1024));
    await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (size > buffer.length) lines.shift();
    return lines.slice(-100).join('\n');
  } catch (error) { return error.code === 'ENOENT' ? '(Chưa có log)' : '(Không đọc được log)'; }
  finally { await handle?.close(); }
}

export async function getLocalLogs(source) {
  if (!LOG_SOURCES.includes(source)) return null;
  let text;
  if (source.startsWith('supabase:')) {
    text = await command(['logs', '--no-color', '--tail', '100', source.slice(9)]);
  } else {
    text = (await Promise.all(files[source].map(async file => `=== ${file} ===\n${await tailFile(file)}`))).join('\n\n');
  }
  const secretValues = Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD|PIN/i.test(key)).map(([, value]) => value);
  // Files are allowlisted; tokens and database passwords are never exposed as log sources.
  for (const file of ['named-tunnel.token', 'status-session.key', 'credentials.env']) {
    try {
      const content = await tailFile(file);
      if (file.endsWith('.env')) secretValues.push(...content.split(/\r?\n/).map(line => line.slice(line.indexOf('=') + 1).trim()).filter(Boolean));
      else secretValues.push(content.trim());
    } catch { /* Redaction also covers tokens by format. */ }
  }
  return redactLog(text.slice(-96 * 1024), secretValues);
}
