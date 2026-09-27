import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrintLayouts, editorBlocks, figureLabel, matchPrintLayout, mergePrintLayouts, tagKind, textLen } from '../src/components/editor/pageMap.ts';
import { sectionNavKey } from '../src/components/editor/shortcuts.ts';
import { buildPlan } from '../src/lib/autowrite.ts';

const p = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const fig = (assetId, caption = '') => ({ type: 'figure', attrs: { assetId, src: `/api/assets/${assetId}`, caption } });

test('paged DOM fragments become per-section block pages relative to the section start', () => {
  // 절 s1이 3쪽(인덱스 2)에서 시작: 제목 + 문단 A(3~4쪽에 걸침) + 그림(4쪽) + 문단 B(5쪽)
  const frags = [
    { sid: 's1', ref: '', tag: 'SECTION', cls: '', page: 2, len: 0 },
    { sid: 's1', ref: 'h', tag: 'H2', cls: 'sec-title', page: 2, len: 5 },
    { sid: 's1', ref: 'a', tag: 'P', cls: '', page: 2, len: 300 },
    { sid: 's1', ref: '', tag: 'SECTION', cls: '', page: 3, len: 0 },
    { sid: 's1', ref: 'a', tag: 'P', cls: '', page: 3, len: 120 },
    { sid: 's1', ref: 'f', tag: 'FIGURE', cls: 'fig fit cap', page: 3, len: 4, asset: 'img1' },
    { sid: 's1', ref: '', tag: 'SECTION', cls: '', page: 4, len: 0 },
    { sid: 's1', ref: 'b', tag: 'P', cls: '', page: 4, len: 50 },
    { sid: 's1', ref: 'e', tag: 'SPAN', cls: 'sec-end', page: 4, len: 0 },
    { sid: 's2', ref: '', tag: 'SECTION', cls: '', page: 5, len: 0 },
    { sid: 's2', ref: 'x', tag: 'P', cls: 'empty-note', page: 5, len: 10 },
  ];
  const m = buildPrintLayouts(frags);
  assert.deepEqual(m.s1.blocks, [
    { kind: 'p', len: 420, start: 0, end: 1 },
    { kind: 'fig', len: 4, asset: 'img1', start: 1, end: 1 },
    { kind: 'p', len: 50, start: 2, end: 2 },
  ]);
  // 빈 절 안내만 있는 절은 본문 블록이 없다
  assert.equal(m.s2, undefined);
});

test('editor blocks follow the print renderer rules (empty paragraphs are not printed, footnotes/whitespace do not count)', () => {
  const doc = {
    type: 'doc',
    content: [
      p('첫 문단 입니다'),
      p(''),
      p('   '),
      { type: 'paragraph', content: [{ type: 'text', text: '각주' }, { type: 'footnote', attrs: { note: '설명' } }] },
      fig('img1', '바다 풍경'),
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '소제목' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('하나')] }, { type: 'listItem', content: [p('둘')] }] },
      { type: 'horizontalRule' },
    ],
  };
  assert.deepEqual(editorBlocks(doc), [
    { kind: 'p', len: textLen('첫 문단 입니다') },
    { kind: null, len: 0 },
    { kind: null, len: 0 },
    { kind: 'p', len: 2 },
    { kind: 'fig', len: 4, asset: 'img1' },
    { kind: 'h', len: 3 },
    { kind: 'ul', len: 3 },
    { kind: 'hr', len: 0 },
  ]);
});

test('matching gives each top-level editor block its printed page, and refuses stale layouts', () => {
  const doc = { type: 'doc', content: [p('가'.repeat(420)), p(''), fig('img1', '그림 설명'), p('나'.repeat(50))] };
  const layout = {
    blocks: [
      { kind: 'p', len: 420, start: 0, end: 1 },
      { kind: 'fig', len: 4, asset: 'img1', start: 1, end: 1 },
      { kind: 'p', len: 50, start: 2, end: 2 },
    ],
  };
  assert.deepEqual(matchPrintLayout(editorBlocks(doc), layout), [{ start: 0, end: 1 }, null, { start: 1, end: 1 }, { start: 2, end: 2 }]);
  // 조판 뒤에 글을 고쳤다 → 쓰지 않는다 (화면 계산으로)
  const edited = { ...doc, content: [p('가'.repeat(421)), ...doc.content.slice(1)] };
  assert.equal(matchPrintLayout(editorBlocks(edited), layout), null);
  // 다른 그림으로 바꿨다
  const swapped = { ...doc, content: [doc.content[0], doc.content[1], fig('img2', '그림 설명'), doc.content[3]] };
  assert.equal(matchPrintLayout(editorBlocks(swapped), layout), null);
  // 캡션을 고쳤다 (캡션 줄 수가 달라져 쪽이 바뀔 수 있다)
  const recaptioned = { ...doc, content: [doc.content[0], doc.content[1], fig('img1', '더 긴 그림 설명'), doc.content[3]] };
  assert.equal(matchPrintLayout(editorBlocks(recaptioned), layout), null);
  // 블록을 더했다 · 조판 결과 없음
  assert.equal(matchPrintLayout(editorBlocks({ ...doc, content: [...doc.content, p('더')] }), layout), null);
  assert.equal(matchPrintLayout(editorBlocks(doc), undefined), null);
});

test('merging layouts keeps identity for unchanged sections', () => {
  const a = { blocks: [{ kind: 'p', len: 1, start: 0, end: 0 }] };
  const prev = { s1: a };
  assert.equal(mergePrintLayouts(prev, { s1: { blocks: [{ kind: 'p', len: 1, start: 0, end: 0 }] } }), prev);
  const next = mergePrintLayouts(prev, { s1: { blocks: [{ kind: 'p', len: 1, start: 1, end: 1 }] }, s2: a });
  assert.notEqual(next, prev);
  assert.equal(next.s2, a);
});

test('tag kinds and figure labels match the print renderer', () => {
  assert.equal(tagKind('H2', 'sec-title'), null);
  assert.equal(tagKind('P', 'empty-note'), null);
  assert.equal(tagKind('H4', 'sub'), 'h');
  assert.equal(tagKind('FIGURE', 'fig fullpage'), 'fig');
  assert.equal(figureLabel(2, 3), '그림 2-3');
  assert.equal(figureLabel(0, 1), '그림 1');
});

test('section navigation uses Alt+arrows only', () => {
  const k = (o) => sectionNavKey({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: 'ArrowDown', ...o });
  assert.equal(k({ altKey: true }), 'next');
  assert.equal(k({ altKey: true, key: 'ArrowUp' }), 'prev');
  assert.equal(k({ altKey: true, shiftKey: true }), 'nextEmpty');
  assert.equal(k({ ctrlKey: true }), null);
  assert.equal(k({ altKey: true, ctrlKey: true }), null);
  assert.equal(k({}), null);
});

test('auto-write range: only the picked sections, in book order, including front/back matter when picked', () => {
  const secs = [
    { id: 'f', label: '', title: '머리말', chapterTitle: '머리말', chapterKind: 'front', targetPages: 2, charCount: 0 },
    { id: 'a', label: '1.1', title: 'A', chapterTitle: '1장', chapterKind: 'body', targetPages: 3, charCount: 0 },
    { id: 'b', label: '1.2', title: 'B', chapterTitle: '1장', chapterKind: 'body', targetPages: 3, charCount: 100 },
    { id: 'c', label: '2.1', title: 'C', chapterTitle: '2장', chapterKind: 'body', targetPages: 3, charCount: 0 },
  ];
  const opts = { extraInstruction: '', factcheck: true, review: true, reviewLevel: 'light', rewrite: false };
  assert.deepEqual(buildPlan(secs, opts, false, ['c', 'f', 'a']).map((x) => x.sectionId), ['f', 'a', 'c']);
  assert.deepEqual(buildPlan(secs, opts, false, []).length, 0);
  // 범위 없이 부르면 예전처럼 책 전체(본문만)
  assert.deepEqual(buildPlan(secs, opts, false).map((x) => x.sectionId), ['a', 'b', 'c']);
  // 본문이 있는 절은 새로 쓰기를 켜지 않으면 집필을 건너뛴다
  assert.equal(buildPlan(secs, opts, false, ['b'])[0].write, 'skipped');
});
