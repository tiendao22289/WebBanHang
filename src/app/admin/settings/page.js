'use client';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';

const BANKS = [
  'Vietcombank', 'MB Bank', 'Techcombank', 'Agribank', 'Vietinbank',
  'BIDV', 'ACB', 'VPBank', 'TPBank', 'Sacombank', 'HDBank', 'OCB',
  'VIB', 'SHB', 'MSB', 'SeABank', 'BaoViet Bank', 'Khác',
];

const EMPTY_FORM = { account_name: '', bank_name: 'Vietcombank', account_number: '', daily_limit: '5000000', sort_order: '0' };

export default function SettingsPage() {
  const [accounts, setAccounts]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [editId, setEditId]       = useState(null);
  const [showForm, setShowForm]   = useState(false);
  const [saving, setSaving]       = useState(false);
  const [msg, setMsg]             = useState('');

  // Restaurant location
  const [locForm, setLocForm]       = useState({ lat: '', lng: '', radius: '300' });
  const [locSaving, setLocSaving]   = useState(false);
  const [locGetting, setLocGetting] = useState(false);

  useEffect(() => {
    fetchAccounts();
    fetchRestaurantLocation();
  }, []);

  async function fetchRestaurantLocation() {
    const { data } = await supabase
      .from('settings').select('value').eq('key', 'restaurant_location').maybeSingle();
    if (data?.value) {
      try {
        const { lat, lng, radius = 300 } = JSON.parse(data.value);
        setLocForm({ lat: String(lat), lng: String(lng), radius: String(radius) });
      } catch {}
    }
  }

  async function saveRestaurantLocation() {
    const lat = parseFloat(locForm.lat);
    const lng = parseFloat(locForm.lng);
    const radius = parseInt(locForm.radius) || 300;
    if (isNaN(lat) || isNaN(lng)) { flash('Vui lòng nhập đúng tọa độ!', true); return; }
    setLocSaving(true);
    await supabase.from('settings').upsert(
      { key: 'restaurant_location', value: JSON.stringify({ lat, lng, radius }) },
      { onConflict: 'key' }
    );
    setLocSaving(false);
    flash('Đã lưu vị trí nhà hàng!');
  }

  function getCurrentLocation() {
    if (!navigator.geolocation) { flash('Trình duyệt không hỗ trợ GPS', true); return; }
    setLocGetting(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocForm(p => ({
          ...p,
          lat: String(pos.coords.latitude.toFixed(6)),
          lng: String(pos.coords.longitude.toFixed(6)),
        }));
        setLocGetting(false);
      },
      () => { flash('Không lấy được vị trí. Hãy nhập thủ công.', true); setLocGetting(false); },
      { timeout: 10000 }
    );
  }

  async function fetchAccounts() {
    setLoading(true);
    const { data } = await supabase
      .from('bank_accounts')
      .select('*, bank_daily_totals(date, total_amount)')
      .order('sort_order');
    setAccounts(data || []);
    setLoading(false);
  }

  function flash(text, isErr = false) {
    setMsg(isErr ? '❌ ' + text : '✅ ' + text);
    setTimeout(() => setMsg(''), 3000);
  }

  function startAdd() {
    setForm({ ...EMPTY_FORM, sort_order: String((accounts.length + 1) * 10) });
    setEditId(null);
    setShowForm(true);
  }

  function startEdit(acc) {
    setForm({
      account_name:   acc.account_name,
      bank_name:      acc.bank_name,
      account_number: acc.account_number,
      daily_limit:    String(acc.daily_limit),
      sort_order:     String(acc.sort_order),
    });
    setEditId(acc.id);
    setShowForm(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!form.account_name.trim() || !form.account_number.trim()) {
      flash('Vui lòng điền đủ thông tin!', true);
      return;
    }
    setSaving(true);
    const payload = {
      account_name:   form.account_name.trim(),
      bank_name:      form.bank_name,
      account_number: form.account_number.trim(),
      daily_limit:    parseInt(form.daily_limit) || 5000000,
      sort_order:     parseInt(form.sort_order)  || 0,
    };
    if (editId) {
      const { error } = await supabase.from('bank_accounts').update(payload).eq('id', editId);
      if (error) flash(error.message, true);
      else { flash('Đã cập nhật tài khoản!'); setShowForm(false); }
    } else {
      const { error } = await supabase.from('bank_accounts').insert({ ...payload, is_active: true });
      if (error) flash(error.message, true);
      else { flash('Đã thêm tài khoản!'); setShowForm(false); }
    }
    setSaving(false);
    fetchAccounts();
  }

  async function toggleActive(acc) {
    await supabase.from('bank_accounts').update({ is_active: !acc.is_active }).eq('id', acc.id);
    fetchAccounts();
  }

  async function deleteAccount(acc) {
    if (!window.confirm(`Xoá tài khoản "${acc.account_name}" (${acc.bank_name})? Không thể hoàn tác!`)) return;
    await supabase.from('bank_accounts').delete().eq('id', acc.id);
    flash('Đã xoá tài khoản.');
    fetchAccounts();
  }

  function todayTotal(acc) {
    const today = new Date().toISOString().slice(0, 10);
    const row = acc.bank_daily_totals?.find(r => r.date === today);
    return row?.total_amount || 0;
  }

  const fmt = n => new Intl.NumberFormat('vi-VN').format(n);

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 16px', fontFamily: "'DM Sans', sans-serif" }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 800, color: '#0f172a' }}>⚙️ Cài đặt</h1>
          <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748b' }}>Quản lý tài khoản ngân hàng nhận thanh toán QR</p>
        </div>
        <button onClick={startAdd}
          style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: 10, padding: '9px 16px', fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
          + Thêm tài khoản
        </button>
      </div>

      {/* Flash */}
      {msg && (
        <div style={{ background: msg.startsWith('❌') ? '#fff7f7' : '#f0fdf4', border: `1px solid ${msg.startsWith('❌') ? '#fecaca' : '#bbf7d0'}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: '0.85rem', fontWeight: 600, color: msg.startsWith('❌') ? '#dc2626' : '#15803d' }}>
          {msg}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div style={{ background: 'white', border: '2px solid #bfdbfe', borderRadius: 14, padding: '18px 16px', marginBottom: 20, boxShadow: '0 4px 20px rgba(37,99,235,0.08)' }}>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#1d4ed8', marginBottom: 14 }}>
            {editId ? '✏️ Chỉnh sửa tài khoản' : '➕ Thêm tài khoản mới'}
          </div>
          <form onSubmit={handleSave} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569' }}>Ngân hàng *</label>
              <select value={form.bank_name} onChange={e => setForm(p => ({ ...p, bank_name: e.target.value }))}
                style={{ padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.88rem', background: 'white' }}>
                {BANKS.map(b => <option key={b}>{b}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569' }}>Số tài khoản *</label>
              <input value={form.account_number} onChange={e => setForm(p => ({ ...p, account_number: e.target.value }))}
                placeholder="vd: 1234567890" inputMode="numeric"
                style={{ padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.88rem' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: '1 / -1' }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569' }}>Tên chủ tài khoản *</label>
              <input value={form.account_name} onChange={e => setForm(p => ({ ...p, account_name: e.target.value }))}
                placeholder="vd: NGUYEN VAN A"
                style={{ padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.88rem' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569' }}>Hạn mức / ngày (VND)</label>
              <input type="number" min="0" step="100000" value={form.daily_limit} onChange={e => setForm(p => ({ ...p, daily_limit: e.target.value }))}
                style={{ padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.88rem' }} />
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Tự chuyển tài khoản khi đạt hạn mức</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#475569' }}>Thứ tự ưu tiên</label>
              <input type="number" min="0" value={form.sort_order} onChange={e => setForm(p => ({ ...p, sort_order: e.target.value }))}
                style={{ padding: '9px 12px', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.88rem' }} />
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>Số nhỏ = ưu tiên dùng trước</span>
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" onClick={() => setShowForm(false)}
                style={{ padding: '9px 18px', border: '1.5px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', background: 'white', fontWeight: 600, fontSize: '0.85rem', color: '#374151' }}>
                Huỷ
              </button>
              <button type="submit" disabled={saving}
                style={{ padding: '9px 20px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '0.88rem', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Đang lưu...' : '💾 Lưu'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Account list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: 48 }}>Đang tải...</div>
        ) : accounts.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: 48, background: 'white', borderRadius: 14, border: '1.5px dashed #e2e8f0' }}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>🏦</div>
            <div style={{ fontWeight: 600 }}>Chưa có tài khoản ngân hàng nào</div>
            <div style={{ fontSize: '0.82rem', marginTop: 4 }}>Nhấn "Thêm tài khoản" để cấu hình QR thanh toán</div>
          </div>
        ) : accounts.map((acc, idx) => {
          const today     = todayTotal(acc);
          const pct       = Math.min(Math.round((today / acc.daily_limit) * 100), 100);
          const remaining = Math.max(0, acc.daily_limit - today);
          const isFull    = today >= acc.daily_limit;
          return (
            <div key={acc.id} style={{
              background: 'white', border: `1.5px solid ${acc.is_active ? '#bfdbfe' : '#e2e8f0'}`,
              borderRadius: 14, padding: '14px 16px',
              opacity: acc.is_active ? 1 : 0.55,
              boxShadow: acc.is_active ? '0 2px 10px rgba(37,99,235,0.07)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ minWidth: 44, height: 44, background: acc.is_active ? '#eff6ff' : '#f1f5f9', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.4rem' }}>🏦</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 800, fontSize: '0.95rem', color: '#0f172a' }}>{acc.account_name}</span>
                    <span style={{ fontSize: '0.72rem', background: acc.is_active ? '#dbeafe' : '#f1f5f9', color: acc.is_active ? '#1d4ed8' : '#94a3b8', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>
                      {acc.is_active ? `#${idx + 1} Đang dùng` : 'Đã tắt'}
                    </span>
                    {isFull && acc.is_active && <span style={{ fontSize: '0.72rem', background: '#fef9c3', color: '#92400e', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>⚠️ Đầy hạn mức</span>}
                  </div>
                  <div style={{ fontSize: '0.82rem', color: '#64748b', marginTop: 2 }}>
                    {acc.bank_name} · <span style={{ letterSpacing: 1, fontWeight: 600, color: '#374151' }}>{acc.account_number}</span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#94a3b8', marginBottom: 4 }}>
                      <span>Hôm nay: <strong style={{ color: '#0f172a' }}>{fmt(today)}đ</strong></span>
                      <span>Còn lại: <strong style={{ color: isFull ? '#f59e0b' : '#16a34a' }}>{fmt(remaining)}đ</strong> / {fmt(acc.daily_limit)}đ</span>
                    </div>
                    <div style={{ height: 5, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#f59e0b' : pct > 80 ? '#f97316' : '#2563eb', borderRadius: 3, transition: 'width 0.4s' }} />
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => startEdit(acc)} style={{ padding: '5px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color: '#374151' }}>✏️ Sửa</button>
                  <button onClick={() => toggleActive(acc)} style={{ padding: '5px 12px', background: acc.is_active ? '#fef9c3' : '#f0fdf4', border: `1px solid ${acc.is_active ? '#fde68a' : '#bbf7d0'}`, borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color: acc.is_active ? '#92400e' : '#15803d' }}>
                    {acc.is_active ? '⏸ Tắt' : '▶ Bật'}
                  </button>
                  <button onClick={() => deleteAccount(acc)} style={{ padding: '5px 12px', background: '#fff7f7', border: '1px solid #fecaca', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color: '#dc2626' }}>🗑 Xoá</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Info note */}
      <div style={{ marginTop: 20, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 16px', fontSize: '0.78rem', color: '#64748b' }}>
        <strong style={{ color: '#0f172a' }}>💡 Cách hoạt động:</strong> Khi thanh toán chuyển khoản, hệ thống tự chọn tài khoản có thứ tự ưu tiên nhỏ nhất mà chưa đạt hạn mức ngày.
      </div>

      {/* ── Restaurant Location ── */}
      <div style={{ marginTop: 28, background: 'white', border: '1.5px solid #d1fae5', borderRadius: 14, padding: '18px 16px', boxShadow: '0 2px 10px rgba(16,185,129,0.07)' }}>
        <div style={{ fontWeight: 800, fontSize: '1rem', color: '#065f46', marginBottom: 4 }}>📍 Vị trí nhà hàng</div>
        <p style={{ margin: '0 0 14px', fontSize: '0.8rem', color: '#6b7280' }}>
          Dùng để xác minh khách hàng có đang ở nhà hàng khi đặt món. Bấm <b>Lấy vị trí hiện tại</b> hoặc nhập thủ công rồi nhấn Lưu.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151' }}>Vĩ độ (Lat)</label>
            <input value={locForm.lat} onChange={e => setLocForm(p => ({ ...p, lat: e.target.value }))}
              placeholder="vd: 10.776889"
              style={{ padding: '8px 10px', border: '1.5px solid #d1fae5', borderRadius: 8, fontSize: '0.85rem' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151' }}>Kinh độ (Lng)</label>
            <input value={locForm.lng} onChange={e => setLocForm(p => ({ ...p, lng: e.target.value }))}
              placeholder="vd: 106.700981"
              style={{ padding: '8px 10px', border: '1.5px solid #d1fae5', borderRadius: 8, fontSize: '0.85rem' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151' }}>Phạm vi (mét)</label>
            <input type="number" min="50" value={locForm.radius} onChange={e => setLocForm(p => ({ ...p, radius: e.target.value }))}
              style={{ padding: '8px 10px', border: '1.5px solid #d1fae5', borderRadius: 8, fontSize: '0.85rem' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={getCurrentLocation} disabled={locGetting}
            style={{ padding: '8px 14px', background: '#ecfdf5', border: '1.5px solid #6ee7b7', borderRadius: 8, cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700, color: '#065f46', opacity: locGetting ? 0.7 : 1 }}>
            {locGetting ? '⏳ Đang lấy...' : '📡 Lấy vị trí hiện tại'}
          </button>
          <button onClick={saveRestaurantLocation} disabled={locSaving}
            style={{ padding: '8px 16px', background: '#10b981', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700, opacity: locSaving ? 0.7 : 1 }}>
            {locSaving ? 'Đang lưu...' : '💾 Lưu vị trí'}
          </button>
        </div>
      </div>
    </div>
  );
}
