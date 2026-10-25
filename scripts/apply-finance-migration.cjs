// Cài supabase/migrations/owner_finance.sql vào DB THẬT trên máy chủ quán.
// Chạy bởi workflow "Apply Finance Migration" (chạy tay) trên runner của máy
// chủ, đọc C:\Tool\SupabaseLocal\production.env. Chỉ chạy khi đúng là
// Supabase prod cục bộ (http://localhost:8000) và không phải DB DEV.
// Không in khoá bí mật. File SQL chạy lại được nhiều lần.
const fs = require('node:fs');
const path = require('node:path');

const envFile = process.argv[2] || 'C:\\Tool\\SupabaseLocal\\production.env';
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '8000') {
    throw new Error('Chỉ cài vào Supabase prod cục bộ cổng 8000.');
  }
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.length < 40) throw new Error('Thiếu SUPABASE_SERVICE_ROLE_KEY.');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const base = url.origin;
  const query = async sql => {
    const response = await fetch(`${base}/pg/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`SQL HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };

  // DB DEV có bảng đánh dấu; DB thật thì không.
  const [marker] = await query(`SELECT to_regclass('public.dev_environment_marker') AS dev, to_regclass('public.orders') AS orders`);
  if (marker.dev) throw new Error('Đây là DB DEV, dừng lại.');
  if (!marker.orders) throw new Error('Không thấy bảng orders, sai DB.');

  // Trang Mã QR: nút "Xác nhận đã nhận tiền" (bản đúng với bảng thật, thay confirm_shadow_qr_atomic).
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'confirm_custom_qr_payment.sql'), 'utf8'));
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'owner_finance.sql'), 'utf8');
  await query(sql);

  const [check] = await query(`SELECT
    to_regclass('public.finance_revenue_ledger') IS NOT NULL AS ledger,
    to_regclass('public.finance_entries') IS NOT NULL AS entries,
    to_regclass('public.finance_day_closes') IS NOT NULL AS day_closes,
    to_regclass('public.finance_categories') IS NOT NULL AS categories,
    to_regclass('public.finance_manual_receipts') IS NOT NULL AS paper,
    to_regclass('public.finance_settings') IS NOT NULL AS settings,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'finance_revenue_ledger' AND column_name = 'verified_at') AS verify_cols,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'finance_revenue_ledger' AND column_name IN ('cash_image_path', 'photo_skip_reason', 'photo_by')) = 3 AS table_photo_cols,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_finance_revenue' AND tgrelid = 'public.orders'::regclass AND tgenabled = 'O') AS trigger_on,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_qr_page_receipt' AND tgrelid = to_regclass('public.payment_transactions') AND tgenabled = 'O') AS qr_trigger_on,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_qr_page_receipt' AND tgrelid = to_regclass('public.custom_cash_receipts') AND tgenabled = 'O') AS cash_trigger_on,
    to_regprocedure('public.confirm_custom_qr_payment(text,numeric,uuid)') IS NOT NULL AS qr_confirm_fixed,
    NOT has_table_privilege('anon', 'public.finance_revenue_ledger', 'SELECT') AS anon_blocked,
    (SELECT count(*)::int FROM public.finance_revenue_ledger) AS ledger_rows`);
  console.log(JSON.stringify(check));
  if (!check.ledger || !check.entries || !check.day_closes || !check.categories || !check.paper || !check.settings || !check.verify_cols || !check.table_photo_cols || !check.trigger_on || !check.qr_trigger_on || !check.cash_trigger_on || !check.qr_confirm_fixed || !check.anon_blocked) {
    throw new Error('Cài chưa đủ, xem kết quả kiểm tra ở trên.');
  }
  console.log('Đã cài sổ thu chi vào DB thật.');

  // Khoá ghi trực tiếp từ trình duyệt + nhật ký + sổ trả nợ Sổ tay (staff_security.sql).
  // Chạy SAU khi web mới đã deploy (Sổ tay / Lương / Chấm công đã ghi qua máy chủ).
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'staff_security.sql'), 'utf8'));
  const [lock] = await query(`SELECT
    (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'block_client_writes') AS write_locks,
    (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'audit_staff_data') AS audit_triggers,
    to_regclass('public.staff_note_payments') IS NOT NULL AS payments,
    NOT has_table_privilege('anon', 'public.staff_data_audit', 'SELECT') AS audit_hidden`);
  console.log(JSON.stringify(lock));
  if (lock.write_locks < 8 || lock.audit_triggers < 7 || !lock.payments || !lock.audit_hidden) throw new Error('Khoá dữ liệu nhân viên chưa đủ.');

  // Sổ tay ghi mỗi thao tác trong một giao dịch (staff_notes_commit.sql) — cài TRƯỚC khi web dùng.
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'staff_notes_commit.sql'), 'utf8'));
  const [commitFn] = await query(`SELECT to_regprocedure('public.staff_notes_commit(jsonb)') IS NOT NULL AS installed,
    NOT has_function_privilege('anon', 'public.staff_notes_commit(jsonb)', 'EXECUTE') AS anon_blocked`);
  console.log(JSON.stringify(commitFn));
  if (!commitFn.installed || !commitFn.anon_blocked) throw new Error('Chưa cài được staff_notes_commit.');

  // Chấm công chống gian lận (checkin_security.sql) — cài TRƯỚC khi web dùng máy quầy.
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'checkin_security.sql'), 'utf8'));
  const [checkin] = await query(`SELECT
    (SELECT count(*)::int FROM unnest(ARRAY['checkin_kiosks', 'checkin_nonces', 'checkin_scans', 'staff_checkin_devices', 'checkin_settings', 'checkin_hours', 'attendance_fix_requests', 'staff_shifts', 'attendance_extra_reviews', 'attendance_changes']) t
      WHERE to_regclass('public.' || t) IS NOT NULL) AS tables,
    (SELECT count(*)::int FROM public.checkin_settings) AS settings,
    (SELECT hours_from::text FROM public.checkin_settings WHERE id = 1) AS hours_from,
    NOT has_table_privilege('anon', 'public.checkin_scans', 'SELECT') AS anon_blocked`);
  console.log(JSON.stringify(checkin));
  if (checkin.tables !== 10 || checkin.settings !== 1 || !checkin.anon_blocked) throw new Error('Chưa cài đủ bảng chấm công.');

  // Chốt lương tháng + ngày nghỉ của đơn báo nghỉ (payroll_closes.sql) — cài TRƯỚC khi web dùng.
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'payroll_closes.sql'), 'utf8'));
  const [payroll] = await query(`SELECT
    to_regclass('public.payroll_closes') IS NOT NULL AS closes,
    to_regclass('public.payroll_leave_days') IS NOT NULL AS leave_days,
    to_regclass('public.staff_departures') IS NOT NULL AS departures,
    NOT has_table_privilege('anon', 'public.payroll_closes', 'SELECT') AS anon_blocked`);
  console.log(JSON.stringify(payroll));
  if (!payroll.closes || !payroll.leave_days || !payroll.departures || !payroll.anon_blocked) throw new Error('Chưa cài đủ bảng chốt lương / nghỉ việc.');

  // Thưởng chuyên cần + phạt có ngày / người ghi / gợi ý từ chấm công (payroll_bonus_fines.sql).
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'payroll_bonus_fines.sql'), 'utf8'));
  const [bonusFines] = await query(`SELECT
    (SELECT count(*)::int FROM unnest(ARRAY['payroll_settings', 'payroll_bonuses', 'payroll_fine_rules', 'payroll_violation_meta', 'payroll_fine_reviews']) t
      WHERE to_regclass('public.' || t) IS NOT NULL) AS tables,
    (SELECT count(*)::int FROM public.payroll_settings) AS settings,
    (SELECT count(*)::int FROM public.payroll_fine_rules WHERE kind IS NOT NULL) AS auto_rules,
    NOT has_table_privilege('anon', 'public.payroll_bonuses', 'SELECT') AS anon_blocked`);
  console.log(JSON.stringify(bonusFines));
  if (bonusFines.tables !== 5 || bonusFines.settings !== 1 || bonusFines.auto_rules !== 2 || !bonusFines.anon_blocked) throw new Error('Chưa cài đủ bảng thưởng / phạt.');

  // So khuôn mặt ở máy quầy (checkin_face.sql): chỉ dấu mặt mẫu, không ảnh — cài TRƯỚC khi dùng app máy quầy.
  await query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', 'checkin_face.sql'), 'utf8'));
  const [face] = await query(`SELECT
    (SELECT count(*)::int FROM unnest(ARRAY['staff_face_templates', 'checkin_face_checks', 'attendance_face_reviews', 'checkin_face_settings', 'checkin_kiosk_apps']) t
      WHERE to_regclass('public.' || t) IS NOT NULL) AS tables,
    (SELECT count(*)::int FROM public.checkin_face_settings) AS settings,
    NOT has_table_privilege('anon', 'public.staff_face_templates', 'SELECT') AS anon_blocked`);
  console.log(JSON.stringify(face));
  if (face.tables !== 5 || face.settings !== 1 || !face.anon_blocked) throw new Error('Chưa cài đủ bảng so khuôn mặt.');

  // Băm mã PIN còn lưu chữ thường (web đang chạy ở 127.0.0.1:3000 làm việc này).
  const crypto = require('node:crypto');
  const serverKey = crypto.createHmac('sha256', key).update('staff-maintenance').digest('hex');
  const response = await fetch('http://127.0.0.1:3000/api/admin/workforce', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-server-key': serverKey },
    body: JSON.stringify({ action: 'hash_all_pins' }), signal: AbortSignal.timeout(60000),
  });
  const hashed = await response.json().catch(() => ({}));
  console.log(`băm PIN: HTTP ${response.status} ${JSON.stringify(hashed)}`);
  if (!response.ok) throw new Error('Chưa băm được PIN.');
  console.log('Đã khoá dữ liệu nhân viên và băm PIN.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
