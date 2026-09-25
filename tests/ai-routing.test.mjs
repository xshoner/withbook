import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { parseAiScope, scopeForPurpose, updatedApiKey } from '../src/lib/ai/routing.ts';
import { singleFlight } from '../src/lib/ai/single-flight.ts';

test('every writing workflow routes to its assigned connection', () => {
  const groups = {
    summary: ['summary', 'chapter_summary'],
    outline: ['toc_design', 'section_outline'],
    writing: ['section_write', 'section_write_part', 'length_adjust'],
    revision: ['proofread', 'chapter_revise', 'rewrite_shorten', 'rewrite_expand'],
    style: ['style_analyze', 'style_learn'], footnote: ['footnote', 'footnote_auto'],
    default: ['ping', 'unknown'],
  };
  for (const [scope, purposes] of Object.entries(groups)) {
    for (const purpose of purposes) assert.equal(scopeForPurpose(purpose), scope);
    assert.equal(parseAiScope(scope), scope);
  }
  assert.equal(parseAiScope(null), 'default');
  for (const invalid of ['constructor', '__proto__', '', {}, 'bad']) assert.throws(() => parseAiScope(invalid), { status: 400 });
});

test('keys cannot accidentally follow a changed provider or URL', () => {
  const old = { apiKey: 'secret', baseUrl: 'https://api.example', provider: 'custom', keyName: 'LLM_API_KEY' };
  assert.equal(updatedApiKey(old, { apiKey: '' }), 'secret');
  assert.throws(() => updatedApiKey(old, { baseUrl: 'https://different.example' }), { status: 400 });
  assert.throws(() => updatedApiKey(old, { provider: 'gemini' }), { status: 400 });
  assert.equal(updatedApiKey(old, { baseUrl: 'https://different.example', apiKey: 'new' }), 'new');
  assert.equal(updatedApiKey(old, { clearKey: true }), '');
});

// Load the real settings implementation with an isolated in-memory settings store.
// No database, environment credentials, or paid AI calls are needed.
async function settingsHarness() {
  let source = await readFile(new URL('../src/lib/ai/settings.ts', import.meta.url), 'utf8');
  source = source.replace('import "server-only";', '')
    .replace('import { getSetting, setSetting } from "../app-settings";',
      'export const testStore = new Map(); const getSetting = async (key) => testStore.get(key) ?? null; const setSetting = async (key, value) => { testStore.set(key, value); };')
    .replace('"../security"', JSON.stringify(new URL('../src/lib/security.ts', import.meta.url).href))
    .replace('"./routing"', JSON.stringify(new URL('../src/lib/ai/routing.ts', import.meta.url).href));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

test('legacy defaults, per-task saves, masked reads, server-side copy and reset', async () => {
  const s = await settingsHarness();
  s.testStore.clear();
  const base = { provider: 'custom', baseUrl: 'https://api.example/v1', apiKey: 'test-secret-original-1234', model: 'writer', keyName: 'TEST_WRITER_API_KEY', authScheme: 'bearer', maxOutputTokens: 32000 };
  s.testStore.set('ai', base);
  assert.equal((await s.loadAiSettings('summary')).inherited, true);
  assert.equal((await s.loadAiSettings('summary')).model, 'writer');
  await s.saveAiSettings({ ...base, provider: 'gemini', baseUrl: s.PROVIDERS.gemini.baseUrl, apiKey: 'test-secret-gemini-5678', model: 'gemini-3.8-flash', reasoningEffort: 'low' }, 'summary');
  assert.equal((await s.loadAiSettings('writing')).model, 'writer');
  assert.equal((await s.loadAiSettings('summary')).reasoningEffort, 'low');
  const pub = await s.publicAiSettings('summary');
  assert.equal(pub.inherited, false);
  assert.equal('apiKey' in pub, false);
  assert.equal(JSON.stringify(pub).includes('test-secret-gemini-5678'), false);
  await s.saveAiSettings({ model: 'gemini-3.8-flash', apiKey: '' }, 'summary');
  assert.equal((await s.loadAiSettings('summary')).apiKey, 'test-secret-gemini-5678');
  await s.copyAiSettings('summary', 'outline');
  assert.equal((await s.loadAiSettings('outline')).apiKey, 'test-secret-gemini-5678');
  await s.resetAiSettings('summary');
  assert.equal((await s.loadAiSettings('summary')).model, 'writer');
  assert.equal((await s.loadAiSettings('outline')).model, 'gemini-3.8-flash');
  await assert.rejects(s.resetAiSettings('default'), { status: 400 });
  await assert.rejects(s.saveAiSettings({ ...base, baseUrl: 'ftp://api.example' }, 'summary'), { status: 400 });
});

test('overlapping summaries share work and failed work can be retried', async () => {
  const run = singleFlight();
  let calls = 0;
  const work = async () => { calls++; return 'summary'; };
  assert.deepEqual(await Promise.all([run('same', work), run('same', work)]), ['summary', 'summary']);
  assert.equal(calls, 1);
  await run('same', work);
  assert.equal(calls, 2);
  await assert.rejects(run('error', async () => { throw new Error('failed'); }));
  assert.equal(await run('error', work), 'summary');
});
