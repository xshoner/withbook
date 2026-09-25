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
        findUnique: async args => { const s = findSection(args.where.id); return s ? { ...s, chapter: { projectId: state.book.project.id } } : null; },
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
    export const numberChapters = chapters => chapters;
    export const parseLayout = () => ({ numberFormat: '' });
    export const editStats = () => {}; export const pickLearningPairs = () => [];
    export const buildMessages = async (name, vars) => ({ messages: [{ role: 'user', content: JSON.stringify({ name, vars, template: state.template }) }], instructionIncluded: false });
    export const loadAiSettings = async () => state.settings;
    export const getSetting = async key => state.store.get(key) ?? null;
    export const setSetting = async (key, value) => { state.store.set(key, value); };
    export const extractJson = JSON.parse;
    export const chat = async opts => {
      state.calls.push(opts.purpose);
      if (state.beforeChat) await state.beforeChat(opts);
      const text = opts.purpose === 'section_outline' ? JSON.stringify({ parts: [{ heading: 'Part', points: ['point'], sketchItems: [], chars: 5000 }] }) : 'summary';
      return { text, usage: {} };
    };
    export async function* chatStream(opts) { state.calls.push(opts.purpose); yield 'draft body'; return {}; }
  `);
  let source = await readFile(new URL('../src/lib/ai/tasks.ts', import.meta.url), 'utf8');
  source += '\nexport { previousSummaries, preparedOutline };';
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  js = js.replace('import "server-only";', '').replace(/from "([^"]+)"/g, (whole, path) => {
    if (path === 'zod') return `from ${JSON.stringify(import.meta.resolve('zod'))}`;
    if (path.startsWith('node:')) return whole;
    if (['../doc/doc', './single-flight', './recent-context', './write-timing'].includes(path)) {
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
