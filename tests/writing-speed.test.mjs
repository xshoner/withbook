import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { WriteClock } from '../src/lib/ai/write-timing.ts';
import { IdleWork } from '../src/lib/idle-work.ts';
import { hashText } from '../src/lib/doc/doc.ts';
import { writingContext, WRITING_CONTEXT_CHARS } from '../src/lib/ai/writing-context.ts';
import { groupWriteParts, singleWriteLimit, writeTokens } from '../src/lib/ai/write-plan.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
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
    export const state = { calls: [], requests: [], store: new Map(), book: null, settings: { model: 'fast', provider: 'gateway', maxOutputTokens: 32000 }, template: 1, updates: [] };
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
      const text = opts.purpose === 'section_outline' ? JSON.stringify({ parts: state.parts ?? [{ heading: 'Part', points: ['point'], sketchItems: [], chars: 5000 }] }) : 'summary';
      return { text, usage: {} };
    };
    export async function* chatStream(opts) { state.calls.push(opts.purpose); state.requests.push(opts); yield 'draft body'; return { truncated: Boolean(state.truncated) }; }
  `);
  let source = await readFile(new URL('../src/lib/ai/tasks.ts', import.meta.url), 'utf8');
  source += '\nexport { previousSummaries, preparedOutline };';
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  js = js.replace('import "server-only";', '').replace(/from "([^"]+)"/g, (whole, path) => {
    if (path === 'zod') return `from ${JSON.stringify(import.meta.resolve('zod'))}`;
    if (path.startsWith('node:')) return whole;
    if (['../doc/doc', './single-flight', './writing-context', './write-plan', './write-timing'].includes(path)) {
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
  assert.deepEqual(state.calls, ['section_outline', 'section_write_part', 'section_write_part']);
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
  assert.ok(text.length <= WRITING_CONTEXT_CHARS);
  assert.deepEqual(state.calls, []);
});

test('cold or stale summaries never cause an AI call or use obsolete claims', async () => {
  const { tasks, state } = await tasksHarness();
  const old = section('old', '도입 설명');
  const recent = section('recent', '최신 수치는 24명이다.');
  recent.summary = '옛 수치는 999명이다.'; recent.summaryHash = hashText('previous manuscript');
  state.book = book([old, recent, section('current')]); state.calls = []; state.updates = [];
  const text = await tasks.previousSummaries(state.book, 0, 2);
  assert.ok(text.includes('24명')); assert.ok(!text.includes('999명'));
  assert.ok(text.includes('recent')); assert.ok(text.includes('문단 1'));
  assert.deepEqual(state.calls, []); assert.deepEqual(state.updates, []);
  await assert.rejects(tasks.previousSummaries(state.book, 0, 2, AbortSignal.abort()));
});

test('context reserves recent continuity while retrieving related earlier material', () => {
  const sources = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, label: `${i}`, title: `일반 주제 ${i}`, paragraphs: [`일반적인 설명 ${i}. `.repeat(200)] }));
  sources[1] = { id: 'older', label: '1장 2절', title: '청소년 수면', paragraphs: ['수면 부족은 집중력에 영향을 준다. 관찰 집단은 24명이다.'] };
  const text = writingContext(sources, '청소년 수면과 집중력');
  assert.ok(text.includes('1장 2절')); assert.ok(text.includes('24명'));
  assert.ok(text.includes('일반 주제 19')); assert.ok(text.includes('일반 주제 18'));
  assert.ok(text.length <= WRITING_CONTEXT_CHARS);
  assert.ok(text.indexOf('1장 2절') < text.indexOf('일반 주제 19'));
});

test('long paragraphs retain a matching passage and empty sections add no invented content', () => {
  const result = writingContext([
    { id: 'empty', label: '', title: 'unwritten', paragraphs: [''], summary: 'old deleted content' },
    { id: 'long', label: '1절', title: 'source', paragraphs: ['배경 '.repeat(1000) + '수면 실험에는 24명이 참여했다. ' + '후속 설명 '.repeat(300)] },
  ], '수면 실험');
  assert.ok(result.includes('24명'));
  assert.ok(!result.includes('old deleted content'));
  assert.ok(result.length <= WRITING_CONTEXT_CHARS);
});

test('write planning merges adjacent parts, preserves assignments and exact total length', () => {
  const parts = Array.from({ length: 5 }, (_, i) => ({ heading: `H${i}`, points: [`P${i}`], sketchItems: [`S${i}`], chars: 1600 }));
  const groups = groupWriteParts(parts, 8000, 5000);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.flat().flatMap(p => p.sketchItems), parts.flatMap(p => p.sketchItems));
  assert.deepEqual(groups.flat().flatMap(p => p.points), parts.flatMap(p => p.points));
  assert.equal(groups.flat().reduce((sum, p) => sum + p.chars, 0), 8000);
  assert.ok(groups.every(g => g.reduce((sum, p) => sum + p.chars, 0) <= 5000));
  const split = groupWriteParts([parts[0]], 10001, 5000).flat();
  assert.equal(split.reduce((sum, p) => sum + p.chars, 0), 10001);
  assert.equal(split.filter(p => p.heading).length, 1);
  assert.ok(split.slice(1).every(p => p.continuation));
  assert.equal(singleWriteLimit(32000), 5000);
  assert.ok(writeTokens(singleWriteLimit(12000)) <= 12000 * 0.9);
});

test('six-page writing makes one body call without an outline or summary', async () => {
  const { tasks, state } = await tasksHarness();
  state.book = book([section('previous'), section('current')]); state.calls = []; state.requests = []; state.store.clear();
  state.settings.model = 'keep-current-model';
  const opts = { targetPages: 6, mode: 'overwrite' };
  assert.deepEqual(await tasks.prepareSection('current', opts), { ready: false });
  const events = [];
  for await (const e of tasks.writeSection('current', opts)) events.push(e);
  assert.deepEqual(state.calls, ['section_write']);
  assert.equal(events.at(-2).timing.outlineMs, 0);
  assert.equal(state.settings.model, 'keep-current-model');
});

test('merged calls receive their own length and stop after truncated output', async () => {
  const { tasks, state } = await tasksHarness();
  state.book = book([section('current')]); state.store.clear(); state.calls = []; state.requests = [];
  state.parts = Array.from({ length: 5 }, (_, i) => ({ heading: `H${i}`, points: [`P${i}`], sketchItems: [`S${i}`], chars: 1600 }));
  const opts = { targetPages: 12, mode: 'overwrite' };
  for await (const e of tasks.writeSection('current', opts)) {}
  assert.deepEqual(state.calls, ['section_outline', 'section_write_part', 'section_write_part', 'section_write_part']);
  const vars = state.requests.map(r => JSON.parse(r.messages[0].content).vars);
  assert.equal(vars.reduce((sum, v) => sum + v.targetChars, 0), 8400);
  assert.ok(vars.every(v => v.targetChars <= 5000));
  assert.ok(vars[0].partInfo.includes('H0') && vars[0].partInfo.includes('H1'));
  state.requests = []; state.truncated = true;
  try {
    const events = [];
    for await (const e of tasks.writeSection('current', opts)) events.push(e);
    assert.equal(state.requests.length, 1);
    assert.ok(events.some(e => e.t === 'status' && e.v === 'truncated'));
  } finally { state.truncated = false; state.parts = undefined; }
});

test('idle summary refreshes only the edited section and never regenerates a chapter', async () => {
  const { tasks, state } = await tasksHarness();
  state.book = book([section('a'), section('b')]); state.calls = [];
  await tasks.summarizeSection('a');
  assert.deepEqual(state.calls, ['summary']);
  await tasks.summarizeSection('b');
  assert.deepEqual(state.calls, ['summary', 'summary']);
  await tasks.summarizeSection('b');
  assert.equal(state.calls.length, 2);
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
