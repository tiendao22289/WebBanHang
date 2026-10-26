import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraErrorText } from '../src/lib/cameraErrors.mjs';

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const ZALO = `${ANDROID} Zalo android/12345 ZaloTheme/light`;

test('when the in-page camera fails, staff are told why and pointed to the phone camera, with the error code', () => {
  const denied = cameraErrorText({ name: 'NotAllowedError' }, ANDROID);
  assert.match(denied, /Chưa cho phép camera/);
  assert.match(denied, /Dùng camera của máy/);
  assert.match(denied, /mã lỗi: NotAllowedError/);
  assert.match(cameraErrorText({ name: 'NotAllowedError' }, ZALO), /Zalo \/ Facebook không cho trang dùng camera.*Chrome/);
  assert.match(cameraErrorText({ name: 'NotReadableError' }, ANDROID), /ứng dụng khác dùng/);
  assert.match(cameraErrorText({ name: 'AbortError' }, ANDROID), /ứng dụng khác dùng.*mã lỗi: AbortError/);
  assert.match(cameraErrorText({ name: 'OverconstrainedError' }, ANDROID), /Không mở được camera trong trang.*Dùng camera của máy.*OverconstrainedError/);
  assert.match(cameraErrorText(null, ANDROID), /mã lỗi: không rõ/);
});
