import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { collectRecentContext } from '../src/lib/ai/recent-context.ts';
import { WriteClock } from '../src/lib/ai/write-timing.ts';
import { IdleWork } from '../src/lib/idle-work.ts';
import { hashText } from '../src/lib/doc/doc.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('recent context stops resolving old chapters once the budget is full', async () => {
  const called = [];
  const items = ['near', 'middle', 'old'].map(text => async () => { called.push(text); return text; });
  assert.equal(await collectRecentContext(items, 11), 'middle\nnear');
  assert.deepEqual(called, ['near', 'middle']);
  assert.equal(await collectRecentContext([async () => 'oversized nearest'], 5), 'over…');
  assert.equal(await collectRecentContext([async () => '', async () => 'near'], 4), 'near');
});

test('cancelling context preparation prevents further summary calls', async () => {
  const ctrl = new AbortController();
  let called = false;
  await assert.rejects(collectRecentContext([
    async () => { ctrl.abort(); return 'near'; },
    async () => { called = true; return 'old'; },
  ], 2500, ctrl.signal));
  assert.equal(called, false);
});

test('write timing distinguishes preparation, first body text and generation', () => {
  let now = 0;
  const clock = new WriteClock(() => now);
  now = 100; clock.loadMs = 100;
  now = 600; clock.summaryMs = 500;
  now = 800; clock.outlineMs = 200; clock.outlineCached = true;
  clock.startGeneration();
  now = 1200; clock.text();
  now = 2000; clock.text(); clock.startGeneration();
  assert.deepEqual(clock.snapshot(), { loadMs: 100, summaryMs: 500, outlineMs: 200, generationMs: 1200, firstTextMs: 1200, totalMs: 2000, outlineCached: true });
  assert.equal(new WriteClock(() => 0).snapshot().firstTextMs, null);
});

test('idle preparation debounces edits and runs only one request at a time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const queue = new IdleWork();
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  queue.schedule('a', async () => calls.push('obsolete'));
  t.mock.timers.tick(10000);
  queue.schedule('a', async () => { calls.push('latest'); await gate; });
  t.mock.timers.tick(19999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ['latest']);
  queue.schedule('b', async () => { calls.push('b'); throw new Error('optional failure'); }, 0);
  queue.schedule('c', async () => calls.push('cancelled'), 0);
  queue.cancel('c');
  t.mock.timers.tick(20000);
  assert.deepEqual(calls, ['latest']);
  release(); await tick(); t.mock.timers.tick(1); await tick();
  assert.deepEqual(calls, ['latest', 'b']);
  queue.schedule('d', async () => calls.push('after failure'), 0);
  t.mock.timers.tick(1); await tick();
  assert.deepEqual(calls, ['latest', 'b', 'after failure']);
});

const asModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
async function tasksHarness() {
  const mockUrl = asModule(`
    export const state = { calls: [], store: new Map(), book: null, settings: { model: 'fast', provider: 'gateway' }, template: 1, updates: [] };
    const findSection = id => state.book.chapters.flatMap(c => c.sections).find(s => s.id === id);
    export const prisma = {
      section: {
        findUnique: async args => { const s = findSection(args.where.id); return s ? { ...s, chapter: { projectId: state.book.project.id, project: state.book.project } } : null; },
        updateMany: async args => { state.updates.push(args); const s = findSection(args.where.id); if (s?.content === args.where.content) { Object.assign(s, args.data); return {count: 1}; } return {count: 0}; },
      },
      chapter: {
        findUnique: async args => state.book.chapters.find(c => c.id === args.where.id) ?? null,
        updateMany: async args => { state.updates.push(args); Object.assign(state.book.chapters.find(c => c.id === args.where.id), args.data); return {count: 1}; },
      },
      project: { findUnique: async () => ({ layout: '', chapters: state.book.chapters }) },
    };
    export const flatSections = book => book.chapters.flatMap(chapter => chapter.sections.map(section => ({ chapter, section })));
    export const loadBook = async () => state.book;
    export const loadBookOutline = async () => state.book;
    export const fillContent = async sections => { state.filled = [...(state.filled ?? []), ...sections.filter(s => s.content === undefined).map(s => s.id)]; for (const s of sections) if (s.content === undefined) s.content = findSection(s.id)?.stored ?? ''; };
    export const numberChapters = chapters => chapters;
    export const parseLayout = () => ({ numberFormat: '' });
    export const editStats = () => {}; export const pickLearningPairs = () => [];
    export const buildMessages = async (name, vars) => ({ messages: [{ role: 'user', content: JSON.stringify({ name, vars, template: state.template }) }], instructionIncluded: false });
    export const loadAiSettings = async () => state.settings;
    export const getSetting = async key => state.store.get(key) ?? null;
    export const loadSectionReferences = async id => state.refs?.[id] ?? { block: '', ids: [] };
    export const readMemoryText = async () => state.memory ?? '';
    export const setSetting = async (key, value) => { state.store.set(key, value); };
    export const extractJson = JSON.parse;
    export const chat = async opts => {
      state.calls.push(opts.purpose);
      state.lastMessages = opts.messages;
      if (state.beforeChat) await state.beforeChat(opts);
      const text = opts.purpose === 'section_outline' ? JSON.stringify({ parts: [{ heading: 'Part', points: ['point'], sketchItems: [], chars: 5000 }] }) : 'summary';
      return { text, usage: {} };
    };
    export async function* chatStream(opts) { state.calls.push(opts.purpose); (state.streamed ??= []).push(opts.messages); yield 'draft body'; return {}; }
  `);
  let source = await readFile(new URL('../src/lib/ai/tasks.ts', import.meta.url), 'utf8');
  source += '\nexport { previousSummaries, preparedOutline };';
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  js = js.replace('import "server-only";', '').replace(/from "([^"]+)"/g, (whole, path) => {
    if (path === 'zod') return `from ${JSON.stringify(import.meta.resolve('zod'))}`;
    if (path.startsWith('node:')) return whole;
    if (['../doc/doc', './single-flight', './recent-context', './write-timing', './outline-text'].includes(path)) {
      return `from ${JSON.stringify(new URL(`../src/lib/ai/${path}.ts`, import.meta.url).href)}`;
    }
    return `from ${JSON.stringify(mockUrl)}`;
  });
  return { tasks: await import(asModule(js)), state: (await import(mockUrl)).state };
}
function section(id, text = 'manuscript') {
  return { id, title: id, label: id, chapterId: 'chapter', content: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }), sketch: 'notes', gist: '', summary: null, summaryHash: null };
}
function book(sections) {
  return { project: { id: 'project', glossary: [], charsPerPage: 700 }, chapters: [{ id: 'chapter', title: 'chapter', label: '1', kind: 'body', sections }] };
}

test('long-outline cache is reused only for identical prompts and model settings', async () => {
  const { tasks, state } = await tasksHarness();
  state.store.clear(); state.calls = []; state.beforeChat = undefined;
  const vars = { sketch: 'notes', targetChars: 5000, extraInstruction: 'style', previousSummaries: 'earlier' };
  await Promise.all([tasks.preparedOutline('s', 'p', vars), tasks.preparedOutline('s', 'p', vars)]);
  assert.equal(state.calls.length, 1);
  assert.equal((await tasks.preparedOutline('s', 'p', vars)).cached, true);
  for (const changed of [{ ...vars, sketch: 'new notes' }, { ...vars, targetChars: 6000 }, { ...vars, extraInstruction: 'other' }, { ...vars, previousSummaries: 'changed' }]) {
    const before = state.calls.length;
    await tasks.preparedOutline('s', 'p', changed);
    assert.equal(state.calls.length, before + 1);
  }
  await tasks.preparedOutline('s', 'p', vars);
  let before = state.calls.length;
  state.settings.model = 'other';
  await tasks.preparedOutline('s', 'p', vars);
  assert.equal(state.calls.length, before + 1);
  before = state.calls.length; state.template++;
  await tasks.preparedOutline('s', 'p', vars);
  assert.equal(state.calls.length, before + 1);
  state.store.get('ai:outline-cache:s').expires = 0;
  before = state.calls.length;
  await tasks.preparedOutline('s', 'p', vars);
  assert.equal(state.calls.length, before + 1);
});

test('foreground writing uses prepared outline and emits timings before completion', async () => {
  const { tasks, state } = await tasksHarness();
  state.store.clear(); state.calls = []; state.book = book([section('current')]);
  const opts = { targetPages: 8, mode: 'overwrite', extraInstruction: '' };
  await tasks.prepareSection('current', opts);
  const events = [];
  for await (const event of tasks.writeSection('current', opts)) events.push(event);
  assert.deepEqual(state.calls, ['section_outline', 'section_write_part']);
  assert.equal(events.at(-2).t, 'timing');
  assert.equal(events.at(-2).timing.outlineCached, true);
  assert.notEqual(events.at(-2).timing.firstTextMs, null);
  assert.equal(events.at(-1).t, 'done');
  assert.equal(state.book.chapters[0].sections[0].content, section('current').content);
});

test('a full recent context avoids all old chapters and missing old summaries', async () => {
  const { tasks, state } = await tasksHarness();
  const recent = section('recent');
  recent.summary = 'x'.repeat(2600); recent.summaryHash = hashText('manuscript');
  state.book = book([section('old'), recent, section('current')]); state.calls = [];
  const text = await tasks.previousSummaries(state.book, 0, 2);
  assert.equal(text.length, 2500);
  assert.deepEqual(state.calls, []);
});

test('idle summary warms a chapter only when all other sections are already summarized', async () => {
  const { tasks, state } = await tasksHarness();
  state.book = book([section('a'), section('b')]); state.calls = [];
  await tasks.summarizeSection('a');
  assert.deepEqual(state.calls, ['summary']);
  await tasks.summarizeSection('b');
  assert.deepEqual(state.calls, ['summary', 'summary', 'chapter_summary']);
  await tasks.summarizeSection('b');
  assert.equal(state.calls.length, 3);
});

test('an edit during summary generation cannot persist the old summary', async () => {
  const { tasks, state } = await tasksHarness();
  state.book = book([section('changing')]); state.calls = [];
  state.beforeChat = async opts => {
    if (opts.purpose === 'summary') state.book.chapters[0].sections[0].content = section('changing', 'new manuscript').content;
  };
  try {
    await tasks.summarizeSection('changing');
    assert.equal(state.book.chapters[0].sections[0].summary, null);
    assert.deepEqual(state.calls, ['summary']);
  } finally { state.beforeChat = undefined; }
});

test('writing reads manuscript bodies only for the current, previous and summarized sections', async () => {
  const { tasks, state } = await tasksHarness();
  // 책 구조만 읽은 상태(본문 없음) — 본문은 fillContent가 필요한 절만 채운다
  const lazy = id => { const s = section(id); s.stored = s.content; delete s.content; return s; };
  const recent = lazy('recent');
  recent.summary = 'x'.repeat(2600); recent.summaryHash = hashText('manuscript');
  state.book = book([lazy('old1'), lazy('old2'), recent, lazy('current')]);
  state.calls = []; state.filled = [];
  const events = [];
  for await (const event of tasks.writeSection('current', { targetPages: 3, mode: 'overwrite', extraInstruction: '' })) events.push(event);
  assert.equal(events.at(-1).t, 'done');
  assert.deepEqual(state.calls, ['section_write']);
  assert.deepEqual([...state.filled].sort(), ['current', 'recent']);
  assert.equal(state.book.chapters[0].sections[0].content, undefined);
});

const varsOf = messages => JSON.parse(messages[0].content).vars;
const editedParts = [
  { heading: '첫 파트', points: ['도입'], sketchItems: [], chars: 1500 },
  { heading: '둘째 파트', points: ['전개'], sketchItems: ['메모'], chars: 1500 },
];

test('an author-edited outline is used verbatim and never replaced by generation or cache refresh', async () => {
  const { tasks, state } = await tasksHarness();
  state.store.clear(); state.calls = []; state.streamed = []; state.book = book([section('current')]);
  state.store.set('outline-edit:current', { outline: '## 첫 파트', parts: editedParts, inputHash: 'h', editedAt: 'now' });
  const prep = await tasks.prepareSection('current', { targetPages: 8, mode: 'overwrite' });
  assert.deepEqual(prep, { ready: true, cached: true });
  const events = [];
  for await (const e of tasks.writeSection('current', { targetPages: 8, mode: 'overwrite', extraInstruction: '' })) events.push(e);
  assert.deepEqual(state.calls, ['section_write_part', 'section_write_part']);
  const text = events.filter(e => e.t === 'delta').map(e => e.v).join('');
  assert.match(text, /## 첫 파트[\s\S]*## 둘째 파트/);
  assert.equal(state.store.has('ai:outline-cache:current'), false);
  assert.deepEqual(state.store.get('outline-edit:current').parts, editedParts);
  // 짧은 절도 고친 개요가 있으면 그 개요대로 나눠 쓴다
  state.calls = [];
  for await (const _ of tasks.writeSection('current', { targetPages: 3, mode: 'newVersion', extraInstruction: '' }));
  assert.deepEqual(state.calls, ['section_write_part', 'section_write_part']);
  // 이어쓰기는 기존 본문 뒤라 고친 개요를 쓰지 않는다
  state.calls = [];
  for await (const _ of tasks.writeSection('current', { targetPages: 3, mode: 'continue', extraInstruction: '' }));
  assert.deepEqual(state.calls, ['section_write']);
});

test('generating an outline on demand ignores a matching cache and records what it was made from', async () => {
  const { tasks, state } = await tasksHarness();
  state.store.clear(); state.calls = []; state.book = book([section('current')]);
  await tasks.prepareSection('current', { targetPages: 8, mode: 'overwrite' });
  assert.deepEqual(state.calls, ['section_outline']);
  const r = await tasks.generateOutline('current', { targetPages: 8, sketch: 'unsaved notes' });
  assert.deepEqual(state.calls, ['section_outline', 'section_outline']);
  assert.equal(r.parts[0].heading, 'Part');
  assert.equal(varsOf(state.lastMessages).sketch, 'unsaved notes');
  assert.equal(state.store.get('ai:outline-cache:current').inputHash, r.inputHash);
});

test('section references reach the write prompt and change the outline input hash', async () => {
  const { tasks, state } = await tasksHarness();
  state.store.clear(); state.calls = []; state.streamed = []; state.book = book([section('current')]);
  const before = await tasks.generateOutline('current', { targetPages: 8 });
  const block = '### 자료 1: 보고서\n근거 문장';
  state.refs = { current: { block, ids: ['r1'] } };
  try {
    const after = await tasks.generateOutline('current', { targetPages: 8 });
    assert.notEqual(before.inputHash, after.inputHash);
    assert.equal(varsOf(state.lastMessages).sectionReferences, block);
    for await (const _ of tasks.writeSection('current', { targetPages: 3, mode: 'overwrite', extraInstruction: '' }));
    assert.equal(varsOf(state.streamed.at(-1)).sectionReferences, block);
  } finally { state.refs = undefined; }
});

test('custom rewrite sends the author instruction in the user variables', async () => {
  const { tasks, state } = await tasksHarness();
  state.calls = []; state.book = book([section('current')]);
  await tasks.rewriteSelection('current', { action: 'custom', before: '앞', selection: '고칠 문장', after: '뒤', instruction: '더 짧게, 예시는 빼고' });
  assert.deepEqual(state.calls, ['rewrite_custom']);
  assert.equal(varsOf(state.lastMessages).customInstruction, '더 짧게, 예시는 빼고');
  await tasks.rewriteSelection('current', { action: 'polish', before: '', selection: '문장', after: '', instruction: '무시' });
  assert.equal(varsOf(state.lastMessages).customInstruction, '');
});
