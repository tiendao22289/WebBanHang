import test from 'node:test';
import assert from 'node:assert/strict';
import { monthFolders, purgeOldNotePhotos } from '../src/lib/receiptImages.mjs';

test('month folders from the first note photo to the cutoff month', () => {
  assert.deepEqual(monthFolders('2026-11', new Date('2027-02-10T00:00:00Z')), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(monthFolders('2026-11', new Date('2026-10-10T00:00:00Z')), []);
});

test('note photos and bills older than 90 days are deleted; other receipt photos and newer ones stay', async () => {
  const now = Date.parse('2027-02-20T00:00:00Z');
  const files = {
    '2026-11': [{ name: 'note-a.jpg', created_at: '2026-11-05T00:00:00Z' }, { name: 'notebill-b.jpg', created_at: '2026-11-05T00:00:00Z' },
      { name: 'bill-c.jpg', created_at: '2026-11-05T00:00:00Z' }],
    '2026-12': [{ name: 'note-d.jpg', created_at: '2026-12-30T00:00:00Z' }],
  };
  const removed = [];
  const db = { storage: { from: () => ({
    list: async folder => ({ data: files[folder] || [], error: null }),
    remove: async list => { removed.push(...list); return { error: null }; },
  }) } };
  await purgeOldNotePhotos(db, now);
  assert.deepEqual(removed, ['2026-11/note-a.jpg', '2026-11/notebill-b.jpg']);
  await purgeOldNotePhotos(db, now + 3600000);
  assert.equal(removed.length, 2, 'runs at most every 6 hours');
});
