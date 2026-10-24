'use client';

/**
 * /thongke — đọc báo cáo doanh thu hằng ngày trên điện thoại (chỉ admin).
 * Cùng số liệu tin Zalo (GET /api/admin/finance?report=), xem lại được ngày cũ; thêm
 * thẻ nhân sự & lương của tháng (GET /api/admin/workforce?stats=).
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Banknote, BarChart3, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Clock, CreditCard, LogOut, NotebookPen, RefreshCw, ShieldAlert, Users, UtensilsCrossed, Wallet,
} from 'lucide-react';

const vnToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const vnHour = () => new Date(Date.now() + 7 * 3600000).getUTCHours();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekdayOf = d => new Date(`${d}T00:00:00Z`).getUTCDay();
const WEEKDAYS = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const SHORT_DAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const money = n => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;
// Số gọn cho biểu đồ: 1,2tr · 850k.
const compact = n => {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace('.', ',')}tr`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
};
const ddmm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dayTitle = d => {
  const today = vnToday();
  if (d === today) return 'Hôm nay';
  if (d === addDays(today, -1)) return 'Hôm qua';
  return WEEKDAYS[weekdayOf(d)];
};
const change = (now, before) => (before > 0 ? Math.round((now - before) / before * 100) : null);
// Buổi sáng xem số hôm qua (giống giờ gửi Zalo), từ trưa xem số hôm nay.
const defaultDate = () => (vnHour() < 12 ? addDays(vnToday(), -1) : vnToday());

function Login({ onLogin, error: initialError }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState(initialError || '');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/admin/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone.trim(), pin: pin.trim() }) });
      const result = await res.json();
      if (!res.ok || !result.user) throw new Error(result.error || 'Sai số điện thoại hoặc mã PIN!');
      onLogin(result.user);
    } catch (err) { setError(err.message === 'Failed to fetch' ? 'Không kết nối được máy chủ.' : err.message); }
    finally { setBusy(false); }
  }
  return <main className="tk-page tk-login-page">
    <form className="tk-login" onSubmit={submit}>
      <div className="tk-login-logo"><BarChart3 size={28} /></div>
      <h1>Thống kê doanh thu</h1>
      <p>Đăng nhập bằng tài khoản admin</p>
      {error && <div className="tk-alert" role="alert">{error}</div>}
      <label><span>Số điện thoại</span><input type="tel" inputMode="numeric" autoComplete="username" value={phone} onChange={e => setPhone(e.target.value)} required /></label>
      <label><span>Mã PIN</span><input type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={e => setPin(e.target.value)} required /></label>
      <button className="tk-btn" disabled={busy}>{busy ? 'Đang đăng nhập...' : 'Đăng nhập'}</button>
    </form>
  </main>;
}

function Delta({ now, before, label }) {
  if (before === null || before === undefined) return <span className="tk-delta muted">{label}: chưa có số</span>;
  const pct = change(now, before);
  const cls = pct === null ? 'muted' : pct >= 0 ? 'up' : 'down';
  return <span className={`tk-delta ${cls}`}>
    {pct === null ? '—' : `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`} <em>{label}</em>
  </span>;
}

function Hero({ date, summary, compare, trend, onPick }) {
  const max = Math.max(1, ...trend.map(t => t.revenue || 0));
  const avg = summary.bills + summary.paperBills ? summary.revenue / (summary.bills + summary.paperBills) : 0;
  return <section className="tk-hero">
    <div className="tk-hero-label"><Wallet size={16} /> Doanh thu · {dayTitle(date)} {ddmm(date)}</div>
    <div className="tk-hero-value">{money(summary.revenue)}</div>
    <div className="tk-hero-meta">
      <span>{summary.bills} bill{summary.paperBills ? ` + ${summary.paperBills} bill giấy` : ''}</span>
      {avg > 0 && <span>TB {money(avg)}/bill</span>}
    </div>
    {compare && <div className="tk-hero-deltas">
      <Delta now={summary.revenue} before={compare.prev} label="hôm trước" />
      <Delta now={summary.revenue} before={compare.week} label={`${compare.weekdayLabel} tuần trước`} />
    </div>}
    <div className="tk-week" role="group" aria-label="Doanh thu 7 ngày">
      {trend.map(t => <button key={t.date} className={t.date === date ? 'tk-week-day on' : 'tk-week-day'} disabled={t.revenue === null}
        onClick={() => onPick(t.date)} aria-label={`${WEEKDAYS[weekdayOf(t.date)]} ${ddmm(t.date)}: ${money(t.revenue)}`}>
        <span className="tk-week-amount">{t.revenue ? compact(t.revenue) : ''}</span>
        <span className="tk-week-track"><span className="tk-week-bar" style={{ height: `${Math.max(4, (t.revenue || 0) / max * 100)}%` }} /></span>
        <span className="tk-week-label">{SHORT_DAYS[weekdayOf(t.date)]}</span>
      </button>)}
    </div>
  </section>;
}

function Kpis({ summary, date }) {
  const loss = summary.profit < 0;
  const monthLoss = summary.month.profit < 0;
  return <section className="tk-kpis">
    <div className="tk-kpi"><span className="tk-kpi-label">Chi trong ngày</span><b>{money(summary.cost)}</b></div>
    <div className={`tk-kpi ${loss ? 'neg' : 'pos'}`}><span className="tk-kpi-label">{loss ? 'Lỗ ngày' : 'Lãi ngày'}</span><b>{loss ? '-' : '+'}{money(Math.abs(summary.profit))}</b></div>
    <div className="tk-kpi"><span className="tk-kpi-label">Thu tháng {date.slice(5, 7)} tới nay</span><b>{money(summary.month.revenue)}</b></div>
    <div className={`tk-kpi ${monthLoss ? 'neg' : 'pos'}`}><span className="tk-kpi-label">{monthLoss ? 'Lỗ' : 'Lãi'} tháng tới nay</span><b>{monthLoss ? '-' : '+'}{money(Math.abs(summary.month.profit))}</b></div>
  </section>;
}

function Card({ icon: Icon, title, aside, children, tone }) {
  return <section className={`tk-card${tone ? ` ${tone}` : ''}`}>
    <header className="tk-card-head"><span className="tk-card-icon"><Icon size={17} /></span><h2>{title}</h2>{aside && <span className="tk-card-aside">{aside}</span>}</header>
    {children}
  </section>;
}

const PAY_COLORS = ['var(--tk-c1)', 'var(--tk-c2)', 'var(--tk-c3)', 'var(--tk-c4)', 'var(--tk-c5)'];
function Payments({ summary }) {
  const rows = [{ name: 'Tiền mặt', amount: summary.cash, icon: Banknote }, ...summary.transfers.map(t => ({ ...t, name: `CK ${t.name}`, icon: CreditCard }))].filter(r => r.amount > 0);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  if (!total) return <Card icon={CreditCard} title="Thu theo hình thức"><p className="tk-empty">Chưa có khoản thu.</p></Card>;
  return <Card icon={CreditCard} title="Thu theo hình thức">
    <div className="tk-stack" aria-hidden="true">{rows.map((r, i) => <span key={r.name} style={{ width: `${r.amount / total * 100}%`, background: PAY_COLORS[i % PAY_COLORS.length] }} />)}</div>
    <ul className="tk-rows">{rows.map((r, i) => <li key={r.name}>
      <span className="tk-dot" style={{ background: PAY_COLORS[i % PAY_COLORS.length] }} />
      <span className="tk-row-name">{r.name}</span>
      <span className="tk-row-pct">{Math.round(r.amount / total * 100)}%</span>
      <b>{money(r.amount)}</b>
    </li>)}</ul>
  </Card>;
}

function Costs({ summary }) {
  const max = Math.max(1, ...summary.costs.map(c => c.amount));
  return <Card icon={Wallet} title="Chi trong ngày" aside={money(summary.cost)}>
    {summary.costs.length ? <ul className="tk-bars">{summary.costs.map(c => <li key={c.label}>
      <div className="tk-bar-line"><span>{c.label}</span><b>{money(c.amount)}</b></div>
      <span className="tk-bar-track"><span className="tk-bar-fill cost" style={{ width: `${c.amount / max * 100}%` }} /></span>
    </li>)}</ul> : <p className="tk-empty">Chưa có khoản chi.</p>}
  </Card>;
}

function Warnings({ summary }) {
  if (!summary.warnings.length) return <section className="tk-ok"><CheckCircle2 size={20} /> Không có gì bất thường</section>;
  return <Card icon={AlertTriangle} title="Cần chú ý" aside={summary.warnings.length} tone="warn">
    <ul className="tk-warns">{summary.warnings.map(w => <li key={w}>{w}</li>)}</ul>
  </Card>;
}

function Hours({ compare }) {
  if (!compare?.hours?.length) return null;
  const first = Math.min(...compare.hours.map(h => h.hour));
  const last = Math.max(...compare.hours.map(h => h.hour));
  const byHour = new Map(compare.hours.map(h => [h.hour, h]));
  const slots = Array.from({ length: last - first + 1 }, (_, i) => byHour.get(first + i) || { hour: first + i, bills: 0, amount: 0 });
  const max = Math.max(1, ...slots.map(s => s.amount));
  const peak = compare.peak;
  return <Card icon={Clock} title="Giờ đông khách" aside={peak ? `${peak.hour}h–${(peak.hour + 1) % 24}h` : null}>
    <div className="tk-hours" role="img" aria-label={peak ? `Đông nhất ${peak.hour} giờ: ${peak.bills} bill, ${money(peak.amount)}` : 'Theo giờ'}>
      {slots.map(s => <div key={s.hour} className={peak && s.hour === peak.hour ? 'tk-hour peak' : 'tk-hour'} title={`${s.hour}h: ${s.bills} bill · ${money(s.amount)}`}>
        <span className="tk-hour-track"><span style={{ height: `${Math.max(s.amount ? 6 : 0, s.amount / max * 100)}%` }} /></span>
        <span className="tk-hour-label">{s.hour}</span>
      </div>)}
    </div>
    {peak && <p className="tk-caption">Đông nhất {peak.hour}h–{(peak.hour + 1) % 24}h: {peak.bills} bill · {money(peak.amount)}</p>}
  </Card>;
}

function TopItems({ compare }) {
  if (!compare?.top?.length) return null;
  const max = Math.max(1, ...compare.top.map(i => i.qty));
  return <Card icon={UtensilsCrossed} title="Món bán chạy">
    <ol className="tk-bars tk-rank">{compare.top.map((item, i) => <li key={item.name}>
      <div className="tk-bar-line"><span><em>{i + 1}</em>{item.name}</span><b>{item.qty}</b></div>
      <span className="tk-bar-track"><span className="tk-bar-fill" style={{ width: `${item.qty / max * 100}%` }} /></span>
    </li>)}</ol>
    {compare.slow?.length > 0 && <p className="tk-caption">Bán ít: {compare.slow.map(i => `${i.name} (${i.qty})`).join(', ')}</p>}
  </Card>;
}

// Khối chữ của báo cáo (thất thoát / nhân viên / Sổ tay) → nhóm có tiêu đề + danh sách.
function ReportText({ text }) {
  const groups = text.split(/\n{2,}/).map(g => g.split('\n').filter(l => l.trim()));
  return <div className="tk-text">{groups.map((lines, gi) => <div key={gi} className="tk-text-group">
    {lines.map((line, li) => {
      // Dòng tiêu đề khối (🔍 Kiểm soát thất thoát / 👥 Nhân viên) đã có ở đầu thẻ.
      if (gi === 0 && li === 0 && /^(🔍|👥)/.test(line)) {
        const rest = line.split(': ').slice(1).join(': ');
        return rest ? <p key={li}>{rest.charAt(0).toUpperCase() + rest.slice(1)}</p> : null;
      }
      if (/^\s*[•-]\s/.test(line)) return <p key={li} className="tk-li">{line.replace(/^\s*[•-]\s/, '')}</p>;
      return <p key={li} className={li === 0 ? 'tk-text-head' : ''}>{line}</p>;
    })}
  </div>)}</div>;
}

const SECTION_ICONS = { loss: ShieldAlert, staff: Users, notes: NotebookPen };
function Section({ section }) {
  const [open, setOpen] = useState(false);
  const Icon = SECTION_ICONS[section.key] || NotebookPen;
  const count = section.text.split('\n').filter(l => /^\s*•\s/.test(l)).length;
  return <section className={open ? 'tk-card tk-acc open' : 'tk-card tk-acc'}>
    <button className="tk-acc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="tk-card-icon"><Icon size={17} /></span>
      <h2>{section.title}</h2>
      {count > 0 && <span className="tk-badge">{count}</span>}
      <ChevronDown size={18} className="tk-acc-chev" />
    </button>
    {open && <ReportText text={section.text} />}
  </section>;
}

const minutesText = m => (m >= 60 ? `${Math.floor(m / 60)} giờ${m % 60 ? ` ${m % 60} phút` : ''}` : `${m} phút`);
const num = n => String(n ?? 0).replace('.', ',');

// Nhân sự & lương của tháng đang xem: quỹ lương, so với doanh thu, ai hay trễ / quên ra ca, việc chờ duyệt.
function StaffReport({ date, monthRevenue }) {
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetch(`/api/admin/workforce?stats=1&year=${year}&month=${month}`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(result => { if (!cancelled) setData(result); })
      .catch(() => { if (!cancelled) { setData(null); setFailed(true); } });
    return () => { cancelled = true; };
  }, [year, month]);
  if (failed || !data || data.year !== year || data.month !== month) return null;
  const t = data.totals, pending = data.pending.fixes + data.pending.extras + data.pending.requests + (data.pending.fines || 0) + (data.pending.bonuses || 0);
  const ratio = monthRevenue > 0 ? Math.round(t.gross / monthRevenue * 100) : null;
  const people = [...data.people].sort((a, b) => b.salary.net - a.salary.net);
  const watch = people.flatMap(p => [
    p.late.count >= 3 && `${p.name} đi trễ ${p.late.count} lần (tổng ${minutesText(p.late.minutes)})`,
    p.forgot >= 2 && `${p.name} quên ra ca ${p.forgot} lần`,
    p.leftEarly.count >= 3 && `${p.name} về sớm ${p.leftEarly.count} lần`,
    p.warnings > 0 && `${p.name} có ${p.warnings} lần quét bị cảnh báo (khác wifi / máy lạ)`,
    p.blocked > 0 && `${p.name} bị chặn ${p.blocked} lần khi quét`,
  ].filter(Boolean));
  return <Card icon={Users} title={`Nhân sự & lương tháng ${month}/${year}`} aside={t.staff && t.closed === t.staff ? 'đã chốt' : 'tạm tính'}>
    <div className="tk-staff-kpis">
      <div><span>Quỹ lương (lương + tăng ca + thưởng)</span><b>{money(t.gross)}</b></div>
      <div><span>So với doanh thu tháng</span><b>{ratio === null ? '—' : `${ratio}%`}</b></div>
      <div><span>Đã ứng</span><b>{money(t.advances)}</b>{(t.fines > 0 || t.bonuses > 0) && <small>{[t.bonuses > 0 && `thưởng ${money(t.bonuses)}`, t.fines > 0 && `phạt ${money(t.fines)}`].filter(Boolean).join(' · ')}</small>}</div>
      <div><span>Chờ bạn duyệt</span><b className={pending ? 'warn' : ''}>{pending}</b></div>
    </div>
    {watch.length > 0 && <ul className="tk-warns" style={{ marginBottom: 10 }}>{watch.map(w => <li key={w}>{w}</li>)}</ul>}
    {people.length ? <ul className="tk-people">{people.map(p => {
      const c = p.salary;
      const meta = [
        c.rule === 'days' ? `${num(c.workUnits)}/${c.standardDays} ngày công` : `${c.workDays} ngày`,
        `${num(c.totalWorkH)} giờ`,
        p.late.count ? <span className="warn">trễ {p.late.count} lần ({minutesText(p.late.minutes)})</span> : null,
        p.leftEarly.count ? `về sớm ${p.leftEarly.count} lần` : null,
        p.forgot ? <span className="warn">quên ra ca {p.forgot}</span> : null,
        c.otHours ? `tăng ca ${num(c.otHours)} giờ` : null,
        c.pendingH ? `${num(c.pendingH)} giờ ngoài ca chờ duyệt` : null,
        c.earlyAmt ? <span className="warn">trừ về sớm {money(c.earlyAmt)}</span> : null,
        c.bonusAmt ? `thưởng ${money(c.bonusAmt)}` : null,
        c.advAmt ? `ứng ${money(c.advAmt)}` : null,
        c.vioAmt ? `phạt ${money(c.vioAmt)}` : null,
      ].filter(Boolean);
      return <li key={p.staff_id}>
        <div className="tk-person-line">
          <span>{p.name}{p.departure && <span className="tk-tag">nghỉ việc</span>}{c.paid_at ? <span className="tk-tag ok">đã trả</span> : c.locked ? <span className="tk-tag">đã chốt</span> : null}</span>
          <b>{money(c.net)}</b>
        </div>
        <div className="tk-person-meta">{meta.map((m, i) => <Fragment key={i}>{i > 0 && ' · '}{m}</Fragment>)}</div>
      </li>;
    })}</ul> : <p className="tk-empty">Chưa có giờ công hay lương tháng này.</p>}
    <p className="tk-caption">Số lương là thực lĩnh {t.staff && t.closed === t.staff ? 'đã chốt' : 'tạm tính tới hôm nay'} (đã cộng thưởng, trừ về sớm, ứng, phạt). Quỹ lương so với doanh thu tháng tới ngày đang xem.</p>
    <a className="tk-link" href="/admin/payroll">Mở bảng lương →</a>
  </Card>;
}

function Skeleton() {
  return <div className="tk-skeleton" aria-label="Đang tải">
    <div className="sk sk-hero" />
    <div className="tk-kpis">{[0, 1, 2, 3].map(i => <div key={i} className="sk sk-kpi" />)}</div>
    <div className="sk sk-card" /><div className="sk sk-card" />
  </div>;
}

export default function ThongKePage() {
  const [user, setUser] = useState(undefined); // undefined = đang kiểm tra
  const [sessionError, setSessionError] = useState('');
  const [date, setDate] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);

  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('date');
    setDate(/^\d{4}-\d{2}-\d{2}$/.test(asked || '') && asked <= vnToday() ? asked : defaultDate());
    fetch('/api/admin/session', { cache: 'no-store' })
      .then(async res => {
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.user) setUser(result.user);
        else { setUser(null); if (res.status === 503) setSessionError('Không kiểm tra được phiên đăng nhập. Thử lại.'); }
      })
      .catch(() => { setUser(null); setSessionError('Không kết nối được máy chủ.'); });
  }, []);

  const load = useCallback(async d => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/admin/finance?report=${d}`, { cache: 'no-store' });
      const result = await res.json().catch(() => ({}));
      if (res.status === 401) { setUser(null); setSessionError('Phiên đăng nhập đã hết hạn. Đăng nhập lại.'); return; }
      if (!res.ok) throw new Error(result.error || 'Không đọc được báo cáo.');
      setReport(result);
      setLoadedAt(new Date());
    } catch (err) { setError(err.message === 'Failed to fetch' ? 'Không kết nối được máy chủ.' : err.message); setReport(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!user || user.role !== 'admin' || !date) return;
    window.history.replaceState(null, '', `/thongke?date=${date}`);
    load(date);
  }, [user, date, load]);

  async function logout() {
    await fetch('/api/admin/session', { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem('staffUser');
    setUser(null); setReport(null); setSessionError('');
  }

  if (user === undefined || !date) return <main className="tk-page"><div className="tk-shell"><Skeleton /></div></main>;
  if (!user) return <Login error={sessionError} onLogin={u => { localStorage.setItem('staffUser', JSON.stringify({ id: u.id, full_name: u.full_name, phone: u.phone, role: u.role })); setUser(u); }} />;
  if (user.role !== 'admin') return <main className="tk-page tk-login-page">
    <div className="tk-login"><div className="tk-login-logo"><BarChart3 size={28} /></div><h1>Thống kê doanh thu</h1>
      <div className="tk-alert">Chỉ admin được xem doanh thu.</div><button className="tk-btn ghost" onClick={logout}>Đăng xuất</button></div>
  </main>;

  const today = vnToday();
  const start = report?.startDate;
  const ready = report?.date === date && report.summary;
  return <main className="tk-page">
    <header className="tk-bar">
      <div className="tk-bar-inner">
        <div className="tk-brand"><span className="tk-brand-logo"><BarChart3 size={18} /></span><div><b>Thống kê</b><small>{user.full_name || 'Admin'}</small></div></div>
        <div className="tk-bar-actions">
          <button className="tk-icon" onClick={() => load(date)} disabled={loading} aria-label="Tải lại"><RefreshCw size={19} className={loading ? 'spin' : ''} /></button>
          <button className="tk-icon" onClick={logout} aria-label="Đăng xuất"><LogOut size={19} /></button>
        </div>
      </div>
      <nav className="tk-datebar" aria-label="Chọn ngày">
        <button className="tk-icon" aria-label="Ngày trước" disabled={loading || (start && date <= start)} onClick={() => setDate(addDays(date, -1))}><ChevronLeft size={22} /></button>
        <label className="tk-date">
          <CalendarDays size={17} />
          <span><b>{dayTitle(date)}</b> · {ddmm(date)}/{date.slice(0, 4)}</span>
          <input type="date" value={date} max={today} min={start || undefined} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Chọn ngày" />
        </label>
        <button className="tk-icon" aria-label="Ngày sau" disabled={loading || date >= today} onClick={() => setDate(addDays(date, 1))}><ChevronRight size={22} /></button>
      </nav>
    </header>

    <div className="tk-shell">
      {error && <div className="tk-alert" role="alert">{error}<button onClick={() => load(date)}>Thử lại</button></div>}
      {!error && report?.date === date && report.error && <div className="tk-empty-state"><CalendarDays size={32} /><p>{report.error}</p></div>}
      {!ready && !error && !(report?.date === date && report.error) && <Skeleton />}
      {ready && <div className={loading ? 'tk-content dim' : 'tk-content'}>
        <Hero date={date} summary={report.summary} compare={report.compare} trend={report.trend || []} onPick={setDate} />
        <Kpis summary={report.summary} date={date} />
        <Warnings summary={report.summary} />
        <Payments summary={report.summary} />
        <Costs summary={report.summary} />
        <Hours compare={report.compare} />
        <TopItems compare={report.compare} />
        <StaffReport date={date} monthRevenue={report.summary.month.revenue} />
        {report.sections.map(s => <Section key={`${date}-${s.key}`} section={s} />)}
        <footer className="tk-foot">
          {loadedAt && <span>Cập nhật {loadedAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>}
          <a href="/admin/finance">Mở Sổ thu chi đầy đủ →</a>
        </footer>
      </div>}
    </div>
  </main>;
}
