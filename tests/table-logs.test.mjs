import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server.js';
import { billLog, mergeLogPage, LOG_PAGE_SIZE, LOG_SOURCES } from '../src/lib/tableLogs.mjs';

test('pagination merges all sources newest first without losing or duplicating events', () => {
  const all = Object.fromEntries(LOG_SOURCES.map((source, sourceIndex) => [source,
    Array.from({ length: 83 }, (_, index) => ({ id: `${source}:${index}`, at: new Date(1800000000000 - index * 3000 - sourceIndex * 1000).toISOString() })),
  ]));
  let offsets = { paid: 0, cancelled: 0, opened: 0 };
  const output = [];
  for (let page = 0; page < 10; page++) {
    const streams = Object.fromEntries(LOG_SOURCES.map(source => [source, all[source].slice(offsets[source], offsets[source] + LOG_PAGE_SIZE)]));
    const result = mergeLogPage(streams, offsets);
    output.push(...result.entries);
    offsets = result.nextOffsets;
    if (!result.hasMore) break;
  }
  assert.equal(output.length, 249);
  assert.equal(new Set(output.map(entry => entry.id)).size, 249);
  assert.ok(output.every((entry, index) => !index || Date.parse(output[index - 1].at) >= Date.parse(entry.at)));
});

test('archived bill normalization preserves details and excludes customer phone', () => {
  const entry = billLog({ id: 'a', table_id: 'b', table_number: 3, paid_at: '2026-10-13', paid_by_name: 'Admin', total_amount: 50000, customer_phone: 'private', order_items: [{ quantity: 2, unit_price: 25000, item_name: 'Món', added_by_name: 'NV', item_options: [{ choice: 'Cay' }] }] }, null, 'paid', ['b', 'c']);
  assert.equal(entry.actor, 'Admin');
  assert.equal(entry.items[0].name, 'Món');
  assert.equal(entry.items[0].addedBy, 'NV');
  assert.equal(entry.items[0].note, 'Cay');
  assert.deepEqual(entry.tableIds, ['b', 'c']);
  assert.equal(entry.customer_phone, undefined);
});

const source = readFileSync(new URL('../src/app/api/admin/logs/route.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
function route(code) {
  return compileFunction(`${source}\nreturn GET;`, ['NextResponse', 'requireStatusAdmin', 'statusDatabase', 'billLog', 'mergeLogPage', 'LOG_PAGE_SIZE', 'LOG_SOURCES'])(
    NextResponse, async () => code, () => { throw new Error('Unauthorized query'); }, billLog, mergeLogPage, LOG_PAGE_SIZE, LOG_SOURCES,
  );
}
for (const code of [401, 403, 503]) {
  test(`route denies ${code} before querying history`, async () => {
    const response = await route(code)(new Request('http://localhost/api/admin/logs'));
    assert.equal(response.status, code);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
}
test('route rejects invalid table IDs and pagination cursors', async () => {
  for (const query of ['table=invalid', 'cursor=forged', `cursor=${Buffer.from(JSON.stringify({ paid: -1 })).toString('base64url')}`]) {
    assert.equal((await route(200)(new Request(`http://localhost/api/admin/logs?${query}`))).status, 400);
  }
});
