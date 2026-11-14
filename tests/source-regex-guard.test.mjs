import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Code sửa bằng lệnh có thể mất dấu "\" trong biểu thức: "/\./g" thành "/./g" (xoá hết mọi ký tự),
// "/\D/g" thành "/D/g". Lỗi kiểu này làm "Tiền chủ giao 10.000.000" thành 0đ ở Tổng kết Sổ tay (2026-11-14).
const ROOT = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOST = [
  [/\.replace\(\/\.\/g/, '.replace(/./g — dấu chấm thiếu "\\" xoá hết mọi ký tự'],
  [/\.replace\(\/[DdSsWw]\+?\/g/, '.replace(/D/g, /s+/g… — thiếu "\\" trước D / d / s / w'],
];

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(m?js|jsx)$/.test(name) ? [path] : [];
  });
}

test('no regex in the app lost its backslash', () => {
  const found = [];
  for (const file of files(ROOT)) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const [pattern, why] of LOST) if (pattern.test(line)) found.push(`${relative(ROOT, file)}:${i + 1} ${why}`);
    });
  }
  assert.deepEqual(found, []);
});
