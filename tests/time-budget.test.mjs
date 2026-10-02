// 서버 시간 한도(Vercel Hobby 300초, AI 예산 240초) 안에 끝나게 하는 장치 — 절 집필 준비 시간 배분, 목차 단계 설계
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { collectRecentContext } from '../src/lib/ai/recent-context.ts';
import {
  FIRST_PART_START_MS, PART_START_BUDGET_MS, SUMMARY_DEADLINE_MS, OUTLINE_DEADLINE_MS, FALLBACK_PART_CHARS,
  partStart, fallbackParts, withinTime, timeLeft, isDeadlineError,
} from '../src/lib/ai/write-budget.ts';
import {
  applyChapterDetail, cleanTocTitles, mergeChapterDetail, pendingChapters, replaceChapter, runLimited, tocDesignText, withDetailPending,
} from '../src/lib/ai/toc-steps.ts';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 시간 배분 (순수 함수) ---------------- */

test('the time plan leaves the generation enough of the 240s AI budget', () => {
  // 준비 단계는 차례로 끝나고, 첫 파트·다음 파트 시작 한도 뒤에도 본문에 90초 이상 남는다
  assert.ok(SUMMARY_DEADLINE_MS < FIRST_PART_START_MS);
  assert.ok(FIRST_PART_START_MS <= OUTLINE_DEADLINE_MS);
  assert.ok(240_000 - FIRST_PART_START_MS >= 120_000);
  assert.ok(240_000 - PART_START_BUDGET_MS >= 90_000);
});

test('a part starts in this request only while there is time left for it', () => {
  assert.equal(partStart(10_000, 0, 0), 'write');
  assert.equal(partStart(FIRST_PART_START_MS, 0, 0), 'write');
  assert.equal(partStart(FIRST_PART_START_MS + 1, 0, 0), 'resume'); // 준비가 길었다 — 새 요청에서 첫 파트부터
  assert.equal(partStart(FIRST_PART_START_MS + 1, 2, 2), 'resume'); // 이어 쓰는 요청의 첫 파트도 같은 기준
  assert.equal(partStart(FIRST_PART_START_MS + 1, 1, 0), 'write'); // 두 번째 파트부터는 기존 150초 기준
  assert.equal(partStart(PART_START_BUDGET_MS + 1, 1, 0), 'resume');
  assert.equal(timeLeft(1000, 5000, 3000), 3000);
  assert.equal(timeLeft(1000, 5000, 9000), 0);
});

test('the fallback outline splits a long section into short parts and spreads the sketch', () => {
  const parts = fallbackParts(5600, '- 도입 사례\n\n* 핵심 개념\n1. 반론\n2) 정리');
  assert.equal(parts.length, Math.ceil(5600 / FALLBACK_PART_CHARS));
  assert.ok(parts.every(p => p.heading === '' && p.chars <= FALLBACK_PART_CHARS && p.points.length === 0));
  assert.equal(parts.reduce((a, p) => a + p.chars, 0), 5600);
  assert.deepEqual(parts.flatMap(p => p.sketchItems), ['도입 사례', '핵심 개념', '반론', '정리']);
  assert.deepEqual(fallbackParts(800, ''), [{ heading: '', points: [], sketchItems: [], chars: 800 }]);
  assert.equal(fallbackParts(1_000_000).length, 20); // 이어 쓰기 입력 한도(파트 20개)를 넘지 않는다
  assert.equal(fallbackParts(NaN).length, 1);
});

test('waiting is bounded and a late failure is swallowed', async () => {
  assert.deepEqual(await withinTime(Promise.resolve(7), 1000), { done: true, value: 7 });
  let fail;
  const late = new Promise((_, reject) => { fail = reject; });
  assert.deepEqual(await withinTime(late, 5), { done: false });
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  fail(new Error('late'));
  await sleep(10);
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, false);
  await assert.rejects(withinTime(Promise.reject(new Error('early')), 1000), /early/);
  assert.equal(isDeadlineError({ status: 504 }), true);
  assert.equal(isDeadlineError(new Error('x')), false);
  assert.equal(isDeadlineError(null), false);
});

test('recent context stops waiting at the deadline and keeps what is ready', async () => {
  const called = [];
  const items = [
    async () => { called.push('near'); return 'near'; },
    async () => { called.push('slow'); await sleep(200); return 'slow'; },
    async () => { called.push('old'); return 'old'; },
  ];
  const t0 = Date.now();
  assert.equal(await collectRecentContext(items, 2500, undefined, Date.now() + 30), 'near');
  assert.ok(Date.now() - t0 < 150);
  assert.deepEqual(called, ['near', 'slow']);
  called.length = 0;
  assert.equal(await collectRecentContext(items, 2500, undefined, Date.now() - 1), '');
  assert.deepEqual(called, []);
});

/* ---------------- 절 집필 (tasks.ts를 모의 AI로) ---------------- */

const asModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
async function tasksHarness() {
  const mockUrl = asModule(`
    export const state = { calls: [], store: new Map(), book: null, settings: { model: 'fast', provider: 'gateway' }, template: 1, updates: [] };
    const findSection = id => state.book.chapters.flatMap(c => c.sections).find(s => s.id === id);
    export const prisma = {
      section: {
        findUnique: async args => { const s = findSection(args.where.id); return s ? { ...s, chapter: { projectId: state.book.project.id, project: state.book.project } } : null; },
        updateMany: async args => { const s = findSection(args.where.id); if (s?.content === args.where.content) { Object.assign(s, args.data); return {count: 1}; } return {count: 0}; },
      },
      chapter: {
        findUnique: async args => state.book.chapters.find(c => c.id === args.where.id) ?? null,
        updateMany: async args => { Object.assign(state.book.chapters.find(c => c.id === args.where.id), args.data); return {count: 1}; },
      },
      project: { findUnique: async () => ({ layout: '', chapters: state.book.chapters }) },
    };
    export const flatSections = book => book.chapters.flatMap(chapter => chapter.sections.map(section => ({ chapter, section })));
    export const loadBookOutline = async () => state.book;
    export const fillContent = async () => {};
    export const numberChapters = chapters => chapters;
    export const parseLayout = () => ({ numberFormat: '' });
    export const editStats = () => {}; export const pickLearningPairs = () => [];
    export const buildMessages = async (name, vars) => ({ messages: [{ role: 'user', content: JSON.stringify({ name, vars }) }], instructionIncluded: false });
    export const loadAiSettings = async () => state.settings;
    export const getSetting = async key => state.store.get(key) ?? null;
    export const loadSectionReferences = async () => { state.onRefs?.(); return { block: '', ids: [] }; };
    export const readMemoryText = async () => '';
    export const setSetting = async (key, value) => { state.store.set(key, value); };
    export const extractJson = JSON.parse;
    export const chat = async opts => {
      state.calls.push(opts.purpose);
      state.lastVars = JSON.parse(opts.messages[0].content).vars;
      if (state.beforeChat) await state.beforeChat(opts);
      const text = state.chatText?.(opts) ?? (opts.purpose === 'section_outline' ? JSON.stringify({ parts: [{ heading: 'A', points: [], sketchItems: [], chars: 1400 }, { heading: 'B', points: [], sketchItems: [], chars: 1400 }] }) : 'summary');
      return { text, usage: {} };
    };
    export async function* chatStream(opts) {
      state.calls.push(opts.purpose);
      if (state.stream) return yield* state.stream(opts, state.calls.filter(c => c.startsWith('section_write')).length);
      yield 'body'; return {};
    }
  `);
  let source = await readFile(new URL('../src/lib/ai/tasks.ts', import.meta.url), 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  js = js.replace('import "server-only";', '').replace(/from "([^"]+)"/g, (whole, path) => {
    if (path === 'zod') return `from ${JSON.stringify(import.meta.resolve('zod'))}`;
    if (path.startsWith('node:')) return whole;
    if (['../doc/doc', '../request-context', './single-flight', './recent-context', './write-timing', './outline-text', './write-budget', './toc-steps'].includes(path)) {
      return `from ${JSON.stringify(new URL(`../src/lib/ai/${path}.ts`, import.meta.url).href)}`;
    }
    return `from ${JSON.stringify(mockUrl)}`;
  });
  const state = (await import(mockUrl)).state;
  return { tasks: await import(asModule(js)), state };
}
const H = tasksHarness();
async function fresh() {
  const h = await H;
  Object.assign(h.state, { calls: [], beforeChat: undefined, chatText: undefined, stream: undefined, onRefs: undefined });
  h.state.store.clear();
  return h;
}
function section(id, text = 'manuscript') {
  return { id, title: id, label: id, chapterId: 'chapter', content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }), sketch: '- 사례\n- 개념', gist: '', summary: null, summaryHash: null };
}
const book = sections => ({ project: { id: 'project', glossary: [], charsPerPage: 700 }, chapters: [{ id: 'chapter', title: 'chapter', label: '1', kind: 'body', sections }] });
async function collect(gen) { const out = []; for await (const e of gen) out.push(e); return out; }

/** Date.now를 앞당겨 준비 단계가 오래 걸린 것처럼 만든다 */
async function withClock(fn) {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try { return await fn(ms => { offset += ms; }); } finally { Date.now = real; }
}

test('a slow previous-section summary is left out instead of delaying the draft', async () => {
  const { tasks, state } = await fresh();
  state.book = book([section('prev'), section('current')]);
  await withClock(async advance => {
    state.onRefs = () => advance(SUMMARY_DEADLINE_MS + 1);
    const events = await collect(tasks.writeSection('current', { targetPages: 3, mode: 'overwrite' }));
    assert.deepEqual(state.calls, ['section_write']);
    assert.equal(events.at(-1).t, 'done');
  });
});

test('a failing summary does not fail the whole draft', async () => {
  const { tasks, state } = await fresh();
  state.book = book([section('prev2'), section('current')]);
  state.beforeChat = async opts => { if (opts.purpose === 'summary') throw Object.assign(new Error('AI 서버 혼잡'), { status: 429 }); };
  const events = await collect(tasks.writeSection('current', { targetPages: 3, mode: 'overwrite' }));
  assert.deepEqual(state.calls, ['summary', 'section_write']);
  assert.equal(events.at(-1).t, 'done');
});

test('when the outline arrives too late for this request, the first part is handed to a new request', async () => {
  const { tasks, state } = await fresh();
  state.book = book([section('current')]);
  await withClock(async advance => {
    state.beforeChat = async opts => { if (opts.purpose === 'section_outline') advance(FIRST_PART_START_MS + 5_000); };
    const events = await collect(tasks.writeSection('current', { targetPages: 8, mode: 'overwrite' }));
    assert.deepEqual(state.calls, ['section_outline']); // 본문은 시작하지 않았다
    const resume = events.find(e => e.t === 'resume');
    assert.equal(resume.fromPart, 0);
    assert.deepEqual(resume.parts.map(p => p.heading), ['A', 'B']);
    assert.ok(events.some(e => e.t === 'status' && e.v === 'partial'));
    assert.equal(events.filter(e => e.t === 'delta').length, 0);
  });
  // 다음 요청(resume)은 개요를 다시 만들지 않고 곧바로 쓴다
  state.calls = []; state.beforeChat = undefined;
  const parts = [{ heading: 'A', points: [], sketchItems: [], chars: 1400 }, { heading: 'B', points: [], sketchItems: [], chars: 1400 }];
  const events = await collect(tasks.writeSection('current', { targetPages: 8, mode: 'overwrite', resume: { fromPart: 0, written: '', parts } }));
  assert.deepEqual(state.calls, ['section_write_part', 'section_write_part']);
  assert.equal(events.filter(e => e.t === 'delta').map(e => e.v).join(''), '## A\n\nbody\n\n## B\n\nbody');
});

test('an outline that never arrives in time falls back to equal parts without headings', async () => {
  const { tasks, state } = await fresh();
  state.book = book([section('current')]);
  await withClock(async advance => {
    state.onRefs = () => advance(OUTLINE_DEADLINE_MS + 1);
    state.beforeChat = async opts => { if (opts.purpose === 'section_outline') await sleep(30); };
    const events = await collect(tasks.writeSection('current', { targetPages: 8, mode: 'overwrite' }));
    const resume = events.find(e => e.t === 'resume');
    assert.equal(resume.fromPart, 0);
    assert.equal(resume.parts.length, Math.ceil(5600 / FALLBACK_PART_CHARS));
    assert.ok(resume.parts.every(p => p.heading === ''));
    assert.deepEqual(resume.parts.flatMap(p => p.sketchItems), ['사례', '개념']);
  });
  await sleep(40); // 늦은 개요 호출이 끝나 캐시에 남는다
  assert.ok(state.store.get('ai:outline-cache:current'));
});

test('a later part that hits the time limit before any text resumes without repeating its heading', async () => {
  const { tasks, state } = await fresh();
  state.book = book([section('current')]);
  state.stream = async function* (_opts, n) {
    if (n === 2) throw Object.assign(new Error('deadline'), { status: 504 });
    yield 'first body';
    return {};
  };
  const events = await collect(tasks.writeSection('current', { targetPages: 8, mode: 'overwrite' }));
  assert.equal(events.filter(e => e.t === 'delta').map(e => e.v).join(''), '## A\n\nfirst body');
  const resume = events.find(e => e.t === 'resume');
  assert.equal(resume.fromPart, 1);
  assert.equal(events.at(-1).t, 'done');
});

test('a draft that gets no text before the time limit fails with an actionable message', async () => {
  const { tasks, state } = await fresh();
  state.book = book([section('current')]);
  state.stream = async function* () { throw Object.assign(new Error('서버 실행 시간 한도'), { status: 504 }); };
  await assert.rejects(collect(tasks.writeSection('current', { targetPages: 3, mode: 'overwrite' })), e => {
    assert.equal(e.expose, true);
    assert.equal(e.httpStatus, 504);
    assert.match(e.message, /다시 시도하면 바로 본문부터/);
    return true;
  });
  // 다른 오류는 그대로
  state.stream = async function* () { throw Object.assign(new Error('인증 실패'), { status: 401 }); };
  await assert.rejects(collect(tasks.writeSection('current', { targetPages: 3, mode: 'overwrite' })), /인증 실패/);
});

/* ---------------- 목차 단계 설계 ---------------- */

const ch = (title, sections, extra = {}) => ({ title, promise: '', rationale: '', sections: sections.map(t => ({ title: t, gist: '', hook: '', targetPages: 3 })), ...extra });
const skeleton = () => withDetailPending({
  concept: 'c', flow: 'f', chapters: [ch('하나', ['가', '나']), ch('둘', ['다'], { promise: '약속' })],
  readerHooks: [], differentiation: [], estimatedPages: 9, frontMatter: [], backMatter: [],
});

test('the skeleton report marks every chapter as waiting for detail', () => {
  const rep = skeleton();
  assert.deepEqual(rep.detailPending, [1, 2]);
  assert.deepEqual(pendingChapters({ chapters: [1, 2, 3], detailPending: [3, 3, 0, 9, '2', 1.5] }), [2, 3]);
  assert.deepEqual(pendingChapters({ chapters: [1] }), []);
});

test('chapter detail keeps the skeleton titles and pages and fills rationale, gist and hook', () => {
  const detail = { title: '바뀐 제목', promise: '새 약속', rationale: '이유', sections: [
    { title: '나', gist: '나 요지', hook: '나 훅', targetPages: 9 },
    { title: '전혀 다른 절', gist: '엉뚱', hook: '', targetPages: 1 },
  ] };
  const merged = mergeChapterDetail(ch('하나', ['가', '나']), detail);
  assert.equal(merged.title, '하나');
  assert.equal(merged.promise, '새 약속');
  assert.equal(merged.rationale, '이유');
  assert.deepEqual(merged.sections.map(s => [s.title, s.gist, s.targetPages]), [['가', '엉뚱', 3], ['나', '나 요지', 3]]);
  // 절 개수가 다르면 제목이 맞는 절만 채운다
  const partial = mergeChapterDetail(ch('하나', ['가', '나', '라']), detail);
  assert.deepEqual(partial.sections.map(s => s.gist), ['', '나 요지', '']);
  // 골격의 약속은 그대로
  assert.equal(mergeChapterDetail(ch('둘', ['다'], { promise: '약속' }), detail).promise, '약속');
});

test('filling every chapter leaves a report shaped exactly like a one-shot design', () => {
  let rep = skeleton();
  rep = applyChapterDetail(rep, 2, { ...ch('둘', ['다']), rationale: 'r2' });
  assert.deepEqual(rep.detailPending, [1]);
  rep = applyChapterDetail(rep, 1, { ...ch('하나', ['가', '나']), rationale: 'r1' });
  assert.equal('detailPending' in rep, false);
  assert.deepEqual(Object.keys(rep).sort(), ['backMatter', 'chapters', 'concept', 'differentiation', 'estimatedPages', 'flow', 'frontMatter', 'readerHooks']);
  assert.deepEqual(rep.chapters.map(c => c.rationale), ['r1', 'r2']);
  assert.equal(applyChapterDetail(rep, 7, ch('x', ['y'])), rep);
  const redone = replaceChapter(skeleton(), 1, { ...ch('새 장', ['새 절']), rationale: 'new' });
  assert.equal(redone.chapters[0].title, '새 장');
  assert.deepEqual(redone.detailPending, [2]);
});

test('toc titles lose AI numbering and the prompt outline numbers chapters', () => {
  const chapters = cleanTocTitles([ch('제1장. 시작', ['1.1 첫 절', '2) 둘째'])]);
  assert.equal(chapters[0].title, '시작');
  assert.deepEqual(chapters[0].sections.map(s => s.title), ['첫 절', '둘째']);
  assert.equal(tocDesignText(skeleton()), '1장 하나\n   1.1 가 (3쪽)\n   1.2 나 (3쪽)\n2장 둘 — 약속\n   2.1 다 (3쪽)');
});

test('chapter details run with limited concurrency and stop starting new ones on request', async () => {
  let active = 0, peak = 0;
  const seen = [];
  await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async n => { active++; peak = Math.max(peak, active); seen.push(n); await sleep(5); active--; });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  let stop = false;
  const started = [];
  await runLimited([1, 2, 3, 4, 5], 2, async n => { started.push(n); if (n === 2) stop = true; await sleep(1); }, () => stop);
  assert.deepEqual(started, [1, 2]);
});

test('skeleton and chapter-detail calls are small and use the right prompt mode', async () => {
  const { tasks, state } = await fresh();
  state.book = book([section('current')]);
  state.chatText = () => JSON.stringify({ concept: 'c', chapters: [{ title: '1장 하나', promise: 'p', sections: [{ title: '1.1 가', targetPages: 4 }] }] });
  let maxTokens = [];
  state.beforeChat = async opts => { maxTokens.push(opts.maxTokens); };
  const sk = await tasks.designTocSkeleton('project', {});
  assert.equal(state.lastVars.skeleton, true);
  assert.deepEqual(sk.design.detailPending, [1]);
  assert.equal(sk.design.chapters[0].title, '하나');
  assert.equal(sk.design.chapters[0].sections[0].gist, '');
  state.chatText = () => JSON.stringify({ chapters: [{ title: '하나', rationale: '근거', sections: [{ title: '가', gist: '요지', hook: '훅', targetPages: 4 }] }] });
  const d = await tasks.designTocChapter('project', { chapterIndex: 1, mode: 'detail', report: sk.design });
  assert.equal(state.lastVars.detailOnly, true);
  assert.equal(state.lastVars.chapterOnly, false);
  assert.equal(state.lastVars.currentToc, '1장 하나 — p\n   1.1 가 (4쪽)');
  assert.equal(d.chapter.rationale, '근거');
  await tasks.designTocChapter('project', { chapterIndex: 1, mode: 'redesign', report: sk.design });
  assert.equal(state.lastVars.chapterOnly, true);
  assert.ok(maxTokens.every(n => n <= 12000), `max tokens ${maxTokens}`);
  state.chatText = () => 'not json';
  const bad = await tasks.designTocChapter('project', { chapterIndex: 1, mode: 'detail', report: sk.design });
  assert.match(bad.error, /1장/);
});

test('toc prompts render the skeleton and per-chapter modes', async () => {
  const sys = await readFile(new URL('../prompts/toc-design.system.md', import.meta.url), 'utf8');
  const user = await readFile(new URL('../prompts/toc-design.user.md', import.meta.url), 'utf8');
  // prompts.ts render()와 같은 규칙
  const render = (tpl, vars) => tpl
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (_, k, a, b) => (vars[k] ? a : (b ?? '')))
    .replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null || vars[k] === '' ? '(없음)' : String(vars[k])));
  const skel = render(sys, { topic: 'x', skeleton: true });
  assert.doesNotMatch(skel, /"rationale"|"gist"|"hook"/);
  assert.match(skel, /골격만/);
  const full = render(sys, { topic: 'x' });
  assert.match(full, /"rationale"/);
  assert.match(full, /"gist"/);
  assert.doesNotMatch(full, /골격만/);
  const detail = render(user, { detailOnly: true, chapterIndex: 3, currentToc: '1장 A' });
  assert.match(detail, /3장 하나만 세부 설계/);
  assert.match(detail, /1장 A/);
  assert.doesNotMatch(detail, /부분 재설계/);
  assert.doesNotMatch(render(user, { chapterOnly: true, chapterIndex: 3 }), /세부 설계/);
  for (const t of [skel, full, detail]) assert.doesNotMatch(t, /\{\{/);
});
