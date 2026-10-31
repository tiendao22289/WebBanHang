'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Swal from 'sweetalert2';
import { removeVietnameseTones } from '@/lib/utils';
import {
  voucherValueText, voucherState, VOUCHER_STATE_TEXT, VOUCHER_SOURCES, shortDay, firstUseDay, lastUseDay, money,
  GIFT_MESSAGE_TEMPLATE, NEXT_VISIT_MESSAGE_TEMPLATE, fillVoucherMessage,
} from '@/lib/voucher.mjs';

// Trang Voucher của chủ quán (xem lib/voucher.mjs, api/admin/vouchers):
//  - Công tắc chung: tắt thì khách / nhân viên không dùng mã, vòng xoay không ra voucher, không phát mã mới.
//  - Tặng khách: tạo mã có hạn cho từng khách (hoặc N mã không tên), nhắn qua Zalo OA hoặc chép tin để gửi tay.
//  - Hẹn lần sau: thanh toán xong máy tự tặng mã cho SĐT của bill.
//  - Danh sách + số liệu: đã tặng / đã dùng / tiền giảm / doanh thu bill có voucher.

const DAY_MS = 86400000;
const vnDay = (ms = Date.now()) => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const norm = s => removeVietnameseTones(String(s || '').toLowerCase());
const card = { background: 'white', border: '1px solid #e5e7eb', borderRadius: 14, padding: 14, marginBottom: 12 };
const label = { display: 'block', fontSize: '0.78rem', fontWeight: 700, color: '#374151', margin: '10px 0 4px' };
const input = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid #e5e7eb', fontSize: '0.95rem', boxSizing: 'border-box', background: 'white' };
const btn = (bg, color = 'white') => ({ padding: '10px 14px', border: 'none', borderRadius: 10, background: bg, color, fontWeight: 800, cursor: 'pointer', fontSize: '0.88rem' });
const chip = on => ({ padding: '6px 10px', borderRadius: 999, border: `1.5px solid ${on ? '#d97706' : '#e5e7eb'}`, background: on ? '#fffbeb' : 'white', color: on ? '#b45309' : '#475569', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer', whiteSpace: 'nowrap' });
const STATE_COLOR = { active: '#16a34a', not_yet: '#2563eb', expired: '#9ca3af', used: '#7c3aed', cancelled: '#dc2626' };

async function api(body) {
  const res = await fetch('/api/admin/vouchers', body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
  } : { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Chưa kết nối được máy chủ.');
  return data;
}
const getView = view => fetch(`/api/admin/vouchers?view=${view}`, { cache: 'no-store' })
  .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Lỗi tải dữ liệu'); return d; });

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* trình duyệt cũ */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

const messageOf = v => v.message || fillVoucherMessage(v.source === 'next_visit' ? NEXT_VISIT_MESSAGE_TEMPLATE : GIFT_MESSAGE_TEMPLATE, v);
const toast = (title, icon = 'success') => Swal.fire({ icon, title, toast: true, position: 'top-end', showConfirmButton: false, timer: 1800 });

function Stats({ vouchers }) {
  const since = Date.now() - 30 * DAY_MS;
  const recent = vouchers.filter(v => new Date(v.created_at).getTime() >= since && v.status !== 'cancelled');
  const used = recent.filter(v => v.status === 'used');
  const rate = recent.length ? Math.round(used.length * 100 / recent.length) : 0;
  const cell = (big, small, color = '#0f172a') => (
    <div style={{ flex: '1 1 30%', minWidth: 90, background: '#f8fafc', borderRadius: 12, padding: '10px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: '1.15rem', fontWeight: 900, color }}>{big}</div>
      <div style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 600 }}>{small}</div>
    </div>
  );
  return (
    <div style={card}>
      <div style={{ fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>📊 30 ngày qua</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {cell(recent.length, 'mã đã tặng')}
        {cell(used.length, 'khách quay lại dùng', '#7c3aed')}
        {cell(`${rate}%`, 'tỉ lệ quay lại', '#16a34a')}
        {cell(money(used.reduce((s, v) => s + (Number(v.discount_amount) || 0), 0)), 'tiền đã giảm', '#dc2626')}
        {cell(money(used.reduce((s, v) => s + (Number(v.bill_total) || 0), 0)), 'tiền món các bill dùng mã', '#0f766e')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, fontSize: '0.74rem', color: '#475569' }}>
        {Object.entries(VOUCHER_SOURCES).map(([key, name]) => {
          const mine = recent.filter(v => v.source === key);
          return <span key={key}>{name}: <b>{mine.filter(v => v.status === 'used').length}/{mine.length}</b> đã dùng</span>;
        })}
      </div>
    </div>
  );
}

function VoucherRow({ v, onChanged }) {
  const state = voucherState(v);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try {
      const { results } = await api({ action: 'send', ids: [v.id], force: !!v.sent_at });
      const r = results?.[0];
      if (r?.ok) toast('Đã nhắn mã qua Zalo');
      else Swal.fire('Chưa gửi được qua Zalo', `${r?.message || 'Thử lại sau.'}\n\nBấm "Chép tin" rồi dán vào Zalo OA để gửi tay.`, 'warning');
      onChanged();
    } catch (e) { Swal.fire('Lỗi', e.message, 'error'); } finally { setBusy(false); }
  }
  async function cancel() {
    const { isConfirmed } = await Swal.fire({ title: `Huỷ mã ${v.code}?`, text: 'Khách sẽ không dùng được mã này nữa.', icon: 'warning', showCancelButton: true, confirmButtonText: 'Huỷ mã', cancelButtonText: 'Không', confirmButtonColor: '#dc2626', reverseButtons: true });
    if (!isConfirmed) return;
    try { await api({ action: 'cancel', id: v.id }); toast('Đã huỷ mã'); onChanged(); } catch (e) { Swal.fire('Lỗi', e.message, 'error'); }
  }
  return (
    <div style={{ borderTop: '1px solid #f1f5f9', padding: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <b style={{ letterSpacing: 1, color: '#0f172a' }}>{v.code}</b>
        <span style={{ fontSize: '0.72rem', fontWeight: 800, color: STATE_COLOR[state] }}>{VOUCHER_STATE_TEXT[state]}</span>
      </div>
      <div style={{ fontSize: '0.82rem', color: '#334155' }}>
        Giảm <b>{voucherValueText(v)}</b>{Number(v.min_bill) > 0 ? ` · bill từ ${money(v.min_bill)}` : ''} · {VOUCHER_SOURCES[v.source]}
      </div>
      <div style={{ fontSize: '0.76rem', color: '#64748b' }}>
        {v.customer_name || (v.customer_phone ? 'Khách' : 'Mã không tên')}{v.customer_phone ? ` · ${v.customer_phone}` : ''}
        {' · '}dùng {shortDay(firstUseDay(v.valid_from))} → hết {shortDay(lastUseDay(v.valid_until))}
      </div>
      {state === 'used' && (
        <div style={{ fontSize: '0.76rem', color: '#7c3aed' }}>
          Đã giảm {money(v.discount_amount)} trên bill {money(v.bill_total)}{v.used_table_number ? ` · bàn ${v.used_table_number}` : ''}{v.used_by_name ? ` · ${v.used_by_name}` : ''}
        </div>
      )}
      {(state === 'active' || state === 'not_yet') && (
        <>
          <div style={{ fontSize: '0.72rem', color: v.sent_at ? '#0f766e' : v.send_error ? '#b45309' : '#94a3b8' }}>
            {v.sent_at ? '✓ Đã nhắn Zalo' : v.send_error || (v.customer_phone ? 'Chưa nhắn Zalo' : 'Chép tin để gửi khách')}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button style={btn('#eff6ff', '#1d4ed8')} onClick={async () => toast(await copyText(messageOf(v)) ? 'Đã chép tin nhắn' : 'Không chép được', 'info')}>📋 Chép tin</button>
            {v.customer_phone && <button style={btn('#0d9488')} disabled={busy} onClick={send}>{busy ? 'Đang gửi…' : v.sent_at ? '💬 Gửi lại Zalo' : '💬 Gửi Zalo'}</button>}
            <button style={btn('#fef2f2', '#dc2626')} onClick={cancel}>Huỷ mã</button>
          </div>
        </>
      )}
    </div>
  );
}

function GiftTab({ onCreated }) {
  const today = vnDay();
  const [form, setForm] = useState({ batchName: '', type: 'amount', value: '30000', max: '', minBill: '200000', fromDay: today, toDay: addDays(today, 14), message: GIFT_MESSAGE_TEMPLATE });
  const [mode, setMode] = useState('pick'); // 'pick' = chọn khách | 'blank' = mã không tên
  const [count, setCount] = useState('10');
  const [customers, setCustomers] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [picked, setPicked] = useState({});
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState([]);
  const [sending, setSending] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => { getView('customers').then(d => setCustomers(d.customers || [])).catch(() => setCustomers([])); }, []);

  const shown = useMemo(() => {
    const q = norm(search).trim();
    const cut = Date.now() - 30 * DAY_MS;
    return (customers || []).filter(c => {
      if (filter === 'zalo' && !c.hasZalo) return false;
      if (filter === 'away' && !(c.lastVisitAt && new Date(c.lastVisitAt).getTime() < cut)) return false;
      if (filter === 'regular' && !(c.visits >= 3)) return false;
      return !q || norm(c.name).includes(q) || String(c.phone).includes(q);
    });
  }, [customers, search, filter]);
  const pickedList = (customers || []).filter(c => picked[c.phone]);
  const preview = fillVoucherMessage(form.message, {
    code: 'BK-XXXXXX', customer_name: pickedList[0]?.name || '', discount_type: form.type, discount_value: Number(form.value) || 0,
    max_discount: Number(form.max) || 0, min_bill: Number(form.minBill) || 0,
    valid_from: `${form.fromDay}T05:00:00+07:00`, valid_until: new Date(Date.parse(`${form.toDay}T05:00:00+07:00`) + DAY_MS).toISOString(),
  });

  async function create() {
    const recipients = mode === 'pick' ? pickedList.map(c => ({ phone: c.phone, name: c.name })) : [];
    if (mode === 'pick' && !recipients.length) { Swal.fire('Chưa chọn khách', 'Tick chọn khách nhận voucher ở danh sách bên dưới.', 'info'); return; }
    const n = mode === 'blank' ? Number(count) || 0 : recipients.length;
    const { isConfirmed } = await Swal.fire({ title: `Tạo ${n} mã giảm ${voucherValueText({ discount_type: form.type, discount_value: Number(form.value), max_discount: Number(form.max) })}?`,
      text: `Dùng từ ${shortDay(form.fromDay)} đến hết ${shortDay(form.toDay)}. Mỗi mã dùng 1 lần.`, icon: 'question', showCancelButton: true, confirmButtonText: 'Tạo mã', cancelButtonText: 'Thôi', reverseButtons: true });
    if (!isConfirmed) return;
    setSaving(true);
    try {
      const { vouchers } = await api({ action: 'create', ...form, value: Number(form.value), max: Number(form.max) || 0, minBill: Number(form.minBill) || 0,
        recipients, count: mode === 'blank' ? Number(count) || 0 : 0 });
      setCreated(vouchers || []);
      setPicked({});
      onCreated();
      toast(`Đã tạo ${vouchers?.length || 0} mã`);
    } catch (e) { Swal.fire('Chưa tạo được', e.message, 'error'); } finally { setSaving(false); }
  }

  async function sendAll() {
    const ids = created.filter(v => v.customer_phone).map(v => v.id);
    if (!ids.length) return;
    setSending(true);
    try {
      const { results } = await api({ action: 'send', ids });
      const ok = results.filter(r => r.ok).length;
      const noZalo = results.filter(r => r.reason === 'no_zalo').length;
      const refused = results.filter(r => !r.ok && r.reason !== 'no_zalo');
      setCreated(list => list.map(v => { const r = results.find(x => x.id === v.id); return r ? { ...v, sent_at: r.ok ? new Date().toISOString() : null, send_error: r.ok ? null : r.message } : v; }));
      onCreated();
      Swal.fire(ok ? 'Đã gửi Zalo' : 'Chưa gửi được', [
        `Gửi được ${ok}/${results.length} khách.`,
        noZalo ? `${noZalo} khách chưa nối Zalo với quán.` : '',
        refused.length ? `${refused.length} khách chưa gửi được: ${refused[0].message}` : '',
        ok < results.length ? 'Khách chưa nhận thì bấm "Chép tin" rồi dán vào Zalo để gửi tay.' : '',
      ].filter(Boolean).join('\n'), ok ? 'success' : 'warning');
    } catch (e) { Swal.fire('Lỗi', e.message, 'error'); } finally { setSending(false); }
  }

  return (
    <>
      <div style={card}>
        <div style={{ fontWeight: 800, color: '#0f172a' }}>🎁 Tạo voucher tặng khách</div>
        <label style={label}>Tên đợt (để mình xem lại)</label>
        <input style={input} value={form.batchName} onChange={e => set('batchName', e.target.value)} placeholder="vd Tặng khách quen tháng 11" />
        <label style={label}>Giảm</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {[['amount', 'Số tiền'], ['percent', '% bill']].map(([k, t]) => <button key={k} style={chip(form.type === k)} onClick={() => set('type', k)}>{t}</button>)}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>{form.type === 'percent' ? '% giảm' : 'Số tiền giảm (đ)'}</label>
            <input style={input} type="number" inputMode="numeric" value={form.value} onChange={e => set('value', e.target.value)} />
          </div>
          {form.type === 'percent' && (
            <div style={{ flex: 1 }}>
              <label style={label}>Giảm tối đa (đ)</label>
              <input style={input} type="number" inputMode="numeric" value={form.max} onChange={e => set('max', e.target.value)} placeholder="không giới hạn" />
            </div>
          )}
        </div>
        <label style={label}>Bill từ bao nhiêu mới dùng được (đ)</label>
        <input style={input} type="number" inputMode="numeric" value={form.minBill} onChange={e => set('minBill', e.target.value)} placeholder="0 = bill nào cũng được" />
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>Dùng từ ngày</label>
            <input style={input} type="date" value={form.fromDay} min={today} onChange={e => set('fromDay', e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>Đến hết ngày</label>
            <input style={input} type="date" value={form.toDay} min={form.fromDay} onChange={e => set('toDay', e.target.value)} />
          </div>
        </div>
        <label style={label}>Lời nhắn Zalo</label>
        <textarea style={{ ...input, minHeight: 96, fontSize: '0.86rem' }} value={form.message} onChange={e => set('message', e.target.value)} />
        <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>Máy tự điền: {'{ten}'} tên khách · {'{giam}'} mức giảm · {'{ma}'} mã · {'{tu}'} {'{den}'} ngày · {'{dieukien}'} bill tối thiểu</div>
        <div style={{ marginTop: 8, background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 10, padding: '8px 10px', fontSize: '0.8rem', color: '#134e4a', whiteSpace: 'pre-wrap' }}>{preview}</div>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>👥 Tặng cho ai?</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button style={chip(mode === 'pick')} onClick={() => setMode('pick')}>Chọn khách</button>
          <button style={chip(mode === 'blank')} onClick={() => setMode('blank')}>Mã không tên</button>
        </div>
        {mode === 'blank' ? (
          <>
            <label style={label}>Số mã cần tạo</label>
            <input style={input} type="number" inputMode="numeric" value={count} onChange={e => setCount(e.target.value)} />
            <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: 4 }}>Mỗi mã dùng 1 lần, ai đưa mã cũng dùng được. Hợp để chép gửi tay trong Zalo OA.</div>
          </>
        ) : customers === null ? <div style={{ color: '#94a3b8' }}>Đang tải khách…</div> : (
          <>
            <input style={input} value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm tên hoặc SĐT" />
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '8px 0' }}>
              {[['all', 'Tất cả'], ['zalo', 'Có Zalo'], ['away', 'Lâu chưa ghé (30+ ngày)'], ['regular', 'Khách quen (3+ lần)']].map(([k, t]) => (
                <button key={k} style={chip(filter === k)} onClick={() => setFilter(k)}>{t}</button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', color: '#475569', marginBottom: 4 }}>
              <span>Đã chọn <b>{pickedList.length}</b> khách</span>
              <span style={{ display: 'flex', gap: 10 }}>
                <button style={{ ...chip(false), padding: '4px 8px' }} onClick={() => setPicked(p => ({ ...p, ...Object.fromEntries(shown.slice(0, 500).map(c => [c.phone, true])) }))}>Chọn {Math.min(shown.length, 500)} khách đang lọc</button>
                {pickedList.length > 0 && <button style={{ ...chip(false), padding: '4px 8px' }} onClick={() => setPicked({})}>Bỏ chọn</button>}
              </span>
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #f1f5f9', borderRadius: 10 }}>
              {shown.slice(0, 150).map(c => (
                <label key={c.phone} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid #f8fafc', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!picked[c.phone]} onChange={e => setPicked(p => ({ ...p, [c.phone]: e.target.checked }))} style={{ width: 18, height: 18 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.88rem' }}>{c.name || 'Khách'}</span>
                    {c.hasZalo && <span style={{ marginLeft: 6, fontSize: '0.64rem', fontWeight: 800, color: '#0f766e', background: '#ccfbf1', borderRadius: 6, padding: '1px 5px' }}>Zalo</span>}
                    <span style={{ display: 'block', fontSize: '0.74rem', color: '#64748b' }}>{c.phone} · {c.visits} lần{c.lastVisitAt ? ` · ghé ${shortDay(vnDay(new Date(c.lastVisitAt).getTime()))}` : ''}</span>
                  </span>
                </label>
              ))}
              {shown.length > 150 && <div style={{ padding: 8, fontSize: '0.74rem', color: '#94a3b8', textAlign: 'center' }}>Còn {shown.length - 150} khách — gõ tìm để lọc bớt</div>}
              {!shown.length && <div style={{ padding: 12, color: '#94a3b8', textAlign: 'center', fontSize: '0.84rem' }}>Không có khách phù hợp</div>}
            </div>
            <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 6 }}>
              Zalo chỉ cho quán nhắn riêng khách <b>vừa nhắn cho quán gần đây</b>. Khách gửi không được thì bấm "Chép tin" để tự gửi trong Zalo OA.
            </div>
          </>
        )}
        <button style={{ ...btn('#d97706'), width: '100%', marginTop: 12, padding: 12, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={create}>
          {saving ? 'Đang tạo…' : `Tạo ${mode === 'blank' ? Number(count) || 0 : pickedList.length} mã voucher`}
        </button>
      </div>

      {created.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <b>✅ Vừa tạo {created.length} mã</b>
            {created.some(v => v.customer_phone) && (
              <button style={btn('#0d9488')} disabled={sending} onClick={sendAll}>{sending ? 'Đang gửi…' : '💬 Gửi Zalo tất cả'}</button>
            )}
          </div>
          {created.map(v => <VoucherRow key={v.id} v={v} onChanged={onCreated} />)}
        </div>
      )}
    </>
  );
}

/** Công tắc chung bật / tắt cả tính năng voucher. Mã đã phát không bị đụng tới. */
function VoucherSwitch({ on, onChange }) {
  const [busy, setBusy] = useState(false);
  if (on == null) return <div style={card}>Đang tải…</div>;
  async function flip() {
    if (on) {
      const ok = await Swal.fire({
        icon: 'question', title: 'Tắt voucher?', showCancelButton: true, confirmButtonText: 'Tắt voucher', cancelButtonText: 'Không',
        confirmButtonColor: '#dc2626',
        text: 'Khách không nhập mã được, nhân viên không áp mã được, vòng xoay không ra voucher, không tặng / gửi mã mới. Mã đã phát vẫn giữ, bật lại là dùng tiếp.',
      });
      if (!ok.isConfirmed) return;
    }
    setBusy(true);
    try {
      const d = await api({ action: 'switch', on: !on });
      onChange(d.on);
      toast(d.on ? 'Đã bật voucher' : 'Đã tắt voucher');
    } catch (e) { Swal.fire('Chưa đổi được', e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, background: on ? '#f0fdf4' : '#f8fafc', borderColor: on ? '#86efac' : '#e5e7eb' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 900, color: on ? '#15803d' : '#475569' }}>{on ? 'Voucher đang BẬT' : 'Voucher đang TẮT'}</div>
        <div style={{ fontSize: '0.78rem', color: '#475569', marginTop: 3, lineHeight: 1.4 }}>
          {on ? 'Khách tự nhập mã khi gọi món, nhân viên áp mã ở trang Bàn, vòng xoay ra được ô voucher (nếu đã thêm).'
            : 'Khách không thấy ô nhập mã, nhân viên không áp được mã, vòng xoay không ra voucher, không tặng / gửi mã mới. Mã đã phát vẫn giữ.'}
        </div>
      </div>
      <button role="switch" aria-checked={on} aria-label={on ? 'Tắt voucher' : 'Bật voucher'} disabled={busy} onClick={flip}
        style={{ width: 54, height: 30, flexShrink: 0, borderRadius: 999, border: 'none', padding: 3, cursor: 'pointer',
          background: on ? '#16a34a' : '#cbd5e1', opacity: busy ? 0.6 : 1, transition: 'background .15s' }}>
        <span style={{ display: 'block', width: 24, height: 24, borderRadius: '50%', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
          transform: on ? 'translateX(24px)' : 'none', transition: 'transform .15s' }} />
      </button>
    </div>
  );
}

function NextVisitTab({ vouchers, voucherOn }) {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { getView('config').then(d => setCfg(d.config)).catch(e => Swal.fire('Lỗi', e.message, 'error')); }, []);
  if (!cfg) return <div style={card}>Đang tải…</div>;
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  async function save() {
    setSaving(true);
    try {
      const d = await api({ action: 'config', config: { ...cfg, value: Number(cfg.value), max: Number(cfg.max) || 0, minBill: Number(cfg.minBill) || 0, useMinBill: Number(cfg.useMinBill) || 0, days: Number(cfg.days) } });
      setCfg(d.config); toast('Đã lưu');
    } catch (e) { Swal.fire('Chưa lưu được', e.message, 'error'); } finally { setSaving(false); }
  }
  const mine = vouchers.filter(v => v.source === 'next_visit');
  return (
    <div style={card}>
      <div style={{ fontWeight: 800, color: '#0f172a' }}>🔁 Hẹn lần sau</div>
      {voucherOn === false && (
        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#b45309', marginTop: 4 }}>
          Voucher đang tắt (công tắc đầu trang) — Hẹn lần sau chỉ chạy khi bật lại.
        </div>
      )}
      <div style={{ fontSize: '0.8rem', color: '#475569', margin: '4px 0 10px' }}>
        Nhân viên bấm thanh toán như thường. Bill đủ mức và có SĐT khách thì máy tự tặng 1 mã cho lần ghé tới, nhắn Zalo nếu khách đã nối Zalo, và hiện trên điện thoại khách.
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, color: cfg.enabled ? '#16a34a' : '#64748b', cursor: 'pointer' }}>
        <input type="checkbox" checked={cfg.enabled} onChange={e => set('enabled', e.target.checked)} style={{ width: 20, height: 20 }} />
        {cfg.enabled ? 'Đang bật' : 'Đang tắt'}
      </label>
      <label style={label}>Bill từ bao nhiêu thì được tặng (đ)</label>
      <input style={input} type="number" inputMode="numeric" value={cfg.minBill} onChange={e => set('minBill', e.target.value)} />
      <label style={label}>Tặng</label>
      <div style={{ display: 'flex', gap: 6 }}>
        {[['amount', 'Số tiền'], ['percent', '% bill']].map(([k, t]) => <button key={k} style={chip(cfg.type === k)} onClick={() => set('type', k)}>{t}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={label}>{cfg.type === 'percent' ? '% giảm' : 'Số tiền giảm (đ)'}</label>
          <input style={input} type="number" inputMode="numeric" value={cfg.value} onChange={e => set('value', e.target.value)} />
        </div>
        {cfg.type === 'percent' && (
          <div style={{ flex: 1 }}>
            <label style={label}>Giảm tối đa (đ)</label>
            <input style={input} type="number" inputMode="numeric" value={cfg.max} onChange={e => set('max', e.target.value)} />
          </div>
        )}
      </div>
      <label style={label}>Lần sau bill từ bao nhiêu mới dùng được (đ)</label>
      <input style={input} type="number" inputMode="numeric" value={cfg.useMinBill} onChange={e => set('useMinBill', e.target.value)} />
      <label style={label}>Hạn dùng (ngày, tính từ hôm sau)</label>
      <input style={input} type="number" inputMode="numeric" value={cfg.days} onChange={e => set('days', e.target.value)} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, fontSize: '0.84rem', color: '#374151', cursor: 'pointer' }}>
        <input type="checkbox" checked={cfg.repeat} onChange={e => set('repeat', e.target.checked)} style={{ width: 18, height: 18 }} />
        Khách dùng voucher mà bill vẫn đủ mức thì tặng tiếp mã mới
      </label>
      <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 8 }}>
        Mỗi SĐT chỉ giữ 1 mã "lần sau" còn hạn. Hạn dùng + bill tối thiểu này cũng áp cho ô "Voucher lần sau" của vòng xoay (Cài đặt → Vòng xoay).
      </div>
      <button style={{ ...btn('#16a34a'), width: '100%', marginTop: 12, padding: 12, opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}>{saving ? 'Đang lưu…' : 'Lưu cài đặt'}</button>
      <div style={{ fontSize: '0.78rem', color: '#475569', marginTop: 10 }}>
        120 ngày qua: đã tặng <b>{mine.length}</b> mã, khách quay lại dùng <b>{mine.filter(v => v.status === 'used').length}</b>.
      </div>
    </div>
  );
}

function ListTab({ vouchers, onChanged }) {
  const [state, setState] = useState('active');
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const q = norm(search).trim();
  const list = vouchers.filter(v => {
    const s = voucherState(v);
    if (state !== 'all' && !(state === 'active' ? (s === 'active' || s === 'not_yet') : s === state)) return false;
    if (source !== 'all' && v.source !== source) return false;
    return !q || norm(`${v.code} ${v.customer_name || ''} ${v.customer_phone || ''} ${v.batch_name || ''}`).includes(q);
  });
  return (
    <div style={card}>
      <input style={input} value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm mã, tên khách, SĐT" />
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '8px 0' }}>
        {[['active', 'Còn dùng'], ['used', 'Đã dùng'], ['expired', 'Hết hạn'], ['cancelled', 'Đã huỷ'], ['all', 'Tất cả']].map(([k, t]) => <button key={k} style={chip(state === k)} onClick={() => setState(k)}>{t}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
        {[['all', 'Mọi nguồn'], ...Object.entries(VOUCHER_SOURCES)].map(([k, t]) => <button key={k} style={chip(source === k)} onClick={() => setSource(k)}>{t}</button>)}
      </div>
      <div style={{ fontSize: '0.76rem', color: '#64748b', margin: '4px 0' }}>{list.length} mã</div>
      {list.slice(0, 200).map(v => <VoucherRow key={v.id} v={v} onChanged={onChanged} />)}
      {list.length > 200 && <div style={{ fontSize: '0.74rem', color: '#94a3b8', textAlign: 'center', padding: 8 }}>Đang hiện 200 mã đầu — gõ tìm để lọc</div>}
    </div>
  );
}

export default function VouchersPage() {
  const [tab, setTab] = useState('gift');
  const [vouchers, setVouchers] = useState([]);
  const [notInstalled, setNotInstalled] = useState(false);
  const [voucherOn, setVoucherOn] = useState(null);
  const load = useCallback(() => getView('list')
    .then(d => { setVouchers(d.vouchers || []); setNotInstalled(!!d.notInstalled); })
    .catch(e => Swal.fire('Lỗi', e.message, 'error')), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { getView('config').then(d => setVoucherOn(!!d.config?.on)).catch(() => setVoucherOn(false)); }, []);

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '12px 12px 40px' }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 900, color: '#0f172a', margin: '4px 0 10px' }}>🎟️ Voucher</h1>
      {notInstalled && (
        <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontWeight: 700 }}>
          Máy chủ chưa cài bảng voucher. Cần chạy cài đặt dữ liệu (migration vouchers.sql) trước khi dùng.
        </div>
      )}
      <VoucherSwitch on={voucherOn} onChange={setVoucherOn} />
      <Stats vouchers={vouchers} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {[['gift', '🎁 Tặng khách'], ['next', '🔁 Hẹn lần sau'], ['list', '📋 Danh sách']].map(([k, t]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...chip(tab === k), flex: 1, padding: '9px 4px', fontSize: '0.82rem', borderRadius: 10 }}>{t}</button>
        ))}
      </div>
      {tab === 'gift' && <GiftTab onCreated={load} />}
      {tab === 'next' && <NextVisitTab vouchers={vouchers} voucherOn={voucherOn} />}
      {tab === 'list' && <ListTab vouchers={vouchers} onChanged={load} />}
    </div>
  );
}
