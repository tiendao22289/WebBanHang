'use client';

/**
 * /thongke — đọc báo cáo doanh thu trên điện thoại (chỉ admin). Mặc định xem theo NGÀY (cùng số liệu
 * tin Zalo: GET /api/admin/finance?report=), bấm Tuần / Tháng để xem cả kỳ (GET ?period=week|month&date=).
 * Thất thoát, Nhân viên, Sổ tay vẽ thành ô số và bảng; xem tháng có thêm thẻ lương (GET /api/admin/workforce?stats=).
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
  return <Card icon={Wallet} title="Các khoản chi" aside={money(summary.cost)}>
    {summary.costs.length ? <ul className="tk-bars">{summary.costs.map(c => <li key={c.label}>
      <div className="tk-bar-line"><span>{c.label}</span><b>{money(c.amount)}</b></div>
      <span className="tk-bar-track"><span className="tk-bar-fill cost" style={{ width: `${c.amount / max * 100}%` }} /></span>
    </li>)}</ul> : <p className="tk-empty">Chưa có khoản chi.</p>}
  </Card>;
}

// Cần chú ý: kết quả máy tự kiểm tra ngày đó (5 giờ sáng hôm sau) + các cảnh báo khác của sổ.
const checkTime = iso => {
  const d = new Date(Date.parse(iso) + 7 * 3600000).toISOString();
  return `${d.slice(11, 16)} ${d.slice(8, 10)}/${d.slice(5, 7)}`;
};
function Warnings({ summary }) {
  const check = summary.check;
  const problems = (check?.issues || []).filter(i => i.level !== 'info');
  const extra = (check?.issues || []).filter(i => i.level === 'info').map(i => `${i.title}: ${i.count}`).join(' · ');
  const by = check ? `Máy tự kiểm tra lúc ${checkTime(check.checkedAt)}${extra ? ` · ${extra}` : ''}` : null;
  if (!problems.length && !summary.warnings.length) return <section className="tk-ok"><CheckCircle2 size={20} />
    <span>Không có gì bất thường{by && <small className="tk-ok-sub">{by}</small>}</span></section>;
  return <Card icon={AlertTriangle} title="Cần chú ý" aside={problems.length + summary.warnings.length} tone="warn">
    <ul className="tk-warns">
      {problems.map(i => <li key={i.key}>{i.title}: <b>{i.count}{i.key === 'removed' ? ' món' : ''}</b>{i.amount ? ` (${money(i.amount)})` : ''}</li>)}
      {summary.warnings.map(w => <li key={w}>{w}</li>)}
    </ul>
    {by && <p className="tk-caption">{by}. Xem từng bill ở Sổ thu chi → Hôm nay.</p>}
  </Card>;
}

function Hours({ compare, title = 'Giờ đông khách' }) {
  if (!compare?.hours?.length) return null;
  const first = Math.min(...compare.hours.map(h => h.hour));
  const last = Math.max(...compare.hours.map(h => h.hour));
  const byHour = new Map(compare.hours.map(h => [h.hour, h]));
  const slots = Array.from({ length: last - first + 1 }, (_, i) => byHour.get(first + i) || { hour: first + i, bills: 0, amount: 0 });
  const max = Math.max(1, ...slots.map(s => s.amount));
  const peak = compare.peak;
  return <Card icon={Clock} title={title} aside={peak ? `${peak.hour}h–${(peak.hour + 1) % 24}h` : null}>
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

// ── Khối dùng chung cho các thẻ: ô số, nhãn màu, dòng bảng.
const clockOf = iso => (iso ? new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(11, 16) : '--:--');
function Tile({ label, value, sub, tone, active, onClick }) {
  const inner = <><span className="tk-tile-label">{label}</span><b>{value}</b>{sub && <small>{sub}</small>}</>;
  const cls = `tk-tile${tone ? ` ${tone}` : ''}${active ? ' on' : ''}`;
  return onClick ? <button type="button" className={cls} onClick={onClick} aria-pressed={!!active}>{inner}</button> : <div className={cls}>{inner}</div>;
}
// Danh sách dài: hiện vài dòng đầu, bấm để xem hết.
function Limited({ items, max = 5, children }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, max);
  return <>{shown.map(children)}{items.length > max && <li className="tk-more"><button type="button" onClick={() => setAll(!all)}>{all ? 'Thu gọn' : `Xem thêm ${items.length - max} dòng`}</button></li>}</>;
}
const Pill = ({ tone, children }) => <span className={`tk-pill${tone ? ` ${tone}` : ''}`}>{children}</span>;
const minutes = m => (m >= 60 ? `${Math.floor(m / 60)} giờ${m % 60 ? ` ${m % 60} phút` : ''}` : `${m} phút`);

// Thất thoát: 4 ô (bill huỷ, món bớt sau khi in bếp, giảm giá, món tặng) — bấm ô để xem từng dòng.
function LossCard({ loss, range }) {
  const [open, setOpen] = useState(null);
  if (!loss) return null;
  const { cancelled, removed, discounts, gifts } = loss;
  const any = cancelled.count || removed.qty || discounts.count || gifts.qty;
  const toggle = key => setOpen(o => (o === key ? null : key));
  const when = iso => (range ? `${ddmm(new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 10))} ${clockOf(iso)}` : clockOf(iso));
  return <Card icon={ShieldAlert} title="Thất thoát" aside={any ? `~${money(loss.total)}` : null} tone={any ? 'warn' : ''}>
    {!any ? <p className="tk-good"><CheckCircle2 size={18} /> Không có bill huỷ, món bị bớt, giảm giá hay món tặng.</p> : <>
      <div className="tk-tiles">
        <Tile label="Bill huỷ" value={cancelled.count} sub={money(cancelled.total)} tone={cancelled.count ? 'bad' : 'zero'} active={open === 'cancel'} onClick={cancelled.count ? () => toggle('cancel') : null} />
        <Tile label="Món bớt sau khi in bếp" value={removed.qty} sub={money(removed.value)} tone={removed.qty ? 'bad' : 'zero'} active={open === 'removed'} onClick={removed.qty ? () => toggle('removed') : null} />
        <Tile label="Giảm giá" value={`${discounts.count} lần`} sub={money(discounts.amount)} tone={discounts.count ? 'warn' : 'zero'} active={open === 'discount'} onClick={discounts.count ? () => toggle('discount') : null} />
        <Tile label="Món tặng" value={gifts.qty} sub={gifts.value ? `~${money(gifts.value)}` : 'theo giá menu'} tone={gifts.qty ? 'warn' : 'zero'} active={open === 'gift'} onClick={gifts.qty ? () => toggle('gift') : null} />
      </div>
      {open === 'cancel' && <ul className="tk-table">{cancelled.rows.map((r, i) => <li key={i}>
        <span className="tk-cell-main"><b>Bàn {r.table ?? '?'}</b><small>{r.at ? when(r.at) : '--:--'}{r.by ? ` · huỷ bởi ${r.by}` : ''}</small></span>
        <span className="tk-cell-end"><b>{money(r.printedValue || r.amount)}</b><small>{r.printedCount ? `${r.printedCount} món đã in bếp` : 'chưa in bếp'}</small></span>
      </li>)}</ul>}
      {open === 'removed' && <ul className="tk-table">{removed.rows.map((r, i) => <li key={i}>
        <span className="tk-cell-main"><b>{r.name} ×{r.qty}</b><small>Bàn {r.table ?? '?'} · thu {r.paidAt ? when(r.paidAt) : '--:--'}</small></span>
        <span className="tk-cell-end"><b>{money(r.value)}</b></span>
      </li>)}</ul>}
      {open === 'discount' && <ul className="tk-table">{discounts.kinds.map(k => <li key={k.kind}>
        <span className="tk-cell-main"><b>{k.kind}</b><small>{k.count} lần</small></span><span className="tk-cell-end"><b>{money(k.amount)}</b></span>
      </li>)}</ul>}
      {open === 'gift' && <ul className="tk-table">{gifts.items.map(g => <li key={g.name}>
        <span className="tk-cell-main"><b>{g.name}</b><small>×{g.qty}</small></span><span className="tk-cell-end"><b>{g.value ? `~${money(g.value)}` : '—'}</b></span>
      </li>)}</ul>}
      {!open && <p className="tk-caption">Bấm vào từng ô để xem chi tiết. Tiền ước tính = món đã in bếp của bill huỷ + món bị bớt + giảm giá + giá menu của món tặng.</p>}
    </>}
  </Card>;
}

// Nhân viên trong ngày: ai làm giờ nào, bao nhiêu giờ, trễ / sớm / quên ra ca, cảnh báo khi quét, việc chờ duyệt.
function StaffDayCard({ staff }) {
  if (!staff) return null;
  const totalHours = Math.round(staff.people.reduce((a, p) => a + p.hours, 0) * 10) / 10;
  const late = staff.people.filter(p => p.flags.late).length;
  const waiting = staff.pending.length + staff.fixes.length + staff.outside.length;
  return <Card icon={Users} title="Nhân viên trong ngày" aside={`${staff.people.length} người`}>
    <div className="tk-tiles three">
      <Tile label="Đi làm" value={staff.people.length} sub={`${num(totalHours)} giờ`} />
      <Tile label="Đi trễ" value={late} sub={late ? 'người' : 'không ai'} tone={late ? 'bad' : 'zero'} />
      <Tile label="Chờ duyệt" value={waiting} sub={waiting ? 'xem bên dưới' : 'không có'} tone={waiting ? 'warn' : 'zero'} />
    </div>
    {staff.people.length ? <ul className="tk-table">{staff.people.map(p => <li key={p.id} className="tk-person">
      <span className="tk-avatar" aria-hidden="true">{(p.name || '?').trim().charAt(0).toUpperCase()}</span>
      <span className="tk-cell-main">
        <b>{p.name}</b>
        <small>{p.spans.map(s => `${clockOf(s.in)} – ${s.out ? clockOf(s.out) : '…'}`).join(' · ')}</small>
        <span className="tk-pills">
          {p.flags.late > 0 && <Pill tone="bad">Trễ {minutes(p.flags.late)}</Pill>}
          {p.flags.leftEarly > 0 && <Pill tone="warn">Về sớm {minutes(p.flags.leftEarly)}{p.cut ? ' · trừ lương' : ''}</Pill>}
          {p.flags.early > 0 && <Pill>Vào sớm {minutes(p.flags.early)}</Pill>}
          {p.flags.stayed > 0 && <Pill>Ở lại {minutes(p.flags.stayed)}</Pill>}
          {p.open && <Pill tone="warn">Chưa ra ca</Pill>}
          {p.forgot && <Pill tone="bad">Quên ra ca</Pill>}
          {p.waitMinutes > 0 && <Pill tone="warn">{minutes(p.waitMinutes)} ngoài ca chờ duyệt</Pill>}
        </span>
      </span>
      <span className="tk-cell-end"><b>{num(p.hours)} giờ</b></span>
    </li>)}</ul> : <p className="tk-empty">Không ai chấm công trong ngày.</p>}
    {staff.alerts.length > 0 && <div className="tk-sub">
      <h3><AlertTriangle size={15} /> Cảnh báo khi quét mã</h3>
      <ul className="tk-table">{staff.alerts.map(a => <li key={a.id}><span className="tk-cell-main"><b>{a.name}</b>
        <span className="tk-pills">{a.items.map(it => <Pill key={it.text} tone="bad">{it.text}{it.count > 1 ? ` ×${it.count}` : ''}</Pill>)}</span></span></li>)}</ul>
    </div>}
    {waiting > 0 && <div className="tk-sub">
      <h3>Chờ bạn duyệt</h3>
      <ul className="tk-table">
        {staff.pending.map((r, i) => <li key={`p${i}`}><span className="tk-cell-main"><b>{r.name}</b><small>{r.kind === 'advance' ? `xin ứng ${money(r.amount)}` : `báo nghỉ ${r.days} ngày`}{r.reason ? ` — ${r.reason}` : ''}</small></span></li>)}
        {staff.fixes.map((f, i) => <li key={`f${i}`}><span className="tk-cell-main"><b>{f.name}</b><small>xin sửa giờ chấm công{f.reason ? ` — ${f.reason}` : ''}</small></span></li>)}
        {staff.outside.map(o => <li key={`o${o.id}`}><span className="tk-cell-main"><b>{o.name}</b><small>{minutes(o.minutes)} ngoài ca chưa tính lương</small></span></li>)}
      </ul>
      <a className="tk-link" href="/admin/payroll">Mở trang Lương để duyệt →</a>
    </div>}
  </Card>;
}

// Nhân viên cả tuần / tháng: mỗi người bao nhiêu ngày, giờ, mấy lần trễ / về sớm / quên ra ca / cảnh báo.
function StaffRangeCard({ staff, label }) {
  if (!staff) return null;
  const t = staff.totals;
  return <Card icon={Users} title={`Nhân viên ${label}`} aside={`${t.people} người`}>
    <div className="tk-tiles three">
      <Tile label="Tổng giờ làm" value={num(t.hours)} sub="giờ" />
      <Tile label="Lần đi trễ" value={t.late} tone={t.late ? 'bad' : 'zero'} sub={t.late ? 'cả kỳ' : 'không có'} />
      <Tile label="Quên ra ca" value={t.forgot} tone={t.forgot ? 'bad' : 'zero'} sub={t.warnings ? `${t.warnings} lần quét bị cảnh báo` : 'quét mã đều ổn'} />
    </div>
    {staff.people.length ? <ul className="tk-table">{staff.people.map(p => <li key={p.id} className="tk-person">
      <span className="tk-avatar" aria-hidden="true">{(p.name || '?').trim().charAt(0).toUpperCase()}</span>
      <span className="tk-cell-main">
        <b>{p.name}</b>
        <small>{p.days} ngày làm</small>
        <span className="tk-pills">
          {p.late.count > 0 && <Pill tone="bad">Trễ {p.late.count} lần · {minutes(p.late.minutes)}</Pill>}
          {p.leftEarly.count > 0 && <Pill tone="warn">Về sớm {p.leftEarly.count} lần</Pill>}
          {p.forgot > 0 && <Pill tone="bad">Quên ra ca {p.forgot}</Pill>}
          {p.warnings + p.blocked > 0 && <Pill tone="bad">Cảnh báo quét {p.warnings + p.blocked}</Pill>}
          {p.waitMinutes > 0 && <Pill tone="warn">{minutes(p.waitMinutes)} ngoài ca chờ duyệt</Pill>}
          {!p.late.count && !p.leftEarly.count && !p.forgot && !(p.warnings + p.blocked) && p.hours > 0 && <Pill tone="good">Đúng giờ</Pill>}
        </span>
      </span>
      <span className="tk-cell-end"><b>{num(p.hours)} giờ</b></span>
    </li>)}</ul> : <p className="tk-empty">Chưa có ai chấm công trong kỳ này.</p>}
  </Card>;
}

// Ô tổng Sổ tay (ngày hoặc cả kỳ).
function NotesTiles({ s }) {
  return <div className="tk-tiles">
    <Tile label="Tiền hàng" value={money(s.goods)} sub={`${s.count} phiếu`} />
    <Tile label="Trả ngay" value={money(s.cashNow)} sub={s.debtPaid ? `+ trả nợ ${money(s.debtPaid)}` : 'tiền mặt'} />
    <Tile label="Nợ mới" value={money(s.newDebt)} tone={s.newDebt ? 'warn' : 'zero'} sub="mua chịu" />
    <Tile label="Còn nợ tất cả" value={money(s.debtLeft)} tone={s.debtLeft ? 'bad' : 'zero'} sub="tới hết kỳ" />
    {s.hasGiven && <Tile label="Chủ đưa" value={money(s.given)} sub="tiền đi chợ" />}
    {s.hasGiven && <Tile label={s.giveBack >= 0 ? 'Dư trả lại chủ' : 'Thiếu (bỏ thêm)'} value={money(Math.abs(s.giveBack))} tone={s.giveBack >= 0 ? 'good' : 'bad'} sub={s.giveBack >= 0 ? 'cần thu lại' : 'người đi chợ bỏ thêm'} />}
  </div>;
}

function OwedList({ owed }) {
  const [open, setOpen] = useState(false);
  if (!owed?.length) return null;
  const total = owed.reduce((a, o) => a + o.total, 0);
  return <div className="tk-sub">
    <button type="button" className="tk-sub-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      <h3>Còn nợ theo chủ nợ</h3><b>{money(total)}</b><ChevronDown size={16} className={open ? 'tk-chev on' : 'tk-chev'} /></button>
    {open && <ul className="tk-table">{owed.map(o => <li key={o.who}>
      <span className="tk-cell-main"><b>{o.who}</b><small>{o.items.slice(0, 6).map(i => `${i.what} ${money(i.left)} (${i.day})`).join(' · ')}{o.items.length > 6 ? ` · +${o.items.length - 6} món` : ''}</small></span>
      <span className="tk-cell-end"><b>{money(o.total)}</b></span>
    </li>)}</ul>}
  </div>;
}

// Sổ tay trong ngày: tổng, từng phiếu (từng món: trả đủ / nợ ai / còn nợ), dư thiếu tiền chủ đưa, trả nợ, sửa xoá.
function NotesDayCard({ notes }) {
  const [open, setOpen] = useState(null);
  if (!notes) return null;
  const s = notes.summary;
  return <Card icon={NotebookPen} title="Sổ tay trong ngày" aside={s.warnings ? <span className="tk-warn-text">⚠ {s.warnings} phiếu cần xem</span> : `${s.count} phiếu`}>
    <NotesTiles s={s} />
    {notes.notes.length ? <ul className="tk-notes">{notes.notes.map(n => {
      const isOpen = open === n.id;
      const warn = n.mismatch || n.items.some(i => i.warnings.length);
      return <li key={n.id} className={warn ? 'bad' : ''}>
        <button type="button" className="tk-note-head" onClick={() => setOpen(isOpen ? null : n.id)} aria-expanded={isOpen}>
          <span className="tk-cell-main"><b>{clockOf(n.at)} · {n.who}</b>
            <small>{n.items.length ? `${n.items.length} món` : n.kind}{n.given ? ` · chủ đưa ${money(n.given)}` : ''}{n.debt ? ` · nợ ${money(n.debt)}` : ''}{warn ? ' · ⚠ cần xem' : ''}</small></span>
          <span className="tk-cell-end"><b>{money(n.saved)}</b></span>
          <ChevronDown size={16} className={isOpen ? 'tk-chev on' : 'tk-chev'} />
        </button>
        {isOpen && <div className="tk-note-body">
          {n.text && <p className="tk-note-text">{n.text}</p>}
          {n.items.length > 0 && <ul className="tk-items">{n.items.map((i, k) => <li key={k}>
            <span><b>{i.name}</b>{(i.qty || i.price) && <small>{[i.qty, i.price && `× ${i.price}`].filter(Boolean).join(' ')}</small>}
              {i.warnings.map(w => <em key={w} className="tk-warn-text">⚠ {w}</em>)}</span>
            <span className="tk-item-end"><b>{money(i.total)}</b>
              {i.owed ? <Pill tone={i.left ? 'bad' : 'good'}>{i.left ? `nợ ${i.creditor || 'chưa ghi tên'} còn ${money(i.left)}` : `đã trả hết nợ ${i.creditor}`}</Pill> : <Pill tone="good">trả đủ</Pill>}</span>
          </li>)}</ul>}
          <div className="tk-note-foot">
            <span>Trả ngay {money(n.paidNow || 0)}{n.debt ? ` · nợ ${money(n.debt)}` : ''}{n.funded ? ` · trả nợ cũ ${money(n.funded)}` : ''}</span>
            {n.left !== null && n.left !== undefined && <b className={n.left >= 0 ? 'tk-good-text' : 'tk-bad-text'}>{n.left >= 0 ? `Dư ${money(n.left)} trả lại chủ` : `Thiếu ${money(-n.left)} (bỏ thêm)`}</b>}
          </div>
          {n.mismatch && <p className="tk-warn-box">⚠ Phiếu lệch tiền: tổng ghi {money(n.mismatch.saved)} nhưng các món cộng lại {money(n.mismatch.items)}.</p>}
          {n.note && <p className="tk-note-text">Ghi chú: {n.note}</p>}
          {n.edits?.length > 0 && <ul className="tk-edits">{n.edits.map((e, k) => <li key={k}>✎ {e.at} {e.by}: {e.changes}</li>)}</ul>}
        </div>}
      </li>;
    })}</ul> : <p className="tk-empty">Không có phiếu Sổ tay nào trong ngày.</p>}
    {notes.payments.length > 0 && <div className="tk-sub"><h3>Trả nợ trong ngày</h3><ul className="tk-table">{notes.payments.map((p, i) => <li key={i}>
      <span className="tk-cell-main"><b>{p.item || 'Trả nợ'}{p.creditor ? ` · ${p.creditor}` : ''}</b><small>{clockOf(p.at)}{p.noteDay ? ` · phiếu ${p.noteDay}` : ''}{p.fromNote ? ' · lấy từ tiền đi chợ' : ''}{p.by ? ` · ${p.by}` : ''}</small></span>
      <span className="tk-cell-end"><b>{money(p.amount)}</b></span></li>)}</ul></div>}
    {(notes.edited.length > 0 || notes.deleted.length > 0) && <div className="tk-sub bad"><h3><AlertTriangle size={15} /> Phiếu bị sửa / xoá trong ngày ({notes.edited.length + notes.deleted.length})</h3><ul className="tk-table">
      <Limited items={[...notes.deleted.map(d => ({ d })), ...notes.edited.map(e => ({ e }))]}>{(x, i) => (x.d
        ? <li key={`d${i}`}><span className="tk-cell-main"><b>XOÁ phiếu {x.d.noteDay || '?'} của {x.d.who}</b><small>{clockOf(x.d.at)}{x.d.by ? ` · người xoá: ${x.d.by}` : ''}</small></span><span className="tk-cell-end"><b>{x.d.amount ? money(x.d.amount) : ''}</b></span></li>
        : <li key={`e${i}`}><span className="tk-cell-main"><b>Sửa phiếu {x.e.noteDay} · {x.e.who}</b><small>{x.e.at} {x.e.by}: {x.e.changes}</small></span></li>)}</Limited>
    </ul></div>}
    <OwedList owed={notes.owed} />
    <a className="tk-link" href="/admin/notes">Mở Sổ tay →</a>
  </Card>;
}

// Sổ tay cả tuần / tháng: tổng, theo người đi chợ, món mua nhiều tiền nhất, còn nợ.
function NotesRangeCard({ notes, label }) {
  if (!notes) return null;
  const s = notes.summary;
  const max = Math.max(1, ...notes.top.map(t => t.total));
  return <Card icon={NotebookPen} title={`Sổ tay ${label}`} aside={s.warnings ? <span className="tk-warn-text">⚠ {s.warnings} phiếu cần xem</span> : `${s.count} phiếu`}>
    <NotesTiles s={s} />
    {notes.byStaff.length > 0 && <div className="tk-sub"><h3>Theo người đi chợ</h3><ul className="tk-table">{notes.byStaff.map(p => <li key={p.who}>
      <span className="tk-cell-main"><b>{p.who}</b><small>{p.notes} phiếu</small></span><span className="tk-cell-end"><b>{money(p.goods)}</b></span></li>)}</ul></div>}
    {notes.top.length > 0 && <div className="tk-sub"><h3>Mua nhiều tiền nhất</h3><ol className="tk-bars tk-rank">{notes.top.map((t, i) => <li key={t.name}>
      <div className="tk-bar-line"><span><em>{i + 1}</em>{t.name} <small className="tk-muted">· {t.times} lần</small></span><b>{money(t.total)}</b></div>
      <span className="tk-bar-track"><span className="tk-bar-fill cost" style={{ width: `${t.total / max * 100}%` }} /></span>
    </li>)}</ol></div>}
    <OwedList owed={notes.owed} />
    <a className="tk-link" href="/admin/notes">Mở Sổ tay →</a>
  </Card>;
}

// ── Tuần / tháng: tổng của kỳ, so với kỳ trước cùng số ngày, cột từng ngày (bấm để xem ngày đó).
const PERIODS = [['day', 'Ngày'], ['week', 'Tuần'], ['month', 'Tháng']];
const periodLabel = d => (d.period === 'week' ? `tuần ${ddmm(d.from)} – ${ddmm(d.to)}` : `tháng ${Number(d.from.slice(5, 7))}/${d.from.slice(0, 4)}`);

function PeriodHero({ data, onPick }) {
  const t = data.totals;
  const days = data.days;
  const max = Math.max(1, ...days.map(d => d.revenue || 0));
  const bills = t.bills + t.paperBills;
  const thin = days.length > 7;
  return <section className="tk-hero">
    <div className="tk-hero-label"><Wallet size={16} /> Doanh thu {periodLabel(data)}</div>
    <div className="tk-hero-value">{money(t.revenue)}</div>
    <div className="tk-hero-meta">
      <span>{bills} bill</span>
      {t.days > 0 && <span>TB {money(t.revenue / t.days)}/ngày</span>}
      {bills > 0 && <span>TB {money(t.revenue / bills)}/bill</span>}
    </div>
    {data.prev && <div className="tk-hero-deltas"><Delta now={t.revenue} before={data.prev.revenue} label={`${data.period === 'week' ? 'tuần' : 'tháng'} trước (cùng số ngày)`} /></div>}
    <div className={thin ? 'tk-week thin' : 'tk-week'} style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }} role="group" aria-label="Doanh thu từng ngày">
      {days.map(d => {
        const n = Number(d.date.slice(8, 10));
        const showLabel = !thin || n === 1 || n % 5 === 0;
        return <button key={d.date} className="tk-week-day" disabled={d.revenue === null} onClick={() => onPick(d.date)}
          aria-label={`${WEEKDAYS[weekdayOf(d.date)]} ${ddmm(d.date)}: ${money(d.revenue)}`}>
          {!thin && <span className="tk-week-amount">{d.revenue ? compact(d.revenue) : ''}</span>}
          <span className="tk-week-track"><span className="tk-week-bar" style={{ height: `${Math.max(d.revenue ? 4 : 2, (d.revenue || 0) / max * 100)}%` }} /></span>
          <span className="tk-week-label">{thin ? (showLabel ? n : '') : SHORT_DAYS[weekdayOf(d.date)]}</span>
        </button>;
      })}
    </div>
  </section>;
}

function DayKpis({ summary }) {
  const loss = summary.profit < 0;
  const bills = summary.bills + summary.paperBills;
  return <section className="tk-kpis">
    <div className="tk-kpi"><span className="tk-kpi-label">Chi trong ngày</span><b>{money(summary.cost)}</b></div>
    <div className={`tk-kpi ${loss ? 'neg' : 'pos'}`}><span className="tk-kpi-label">{loss ? 'Lỗ ngày' : 'Lãi ngày'}</span><b>{loss ? '-' : '+'}{money(Math.abs(summary.profit))}</b></div>
    <div className="tk-kpi"><span className="tk-kpi-label">Số bill</span><b>{bills}</b></div>
    <div className="tk-kpi"><span className="tk-kpi-label">Máy kiểm tra</span>{summary.check
      ? <b className={summary.check.ok ? 'tk-good-text' : 'tk-warn-text'}>{summary.check.ok ? '✓ Ổn' : `${summary.check.problems} việc`}</b>
      : <b className={summary.closed ? 'tk-good-text' : 'tk-muted-text'}>{summary.closed ? 'Đã chốt' : '5h sáng mai'}</b>}</div>
  </section>;
}

function PeriodKpis({ data }) {
  const t = data.totals;
  const loss = t.profit < 0;
  return <section className="tk-kpis">
    <div className="tk-kpi"><span className="tk-kpi-label">Chi cả kỳ</span><b>{money(t.cost)}</b>
      {data.prev && <Delta now={t.cost} before={data.prev.cost} label="kỳ trước" />}</div>
    <div className={`tk-kpi ${loss ? 'neg' : 'pos'}`}><span className="tk-kpi-label">{loss ? 'Lỗ cả kỳ' : 'Lãi cả kỳ'}</span><b>{loss ? '-' : '+'}{money(Math.abs(t.profit))}</b></div>
    <div className="tk-kpi"><span className="tk-kpi-label">Lãi trung bình / ngày</span><b>{t.days ? money(t.profit / t.days) : '—'}</b></div>
    <div className="tk-kpi"><span className="tk-kpi-label">Ngày máy đã kiểm tra</span><b className={t.closedDays < t.days - 1 ? 'tk-warn-text' : ''}>{t.closedDays}/{t.days}</b></div>
  </section>;
}

// Tháng: trung bình doanh thu theo thứ trong tuần (thứ nào đông, thứ nào vắng).
function Weekdays({ weekdays }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const rows = order.map(wd => weekdays.find(w => w.wd === wd)).filter(Boolean);
  if (!rows.some(r => r.days)) return null;
  const max = Math.max(1, ...rows.map(r => r.avg));
  const best = rows.reduce((a, r) => (r.avg > a.avg ? r : a), rows[0]);
  return <Card icon={CalendarDays} title="Trung bình theo thứ" aside={best.avg ? `đông nhất ${WEEKDAYS[best.wd]}` : null}>
    <ul className="tk-bars">{rows.map(r => <li key={r.wd}>
      <div className="tk-bar-line"><span>{WEEKDAYS[r.wd]} <small className="tk-muted">· {r.days} ngày</small></span><b>{r.days ? money(r.avg) : '—'}</b></div>
      <span className="tk-bar-track"><span className="tk-bar-fill" style={{ width: `${r.avg / max * 100}%` }} /></span>
    </li>)}</ul>
  </Card>;
}

export default function ThongKePage() {
  const [user, setUser] = useState(undefined); // undefined = đang kiểm tra
  const [sessionError, setSessionError] = useState('');
  const [date, setDate] = useState(null);
  const [period, setPeriod] = useState('day');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const asked = params.get('date');
    setDate(/^\d{4}-\d{2}-\d{2}$/.test(asked || '') && asked <= vnToday() ? asked : defaultDate());
    if (PERIODS.some(([k]) => k === params.get('p'))) setPeriod(params.get('p'));
    fetch('/api/admin/session', { cache: 'no-store' })
      .then(async res => {
        const result = await res.json().catch(() => ({}));
        if (res.ok && result.user) setUser(result.user);
        else { setUser(null); if (res.status === 503) setSessionError('Không kiểm tra được phiên đăng nhập. Thử lại.'); }
      })
      .catch(() => { setUser(null); setSessionError('Không kết nối được máy chủ.'); });
  }, []);

  const load = useCallback(async (d, p) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(p === 'day' ? `/api/admin/finance?report=${d}` : `/api/admin/finance?period=${p}&date=${d}`, { cache: 'no-store' });
      const result = await res.json().catch(() => ({}));
      if (res.status === 401) { setUser(null); setSessionError('Phiên đăng nhập đã hết hạn. Đăng nhập lại.'); return; }
      if (!res.ok) throw new Error(result.error || 'Không đọc được báo cáo.');
      setReport({ ...result, view: p });
      setLoadedAt(new Date());
    } catch (err) { setError(err.message === 'Failed to fetch' ? 'Không kết nối được máy chủ.' : err.message); setReport(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!user || user.role !== 'admin' || !date) return;
    window.history.replaceState(null, '', `/thongke?date=${date}${period === 'day' ? '' : `&p=${period}`}`);
    load(date, period);
  }, [user, date, period, load]);

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
  const ready = report && report.view === period && report.date === date && !report.error && (period === 'day' ? report.summary : report.totals);
  // Nút ‹ › theo kỳ: ngày ±1, tuần ±7, tháng ±1 tháng.
  const monthStart = d => `${d.slice(0, 7)}-01`;
  const shiftMonth = (d, n) => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); };
  const weekStart = d => addDays(d, -((weekdayOf(d) + 6) % 7));
  const prevDate = period === 'day' ? addDays(date, -1) : period === 'week' ? addDays(weekStart(date), -1) : addDays(monthStart(date), -1);
  const nextDate = period === 'day' ? addDays(date, 1) : period === 'week' ? addDays(weekStart(date), 7) : shiftMonth(date, 1);
  const label = period === 'day' ? <><b>{dayTitle(date)}</b> · {ddmm(date)}/{date.slice(0, 4)}</>
    : period === 'week' ? <><b>Tuần</b> {ddmm(weekStart(date))} – {ddmm(addDays(weekStart(date), 6))}</>
    : <><b>Tháng {Number(date.slice(5, 7))}</b>/{date.slice(0, 4)}</>;
  const openDay = d => { setPeriod('day'); setDate(d); window.scrollTo({ top: 0 }); };
  const rangeLabel = report && period !== 'day' && report.from ? periodLabel(report) : '';

  return <main className="tk-page">
    <header className="tk-bar">
      <div className="tk-bar-inner">
        <div className="tk-brand"><span className="tk-brand-logo"><BarChart3 size={18} /></span><div><b>Thống kê</b><small>{user.full_name || 'Admin'}</small></div></div>
        <div className="tk-bar-actions">
          <button className="tk-icon" onClick={() => load(date, period)} disabled={loading} aria-label="Tải lại"><RefreshCw size={19} className={loading ? 'spin' : ''} /></button>
          <button className="tk-icon" onClick={logout} aria-label="Đăng xuất"><LogOut size={19} /></button>
        </div>
      </div>
      <div className="tk-periods" role="tablist" aria-label="Xem theo">
        {PERIODS.map(([k, t]) => <button key={k} role="tab" aria-selected={period === k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{t}</button>)}
      </div>
      <nav className="tk-datebar" aria-label="Chọn ngày">
        <button className="tk-icon" aria-label="Trước" disabled={loading || (start && prevDate < start)} onClick={() => setDate(prevDate)}><ChevronLeft size={22} /></button>
        <label className="tk-date">
          <CalendarDays size={17} />
          <span>{label}</span>
          <input type="date" value={date} max={today} min={start || undefined} onChange={e => e.target.value && setDate(e.target.value)} aria-label="Chọn ngày" />
        </label>
        <button className="tk-icon" aria-label="Sau" disabled={loading || nextDate > today} onClick={() => setDate(nextDate > today ? today : nextDate)}><ChevronRight size={22} /></button>
      </nav>
    </header>

    <div className="tk-shell">
      {error && <div className="tk-alert" role="alert">{error}<button onClick={() => load(date, period)}>Thử lại</button></div>}
      {!error && report?.view === period && report?.date === date && report.error && <div className="tk-empty-state"><CalendarDays size={32} /><p>{report.error}</p></div>}
      {!ready && !error && !(report?.view === period && report?.date === date && report.error) && <Skeleton />}

      {ready && period === 'day' && <div className={loading ? 'tk-content dim' : 'tk-content'}>
        <Hero date={date} summary={report.summary} compare={report.compare} trend={report.trend || []} onPick={setDate} />
        <DayKpis summary={report.summary} />
        <Warnings summary={report.summary} />
        <Payments summary={report.summary} />
        <Costs summary={report.summary} />
        <Hours compare={report.compare} />
        <TopItems compare={report.compare} />
        <LossCard loss={report.loss} />
        <StaffDayCard staff={report.staff} />
        <NotesDayCard notes={report.notes} />
        <footer className="tk-foot">
          {loadedAt && <span>Cập nhật {loadedAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>}
          <a href="/admin/finance">Mở Sổ thu chi đầy đủ →</a>
        </footer>
      </div>}

      {ready && period !== 'day' && <div className={loading ? 'tk-content dim' : 'tk-content'}>
        <PeriodHero data={report} onPick={openDay} />
        <PeriodKpis data={report} />
        <Payments summary={report.totals} />
        <Costs summary={report.totals} />
        <Hours compare={report.sales} title="Giờ đông khách (cả kỳ)" />
        <TopItems compare={report.sales} />
        {period === 'month' && <Weekdays weekdays={report.weekdays || []} />}
        <LossCard loss={report.loss} range />
        <StaffRangeCard staff={report.staff} label={rangeLabel} />
        {period === 'month' && <StaffReport date={date} monthRevenue={report.totals.revenue} />}
        <NotesRangeCard notes={report.notes} label={rangeLabel} />
        <footer className="tk-foot">
          {loadedAt && <span>Cập nhật {loadedAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>}
          <a href="/admin/finance">Mở Sổ thu chi đầy đủ →</a>
        </footer>
      </div>}
    </div>
  </main>;
}
