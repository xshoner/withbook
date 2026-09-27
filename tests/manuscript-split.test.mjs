import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, htmlToLines, splitManuscript, textToLines, pagesFor } from '../src/lib/manuscript-split.ts';

const L = (text) => textToLines(text);

test('classifies common Korean and English heading lines', () => {
  assert.equal(classifyLine({ text: '제1장 시작하며' }).kind, 'jang');
  assert.equal(classifyLine({ text: '제 3 장' }).num, 3);
  assert.equal(classifyLine({ text: '2장. 습관의 힘' }).rest, '습관의 힘');
  assert.equal(classifyLine({ text: 'Chapter IV - Night' }).num, 4);
  assert.equal(classifyLine({ text: '제2부 실천' }).kind, 'part');
  assert.equal(classifyLine({ text: '1.2 작은 성공' }).kind, 'dec');
  assert.equal(classifyLine({ text: '3. 아침 루틴' }).kind, 'num');
  assert.equal(classifyLine({ text: '프롤로그' }).special, 'front');
  assert.equal(classifyLine({ text: '에필로그: 다시 봄' }).special, 'back');
  assert.equal(classifyLine({ text: '## 소제목' }).kind, 'h2');
  assert.equal(classifyLine({ text: '아무 제목', level: 1 }).kind, 'h1');
  // 문장·긴 줄·‘1장짜리’ 같은 말은 제목이 아니다
  assert.equal(classifyLine({ text: '1. 우리는 매일 아침 같은 길을 걸었다.' }), null);
  assert.equal(classifyLine({ text: '1장짜리 보고서를 썼다' }), null);
  assert.equal(classifyLine({ text: '가'.repeat(80) }), null);
});

test('splits chapters by 제N장 and sections by 1.1, with prologue/epilogue as front/back matter', () => {
  const r = splitManuscript(L([
    '나의 책', '',
    '프롤로그', '처음 이야기를 꺼낸다.',
    '제1장 시작', '1.1 첫 절', '첫 절 본문이다.', '1.2 둘째 절', '둘째 절 본문이다.',
    '제2장', '끝과 시작', '1. 목록이 아니라', '장 도입 문단이다.', '2.1 셋째 절', '셋째 본문.',
    '에필로그', '마무리 글.',
  ].join('\n')));
  assert.equal(r.detected.chapter, 'jang');
  assert.equal(r.detected.section, 'dec');
  assert.deepEqual(r.chapters.map((c) => [c.kind, c.title]), [['front', '프롤로그'], ['body', '시작'], ['body', '끝과 시작'], ['back', '에필로그']]);
  assert.deepEqual(r.chapters[1].sections.map((s) => s.title), ['첫 절', '둘째 절']);
  assert.equal(r.chapters[1].sections[0].md, '첫 절 본문이다.');
  // ‘제2장’만 있는 줄은 다음 짧은 줄이 제목, 첫 절 앞 도입 글은 장 제목의 절
  assert.deepEqual(r.chapters[2].sections.map((s) => s.title), ['끝과 시작', '셋째 절']);
  assert.equal(r.chapters[2].sections[0].md, '1. 목록이 아니라\n장 도입 문단이다.');
  assert.equal(r.titleGuess, '나의 책');
  assert.ok(r.warnings.some((w) => /짧은 글/.test(w)));
});

test('docx heading styles win; a single 제목 1 is the book title', () => {
  const html = '<h1>책 제목</h1><h2>첫째 장</h2><p>본문 &amp; 설명</p><h3>절 하나</h3><p>절 본문</p><ul><li>항목</li></ul><h2>둘째 장</h2><p>둘째 본문</p>';
  const lines = htmlToLines(html);
  assert.deepEqual(lines[0], { text: '책 제목', level: 1 });
  assert.equal(lines.find((l) => l.text === '- 항목')?.text, '- 항목');
  const r = splitManuscript(lines);
  assert.equal(r.detected.chapter, 'h2');
  assert.equal(r.detected.section, 'h3');
  assert.equal(r.titleGuess, '책 제목');
  assert.deepEqual(r.chapters.map((c) => c.title), ['첫째 장', '둘째 장']);
  assert.deepEqual(r.chapters[0].sections.map((s) => [s.title, s.md]), [['첫째 장', '본문 & 설명'], ['절 하나', '절 본문\n- 항목']]);
});

test('markdown headings and author overrides', () => {
  const md = '# 1부\n## 장 A\n본문 A\n### 소제목\n더\n## 장 B\n본문 B';
  const auto = splitManuscript(L(md));
  assert.equal(auto.detected.chapter, 'h2');
  assert.deepEqual(auto.chapters.map((c) => c.title), ['장 A', '장 B']);
  const byH1 = splitManuscript(L(md), { chapter: 'h1', section: 'h2' });
  assert.equal(byH1.chapters.length, 1);
  assert.deepEqual(byH1.chapters[0].sections.map((s) => s.title), ['장 A', '장 B']);
  // 더 깊은 제목은 본문 소제목(##)으로 남는다
  assert.equal(byH1.chapters[0].sections[0].md, '본문 A\n## 소제목\n더');
  const flat = splitManuscript(L(md), { chapter: 'none', section: 'none' });
  assert.equal(flat.chapters.length, 1);
  assert.equal(flat.chapters[0].sections.length, 1);
});

test('numbered headings count only when they run 1, 2, 3 in order', () => {
  const r = splitManuscript(L(['1. 들어가는 문', '본문', '2. 두 번째 문', '본문', '5. 뜬금없는 번호', '3. 세 번째 문', '끝'].join('\n')));
  assert.equal(r.detected.chapter, 'num');
  assert.deepEqual(r.chapters.map((c) => c.title), ['들어가는 문', '두 번째 문', '세 번째 문']);
  assert.equal(r.chapters[1].sections[0].md, '본문\n5. 뜬금없는 번호');
});

test('no headings: whole text becomes one section, with a warning', () => {
  const r = splitManuscript(L('그냥 긴 글이다.\n둘째 문단이다.'));
  assert.equal(r.detected.chapter, 'none');
  assert.equal(r.chapters.length, 1);
  assert.equal(r.chapters[0].sections[0].md, '그냥 긴 글이다.\n둘째 문단이다.');
  assert.ok(r.warnings.some((w) => /찾지 못해/.test(w)));
});

test('PDF lines are re-joined and page numbers / running heads dropped', () => {
  const page = (n) => ['나의 책', n + '쪽 문장이 줄 끝에서', '끊겼다(' + n + ').', String(n)];
  const lines = L(['제1장 첫 장', ...page(1), ...page(2), ...page(3), ...page(4), ...page(5), '제2장 둘째 장', '마지막 문장.'].join('\n'));
  const r = splitManuscript(lines, { joinLines: true });
  assert.deepEqual(r.chapters.map((c) => c.title), ['첫 장', '둘째 장']);
  assert.equal(r.chapters[0].sections[0].md.split('\n')[0], '1쪽 문장이 줄 끝에서 끊겼다(1).');
  assert.ok(!/나의 책|^\d+$/m.test(r.chapters[0].sections[0].md));
});

test('target pages round to half pages', () => {
  assert.equal(pagesFor(0), 0.5);
  assert.equal(pagesFor(1400, 700), 2);
  assert.equal(pagesFor(1100, 700), 1.5);
});
