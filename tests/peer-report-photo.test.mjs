// Báo lỗi đồng nghiệp kèm ảnh làm chứng (không bắt buộc): nhân viên chụp ảnh gửi cùng lần báo (multipart), ảnh vào kho ảnh riêng tư;
// chỉ chủ quán thấy ảnh (link ký tạm), người báo chỉ thấy "có ảnh". Huỷ lần báo thì xoá ảnh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import * as pin from '../src/lib/staffPin.mjs';
import * as token from '../src/lib/checkinToken.mjs';
import * as rules from '../src/lib/attendanceRules.mjs';
import * as payroll from '../src/lib/payroll.mjs';
import * as payrollMonth from '../src/lib/payrollMonth.mjs';
import * as clockApply from '../src/lib/clockApply.mjs';
import * as faceCheck from '../src/lib/faceCheck.mjs';
import * as departure from '../src/lib/staffDeparture.mjs';
import * as roles from '../src/lib/staffRoles.mjs';
import * as images from '../src/lib/receiptImages.mjs';
import { fakeDb } from './helpers/fakeSupabase.mjs';

const source = readFileSync(new URL('../src/app/api/admin/workforce/route.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
const OWNER = { id: '00000000-0000-4000-8000-00000000aaaa', full_name: 'Chủ quán', role: 'admin', created_at: '2026-10-01T00:00:00Z' };
const AN = { id: '00000000-0000-4000-8000-00000000bbbb', full_name: 'An', role: 'staff', created_at: '2026-10-01T00:00:00Z' };
const BINH = { id: '00000000-0000-4000-8000-00000000cccc', full_name: 'Bình', role: 'manager', created_at: '2026-10-01T00:00:00Z' };
const env = { now: 0, user: null };

// Kho ảnh giả: nhớ file đã lưu, ký link như Supabase.
function fakeStorage(files) {
  const bucket = {
    upload: async (path, data, opts) => {
      if (files.down) return { error: new Error('storage down') };
      files.set(path, { size: data.length, type: opts.contentType }); return { error: null };
    },
    remove: async list => { list.forEach(p => files.delete(p)); return { error: null }; },
    createSignedUrls: async list => ({ error: null, data: list.filter(p => files.has(p)).map(p => ({ path: p, signedUrl: `http://sb/storage/v1/object/sign/finance-receipts/${p}?token=aaa.bbb.ccc` })) }),
  };
  return { getBucket: async () => ({ data: {}, error: null }), createBucket: async () => ({ error: null }), from: () => bucket };
}

function api(state, files) {
  class FixedDate extends Date { constructor(...a) { super(...(a.length ? a : [env.now])); } static now() { return env.now; } }
  const NextResponse = { json: (body, init = {}) => ({ status: init.status || 200, body }) };
  return vm.runInNewContext(`${source}\n({ GET, POST })`, {
    NextResponse, ...pin, ...token, ...rules, ...payroll, ...payrollMonth, ...clockApply, ...faceCheck, ...departure, ...roles, ...images,
    createHmac, randomUUID, timingSafeEqual, Buffer, URL, Number, Math, String, JSON, Promise,
    Date: FixedDate, nowMs: () => env.now, refreshClock: async () => {}, clockStatus: () => ({ offsetMs: 0, synced: true }),
    closeForgottenSessions: async () => {}, console: { error() {} }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) } },
    getStaffSession: async () => (env.user ? { code: 200, user: env.user } : { code: 401 }),
    staffDatabase: () => Object.assign(fakeDb(state), { storage: fakeStorage(files) }),
  });
}
const plain = v => JSON.parse(JSON.stringify(v));

test('a peer report can carry a photo that only the owner sees; cancelling removes it', async () => {
  const state = {
    staff: [OWNER, AN, BINH], payroll_config: [], checkin_settings: [{ id: 1, enforce: false, hours_from: '2026-10-25' }],
    checkin_hours: [{ valid_from: '2000-01-01', opening_time: '14:00', closing_time: '00:00', grace_minutes: 10 }],
    payroll_fine_rules: [], payroll_peer_reports: [], payroll_violations: [], payroll_violation_meta: [], payroll_requests: [], attendance_sessions: [], payroll_closes: [],
  };
  const files = new Map();
  const wf = api(state, files);
  const at = Date.UTC(2026, 10, 8, 5, 0);
  const call = async (user, req) => { env.user = user; env.now = at; return plain(await wf.POST(req)); };
  const json = (user, body) => call(user, { json: async () => body, headers: new Map() });
  const withPhoto = (user, body, file) => {
    const form = new FormData();
    form.append('payload', JSON.stringify(body));
    form.append('photo', file);
    return call(user, { headers: new Map([['content-type', 'multipart/form-data; boundary=x']]), formData: async () => form });
  };
  const get = async (user, q) => { env.user = user; env.now = at; return plain(await wf.GET({ url: `http://x/api/admin/workforce?${q}` })); };
  const report = { action: 'report_peer', staff_id: BINH.id, reason: 'Làm vỡ ly', note: 'bàn 5' };
  const jpg = new File([new Uint8Array(2000)], 'a.jpg', { type: 'image/jpeg' });

  // Kho ảnh lỗi: không ghi lần báo, báo rõ để gửi lại hoặc bỏ ảnh.
  files.down = true;
  const down = await withPhoto(AN, report, new File([new Uint8Array(2000)], 'a.jpg', { type: 'image/jpeg' }));
  assert.equal(down.status, 503);
  assert.match(down.body.error, /Xoá ảnh/);
  assert.equal(state.payroll_peer_reports.length, 0);
  files.down = false;

  // Ảnh sai loại: không ghi gì.
  const bad = await withPhoto(AN, report, new File(['x'], 'a.txt', { type: 'text/plain' }));
  assert.equal(bad.status, 400);
  assert.deepEqual([state.payroll_peer_reports.length, files.size], [0, 0]);

  const ok = await withPhoto(AN, report, jpg);
  assert.equal(ok.status, 200);
  const row = state.payroll_peer_reports[0];
  assert.match(row.photo_path, /^\d{4}-\d{2}\/peer-[\da-f-]{36}\.jpg$/);
  assert.deepEqual([...files.keys()], [row.photo_path]);

  // Không có ảnh vẫn báo được như trước.
  assert.equal((await json(AN, { ...report, reason: 'Ghi sai món', note: '' })).status, 200);
  assert.equal(state.payroll_peer_reports[1].photo_path, undefined);

  // Chủ quán thấy ảnh (link qua web của quán); người báo chỉ thấy "có ảnh".
  const link = `/api/admin/receipts/image?p=${encodeURIComponent(row.photo_path)}&token=aaa.bbb.ccc`;
  const owner = (await get(OWNER, 'peer=1')).body.reports;
  assert.deepEqual(owner.map(r => [r.reason, r.photo]).sort(), [['Ghi sai món', null], ['Làm vỡ ly', link]]);
  assert.deepEqual((await get(OWNER, 'inbox=1')).body.peers.map(r => [r.reason, r.photo]).sort(), [['Ghi sai món', null], ['Làm vỡ ly', link]]);
  const mine = (await get(AN, 'me=1')).body.peer.list;
  assert.deepEqual(mine.map(r => [r.reason, r.has_photo, r.photo]).sort(), [['Ghi sai món', false, undefined], ['Làm vỡ ly', true, undefined]]);
  assert.equal((await get(AN, 'peer=1')).status, 403, 'staff cannot open the owner list');

  // Chủ phạt lần báo có ảnh: bảng lương của chủ biết khoản phạt đó do ai báo và mở được ảnh; người bị phạt thấy ngày + lỗi + tiền,
  // không thấy người báo hay ảnh.
  const second = await withPhoto(AN, { ...report, reason: 'Để khách chờ lâu', note: 'bàn 7' }, jpg);
  const fined = await json(OWNER, { action: 'decide_peer', id: second.body.id, status: 'approved', amount: 20000 });
  assert.equal(fined.status, 200);
  const photoPath = state.payroll_peer_reports.find(r => r.id === second.body.id).photo_path;
  const month = (await get(OWNER, 'payroll=1&year=2026&month=11')).body;
  assert.deepEqual(month.peerFines, [{ violation_id: fined.body.violation_id, reporter: 'An', note: 'bàn 7',
    photo: `/api/admin/receipts/image?p=${encodeURIComponent(photoPath)}&token=aaa.bbb.ccc`, seen_at: null }]);
  const binh = (await get(BINH, 'me=1')).body.violations;
  assert.deepEqual(binh.map(v => [v.date, v.reason, v.amount]), [['2026-11-08', 'Để khách chờ lâu', 20000]]);
  assert.ok(!JSON.stringify(binh).includes('An') && !JSON.stringify(binh).includes('peer-'), 'the fined person sees neither the reporter nor the photo');
  assert.equal((await get(BINH, 'payroll=1&year=2026&month=11')).status, 403);

  // Người báo huỷ khi còn chờ: xoá luôn ảnh.
  assert.equal((await json(AN, { action: 'cancel_request', kind: 'peer', id: ok.body.id })).status, 200);
  assert.deepEqual([...files.keys()], [photoPath], 'only the cancelled report loses its photo');
});
