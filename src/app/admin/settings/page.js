'use client';
import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { getActiveAccount } from '@/lib/bankAccount';
import { REWARD_CHANNELS, ALL_SETTING_KEYS, calcReviewDiscount } from '@/lib/reviewReward';
import { LUCKY_SETTING_KEYS, parseLuckyConfig, PRIZE_TYPES, prizeChance, totalWeight, isGiftPrizeType } from '@/lib/luckyWheel';

const BANKS = [
  'Vietcombank', 'MB Bank', 'Techcombank', 'Agribank', 'Vietinbank',
  'BIDV', 'ACB', 'VPBank', 'TPBank', 'Sacombank', 'HDBank', 'OCB',
  'VIB', 'SHB', 'MSB', 'SeABank', 'BaoViet Bank', 'Khác',
];

const EMPTY_FORM = { account_name: '', bank_name: 'Vietcombank', account_number: '', daily_limit: '5000000', sort_order: '0', is_visible: false };

export default function SettingsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [formContext, setFormContext] = useState('inside');
  const [showSecretModal, setShowSecretModal] = useState(false);
  const [secretAccounts, setSecretAccounts] = useState([]);

  // Restaurant location
  const [locForm, setLocForm] = useState({ lat: '', lng: '', radius: '300' });
  const [locSaving, setLocSaving] = useState(false);
  const [locGetting, setLocGetting] = useState(false);

  // Ưu đãi mạng xã hội (Google / TikTok / Facebook)
  const CHANNEL_DEFAULTS = { enabled: false, url: '', percent: '5', max: '50000', minBill: '100000', cooldown: '30', wait: '20' };
  const [channelForms, setChannelForms] = useState(
    () => Object.fromEntries(REWARD_CHANNELS.map(c => [c.key, { ...CHANNEL_DEFAULTS }]))
  );
  const [channelSaving, setChannelSaving] = useState(null); // key của kênh đang lưu

  const setChannelField = (key, field, value) =>
    setChannelForms(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  // Vòng xoay may mắn
  const WHEEL_DEFAULTS = { enabled: false, minBill: '0', max: '50000', cooldown: '1', requireFollow: true, autoNudge: true };
  const [wheelCfg, setWheelCfg] = useState({ ...WHEEL_DEFAULTS });
  const [wheelCfgSaving, setWheelCfgSaving] = useState(false);
  const [prizes, setPrizes] = useState([]);
  const [prizeSaving, setPrizeSaving] = useState(false);
  // Danh sách "nước tặng" — món khách được chọn khi quay trúng quà gift_drink
  const [wheelMenuItems, setWheelMenuItems] = useState([]);
  const [wheelDrinkIds, setWheelDrinkIds] = useState([]);
  const [wheelDrinkSearch, setWheelDrinkSearch] = useState('');
  const [wheelDrinkSaving, setWheelDrinkSaving] = useState(false);
  const [showDrinkPicker, setShowDrinkPicker] = useState(false);

  const setWheelField = (field, value) => setWheelCfg(prev => ({ ...prev, [field]: value }));
  const setPrizeField = (id, field, value) =>
    setPrizes(prev => prev.map(p => (p.id === id ? { ...p, [field]: value, _dirty: true } : p)));

  // QR Download
  const [downloadingQR, setDownloadingQR] = useState(false);
  const [qrProgress, setQrProgress] = useState('');
  const [previewQR, setPreviewQR] = useState(null);

  // Printer management
  const EMPTY_PRINTER = { name: '', target: 'cashier', type: 'thermal', interface: '', sort_order: '0', note: '', is_default: false, is_bill_printer: false };
  const [printers, setPrinters] = useState([]);
  const [categories, setCategories] = useState([]);
  const [printerForm, setPrinterForm] = useState(EMPTY_PRINTER);
  const [printerCategoryIds, setPrinterCategoryIds] = useState([]); // selected category ids
  const [printerEditId, setPrinterEditId] = useState(null);
  const [showPrinterForm, setShowPrinterForm] = useState(false);
  const [printerSaving, setPrinterSaving] = useState(false);

  useEffect(() => {
    fetchAccounts();
    fetchRestaurantLocation();
    fetchRewardChannelConfigs();
    fetchWheelConfig();
    fetchPrizes();
    fetchWheelDrinkItems();
    fetchPrinters();
    fetchCategories();
  }, []);

  async function fetchRestaurantLocation() {
    const { data, error } = await supabase
      .from('settings').select('value').eq('key', 'restaurant_location').maybeSingle();
    if (error) {
      console.warn('settings table error:', error.message);
      return;
    }
    if (data?.value) {
      try {
        const { lat, lng, radius = 300 } = JSON.parse(data.value);
        setLocForm({ lat: String(lat), lng: String(lng), radius: String(radius) });
      } catch { }
    }
  }

  async function saveRestaurantLocation() {
    const lat = parseFloat(locForm.lat);
    const lng = parseFloat(locForm.lng);
    const radius = parseInt(locForm.radius) || 300;
    if (isNaN(lat) || isNaN(lng)) { flash('Vui lòng nhập đúng tọa độ!', true); return; }
    setLocSaving(true);
    // Try upsert first; if settings table doesn't have unique on key, fallback to delete+insert
    const val = JSON.stringify({ lat, lng, radius });
    const { error: upsertErr } = await supabase.from('settings').upsert(
      { key: 'restaurant_location', value: val },
      { onConflict: 'key' }
    );
    if (upsertErr) {
      // Fallback: delete then insert
      await supabase.from('settings').delete().eq('key', 'restaurant_location');
      const { error: insertErr } = await supabase.from('settings').insert({ key: 'restaurant_location', value: val });
      if (insertErr) { flash('Lỗi: ' + insertErr.message, true); setLocSaving(false); return; }
    }
    setLocSaving(false);
    flash('Đã lưu vị trí nhà hàng!');
    // Re-fetch to confirm saved
    fetchRestaurantLocation();
  }

  async function fetchWheelConfig() {
    const { data } = await supabase.from('settings').select('key, value').in('key', LUCKY_SETTING_KEYS);
    const cfg = parseLuckyConfig(data);
    setWheelCfg({
      enabled: cfg.enabled,
      minBill: String(cfg.minBill),
      max: String(cfg.max),
      cooldown: String(cfg.cooldownDays),
      requireFollow: cfg.requireFollow,
      autoNudge: cfg.autoNudge,
    });
  }

  async function fetchPrizes() {
    const { data, error } = await supabase
      .from('lucky_prizes').select('*').order('sort_order', { ascending: true });
    if (error) { console.warn('lucky_prizes:', error.message); return; }
    setPrizes((data || []).map(r => ({ ...r, value: String(r.value ?? 0), weight: String(r.weight ?? 0) })));
  }

  /** Danh sách món để tick chọn "nước tặng" + số đang được chọn (setting riêng, không đụng is_gift_item). */
  async function fetchWheelDrinkItems() {
    const [{ data: items }, { data: setting }] = await Promise.all([
      supabase.from('menu_items').select('id, name, price, image_url').eq('is_available', true).order('name'),
      supabase.from('settings').select('value').eq('key', 'lucky_wheel_drink_item_ids').maybeSingle(),
    ]);
    setWheelMenuItems(items || []);
    try {
      const ids = JSON.parse(setting?.value || '[]');
      setWheelDrinkIds(Array.isArray(ids) ? ids : []);
    } catch { setWheelDrinkIds([]); }
  }

  function toggleWheelDrinkId(id) {
    setWheelDrinkIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function saveWheelDrinkItems() {
    setWheelDrinkSaving(true);
    try {
      await putSetting('lucky_wheel_drink_item_ids', JSON.stringify(wheelDrinkIds));
      flash('Đã lưu danh sách nước tặng!');
    } catch (err) {
      flash('Lỗi: ' + err.message, true);
    }
    setWheelDrinkSaving(false);
  }

  /** Ghi 1 khoá vào bảng settings (kèm fallback như các chỗ khác). */
  async function putSetting(key, value) {
    const { error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'key' });
    if (error) {
      await supabase.from('settings').delete().eq('key', key);
      const { error: insErr } = await supabase.from('settings').insert({ key, value });
      if (insErr) throw insErr;
    }
  }

  async function saveWheelConfig() {
    setWheelCfgSaving(true);
    try {
      await putSetting('lucky_wheel_enabled', String(!!wheelCfg.enabled));
      await putSetting('lucky_wheel_min_bill', String(Number(wheelCfg.minBill) || 0));
      await putSetting('lucky_wheel_max', String(Number(wheelCfg.max) || 0));
      await putSetting('lucky_wheel_cooldown_days', String(Number(wheelCfg.cooldown) || 0));
      await putSetting('lucky_wheel_require_follow', String(!!wheelCfg.requireFollow));
      await putSetting('lucky_wheel_auto_nudge', String(!!wheelCfg.autoNudge));
      flash('Đã lưu cấu hình vòng xoay!');
    } catch (err) {
      flash('Lỗi: ' + err.message, true);
    }
    setWheelCfgSaving(false);
  }

  // Ghi qua /api/admin/lucky-prizes (server, SERVICE_ROLE_KEY) — không ghi
  // thẳng bằng anon key nữa, vì đó là khoá public ai cũng lấy được từ JS gửi
  // cho khách, để RLS cho anon ghi tự do là lỗ hổng cho phép ai cũng tự đổi
  // tỉ lệ/giá trị quà mà không cần vào được trang admin.
  async function addPrize() {
    try {
      const res = await fetch('/api/admin/lucky-prizes', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Lỗi không xác định');
      setPrizes(prev => [...prev, { ...json.prize, value: String(json.prize.value), weight: String(json.prize.weight) }]);
      flash('Đã thêm phần quà — sửa xong nhớ bật lên nhé!');
    } catch (err) {
      flash('Lỗi: ' + err.message, true);
    }
  }

  async function savePrize(prize) {
    const label = (prize.label || '').trim();
    if (!label) { flash('Phần quà cần có tên', true); return; }
    const weight = Number(prize.weight);
    if (!(weight >= 0)) { flash('Tỉ lệ phải là số không âm', true); return; }
    if (prize.type === 'percent') {
      const v = Number(prize.value);
      if (!(v > 0 && v <= 100)) { flash('% giảm phải trong khoảng 1 – 100', true); return; }
    }
    if (isGiftPrizeType(prize.type)) {
      const v = Number(prize.value);
      if (!(v >= 1)) { flash('Số lượng tặng phải từ 1 trở lên', true); return; }
    }

    setPrizeSaving(true);
    try {
      const res = await fetch('/api/admin/lucky-prizes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...prize, label }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Lỗi không xác định');
      setPrizes(prev => prev.map(p => (p.id === prize.id ? { ...p, _dirty: false } : p)));
      flash('Đã lưu phần quà!');
    } catch (err) {
      flash('Lỗi: ' + err.message, true);
    }
    setPrizeSaving(false);
  }

  async function deletePrize(prize) {
    if (!window.confirm(`Xoá phần quà "${prize.label}"?`)) return;
    try {
      const res = await fetch(`/api/admin/lucky-prizes?id=${encodeURIComponent(prize.id)}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Lỗi không xác định');
      setPrizes(prev => prev.filter(p => p.id !== prize.id));
      flash('Đã xoá phần quà.');
    } catch (err) {
      flash('Lỗi: ' + err.message, true);
    }
  }

  async function fetchRewardChannelConfigs() {
    const { data, error } = await supabase.from('settings').select('key, value').in('key', ALL_SETTING_KEYS);
    if (error) { console.warn('reward channel settings error:', error.message); return; }
    const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    setChannelForms(
      Object.fromEntries(REWARD_CHANNELS.map(c => {
        const g = (f) => map[`${c.prefix}_${f}`];
        return [c.key, {
          enabled: g('enabled') === 'true',
          url: g('url') || '',
          percent: g('percent') ?? '5',
          max: g('max') ?? '50000',
          minBill: g('min_bill') ?? '100000',
          cooldown: g('cooldown_days') ?? '30',
          wait: g('wait_seconds') ?? '20',
        }];
      }))
    );
  }

  async function saveRewardChannel(ch) {
    const form = channelForms[ch.key];
    const percent = Number(form.percent);
    if (!(percent > 0 && percent <= 100)) { flash('% giảm phải trong khoảng 1 – 100', true); return; }
    if (form.enabled && !form.url.trim()) { flash(`Cần nhập link ${ch.short} trước khi bật`, true); return; }

    setChannelSaving(ch.key);
    const pairs = [
      [`${ch.prefix}_enabled`, String(form.enabled)],
      [`${ch.prefix}_url`, form.url.trim()],
      [`${ch.prefix}_percent`, String(percent)],
      [`${ch.prefix}_max`, String(Number(form.max) || 0)],
      [`${ch.prefix}_min_bill`, String(Number(form.minBill) || 0)],
      [`${ch.prefix}_cooldown_days`, String(Number(form.cooldown) || 0)],
      [`${ch.prefix}_wait_seconds`, String(Number(form.wait) || 0)],
    ];
    for (const [key, value] of pairs) {
      const { error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'key' });
      if (error) {
        // Fallback giống các chỗ khác: settings có thể chưa có unique trên key
        await supabase.from('settings').delete().eq('key', key);
        const { error: insErr } = await supabase.from('settings').insert({ key, value });
        if (insErr) { setChannelSaving(null); flash('Lỗi: ' + insErr.message, true); return; }
      }
    }
    setChannelSaving(null);
    flash(`Đã lưu cấu hình ${ch.name}!`);
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

  // ── Printer CRUD ────────────────────────────────────────────────
  async function fetchPrinters() {
    // Fetch 2 bảng riêng rồi join trong JS để tránh lỗi Supabase FK embed
    const [{ data: printersData }, { data: catData }] = await Promise.all([
      supabase
        .from('printers')
        .select('id, name, target, type, interface, is_active, is_default, is_bill_printer, sort_order, note')
        .order('sort_order'),
      supabase
        .from('printer_categories')
        .select('printer_id, category_id'),
    ]);

    // Group categories theo printer_id
    const catMap = {};
    for (const pc of (catData || [])) {
      if (!catMap[pc.printer_id]) catMap[pc.printer_id] = [];
      catMap[pc.printer_id].push({ category_id: pc.category_id });
    }

    // Gắn printer_categories vào từng printer
    const merged = (printersData || []).map(p => ({
      ...p,
      printer_categories: catMap[p.id] || [],
    }));

    setPrinters(merged);
  }

  async function fetchCategories() {
    const { data } = await supabase.from('categories').select('id, name').order('sort_order');
    setCategories(data || []);
  }

  function startAddPrinter() {
    setPrinterForm({ ...EMPTY_PRINTER, sort_order: String((printers.length + 1) * 10) });
    setPrinterCategoryIds([]);
    setPrinterEditId(null);
    setShowPrinterForm(true);
  }

  function startEditPrinter(p) {
    setPrinterForm({ name: p.name, target: p.target || 'cashier', type: p.type, interface: p.interface, sort_order: String(p.sort_order), note: p.note || '', is_default: p.is_default || false, is_bill_printer: p.is_bill_printer || false });
    setPrinterCategoryIds((p.printer_categories || []).map(pc => pc.category_id));
    setPrinterEditId(p.id);
    setShowPrinterForm(true);
  }

  function toggleCategorySelection(catId) {
    setPrinterCategoryIds(prev =>
      prev.includes(catId) ? prev.filter(id => id !== catId) : [...prev, catId]
    );
  }

  async function handleSavePrinter(e) {
    e.preventDefault();
    if (!printerForm.name.trim() || !printerForm.interface.trim()) { flash('Vui lòng điền tên và địa chỉ máy in!', true); return; }
    setPrinterSaving(true);
    const payload = {
      name: printerForm.name.trim(),
      target: printerForm.target || 'cashier',
      type: printerForm.type,
      interface: printerForm.interface.trim(),
      sort_order: parseInt(printerForm.sort_order) || 0,
      note: printerForm.note.trim() || null,
      is_default: printerForm.is_default,
      is_bill_printer: printerForm.is_bill_printer || false,
      updated_at: new Date().toISOString(),
    };
    let printerId = printerEditId;
    let savedOk = false;
    if (printerEditId) {
      const { error } = await supabase.from('printers').update(payload).eq('id', printerEditId);
      if (error) { flash(error.message, true); setPrinterSaving(false); return; }
      savedOk = true;
    } else {
      const { data, error } = await supabase.from('printers').insert({ ...payload, is_active: true }).select('id').single();
      if (error) { flash(error.message, true); setPrinterSaving(false); return; }
      printerId = data.id;
      savedOk = true;
    }
    if (savedOk && printerId) {
      // Đảm bảo chỉ có 1 máy in được làm máy in Bill
      if (payload.is_bill_printer) {
        await supabase.from('printers').update({ is_bill_printer: false }).neq('id', printerId);
      }

      // Lưu lại printer_categories: xóa cũ rồi insert mới
      await supabase.from('printer_categories').delete().eq('printer_id', printerId);
      if (printerCategoryIds.length > 0) {
        await supabase.from('printer_categories').insert(
          printerCategoryIds.map(catId => ({ printer_id: printerId, category_id: catId }))
        );
      }
      flash(printerEditId ? 'Đã cập nhật máy in!' : 'Đã thêm máy in!');
      setShowPrinterForm(false);
    }
    setPrinterSaving(false);
    fetchPrinters();
  }

  async function togglePrinter(p) {
    await supabase.from('printers').update({ is_active: !p.is_active, updated_at: new Date().toISOString() }).eq('id', p.id);
    fetchPrinters();
  }

  async function deletePrinter(p) {
    if (!window.confirm(`Xoá máy in "${p.name}"? Không thể hoàn tác!`)) return;
    await supabase.from('printers').delete().eq('id', p.id);
    flash('Đã xoá máy in.');
    fetchPrinters();
  }

  async function generateQRCanvasBase64(tb) {
    const QRCode = (await import('qrcode')).default;
    const url = `${window.location.origin}/order?table=${tb.id}`;
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 1650;
    const ctx = canvas.getContext('2d');

    // Nền trắng
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Generate QR
    const qrDataUrl = await QRCode.toDataURL(url, { width: 800, margin: 1 });
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Vẽ Thông tin Wi-Fi (Top) — font x1.5 (65 → 98px)
        ctx.font = '700 98px sans-serif';
        ctx.fillStyle = '#1e3a8a';
        ctx.fillText('Wifi: Ốc Bảo Khang', 500, 85);
        ctx.fillText('MK : baokhang2018', 500, 195);

        // QR code — đẩy xuống thêm cho WiFi text lớn hơn
        ctx.drawImage(img, 100, 270, 800, 800);

        // Vẽ Tên bàn (với chữ B + Số, hoặc MANG VỀ)
        let displayText = '';
        if (tb.table_number === 0 || tb.table_type === 'takeaway' || (tb.table_name && String(tb.table_name).toLowerCase().includes('mang về'))) {
          displayText = 'MANG VỀ';
          ctx.font = '900 200px sans-serif';
        } else {
          const namePart = (tb.table_number !== null && tb.table_number !== undefined) ? tb.table_number : (tb.table_name || 'Khác');
          displayText = `B${namePart}`;
          ctx.font = '900 500px sans-serif';
        }
        ctx.fillStyle = '#ef4444';

        ctx.save();
        ctx.translate(500, 1330);
        if (displayText !== 'MANG VỀ') ctx.scale(0.95, 1.15);
        ctx.fillText(displayText, 0, 0);
        ctx.restore();

        // Dòng phụ ở dưới cùng
        ctx.font = '700 90px sans-serif';
        ctx.fillStyle = '#0c4a6e';
        ctx.fillText('Quét mã để gọi món', 500, 1580);

        // Xuất JPEG (chất lượng 94%)
        resolve(canvas.toDataURL('image/jpeg', 0.94));
      };
      img.onerror = reject;
      img.src = qrDataUrl;
    });
  }

  async function downloadAllQRs() {
    setDownloadingQR(true);
    setQrProgress('Đang tải danh sách bàn...');
    try {
      const JSZip = (await import('jszip')).default;

      const { data: allTables, error: tErr } = await supabase
        .from('tables')
        .select('id, table_number, table_name')
        .order('table_number');
      if (tErr) throw tErr;

      const zip = new JSZip();
      const folder = zip.folder('QR_Cac_Ban');

      for (let i = 0; i < allTables.length; i++) {
        const tb = allTables[i];
        const label = tb.table_number !== null && tb.table_number !== undefined
          ? `B${tb.table_number}`
          : (tb.table_name || `Ban_${i + 1}`);
        setQrProgress(`Đang tạo ${label}... (${i + 1}/${allTables.length})`);

        const dataUrl = await generateQRCanvasBase64(tb);
        // Bỏ phần header "data:image/jpeg;base64,"
        const base64 = dataUrl.split(',')[1];
        folder.file(`QR_${label}.jpg`, base64, { base64: true });
      }

      setQrProgress('Đang nén file ZIP...');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'QR_Tat_Ca_Cac_Ban.zip';
      a.click();
      URL.revokeObjectURL(url);

      flash(`Đã xuất ${allTables.length} file JPG trong 1 file ZIP!`);
    } catch (err) {
      console.error(err);
      flash('❌ Xuất JPG thất bại: ' + err.message, true);
    } finally {
      setDownloadingQR(false);
      setQrProgress('');
    }
  }

  async function fetchSecretAccounts() {
    const { data } = await supabase
      .from('bank_accounts')
      .select('*, bank_daily_totals(date, total_amount)')
      .order('sort_order');
    setSecretAccounts(data || []);
  }

  async function fetchAccounts() {
    setLoading(true);
    const { data } = await supabase
      .from('bank_accounts')
      .select('*, bank_daily_totals(date, total_amount)')
      .eq('is_visible', true)
      .order('sort_order');
    setAccounts(data || []);
    fetchSecretAccounts();
    setLoading(false);
  }

  function flash(text, isErr = false) {
    setMsg(isErr ? '❌ ' + text : '✅ ' + text);
    setTimeout(() => setMsg(''), 3000);
  }

  function startAdd() {
    setForm({ ...EMPTY_FORM, sort_order: String((secretAccounts.length + 1) * 10) });
    setEditId(null);
    setFormContext('inside');
    setShowForm(true);
  }

  function startEdit(acc, ctx = 'inside') {
    setForm({
      account_name: acc.account_name,
      bank_name: acc.bank_name,
      account_number: acc.account_number,
      daily_limit: String(acc.daily_limit),
      sort_order: String(acc.sort_order),
      is_visible: acc.is_visible || false,
    });
    setEditId(acc.id);
    setFormContext(ctx);
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
      account_name: form.account_name.trim(),
      bank_name: form.bank_name,
      account_number: form.account_number.trim(),
      daily_limit: parseInt(form.daily_limit) || 5000000,
      sort_order: parseInt(form.sort_order) || 0,
      is_visible: form.is_visible,
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
    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
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
          <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#64748b' }}>
            Quản lý tài khoản ngân hàng nhận thanh toán <span onClick={() => setShowSecretModal(true)} style={{ cursor: 'pointer' }}>QR</span>
          </p>
        </div>
        <div style={{ width: 44 }}></div>
      </div>

      {/* Flash */}
      {msg && (
        <div style={{ background: msg.startsWith('❌') ? '#fff7f7' : '#f0fdf4', border: `1px solid ${msg.startsWith('❌') ? '#fecaca' : '#bbf7d0'}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: '0.85rem', fontWeight: 600, color: msg.startsWith('❌') ? '#dc2626' : '#15803d' }}>
          {msg}
        </div>
      )}

      {/* Add/Edit form */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 999999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(3px)' }}>
          <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 500, padding: 24, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
            <div style={{ fontWeight: 800, fontSize: '1.2rem', color: '#1d4ed8', marginBottom: 14 }}>
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

              {formContext !== 'outside' && (
                <>
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
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, gridColumn: '1 / -1', marginTop: 4 }}>
                <input type="checkbox" id="cb_is_visible" checked={form.is_visible} onChange={e => setForm(p => ({ ...p, is_visible: e.target.checked }))} style={{ width: 16, height: 16, accentColor: '#2563eb', cursor: 'pointer' }} />
                <label htmlFor="cb_is_visible" style={{ fontSize: '0.82rem', fontWeight: 600, color: '#334155', cursor: 'pointer' }}>Hiển thị</label>
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
          </div></div>
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
          const today = todayTotal(acc);
          const pct = Math.min(Math.round((today / acc.daily_limit) * 100), 100);
          const remaining = Math.max(0, acc.daily_limit - today);
          const isFull = today >= acc.daily_limit;
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
                  </div>
                  <div style={{ fontSize: '0.82rem', color: '#64748b', marginTop: 2 }}>
                    {acc.bank_name} · <span style={{ letterSpacing: 1, fontWeight: 600, color: '#374151' }}>{acc.account_number}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => startEdit(acc, 'outside')} style={{ padding: '5px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color: '#374151' }}>✏️ Sửa</button>
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
      {/* ── Vòng xoay may mắn ── */}
      <div style={{ marginTop: 28 }}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', color: '#0f172a', marginBottom: 2 }}>
          🎰 Vòng xoay may mắn
        </div>
        <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: '#6b7280' }}>
          Khách điền tên + SĐT rồi quay, <b>chắc chắn có quà</b>. Mỗi bàn quay 1 lượt
          mỗi lượt khách. Quà % tự trừ vào bill; quà là món được ghi thành dòng tặng
          để nhân viên mang ra.
        </p>

        {/* Cấu hình chung */}
        <div style={{ background: 'white', border: '1.5px solid #fed7aa', borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: '0 2px 10px rgba(15,23,42,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: '0.98rem', color: '#b45309' }}>Cấu hình chung</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                onClick={() => setWheelField('enabled', !wheelCfg.enabled)}
                style={{ position: 'relative', width: 44, height: 24, background: wheelCfg.enabled ? '#f59e0b' : '#d1d5db', borderRadius: 12, cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
              >
                <div style={{ position: 'absolute', top: 2, left: wheelCfg.enabled ? 22 : 2, width: 20, height: 20, background: 'white', borderRadius: '50%', transition: 'left 0.2s' }} />
              </div>
              <span style={{ fontWeight: 700, fontSize: '0.8rem', color: wheelCfg.enabled ? '#b45309' : '#6b7280' }}>
                {wheelCfg.enabled ? 'Đang bật' : 'Đang tắt'}
              </span>
            </div>
          </div>

          <div
            onClick={() => setWheelField('requireFollow', !wheelCfg.requireFollow)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}
          >
            <div style={{ position: 'relative', width: 40, height: 22, background: wheelCfg.requireFollow ? '#0d9488' : '#d1d5db', borderRadius: 11, flexShrink: 0, transition: 'background .2s' }}>
              <div style={{ position: 'absolute', top: 2, left: wheelCfg.requireFollow ? 20 : 2, width: 18, height: 18, background: 'white', borderRadius: '50%', transition: 'left .2s' }} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.84rem', color: '#0f766e' }}>
                Phải quan tâm Zalo mới nhận quà
              </div>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                Bật: quay xong khách phải Quan tâm Zalo OA, quà mới vào hoá đơn.
                Tắt: quà vào hoá đơn ngay khi quay.
              </div>
            </div>
          </div>

          <div
            onClick={() => setWheelField('autoNudge', !wheelCfg.autoNudge)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}
          >
            <div style={{ position: 'relative', width: 40, height: 22, background: wheelCfg.autoNudge ? '#f59e0b' : '#d1d5db', borderRadius: 11, flexShrink: 0, transition: 'background .2s' }}>
              <div style={{ position: 'absolute', top: 2, left: wheelCfg.autoNudge ? 20 : 2, width: 18, height: 18, background: 'white', borderRadius: '50%', transition: 'left .2s' }} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.84rem', color: '#b45309' }}>
                Tự mời quay sau khi khách gửi đơn
              </div>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                Bật: khách gửi đơn đủ hoá đơn tối thiểu thì tự hiện lời mời quay.
                Tắt: KHÔNG tự hiện nữa — nút 🎰 Vòng xoay vẫn còn để khách tự bấm quay.
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            {[
              { f: 'minBill', label: 'Hoá đơn tối thiểu (đ)', hint: '0 = không yêu cầu' },
              { f: 'max', label: 'Giảm tối đa (đ)', hint: 'trần cho quà giảm %' },
              { f: 'cooldown', label: 'Mỗi SĐT cách nhau (ngày)', hint: '0 = không giới hạn' },
            ].map(({ f, label, hint }) => (
              <div key={f} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151' }}>{label}</label>
                <input
                  type="number"
                  value={wheelCfg[f]}
                  onChange={e => setWheelField(f, e.target.value)}
                  style={{ padding: '9px 11px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.86rem' }}
                />
                <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>{hint}</span>
              </div>
            ))}
          </div>

          <button
            onClick={saveWheelConfig}
            disabled={wheelCfgSaving}
            style={{ marginTop: 14, padding: '9px 18px', background: '#f59e0b', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700, opacity: wheelCfgSaving ? 0.7 : 1 }}
          >
            {wheelCfgSaving ? 'Đang lưu...' : '💾 Lưu cấu hình'}
          </button>
        </div>

        {/* Cơ cấu quà */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 800, fontSize: '0.95rem', color: '#0f172a' }}>
            Cơ cấu quà ({prizes.filter(p => p.is_active).length} đang bật)
          </div>
          <button
            onClick={addPrize}
            style={{ padding: '8px 14px', background: '#ecfdf5', border: '1.5px solid #6ee7b7', borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, color: '#065f46' }}
          >
            ➕ Thêm quà
          </button>
        </div>

        {prizes.length === 0 ? (
          <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '12px 14px', fontSize: '0.8rem', color: '#9a3412' }}>
            Chưa có phần quà nào. Bấm <b>Thêm quà</b> để tạo, hoặc chạy file
            <code style={{ margin: '0 4px' }}>lucky_prizes_table.sql</code> để nạp cơ cấu mặc định.
          </div>
        ) : (
          <>
            <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: 8 }}>
              Tỉ lệ tính theo tổng trọng số của các quà <b>đang bật</b> (tổng hiện tại: {totalWeight(prizes.filter(p => p.is_active))}).
              Đặt trọng số lớn hơn = ra nhiều hơn.
            </div>
            {prizes.map(prize => {
              const active = prizes.filter(p => p.is_active);
              const chance = prize.is_active ? prizeChance(prize, active) : 0;
              return (
                <div key={prize.id} style={{ background: 'white', border: `1.5px solid ${prize.is_active ? '#e5e7eb' : '#f1f5f9'}`, borderRadius: 12, padding: 14, marginBottom: 10, opacity: prize.is_active ? 1 : 0.7 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', background: prize.color, border: '1px solid rgba(0,0,0,.1)', flexShrink: 0 }} />
                    <input
                      value={prize.label}
                      onChange={e => setPrizeField(prize.id, 'label', e.target.value)}
                      placeholder="Tên phần quà"
                      style={{ flex: 1, minWidth: 120, padding: '8px 10px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.86rem', fontWeight: 700 }}
                    />
                    <div
                      onClick={() => setPrizeField(prize.id, 'is_active', !prize.is_active)}
                      style={{ position: 'relative', width: 40, height: 22, background: prize.is_active ? '#10b981' : '#d1d5db', borderRadius: 11, cursor: 'pointer', flexShrink: 0 }}
                    >
                      <div style={{ position: 'absolute', top: 2, left: prize.is_active ? 20 : 2, width: 18, height: 18, background: 'white', borderRadius: '50%', transition: 'left .2s' }} />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: '0.72rem', fontWeight: 700, color: '#374151' }}>Loại quà</label>
                      <select
                        value={prize.type}
                        onChange={e => setPrizeField(prize.id, 'type', e.target.value)}
                        style={{ padding: '8px 8px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.82rem' }}
                      >
                        {PRIZE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: '0.72rem', fontWeight: 700, color: '#374151' }}>
                        {prize.type === 'percent' ? '% giảm' : prize.type === 'amount' ? 'Số tiền giảm (đ)' : 'Số lượng tặng'}
                      </label>
                      <input
                        type="number"
                        min={isGiftPrizeType(prize.type) ? 1 : undefined}
                        step={isGiftPrizeType(prize.type) ? 1 : undefined}
                        value={prize.value}
                        onChange={e => setPrizeField(prize.id, 'value', e.target.value)}
                        style={{ padding: '8px 10px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.82rem' }}
                      />
                      {isGiftPrizeType(prize.type) && (
                        <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
                          vd 1 = tặng 1 {prize.type === 'gift_drink' ? 'chai/lon' : 'phần'}
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: '0.72rem', fontWeight: 700, color: '#374151' }}>Trọng số</label>
                      <input
                        type="number"
                        value={prize.weight}
                        onChange={e => setPrizeField(prize.id, 'weight', e.target.value)}
                        style={{ padding: '8px 10px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.82rem' }}
                      />
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: prize.is_active ? '#0f766e' : '#9ca3af' }}>
                        {prize.is_active ? `≈ ${chance.toFixed(1)}% trúng` : 'đang tắt'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: '0.72rem', fontWeight: 700, color: '#374151' }}>Chữ trên múi</label>
                      <input
                        value={prize.short || ''}
                        onChange={e => setPrizeField(prize.id, 'short', e.target.value)}
                        placeholder="vd 5%"
                        style={{ padding: '8px 10px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.82rem' }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: '0.72rem', fontWeight: 700, color: '#374151' }}>Màu múi</label>
                      <input
                        type="color"
                        value={prize.color || '#94a3b8'}
                        onChange={e => setPrizeField(prize.id, 'color', e.target.value)}
                        style={{ padding: 2, border: '1.5px solid #e5e7eb', borderRadius: 8, height: 36, cursor: 'pointer' }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ fontSize: '0.72rem', fontWeight: 700, color: '#374151' }}>Thứ tự</label>
                      <input
                        type="number"
                        value={prize.sort_order ?? 0}
                        onChange={e => setPrizeField(prize.id, 'sort_order', e.target.value)}
                        style={{ padding: '8px 10px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.82rem' }}
                      />
                    </div>
                  </div>

                  {prize.type === 'gift_drink' && (
                    <button
                      onClick={() => setShowDrinkPicker(true)}
                      style={{ width: '100%', marginTop: 10, padding: '9px 12px', background: '#fff7ed', border: '1.5px solid #fed7aa', borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, color: '#9a3412', textAlign: 'left' }}
                    >
                      🥤 Danh sách nước được tặng ({wheelDrinkIds.length} món) ›
                    </button>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button
                      onClick={() => savePrize(prize)}
                      disabled={prizeSaving}
                      style={{ padding: '8px 16px', background: prize._dirty ? '#2563eb' : '#e5e7eb', color: prize._dirty ? 'white' : '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700 }}
                    >
                      {prizeSaving ? 'Đang lưu...' : prize._dirty ? '💾 Lưu thay đổi' : '💾 Lưu'}
                    </button>
                    <button
                      onClick={() => deletePrize(prize)}
                      style={{ padding: '8px 14px', background: '#fef2f2', border: '1.5px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, color: '#b91c1c' }}
                    >
                      🗑 Xoá
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Modal chọn danh sách "nước tặng" — chỉ mở khi bấm nút trên quà Tặng nước */}
      {showDrinkPicker && (
        <div
          onClick={() => setShowDrinkPicker(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'white', borderRadius: 14, padding: 18, maxWidth: 480, width: '100%', maxHeight: '85vh', overflowY: 'auto', position: 'relative' }}
          >
            <button
              onClick={() => setShowDrinkPicker(false)}
              style={{ position: 'absolute', top: 12, right: 12, width: 30, height: 30, borderRadius: '50%', border: 'none', background: '#f1f5f9', cursor: 'pointer', fontSize: '0.9rem' }}
            >
              ✕
            </button>
            <div style={{ fontWeight: 800, fontSize: '0.95rem', color: '#0f172a', marginBottom: 4 }}>
              🥤 Danh sách nước được tặng ({wheelDrinkIds.length} món)
            </div>
            <p style={{ margin: '0 0 10px', fontSize: '0.8rem', color: '#6b7280' }}>
              Khách quay trúng quà <b>Tặng nước</b> sẽ được chọn 1 món trong danh sách này.
              Món tặng (Tặng món) vẫn dùng đúng danh sách "món tặng" ở trang Thực đơn, không cần chọn lại ở đây.
            </p>
            <input
              type="text"
              value={wheelDrinkSearch}
              onChange={e => setWheelDrinkSearch(e.target.value)}
              placeholder="Tìm món..."
              style={{ width: '100%', padding: '9px 11px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: '0.86rem', marginBottom: 10 }}
            />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflowY: 'auto', padding: 4 }}>
            {wheelMenuItems
              .filter(it => it.name.toUpperCase().includes(wheelDrinkSearch.trim().toUpperCase()))
              .map(it => {
                const checked = wheelDrinkIds.includes(it.id);
                return (
                  <label key={it.id} style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px',
                    background: checked ? '#fff7ed' : '#f8fafc',
                    border: `1.5px solid ${checked ? '#fb923c' : '#e2e8f0'}`,
                    borderRadius: 20, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                    color: checked ? '#9a3412' : '#64748b', userSelect: 'none',
                  }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleWheelDrinkId(it.id)} style={{ margin: 0 }} />
                    {it.name}
                  </label>
                );
              })}
            {wheelMenuItems.length === 0 && (
              <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>Chưa tải được menu.</div>
            )}
          </div>
          <button
            onClick={async () => { await saveWheelDrinkItems(); setShowDrinkPicker(false); }}
            disabled={wheelDrinkSaving}
            style={{ marginTop: 10, padding: '9px 18px', background: '#fb923c', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.84rem', fontWeight: 700, opacity: wheelDrinkSaving ? 0.7 : 1 }}
          >
            {wheelDrinkSaving ? 'Đang lưu...' : '💾 Lưu danh sách nước'}
          </button>
          </div>
        </div>
      )}

      {/* ── Ưu đãi mạng xã hội (Google / TikTok / Facebook) ── */}
      <div style={{ marginTop: 28 }}>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', color: '#0f172a', marginBottom: 2 }}>
          🎁 Ưu đãi mạng xã hội
        </div>
        <p style={{ margin: '0 0 6px', fontSize: '0.8rem', color: '#6b7280' }}>
          Khách bấm ở trang gọi món → nhân viên duyệt ở màn hình bàn → tự trừ tiền vào bill của <b>cả bàn</b>.
          Mỗi kênh tính riêng, mỗi bàn được <b>1 lần/ngày/kênh</b>.
        </p>
        {(() => {
          const on = REWARD_CHANNELS.filter(c => channelForms[c.key]?.enabled);
          const tong = on.reduce((sum, c) => sum + (Number(channelForms[c.key]?.percent) || 0), 0);
          return on.length > 1 ? (
            <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '8px 11px', fontSize: '0.78rem', color: '#9a3412', marginBottom: 12 }}>
              ⚠️ Đang bật <b>{on.length}</b> kênh — một bàn có thể làm đủ cả {on.length} kênh trong ngày,
              tổng giảm tối đa khoảng <b>{tong}%</b> bill. Cân nhắc hạ % từng kênh hoặc đặt trần "Giảm tối đa".
            </div>
          ) : null;
        })()}

        {REWARD_CHANNELS.map(ch => {
          const form = channelForms[ch.key] || {};
          // Màu lấy từ registry để 3 nơi (Cài đặt / màn bàn / trang khách) luôn khớp nhau
          const theme = { main: ch.color, dark: ch.colorDark, soft: ch.colorSoft, border: ch.colorBorder };
          const saving = channelSaving === ch.key;
          const preview = calcReviewDiscount(Number(form.minBill) || 0, { percent: Number(form.percent) || 0, max: Number(form.max) || 0 });

          return (
            <div key={ch.key} style={{ background: 'white', border: `1.5px solid ${theme.border}`, borderRadius: 14, padding: '16px', marginBottom: 12, boxShadow: '0 2px 10px rgba(15,23,42,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
                <div style={{ fontWeight: 800, fontSize: '0.98rem', color: theme.dark }}>
                  {ch.icon} {ch.name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    onClick={() => setChannelField(ch.key, 'enabled', !form.enabled)}
                    style={{ position: 'relative', width: 44, height: 24, background: form.enabled ? theme.main : '#d1d5db', borderRadius: 12, cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
                  >
                    <div style={{ position: 'absolute', top: 2, left: form.enabled ? 22 : 2, width: 20, height: 20, background: 'white', borderRadius: '50%', transition: 'left 0.2s' }} />
                  </div>
                  <span style={{ fontWeight: 700, fontSize: '0.8rem', color: form.enabled ? theme.dark : '#6b7280' }}>
                    {form.enabled ? 'Đang bật' : 'Đang tắt'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151' }}>Link {ch.short} *</label>
                <input value={form.url || ''} onChange={e => setChannelField(ch.key, 'url', e.target.value)}
                  placeholder={ch.key === 'google' ? 'https://search.google.com/local/writereview?placeid=...' : ch.key === 'tiktok' ? 'https://www.tiktok.com/@tenquan' : 'https://www.facebook.com/tenquan'}
                  style={{ padding: '8px 10px', border: `1.5px solid ${theme.border}`, borderRadius: 8, fontSize: '0.85rem' }} />
                <span style={{ fontSize: '0.72rem', color: '#64748b' }}>{ch.urlHint}</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                {[
                  { f: 'percent', label: '% giảm trên tổng bill bàn', min: 1, max: 100, step: 1 },
                  { f: 'max', label: 'Giảm tối đa (đ)', min: 0, step: 1000 },
                  { f: 'minBill', label: 'Bill tối thiểu (đ)', min: 0, step: 10000 },
                  { f: 'cooldown', label: 'Mỗi SĐT cách nhau (ngày)', min: 0, step: 1 },
                  { f: 'wait', label: 'Chờ tối thiểu (giây)', min: 0, step: 1 },
                ].map(fld => (
                  <div key={fld.f} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151' }}>{fld.label}</label>
                    <input type="number" min={fld.min} max={fld.max} step={fld.step}
                      value={form[fld.f] ?? ''}
                      onChange={e => setChannelField(ch.key, fld.f, e.target.value)}
                      style={{ padding: '8px 10px', border: `1.5px solid ${theme.border}`, borderRadius: 8, fontSize: '0.85rem' }} />
                  </div>
                ))}
              </div>

              <div style={{ background: theme.soft, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '9px 11px', fontSize: '0.76rem', color: theme.dark, marginBottom: 12, lineHeight: 1.55 }}>
                Ví dụ: bill bàn <b>{(Number(form.minBill) || 0).toLocaleString('vi-VN')}đ</b> → giảm <b>{preview.toLocaleString('vi-VN')}đ</b>.
              </div>

              <button onClick={() => saveRewardChannel(ch)} disabled={saving}
                style={{ padding: '8px 16px', background: theme.main, color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700, opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Đang lưu...' : '💾 Lưu cấu hình'}
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Máy in ── */}
      <div style={{ marginTop: 28, background: 'white', border: '1.5px solid #e9d5ff', borderRadius: 14, padding: '18px 16px', boxShadow: '0 2px 10px rgba(124,58,237,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: '1rem', color: '#5b21b6' }}>🖨️ Quản lý máy in</div>
            <div style={{ fontSize: '0.78rem', color: '#7c3aed', marginTop: 2 }}>PrintAgent tự tải config khi khởi động và cập nhật realtime</div>
          </div>
          <button onClick={startAddPrinter}
            style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: 9, padding: '8px 14px', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>
            + Thêm máy in
          </button>
        </div>

        {/* Printer form */}
        {showPrinterForm && (
          <div style={{ background: '#faf5ff', border: '1.5px solid #c4b5fd', borderRadius: 12, padding: '14px 14px', marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#5b21b6', marginBottom: 10 }}>
              {printerEditId ? '✏️ Sửa máy in' : '➕ Thêm máy in mới'}
            </div>
            <form onSubmit={handleSavePrinter} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>Tên hiển thị *</label>
                <input value={printerForm.name} onChange={e => setPrinterForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="ví dụ: Máy in quầy, Máy in bếp"
                  style={{ padding: '8px 10px', border: '1.5px solid #ddd6fe', borderRadius: 8, fontSize: '0.85rem' }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>Chế độ</label>
                <select value={printerForm.type} onChange={e => setPrinterForm(p => ({ ...p, type: e.target.value }))}
                  style={{ padding: '8px 10px', border: '1.5px solid #ddd6fe', borderRadius: 8, fontSize: '0.85rem', background: 'white' }}>
                  <option value="thermal">🔥 Thermal (ESC/POS qua TCP/IP)</option>
                  <option value="windows">🪟 Windows (Notepad /p)</option>
                  <option value="file">📄 File (test mode)</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>Interface / Địa chỉ *</label>
                <input value={printerForm.interface} onChange={e => setPrinterForm(p => ({ ...p, interface: e.target.value }))}
                  placeholder={printerForm.type === 'thermal' ? 'tcp://192.168.1.212:9100' : printerForm.type === 'windows' ? 'Tên printer Windows' : 'file'}
                  style={{ padding: '8px 10px', border: '1.5px solid #ddd6fe', borderRadius: 8, fontSize: '0.85rem', fontFamily: 'monospace' }} />
                <span style={{ fontSize: '0.7rem', color: '#7c3aed' }}>
                  {printerForm.type === 'thermal' && 'Thermal: tcp://IP:9100 (IP máy in trong LAN)'}
                  {printerForm.type === 'windows' && 'Windows: nhập tên máy in (bỏ trống = máy in mặc định)'}
                  {printerForm.type === 'file' && 'File: in ra file .txt trong thư mục output/'}
                </span>
              </div>
              {/* is_default */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 0 0', gridColumn: '1 / -1' }}>
                <input type="checkbox" id="cb_is_default" checked={printerForm.is_default}
                  onChange={e => setPrinterForm(p => ({ ...p, is_default: e.target.checked }))}
                  style={{ width: 16, height: 16, accentColor: '#7c3aed', cursor: 'pointer' }} />
                <label htmlFor="cb_is_default" style={{ fontSize: '0.82rem', fontWeight: 600, color: '#5b21b6', cursor: 'pointer' }}>
                  ⭐ Máy in mặc định (nhận món chưa phân loại)
                </label>
              </div>
              {/* is_bill_printer */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 6px 0', gridColumn: '1 / -1' }}>
                <input type="checkbox" id="cb_is_bill_printer" checked={printerForm.is_bill_printer}
                  onChange={e => setPrinterForm(p => ({ ...p, is_bill_printer: e.target.checked }))}
                  style={{ width: 16, height: 16, accentColor: '#7c3aed', cursor: 'pointer' }} />
                <label htmlFor="cb_is_bill_printer" style={{ fontSize: '0.82rem', fontWeight: 600, color: '#059669', cursor: 'pointer' }}>
                  🧾 Máy in Bill (Hoá đơn tính tiền)
                </label>
              </div>
              {/* Category multi-select */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>🏷️ Danh mục món</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {categories.map(cat => (
                    <label key={cat.id} style={{
                      display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px',
                      background: printerCategoryIds.includes(cat.id) ? '#ede9fe' : '#f8fafc',
                      border: `1.5px solid ${printerCategoryIds.includes(cat.id) ? '#a78bfa' : '#e2e8f0'}`,
                      borderRadius: 20, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                      color: printerCategoryIds.includes(cat.id) ? '#5b21b6' : '#64748b', userSelect: 'none',
                    }}>
                      <input type="checkbox" checked={printerCategoryIds.includes(cat.id)}
                        onChange={() => toggleCategorySelection(cat.id)} style={{ display: 'none' }} />
                      {printerCategoryIds.includes(cat.id) ? '✓ ' : ''}{cat.name}
                    </label>
                  ))}
                </div>
                <span style={{ fontSize: '0.7rem', color: '#7c3aed' }}>Món không thuộc danh mục nào → gửi tới máy mặc định</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>Thứ tự ưu tiên</label>
                <input type="number" min="0" value={printerForm.sort_order} onChange={e => setPrinterForm(p => ({ ...p, sort_order: e.target.value }))}
                  style={{ padding: '8px 10px', border: '1.5px solid #ddd6fe', borderRadius: 8, fontSize: '0.85rem' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 700, color: '#475569' }}>Ghi chú</label>
                <input value={printerForm.note} onChange={e => setPrinterForm(p => ({ ...p, note: e.target.value }))}
                  placeholder="Tuỳ chọn"
                  style={{ padding: '8px 10px', border: '1.5px solid #ddd6fe', borderRadius: 8, fontSize: '0.85rem' }} />
              </div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" onClick={() => setShowPrinterForm(false)}
                  style={{ padding: '8px 16px', border: '1.5px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', background: 'white', fontWeight: 600, fontSize: '0.82rem' }}>
                  Huỷ
                </button>
                <button type="submit" disabled={printerSaving}
                  style={{ padding: '8px 18px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '0.85rem', opacity: printerSaving ? 0.7 : 1 }}>
                  {printerSaving ? 'Đang lưu...' : '💾 Lưu'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Printer list */}
        {printers.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: '24px 0', fontSize: '0.85rem' }}>
            🖨️ Chưa có máy in nào. Nhấn “+ Thêm máy in” để cấu hình.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {printers.map(p => (
              <div key={p.id} style={{
                background: p.is_active ? '#faf5ff' : '#f8fafc',
                border: `1.5px solid ${p.is_active ? '#c4b5fd' : '#e2e8f0'}`,
                borderRadius: 12, padding: '10px 14px',
                opacity: p.is_active ? 1 : 0.6,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{ fontSize: '1.4rem' }}>🖨️</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#0f172a' }}>{p.name}</span>
                    {p.is_default && <span style={{ fontSize: '0.68rem', padding: '1px 7px', borderRadius: 5, fontWeight: 700, background: '#fef3c7', color: '#92400e' }}>⭐ Mặc định</span>}
                    {p.is_bill_printer && <span style={{ fontSize: '0.68rem', padding: '1px 7px', borderRadius: 5, fontWeight: 700, background: '#d1fae5', color: '#065f46' }}>🧾 Bill</span>}
                    <span style={{
                      fontSize: '0.68rem', padding: '1px 7px', borderRadius: 5, fontWeight: 600,
                      background: p.is_active ? '#ede9fe' : '#f1f5f9',
                      color: p.is_active ? '#5b21b6' : '#94a3b8'
                    }}>
                      {p.is_active ? '● active' : '○ off'}
                    </span>
                    <span style={{ fontSize: '0.68rem', padding: '1px 7px', borderRadius: 5, background: '#f1f5f9', color: '#64748b', fontWeight: 600 }}>
                      {p.type}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2, fontFamily: 'monospace' }}>{p.interface}</div>
                  {/* Categories */}
                  {(p.printer_categories || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {(p.printer_categories || []).map(pc => {
                        const cat = categories.find(c => c.id === pc.category_id);
                        return cat ? (
                          <span key={pc.category_id} style={{ fontSize: '0.68rem', padding: '1px 7px', borderRadius: 10, background: '#f0f9ff', color: '#0369a1', border: '1px solid #bae6fd', fontWeight: 600 }}>
                            {cat.name}
                          </span>
                        ) : null;
                      })}
                    </div>
                  )}
                  {p.note && <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 1 }}>{p.note}</div>}
                </div>
                <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                  <button onClick={() => startEditPrinter(p)}
                    style={{ padding: '4px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}>
                    ✏️ Sửa
                  </button>
                  <button onClick={() => togglePrinter(p)}
                    style={{ padding: '4px 10px', background: p.is_active ? '#fef9c3' : '#f0fdf4', border: `1px solid ${p.is_active ? '#fde68a' : '#bbf7d0'}`, borderRadius: 6, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, color: p.is_active ? '#92400e' : '#15803d' }}>
                    {p.is_active ? '⏸ Tắt' : '▶ Bật'}
                  </button>
                  <button onClick={() => deletePrinter(p)}
                    style={{ padding: '4px 10px', background: '#fff7f7', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, color: '#dc2626' }}>
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 10, fontSize: '0.73rem', color: '#7c3aed', background: '#f5f3ff', borderRadius: 8, padding: '8px 12px' }}>
          💡 PrintAgent tự reload khi bạn thay đổi — không cần khởi động lại. Interface thermal: <code>tcp://IP:9100</code>
        </div>
      </div>

      {/* ── Utilities: QR Download ── */}
      <div style={{ marginTop: 28, background: 'white', border: '1.5px solid #cbd5e1', borderRadius: 14, padding: '18px 16px', boxShadow: '0 2px 10px rgba(0,0,0,0.03)' }}>
        <div style={{ fontWeight: 800, fontSize: '1rem', color: '#334155', marginBottom: 4 }}>
          📎 Tiện ích in ấn hàng loạt
        </div>
        <p style={{ margin: '0 0 14px', fontSize: '0.8rem', color: '#64748b' }}>
          Hệ thống sẽ tự động ghép tất cả mã QR của các bàn thành 1 file lớn (A4), giúp bạn dễ dàng in ra và dán hàng loạt.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={downloadAllQRs} disabled={downloadingQR}
            style={{ padding: '10px 20px', background: '#0284c7', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8, opacity: downloadingQR ? 0.7 : 1 }}>
            {downloadingQR ? (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 11-6.219-8.56"></path>
                </svg>
                {qrProgress || 'Đang tạo bảng...'}
              </>
            ) : (
              '📦 Tải tất cả QR (JPG × từng bàn)'
            )}
          </button>

          <button onClick={async () => {
            const dataUrl = await generateQRCanvasBase64({ table_number: 1, id: 'preview-id-1234' });
            setPreviewQR(dataUrl);
          }}
            style={{ padding: '10px 20px', background: '#f8fafc', color: '#0f172a', border: '1.5px solid #cbd5e1', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            👁️ Xem mẫu trước
          </button>
        </div>
      </div>

 

      {/* ── Modal Xem mẫu QR ── */}
      {previewQR && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.85)', backdropFilter: 'blur(3px)' }}>
          <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 460, margin: 20, padding: 24, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 800, margin: '0 0 16px', color: '#0f172a' }}>Mẫu QR dán bàn tính tiền</h3>
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', padding: 10, background: '#f8fafc' }}>
              <img src={previewQR} alt="QR Preview" style={{ width: '100%', maxWidth: 350, height: 'auto', display: 'block', borderRadius: 6, border: '1px solid #e2e8f0' }} />
            </div>
            <button onClick={() => setPreviewQR(null)} style={{ marginTop: 20, padding: '10px 24px', background: '#ef4444', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer', width: '100%' }}>
              Đóng
            </button>
          </div>
        </div>
      )}

      {/* Secret Modal */}
      {showSecretModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 999998, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.85)', backdropFilter: 'blur(3px)' }}>
          <div style={{ background: '#f8fafc', borderRadius: 16, width: '100%', maxWidth: 700, maxHeight: '90vh', overflowY: 'auto', margin: 20, padding: 24, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 800, margin: 0, color: '#0f172a' }}>🕵️ Quản lý tất cả tài khoản</h3>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={startAdd} style={{ padding: '8px 16px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>+ Thêm mới</button>
                <button onClick={() => setShowSecretModal(false)} style={{ padding: '8px 16px', background: '#ef4444', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>Đóng</button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {secretAccounts.map((acc, idx) => {
                const today = todayTotal(acc);
                const pct = Math.min(Math.round((today / acc.daily_limit) * 100), 100);
                const remaining = Math.max(0, acc.daily_limit - today);
                const isFull = today >= acc.daily_limit;
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
          </div>
        </div>
      )}

    </div>
  );
}
