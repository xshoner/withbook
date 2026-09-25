import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc, textblocks, findFootnotes } from '../src/lib/doc/doc.ts';
import { applyBlockChanges, replaceAllInDoc, replaceRange, searchDoc } from '../src/lib/doc/edit.ts';

const text = (doc) => textblocks(doc).map((b) => b.text);

test('replaceAll keeps bold marks and footnotes', () => {
  const doc = markdownToDoc('인공지능은 **인공지능 기술**이다. 알고리즘⟦주:절차다.⟧을 쓴다.');
  const r = replaceAllInDoc(doc, '인공지능', 'AI');
  assert.equal(r.count, 2);
  assert.deepEqual(text(r.doc), ['AI은 AI 기술이다. 알고리즘을 쓴다.']);
  const bold = r.doc.content[0].content.find((n) => n.marks?.[0]?.type === 'bold');
  assert.equal(bold.text, 'AI 기술');
  assert.equal(findFootnotes(r.doc).length, 1);
});

test('footnote after a replaced term stays after the new term', () => {
  const doc = markdownToDoc('알고리즘⟦주:절차다.⟧을 배운다.');
  const r = replaceAllInDoc(doc, '알고리즘', '규칙');
  const inl = r.doc.content[0].content;
  assert.equal(inl[0].text, '규칙');
  assert.equal(inl[1].type, 'footnote');
});

test('replaceRange can insert an atom (marker → footnote)', () => {
  const doc = markdownToDoc('매출은 30% 늘었다[확인 필요].');
  const block = doc.content[0];
  const at = '매출은 30% 늘었다'.length;
  const fn = { type: 'footnote', attrs: { note: '통계청 2025', term: '늘었다', auto: false } };
  const b = replaceRange(block, at, at + '[확인 필요]'.length, '', fn);
  assert.equal(text({ type: 'doc', content: [b] })[0], '매출은 30% 늘었다.');
  assert.equal(b.content[1].type, 'footnote');
});

test('applyBlockChanges applies unique matches and rejects ambiguous ones', () => {
  const doc = markdownToDoc('가나다 가나다\n\n라마바를 쓴다');
  const r = applyBlockChanges(doc, [
    { paragraph: 1, before: '가나다', after: 'x' },
    { paragraph: 2, before: '라마바를', after: '라마바을' },
    { paragraph: 9, before: '없음', after: 'y' },
  ]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.failed.length, 2);
  assert.deepEqual(text(r.doc), ['가나다 가나다', '라마바을 쓴다']);
});

test('searchDoc reports paragraph and context', () => {
  const hits = searchDoc(markdownToDoc('첫 문단\n\n둘째 [확인 필요] 문단'), '[확인 필요]', 3);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].paragraph, 2);
  assert.equal(hits[0].before, '둘째 ');
});

test('findMarkers finds body and footnote markers; resolveMarker removes or converts', async () => {
  const { findMarkers, resolveMarker } = await import('../src/lib/doc/edit.ts');
  const doc = markdownToDoc('매출은 30% 늘었다 [확인 필요]. 용어⟦주:1998년 도입[확인 필요]⟧이다.');
  const ms = findMarkers(doc);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].offset >= 0, true);
  assert.equal(ms[1].offset, -1);
  const removed = resolveMarker(doc, ms[0], 'remove');
  assert.equal(text(removed)[0], '매출은 30% 늘었다. 용어이다.');
  const fnDoc = resolveMarker(doc, ms[0], 'footnote', '통계청, 2025');
  const notes = findFootnotes(fnDoc).map((f) => f.attrs.note);
  assert.deepEqual(notes, ['통계청, 2025', '1998년 도입[확인 필요]']);
  assert.equal(findFootnotes(fnDoc)[0].attrs.term, '늘었다');
  const noteFixed = resolveMarker(doc, ms[1], 'remove');
  assert.equal(findFootnotes(noteFixed)[0].attrs.note, '1998년 도입');
  // 원고가 바뀌어 자리가 다르면 적용하지 않는다
  assert.equal(resolveMarker(doc, { ...ms[0], offset: 3 }, 'remove'), null);
});
