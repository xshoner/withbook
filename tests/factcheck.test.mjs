import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc, textblocks, findFootnotes } from '../src/lib/doc/doc.ts';
import { applyFactCheck, factCheckTarget, findMarkers, locateMarker, markerSentence, withoutMarkers } from '../src/lib/doc/edit.ts';
import { scopeForPurpose, parseAiScope } from '../src/lib/ai/routing.ts';

const text = (doc) => textblocks(doc).map((b) => b.text);

test('factcheck has its own connection scope', () => {
  assert.equal(scopeForPurpose('factcheck'), 'factcheck');
  assert.equal(parseAiScope('factcheck'), 'factcheck');
});

test('marker sentence covers the sentence with the marker before or after the period', () => {
  const t = '첫 문장이다. 매출은 30% 늘었다 [확인 필요]. 끝 문장.';
  const at = t.indexOf('[확인');
  const r = markerSentence(t, at, '[확인 필요]'.length);
  assert.equal(t.slice(r.start, r.end), '매출은 30% 늘었다 [확인 필요].');
  const t2 = '인구는 5,100만 명이다. [확인 필요] 다음 문장.';
  const r2 = markerSentence(t2, t2.indexOf('['), '[확인 필요]'.length);
  assert.equal(t2.slice(r2.start, r2.end), '인구는 5,100만 명이다. [확인 필요]');
  const t3 = '성장률은 3.5%였다[확인 필요: 2024년 기준].';
  const r3 = markerSentence(t3, t3.indexOf('['), '[확인 필요: 2024년 기준]'.length);
  assert.equal(t3.slice(r3.start, r3.end), t3);
  assert.equal(withoutMarkers(t3.slice(r3.start, r3.end)), '성장률은 3.5%였다.');
});

test('locateMarker follows a marker whose offset moved', () => {
  const t = '앞 문장이 길게 바뀌었다. 수치는 10%다 [확인 필요].';
  assert.equal(locateMarker(t, '[확인 필요]', '수치는 10%다 ', 5), t.indexOf('['));
  assert.equal(locateMarker(t, '[확인 필요]', '다른 글', 5), -1);
});

test('revise replaces only the checked sentence and keeps other markers and footnotes', () => {
  const doc = markdownToDoc('서론이다⟦주:설명.⟧. 인구는 4천만 명이다 [확인 필요]. 수출은 1위다 [확인 필요].');
  const [m1, m2] = findMarkers(doc);
  const t1 = factCheckTarget(doc, m1);
  assert.equal(t1.sentence, '인구는 4천만 명이다 [확인 필요].');
  const next = applyFactCheck(doc, m1, t1.sentence, '인구는 통계청 2025년 기준 5,168만 명이다.');
  assert.deepEqual(text(next), ['서론이다. 인구는 통계청 2025년 기준 5,168만 명이다. 수출은 1위다 [확인 필요].']);
  assert.equal(findFootnotes(next).length, 1);
  // 두 번째 표시는 앞 문장이 길어져 위치가 밀려도 찾는다
  const t2 = factCheckTarget(next, m2);
  const passed = applyFactCheck(next, m2, t2.sentence, withoutMarkers(t2.sentence));
  assert.deepEqual(text(passed), ['서론이다. 인구는 통계청 2025년 기준 5,168만 명이다. 수출은 1위다.']);
  // 판정 뒤 문장이 바뀌었으면 쓰지 않는다
  assert.equal(applyFactCheck(doc, m1, '다른 문장', 'x'), null);
});

test('footnote markers are checked and replaced inside the footnote', () => {
  const doc = markdownToDoc('용어⟦주:1990년에 처음 쓰였다 [확인 필요].⟧를 쓴다.');
  const [m] = findMarkers(doc);
  const t = factCheckTarget(doc, m);
  assert.equal(t.sentence, '1990년에 처음 쓰였다 [확인 필요].');
  const next = applyFactCheck(doc, m, t.sentence, '1989년에 처음 쓰였다.');
  assert.equal(findFootnotes(next)[0].attrs.note, '1989년에 처음 쓰였다.');
});
