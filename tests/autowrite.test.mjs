import test from 'node:test';
import assert from 'node:assert/strict';
import { allFinished, buildPlan, isAutoRun, prepareResume, summarize } from '../src/lib/autowrite.ts';

const opts = { extraInstruction: '', factcheck: true, review: true, reviewLevel: 'light', rewrite: false };
const secs = [
  { id: 'f', label: '', title: '머리말', chapterTitle: '앞붙이', chapterKind: 'front', targetPages: 2, charCount: 0 },
  { id: 'a', label: '1.1', title: '처음', chapterTitle: '1장', chapterKind: 'body', targetPages: 0, charCount: 0 },
  { id: 'b', label: '1.2', title: '이미 씀', chapterTitle: '1장', chapterKind: 'body', targetPages: 4, charCount: 1200 },
];
const run = (items, options = opts) => ({ version: 1, runId: 'r', status: 'running', startedAt: 0, updatedAt: 0, owner: 'o', options, items });

test('plan follows book order, skips matter unless asked, keeps existing text unless rewrite', () => {
  const p = buildPlan(secs, opts, false);
  assert.deepEqual(p.map((x) => x.sectionId), ['a', 'b']);
  assert.equal(p[0].targetPages, 3); // 분량이 없으면 3쪽
  assert.equal(p[1].write, 'skipped');
  assert.equal(p[1].fact, 'pending'); // 쓴 절도 팩트체크·검수는 한다
  assert.equal(buildPlan(secs, { ...opts, rewrite: true }, true).filter((x) => x.write === 'pending').length, 3);
  const noChecks = buildPlan(secs, { ...opts, factcheck: false, review: false }, false);
  assert.ok(noChecks.every((x) => x.fact === 'skipped' && x.review === 'skipped'));
});

test('resume restarts interrupted stages and optionally failed ones', () => {
  const items = [
    { sectionId: 'a', label: 'a', chapterTitle: '', targetPages: 3, write: 'done', fact: 'running', review: 'pending', attempts: 2 },
    { sectionId: 'b', label: 'b', chapterTitle: '', targetPages: 3, write: 'error', fact: 'skipped', review: 'skipped', attempts: 0, error: 'x' },
    { sectionId: 'c', label: 'c', chapterTitle: '', targetPages: 3, write: 'running', fact: 'pending', review: 'pending', attempts: 1 },
  ];
  const r1 = prepareResume({ ...run(items), status: 'paused', pauseKind: 'error' }, false);
  assert.equal(r1.status, 'running');
  assert.equal(r1.pauseKind, undefined);
  assert.deepEqual(r1.items.map((x) => [x.write, x.fact, x.review]), [['done', 'pending', 'pending'], ['error', 'skipped', 'skipped'], ['pending', 'pending', 'pending']]);
  const r2 = prepareResume(run(items), true);
  assert.deepEqual(r2.items[1], { ...items[1], write: 'pending', fact: 'pending', review: 'pending', error: undefined });
  // 옵션이 꺼진 단계는 되살리지 않는다
  const r3 = prepareResume(run(items, { ...opts, review: false }), true);
  assert.equal(r3.items[1].review, 'skipped');
});

test('summary and completion', () => {
  const items = buildPlan(secs, opts, false);
  const r = run(items);
  assert.equal(allFinished(r), false);
  assert.equal(summarize(r).percent, 0);
  for (const it of r.items) Object.assign(it, { write: it.write === 'skipped' ? 'skipped' : 'done', fact: 'done', review: 'error' });
  assert.equal(allFinished(r), true);
  const s = summarize(r);
  assert.equal(s.percent, 100);
  assert.equal(s.failed, 2);
  assert.ok(isAutoRun(r));
  assert.equal(isAutoRun({ ...r, version: 2 }), false);
});

import { markdownToDoc, textblocks, findFootnotes } from '../src/lib/doc/doc.ts';
import { trimIncompleteTail } from '../src/lib/doc/edit.ts';
import { paragraphRanges } from '../src/lib/autowrite.ts';

test('a cut-off tail loses only the half sentence', () => {
  const t = (d) => textblocks(d).map((b) => b.text);
  const cut = markdownToDoc('첫 문단이다.\n\n둘째 문단의 첫 문장이다⟦주:각주.⟧. 셋째 문장은 중간에서 끊');
  assert.deepEqual(t(trimIncompleteTail(cut)), ['첫 문단이다.', '둘째 문단의 첫 문장이다.']);
  assert.equal(findFootnotes(trimIncompleteTail(cut)).length, 1);
  const whole = markdownToDoc('끝난 문장이다.\n\n“인용으로 끝났다.”');
  assert.equal(trimIncompleteTail(whole), whole);
  // 완결 문장이 없는 마지막 문단은 비운다
  assert.deepEqual(t(trimIncompleteTail(markdownToDoc('앞 문단.\n\n끊긴 문단'))), ['앞 문단.', '']);
});

test('review ranges cover every non-empty paragraph once, near the size', () => {
  const texts = ['a'.repeat(4000), '', 'b'.repeat(3000), 'c'.repeat(2500), 'd'.repeat(100), ''];
  const r = paragraphRanges(texts, 6000);
  assert.deepEqual(r, [{ from: 1, to: 2 }, { from: 3, to: 6 }]);
  assert.deepEqual(paragraphRanges(['', ''], 6000), []);
  assert.deepEqual(paragraphRanges(['x'.repeat(9000), 'y'], 6000), [{ from: 1, to: 1 }, { from: 2, to: 2 }]);
});
