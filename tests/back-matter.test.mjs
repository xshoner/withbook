import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBiblioCandidates, frequentWords, groupIndex, indexHead, normalizeBiblio, normalizeIndex, pageRanges } from '../src/lib/back-matter.ts';

test('index terms are cleaned, deduplicated and grouped 가나다 → ABC → 기타 with tense consonants merged', () => {
  const ix = normalizeIndex({ enabled: 1, terms: [
    { term: ' 학습 ', aliases: '배움, 학습, ' },
    { term: '학습', aliases: [] },
    { term: 'AI', aliases: ['인공지능'] },
    { term: '까마귀' },
    { term: '가치' },
    { term: '2차 세계대전' },
    { term: '' },
  ] });
  assert.equal(ix.enabled, true);
  assert.deepEqual(ix.terms.map((t) => t.term), ['학습', 'AI', '까마귀', '가치', '2차 세계대전']);
  assert.deepEqual(ix.terms[0].aliases, ['배움']);
  assert.equal(indexHead('까마귀'), 'ㄱ');
  assert.equal(indexHead('ai'), 'A');
  assert.deepEqual(groupIndex(ix.terms).map((g) => [g.head, g.terms.map((t) => t.term)]), [
    ['ㄱ', ['가치', '까마귀']],
    ['ㅎ', ['학습']],
    ['A', ['AI']],
    ['기타', ['2차 세계대전']],
  ]);
});

test('index page lists collapse consecutive pages', () => {
  assert.equal(pageRanges([30, 12, 15, 16, 17, 12, 0]), '12, 15–17, 30');
  assert.equal(pageRanges([4, 5]), '4, 5');
  assert.equal(pageRanges([]), '');
});

test('bibliography entries are trimmed, deduplicated and keep stable ids', () => {
  const b = normalizeBiblio({ enabled: true, entries: [{ id: 'x1', text: '홍길동, 『배움』, 2021.' }, '  홍길동, 『배움』, 2021.  ', { text: '' }, '통계청, 「인구동향」, 2025.'] });
  assert.deepEqual(b.entries.map((e) => e.text), ['홍길동, 『배움』, 2021.', '통계청, 「인구동향」, 2025.']);
  assert.equal(b.entries[0].id, 'x1');
  assert.match(b.entries[1].id, /^[a-z0-9]+$/);
});

test('bibliography candidates come from source-like footnotes, figure credits and reference names only', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [
        { type: 'text', text: '본문' },
        { type: 'footnote', attrs: { note: '홍길동, 『배움의 과학』, 가나출판사, 2021, 45쪽.' } },
        { type: 'footnote', attrs: { note: '여기서 학습은 넓은 뜻으로 쓴다.' } },
      ] },
      { type: 'figure', attrs: { caption: '그림 1. 뉴런 — 출처: Wikimedia Commons, CC BY-SA 4.0' } },
      { type: 'figure', attrs: { caption: '그림 2. 나의 책상' } },
    ],
  };
  const c = collectBiblioCandidates([{ where: '1장 · 1절', content: doc, refs: ['2025 교육부 보도자료', '2025 교육부 보도자료'] }]);
  assert.deepEqual(c.map((x) => x.from), ['footnote', 'figure', 'reference']);
  assert.match(c[0].text, /배움의 과학/);
});

test('frequent words strip common particles and ignore rare words', () => {
  const w = frequentWords('학습은 중요하다. 학습을 한다. 학습이 쌓인다. 기억은 한 번.');
  assert.ok(w.includes('학습(3)'));
  assert.ok(!w.some((x) => x.startsWith('기억')));
});
