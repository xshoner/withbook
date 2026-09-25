import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterInsertIndex, insertIndex, serializeEntry, snapSection, trashKey } from '../src/lib/trash.ts';

const sec = (id, content = 'x', versions = []) => ({
  id, title: `절 ${id}`, gist: '', hook: '', targetPages: 3, status: 'editing', sketch: '', content, charCount: content.length,
  summary: null, summaryHash: null, updatedAt: new Date('2026-09-01T00:00:00Z'), versions,
});

test('trash key is scoped by project', () => {
  assert.equal(trashKey('p1', 's1'), 'trash:p1:s1');
  assert.ok(trashKey('p1', 's1').startsWith(trashKey('p1', '')));
});

test('snapSection keeps content and versions with ISO dates', () => {
  const s = snapSection(sec('a', '본문', [{ id: 'v1', reason: 'manual', content: '옛글', charCount: 2, createdAt: new Date('2026-09-02T00:00:00Z') }]));
  assert.equal(s.content, '본문');
  assert.equal(s.updatedAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(s.versions, [{ id: 'v1', reason: 'manual', content: '옛글', charCount: 2, createdAt: '2026-09-02T00:00:00.000Z' }]);
});

test('serializeEntry drops versions (not content) when too large', () => {
  const big = 'v'.repeat(2000);
  const e = {
    meta: { id: 'c1', kind: 'chapter', title: '장', label: '1장', deletedAt: '2026-09-25T00:00:00Z', charCount: 4 },
    projectId: 'p1', chapterKind: 'body', index: 0,
    chapter: { id: 'c1', title: '장', kind: 'body', promise: '', summary: null, summaryHash: null,
      sections: [snapSection(sec('a', '본문', [{ id: 'v1', reason: 'manual', content: big, charCount: big.length, createdAt: new Date() }]))] },
  };
  const small = JSON.parse(serializeEntry(e));
  assert.equal(small.chapter.sections[0].versions.length, 1);
  assert.equal(small.meta.versionsDropped, undefined);
  const lean = JSON.parse(serializeEntry(e, 1000));
  assert.equal(lean.chapter.sections[0].versions.length, 0);
  assert.equal(lean.chapter.sections[0].content, '본문');
  assert.equal(lean.meta.versionsDropped, true);
});

test('insertIndex clamps to list', () => {
  assert.equal(insertIndex(3, 1), 1);
  assert.equal(insertIndex(3, 9), 3);
  assert.equal(insertIndex(0, 2), 0);
  assert.equal(insertIndex(3, -1), 0);
});

test('chapterInsertIndex keeps position within same kind', () => {
  const cs = [{ kind: 'front' }, { kind: 'body' }, { kind: 'body' }, { kind: 'back' }];
  assert.equal(chapterInsertIndex(cs, 'body', 0), 1);
  assert.equal(chapterInsertIndex(cs, 'body', 1), 2);
  assert.equal(chapterInsertIndex(cs, 'body', 5), 3); // 마지막 본문 장 뒤, 뒷붙이 앞
  assert.equal(chapterInsertIndex(cs, 'front', 3), 1);
  assert.equal(chapterInsertIndex(cs, 'back', 0), 3);
});

test('chapterInsertIndex falls back to kind order when kind is gone', () => {
  assert.equal(chapterInsertIndex([{ kind: 'body' }, { kind: 'back' }], 'front', 0), 0);
  assert.equal(chapterInsertIndex([{ kind: 'front' }, { kind: 'back' }], 'body', 2), 1);
  assert.equal(chapterInsertIndex([{ kind: 'front' }, { kind: 'body' }], 'back', 0), 2);
  assert.equal(chapterInsertIndex([], 'body', 0), 0);
});
