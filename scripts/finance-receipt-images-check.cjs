// Kiểm tra ảnh bill giấy / ảnh CK trong Sổ thu chi trên DB thật (chỉ đọc).
// 1) Mỗi dòng có đường dẫn ảnh → file còn trong kho finance-receipts không.
// 2) Mở thử 1 ảnh qua web (máy quán + tên miền) như điện thoại chủ quán.
// Repo công khai → không in tên / SĐT khách. Chạy bởi workflow "Finance Receipt Images Check".
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const envFile = process.argv[2] || 'C:\\Tool\\SupabaseLocal\\production.env';
const site = process.argv[3] || 'https://ocbaokhang.online';
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')]; }));

async function main() {
  if (env.APP_ENV !== 'prod') throw new Error('APP_ENV phải là prod.');
  const { receiptImageLink } = await import(pathToFileURL(path.join(__dirname, '../src/lib/receiptImages.mjs')).href);
  const base = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const query = async sql => {
    const r = await fetch(`${new URL(base).origin}/pg/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`SQL HTTP ${r.status}`);
    return r.json();
  };
  const has = column => `(${column} IS NULL OR EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'finance-receipts' AND o.name = ${column}))`;
  const paper = await query(`SELECT id, business_date, received_at, amount, payment_method, images_purged_at,
      image_path, transfer_image_path, ${has('image_path')} AS bill_ok, ${has('transfer_image_path')} AS ck_ok
    FROM public.finance_manual_receipts ORDER BY received_at`);
  const bills = await query(`SELECT order_id, business_date, amount, transfer_image_path, ${has('transfer_image_path')} AS ck_ok
    FROM public.finance_revenue_ledger WHERE transfer_image_path IS NOT NULL ORDER BY paid_at`);
  const files = await query(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'finance-receipts'`);

  const missing = [
    ...paper.filter(r => !r.bill_ok).map(r => ({ kind: 'bill giấy · ảnh bill', id: String(r.id).slice(0, 8), date: r.business_date, amount: r.amount })),
    ...paper.filter(r => !r.ck_ok).map(r => ({ kind: 'bill giấy · ảnh CK', id: String(r.id).slice(0, 8), date: r.business_date, amount: r.amount })),
    ...bills.filter(r => !r.ck_ok).map(r => ({ kind: 'bill máy · ảnh CK', id: String(r.order_id).slice(0, 8), date: r.business_date, amount: r.amount })),
  ];
  const summary = {
    filesInStore: files[0]?.n ?? null,
    paperBills: paper.length,
    paperWithBillPhoto: paper.filter(r => r.image_path).length,
    paperWithTransferPhoto: paper.filter(r => r.transfer_image_path).length,
    paperPhotosPurgedAfter90Days: paper.filter(r => r.images_purged_at).length,
    paperWithoutPhotoNotPurged: paper.filter(r => !r.image_path && !r.images_purged_at)
      .map(r => ({ id: String(r.id).slice(0, 8), date: r.business_date, amount: r.amount })),
    machineBillsWithTransferPhoto: bills.length,
    missingFiles: missing,
  };

  // Mở thử 1 ảnh còn file, đúng đường điện thoại đi: web → /api/admin/receipts/image → Supabase.
  const sample = paper.find(r => r.image_path && r.bill_ok)?.image_path || bills.find(r => r.ck_ok)?.transfer_image_path;
  if (sample) {
    const signed = await fetch(`${base}/storage/v1/object/sign/finance-receipts`, {
      method: 'POST', headers, body: JSON.stringify({ expiresIn: 120, paths: [sample] }), signal: AbortSignal.timeout(15000),
    }).then(r => r.json());
    const link = receiptImageLink(sample, `${base}/storage/v1${signed?.[0]?.signedURL || ''}`);
    summary.openTest = {};
    for (const origin of ['http://localhost:3000', site]) {
      try {
        const r = await fetch(origin + link, { signal: AbortSignal.timeout(20000) });
        summary.openTest[origin] = `${r.status} ${r.headers.get('content-type')} ${(await r.arrayBuffer()).byteLength} bytes`;
      } catch (error) { summary.openTest[origin] = `lỗi: ${error.message}`; }
    }
  }
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
