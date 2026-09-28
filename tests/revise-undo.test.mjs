import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc, textblocks } from '../src/lib/doc/doc.ts';
import { applyBlockChanges, undoBlockChanges } from '../src/lib/doc/edit.ts';

const texts = (d) => textblocks(d).map((b) => b.text);

test('chapter revise undo restores the snapshot when nothing changed since', () => {
  const before = markdownToDoc('첫 문단입니다.\n\n둘째 문단입니다.');
  const changes = [{ paragraph: 2, before: '둘째 문단', after: '두 번째 문단' }];
  const after = applyBlockChanges(before, changes).doc;
  const r = undoBlockChanges(after, changes, before);
  assert.equal(r.restored, true);
  assert.deepEqual(texts(r.doc), ['첫 문단입니다.', '둘째 문단입니다.']);
});

test('chapter revise undo reverses only the revised text and keeps later edits', () => {
  const before = markdownToDoc('첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단, 지울 문장. 남길 문장.');
  const changes = [
    { paragraph: 1, before: '첫 문단', after: '처음 문단' },
    { paragraph: 2, before: '둘째 문단', after: '두 번째 문단' },
    { paragraph: 3, before: '지울 문장. ', after: '' },
  ];
  const revised = applyBlockChanges(before, changes).doc;
  // 퇴고 뒤 작가가 첫 문단을 또 고쳤다
  const edited = applyBlockChanges(revised, [{ paragraph: 1, before: '입니다.', after: '이에요.' }]).doc;
  const r = undoBlockChanges(edited, changes, null);
  assert.equal(r.restored, false);
  assert.equal(r.reverted, 2);
  assert.equal(r.failed, 1); // 통째로 지운 글은 되찾을 자리가 없다
  assert.deepEqual(texts(r.doc), ['첫 문단이에요.', '둘째 문단입니다.', '셋째 문단, 남길 문장.']);
});

test('chapter revise undo reports nothing to do when the revised text is gone', () => {
  const doc = markdownToDoc('완전히 새로 쓴 문단.');
  const r = undoBlockChanges(doc, [{ paragraph: 1, before: '옛 글', after: '새 글' }], null);
  assert.equal(r.doc, null);
  assert.equal(r.failed, 1);
});
