import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MIN_IDLE_MS, RETRY_SAME_BUILD_MS, coversScreen, hasUnsentText, isEditing, isNewBuild, isOverlay, isReloadSafeField,
  isTextEntry, parseAttempt, reloadDecision, reloadHoldLabels, setReloadHold,
} from '../src/lib/buildRefresh.mjs';

const require = createRequire(import.meta.url);
const { makeBuildId } = require('../src/lib/buildId.cjs');

const NOW = 1_800_000_000_000;
// Tab PC để yên, không có gì mở, máy chủ vừa lên bản mới.
const idle = (over = {}) => ({ current: 'old-1', latest: 'new-2', idleMs: 5 * 60 * 1000, now: NOW, ...over });

// Phần tử giả cho phần đọc ô nhập.
const input = (over = {}) => ({ tagName: 'INPUT', type: 'text', value: '', isConnected: true, getAttribute: () => null, ...over });
const textarea = (over = {}) => ({ tagName: 'TEXTAREA', value: '', isConnected: true, getAttribute: () => null, ...over });
const marked = attrs => name => (name in attrs ? attrs[name] : null);

test('chỉ coi là bản mới khi biết cả hai mã và hai mã khác nhau', () => {
  assert.equal(isNewBuild('a', 'b'), true);
  assert.equal(isNewBuild('a', 'a'), false);
  assert.equal(isNewBuild('a', ' a '), false);
  assert.equal(isNewBuild('a', ''), false, 'máy chủ trả rỗng (bản cũ chưa có mã) → không tải');
  assert.equal(isNewBuild('a', null), false, 'lỗi mạng / máy chủ đang khởi động lại → không tải');
  assert.equal(isNewBuild('', 'b'), false, 'trang không có mã của mình → không so được');
  assert.equal(isNewBuild(undefined, 'b'), false);
});

test('cùng bản hoặc không biết bản → không làm gì', () => {
  assert.deepEqual(reloadDecision(idle({ latest: 'old-1' })), { action: 'none', reason: 'same-build' });
  assert.deepEqual(reloadDecision(idle({ latest: null })), { action: 'none', reason: 'unknown' });
  assert.deepEqual(reloadDecision({}), { action: 'none', reason: 'unknown' });
});

test('bản mới + để yên + không có gì mở → tải lại', () => {
  assert.deepEqual(reloadDecision(idle()), { action: 'reload', reason: 'idle' });
  assert.deepEqual(reloadDecision(idle({ idleMs: MIN_IDLE_MS })), { action: 'reload', reason: 'idle' });
});

test('vừa có người chạm/gõ → chờ; tab đang ẩn thì khỏi chờ để yên', () => {
  assert.deepEqual(reloadDecision(idle({ idleMs: 2000 })), { action: 'wait', reason: 'recent-activity' });
  assert.deepEqual(reloadDecision(idle({ idleMs: MIN_IDLE_MS - 1 })), { action: 'wait', reason: 'recent-activity' });
  assert.deepEqual(reloadDecision(idle({ idleMs: NaN })), { action: 'wait', reason: 'recent-activity' });
  assert.deepEqual(reloadDecision(idle({ idleMs: 0, hidden: true })), { action: 'reload', reason: 'hidden' });
});

test('khung / Swal đang mở → chờ (kể cả tab ẩn)', () => {
  assert.equal(reloadDecision(idle({ modalOpen: true })).action, 'wait');
  assert.deepEqual(reloadDecision(idle({ modalOpen: true, hidden: true })), { action: 'wait', reason: 'modal' });
});

test('đang gõ hoặc còn chữ chưa gửi → chờ', () => {
  assert.deepEqual(reloadDecision(idle({ editing: true })), { action: 'wait', reason: 'editing' });
  assert.deepEqual(reloadDecision(idle({ unsentText: true })), { action: 'wait', reason: 'unsent-text' });
  assert.deepEqual(reloadDecision(idle({ unsentText: true, hidden: true })), { action: 'wait', reason: 'unsent-text' });
});

test('trang giữ (giỏ nháp có món, đang thanh toán / đóng bàn) → chờ, nêu lý do giữ', () => {
  assert.deepEqual(reloadDecision(idle({ holds: ['giỏ nháp'] })), { action: 'wait', reason: 'hold:giỏ nháp' });
  assert.deepEqual(reloadDecision(idle({ holds: ['thanh toán'], hidden: true })), { action: 'wait', reason: 'hold:thanh toán' });
  assert.equal(reloadDecision(idle({ holds: [] })).action, 'reload');
});

test('hết giữ / đóng khung / gõ xong và để yên → lần xem sau tải lại', () => {
  const states = [
    idle({ holds: ['giỏ nháp'], idleMs: 1000 }),
    idle({ modalOpen: true, idleMs: 1000 }),
    idle({ idleMs: 1000 }),
    idle({ idleMs: MIN_IDLE_MS + 1 }),
  ];
  assert.deepEqual(states.map(s => reloadDecision(s).action), ['wait', 'wait', 'wait', 'reload']);
});

test('đã tải lại vì đúng bản này mà vẫn cũ → không tải liên tục, 30 phút sau mới thử lại', () => {
  const lastAttempt = { build: 'new-2', at: NOW - 60_000 };
  assert.deepEqual(reloadDecision(idle({ lastAttempt })), { action: 'none', reason: 'already-tried' });
  assert.equal(reloadDecision(idle({ lastAttempt: { build: 'new-2', at: NOW - RETRY_SAME_BUILD_MS } })).action, 'reload');
  // Lần trước tải vì bản khác (bản mới hơn nữa đã lên) → tải tiếp bình thường.
  assert.equal(reloadDecision(idle({ lastAttempt: { build: 'new-1', at: NOW - 1000 } })).action, 'reload');
});

test('đọc bản ghi lần tải trước an toàn', () => {
  assert.deepEqual(parseAttempt(JSON.stringify({ build: 'b', at: 5 })), { build: 'b', at: 5 });
  assert.equal(parseAttempt(null), null);
  assert.equal(parseAttempt('không phải json'), null);
  assert.equal(parseAttempt(JSON.stringify({ build: '', at: 5 })), null);
  assert.equal(parseAttempt(JSON.stringify({ build: 'b', at: 'x' })), null);
});

test('giữ / thả theo từng chỗ gọi', () => {
  setReloadHold('a', 'giỏ nháp', true);
  setReloadHold('b', 'thanh toán', true);
  setReloadHold('a', 'giỏ nháp', true);
  assert.deepEqual(reloadHoldLabels(), ['giỏ nháp', 'thanh toán']);
  setReloadHold('a', 'giỏ nháp', false);
  assert.deepEqual(reloadHoldLabels(), ['thanh toán']);
  setReloadHold('b', null, false);
  assert.deepEqual(reloadHoldLabels(), []);
});

test('ô gõ chữ: input chữ/số, textarea, vùng sửa được; không tính nút, ô tích, ô khoá', () => {
  assert.equal(isTextEntry(input()), true);
  assert.equal(isTextEntry(input({ type: 'number' })), true);
  assert.equal(isTextEntry(input({ type: 'tel' })), true);
  assert.equal(isTextEntry(textarea()), true);
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextEntry(input({ type: 'checkbox' })), false);
  assert.equal(isTextEntry(input({ type: 'button' })), false);
  assert.equal(isTextEntry(input({ type: 'file' })), false);
  assert.equal(isTextEntry(input({ readOnly: true })), false);
  assert.equal(isTextEntry(input({ disabled: true })), false);
  assert.equal(isTextEntry({ tagName: 'SELECT' }), false);
  assert.equal(isTextEntry({ tagName: 'BUTTON' }), false);
  assert.equal(isTextEntry(null), false);
});

test('đang gõ = con trỏ trong ô nhập; ô tìm kiếm / data-reload-safe không tính', () => {
  assert.equal(isEditing(input()), true);
  assert.equal(isEditing(textarea()), true);
  assert.equal(isEditing({ tagName: 'BODY' }), false);
  assert.equal(isEditing(null), false);
  assert.equal(isReloadSafeField(input({ type: 'search' })), true);
  assert.equal(isEditing(input({ type: 'search' })), false);
  assert.equal(isEditing(input({ getAttribute: marked({ 'data-reload-safe': '' }) })), false);
});

test('chữ chưa gửi: chỉ ô người dùng đã gõ, còn trên trang và còn chữ', () => {
  const typed = input({ value: 'ghi chú bàn 5' });
  const cleared = input({ value: '   ' });
  const removed = textarea({ value: 'đã đóng khung', isConnected: false });
  const search = input({ type: 'search', value: 'ốc' });
  const safe = input({ value: '5', getAttribute: marked({ 'data-reload-safe': '' }) });

  assert.equal(hasUnsentText(new Set([cleared, search, safe])), false, 'ô trống / ô tìm kiếm không giữ');
  const touched = new Set([cleared, removed, typed]);
  assert.equal(hasUnsentText(touched), true);
  assert.equal(touched.has(removed), false, 'ô đã rời trang bị bỏ khỏi danh sách');
  typed.value = '';
  assert.equal(hasUnsentText(touched), false, 'gửi xong ô trống lại → hết giữ');
  assert.equal(hasUnsentText(new Set([{ tagName: 'DIV', isContentEditable: true, textContent: 'abc', isConnected: true }])), true);
});

test('khung đang mở = phần tử fixed phủ gần hết màn hình; sidebar / thông báo nhỏ không tính', () => {
  const W = 1366, H = 768;
  const fixed = { position: 'fixed', display: 'flex', visibility: 'visible' };
  assert.equal(isOverlay(fixed, { width: W, height: H }, W, H), true, 'lớp mờ inset:0');
  assert.equal(isOverlay(fixed, { width: 230, height: H }, W, H), false, 'sidebar cố định bên trái');
  assert.equal(isOverlay(fixed, { width: W, height: 64 }, W, H), false, 'thanh tab dưới đáy (điện thoại)');
  assert.equal(isOverlay(fixed, { width: 320, height: 60 }, W, H), false, 'thông báo nhỏ');
  assert.equal(isOverlay({ ...fixed, position: 'relative' }, { width: W, height: H }, W, H), false, 'khung chính của trang');
  assert.equal(isOverlay({ ...fixed, visibility: 'hidden' }, { width: W, height: H }, W, H), false);
  assert.equal(isOverlay({ ...fixed, display: 'none' }, { width: W, height: H }, W, H), false);
  assert.equal(coversScreen({ width: 900, height: 500 }, W, H), true);
  assert.equal(coversScreen({ width: 900, height: 500 }, 0, H), false);
});

test('mã bản: mỗi lần build một mã, có mã commit khi chạy trên GitHub Actions', () => {
  const sha = 'ABCDEF0123456789abcdef0123456789abcdef01';
  assert.equal(makeBuildId({ GITHUB_SHA: sha }, 36 ** 3), 'abcdef012345-1000');
  assert.equal(makeBuildId({}, 35), 'local-z');
  assert.equal(makeBuildId({ GITHUB_SHA: 'not a sha' }, 35), 'local-z');
  assert.notEqual(makeBuildId({}, 1000), makeBuildId({}, 1001));
});
