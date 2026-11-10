import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

// Trang Mã QR (/admin/qr) "Nhận tiền mặt": mã phiếu chống ghi trùng chỉ thuộc về MỘT lần thu, và khi
// máy chủ báo phiếu đã có thì nhân viên được hỏi rõ — khoản tiền mới không bị bỏ qua trong im lặng.
const page = readFileSync(new URL('../src/app/admin/qr/page.jsx', import.meta.url), 'utf8');
const helpers = page.slice(page.indexOf('const CASH_ATTEMPT_KEY'), page.indexOf('export default function QrGeneratorPage'));
const saveCashSource = page.slice(page.indexOf('  const saveCash = async'), page.indexOf('  // ─── Tạo mã QR cho thẻ ẨN'));
const amountSource = page.slice(page.indexOf('  const handleAmountChange = '), page.indexOf('  const handleCancel = '));

function qrPage(server) {
  const env = { now: Date.parse('2026-11-04T12:00:00Z'), posts: [], sent: [], prompts: [], toasts: [], store: new Map(), answer: false, seq: 0 };
  const context = {
    sessionStorage: { getItem: k => env.store.get(k) ?? null, setItem: (k, v) => env.store.set(k, v), removeItem: k => env.store.delete(k) },
    Date: { now: () => env.now }, JSON, Number, Error,
    newLuckyRequestId: () => `receipt-${++env.seq}`,
    postQrPayment: async (fields, images) => { env.posts.push(fields.receipt_id); env.sent.push({ fields, images }); return server(fields); },
    Swal: { fire: async opts => {
      if (opts.showCancelButton) { env.prompts.push(opts.title); return { isConfirmed: env.answer }; }
      env.toasts.push(opts.title); return {};
    } },
    setIsGenerating() {}, setAmount() {}, setPaymentStatus() {}, setTransactionCode() {}, setActiveQr() {}, clearForm() {},
  };
  const api = vm.runInNewContext(`${helpers}\n${saveCashSource}\n${amountSource}\n({ saveCash, handleAmountChange })`, context);
  return { ...api, env };
}

test('a lost reply that staff do not retry no longer swallows the next cash payment of the same amount', async () => {
  const saved = new Set();
  const h = qrPage(({ receipt_id }) => {
    const already = saved.has(receipt_id);
    saved.add(receipt_id);
    if (receipt_id === 'receipt-1' && !already) throw new Error('mạng rớt'); // ghi được nhưng mất phản hồi
    return { ok: true, alreadyDone: already };
  });
  await assert.rejects(h.saveCash({ amount: 200000 }, 'photo-1'), /mạng rớt/);
  // Khách sau cũng trả 200.000đ: nhân viên gõ lại số tiền → lần thu mới, mã mới.
  h.handleAmountChange({ target: { value: '200000' } });
  await h.saveCash({ amount: 200000 }, 'photo-2');
  assert.deepEqual(h.env.posts, ['receipt-1', 'receipt-2']);
  assert.equal(saved.size, 2, 'both payments are in the book');
});

test('retrying right after an error reuses the receipt code, and the "already saved" answer is shown to staff', async () => {
  const saved = new Set();
  let lose = true;
  const h = qrPage(({ receipt_id }) => {
    const already = saved.has(receipt_id);
    saved.add(receipt_id);
    if (lose) { lose = false; throw new Error('mạng rớt'); }
    return { ok: true, alreadyDone: already };
  });
  await assert.rejects(h.saveCash({ amount: 150000 }, 'photo'));
  h.env.now += 60000;
  h.env.answer = false; // "Đúng, cùng khoản đó"
  await h.saveCash({ amount: 150000 }, 'photo');
  assert.deepEqual(h.env.posts, ['receipt-1', 'receipt-1'], 'same code → the server never records it twice');
  assert.deepEqual(h.env.prompts, ['Khoản này đã ghi từ lần bấm trước']);
  assert.equal(saved.size, 1);
  assert.equal(h.env.store.size, 0, 'the attempt is closed after success');
});

test('when staff say it is a new customer, the payment is saved under a new code', async () => {
  const saved = new Set(['receipt-1']);
  const h = qrPage(({ receipt_id }) => { const already = saved.has(receipt_id); saved.add(receipt_id); return { ok: true, alreadyDone: already }; });
  h.env.store.set('custom-cash-receipt', JSON.stringify({ id: 'receipt-1', amount: 90000, at: h.env.now - 60000 }));
  h.env.seq = 1;
  h.env.answer = true; // "Ghi khoản mới"
  await h.saveCash({ amount: 90000 }, 'photo');
  assert.deepEqual(h.env.posts, ['receipt-1', 'receipt-2']);
  assert.ok(saved.has('receipt-2'));
  assert.deepEqual(h.env.toasts, ['✅ Nhận tiền mặt!']);
});

test('the table typed in the QR box goes with the cash payment, the bill photo as its one photo', async () => {
  const h = qrPage(() => ({ ok: true, alreadyDone: false }));
  await h.saveCash({ amount: 90000, table: 'Bàn 3' }, 'bill-photo');
  await h.saveCash({ amount: 40000 }, 'p2');
  assert.deepEqual(JSON.parse(JSON.stringify(h.env.sent.map(s => [s.fields.amount, s.fields.table_label, s.images]))),
    [[90000, 'Bàn 3', { image: ['bill-photo', 'bill'] }], [40000, '', { image: ['p2', 'bill'] }]]);
});

test('an old code is not reused after 5 minutes or for another amount', async () => {
  const h = qrPage(() => ({ ok: true, alreadyDone: false }));
  h.env.store.set('custom-cash-receipt', JSON.stringify({ id: 'old', amount: 50000, at: h.env.now - 6 * 60000 }));
  await h.saveCash({ amount: 50000 }, 'p');
  h.env.store.set('custom-cash-receipt', JSON.stringify({ id: 'old', amount: 50000, at: h.env.now - 60000 }));
  await h.saveCash({ amount: 60000 }, 'p');
  assert.deepEqual(h.env.posts, ['receipt-1', 'receipt-2']);
});

// ── record_custom_cash_receipt báo phiếu đã có (custom_cash_receipt_once.sql) ──
const db = new PGlite();
after(() => db.close());
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

test('the server says when a cash receipt code was already recorded, and still records each new code once', async () => {
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  await db.exec(migration('custom_cash_receipts.sql'));
  await db.exec(migration('custom_cash_receipt_once.sql'));
  await db.exec(migration('custom_cash_receipt_once.sql')); // chạy lại được
  const id = '00000000-0000-4000-8000-0000000000c1';
  const call = async (amount, rid = id) => (await db.query('SELECT record_custom_cash_receipt($1,$2) AS r', [rid, amount])).rows[0].r;
  assert.deepEqual(await call(120000), { success: true, receipt_id: id, amount: 120000, already_completed: false });
  assert.equal((await call(120000)).already_completed, true);
  await assert.rejects(call(90000), /số tiền khác/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM custom_cash_receipts')).rows[0].n, 1);
  assert.equal(has(await db.query(`SELECT has_function_privilege('anon', 'record_custom_cash_receipt(uuid,numeric)', 'EXECUTE') AS ok`)), false);
});
const has = r => r.rows[0].ok;
