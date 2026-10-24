import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { receiptImageLink, receiptImageSource, signReceiptImages } from '../src/lib/receiptImages.mjs';

// Như prod: server nói chuyện với Supabase trong máy quán qua http://localhost:8000.
const INTERNAL = 'http://localhost:8000';
const BILL = '2026-10/bill-3f1c2a9e-8b7d-4c6e-9a1b-2c3d4e5f6a7b.jpg';
const CK = '2026-10/ck-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJmaW5hbmNlLXJlY2VpcHRzIn0.c2lnbmF0dXJlLXRlc3Q';

// createSignedUrls của supabase-js ghép địa chỉ client (nội bộ) vào link ký.
const storage = (fail = {}) => ({ storage: { from: bucket => ({
  createSignedUrls: async (paths, seconds) => ({ error: null, data: paths.map(path => fail[path]
    ? { path, error: fail[path], signedURL: null, signedUrl: null }
    : { path, error: null, signedURL: `/object/sign/${bucket}/${path}?token=${TOKEN}`,
      signedUrl: encodeURI(`${INTERNAL}/storage/v1/object/sign/${bucket}/${path}?token=${TOKEN}`), seconds }) }),
}) } });

test('photo links never point the phone at the shop computer\'s internal Supabase address', async () => {
  const urls = await signReceiptImages(storage(), [BILL, null, CK, BILL]);
  assert.deepEqual(Object.keys(urls).sort(), [BILL, CK].sort());
  for (const [path, url] of Object.entries(urls)) {
    assert.ok(url.startsWith('/api/admin/receipts/image?'), url);
    assert.ok(!url.includes('localhost') && !url.includes(':8000'), url);
    const query = new URL(url, 'https://ocbaokhang.online').searchParams;
    assert.equal(query.get('p'), path);
    assert.equal(query.get('token'), TOKEN);
  }
});

test('a photo the store cannot sign is left out instead of showing a broken image', async () => {
  const urls = await signReceiptImages(storage({ [CK]: 'Object not found' }), [BILL, CK]);
  assert.deepEqual(Object.keys(urls), [BILL]);
  assert.equal(receiptImageLink(BILL, 'not a url'), null);
  assert.equal(receiptImageLink('../secret.jpg', `${INTERNAL}/x?token=${TOKEN}`), null);
});

test('the web only fetches finance-receipts photos with a signed token, from its own Supabase', () => {
  assert.equal(receiptImageSource(BILL, TOKEN, `${INTERNAL}/`),
    `${INTERNAL}/storage/v1/object/sign/finance-receipts/${BILL}?token=${TOKEN}`);
  for (const [path, token] of [
    ['../../rest/v1/staff', TOKEN], [`2026-10/bill-x.jpg`, TOKEN], [`${BILL}?x=1`, TOKEN], [`other/${BILL}`, TOKEN],
    [BILL, ''], [BILL, 'abc'], [BILL, `${TOKEN}&download=1`], [null, TOKEN],
  ]) assert.equal(receiptImageSource(path, token, INTERNAL), null, `${path} ${token}`);
  assert.equal(receiptImageSource(BILL, TOKEN, ''), null);
});

const routeSource = readFileSync(new URL('../src/app/api/admin/receipts/image/route.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');

function loadRoute(upstream) {
  const calls = [];
  const { GET } = vm.runInNewContext(`${routeSource}\n({ GET })`, {
    receiptImageSource, Response, URL, AbortSignal,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: INTERNAL } },
    fetch: async (url, options) => { calls.push({ url, options }); return upstream(); },
  });
  return { GET, calls };
}
const ask = (GET, path, token = TOKEN) => GET({ url: `https://ocbaokhang.online/api/admin/receipts/image?p=${encodeURIComponent(path)}&token=${token}` });

test('opening a photo link returns the image fetched from the shop\'s Supabase', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const { GET, calls } = loadRoute(() => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }));
  const res = await ask(GET, BILL);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /private/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${INTERNAL}/storage/v1/object/sign/finance-receipts/${BILL}?token=${TOKEN}`);
});

test('the link from the finance book opens through the photo route end to end', async () => {
  const urls = await signReceiptImages(storage(), [CK]);
  const { GET, calls } = loadRoute(() => new Response('png', { headers: { 'Content-Type': 'image/png' } }));
  const res = await GET({ url: new URL(urls[CK], 'https://ocbaokhang.online').href });
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, `${INTERNAL}/storage/v1/object/sign/finance-receipts/${CK}?token=${TOKEN}`);
});

test('expired links, odd paths and non-image answers do not leak anything', async () => {
  const expired = loadRoute(() => new Response('{"error":"InvalidJWT","message":"jwt expired"}', { status: 400, headers: { 'Content-Type': 'application/json' } }));
  let res = await ask(expired.GET, BILL);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /hết hạn/);

  const html = loadRoute(() => new Response('<script>alert(1)</script>', { headers: { 'Content-Type': 'text/html' } }));
  res = await ask(html.GET, BILL);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /script/);

  const odd = loadRoute(() => { throw new Error('must not fetch'); });
  assert.equal((await ask(odd.GET, '../../rest/v1/staff')).status, 404);
  assert.equal((await ask(odd.GET, BILL, 'abc')).status, 404);
  assert.equal(odd.calls.length, 0);

  const down = loadRoute(() => { throw new Error('ECONNREFUSED'); });
  assert.equal((await ask(down.GET, BILL)).status, 502);
});
