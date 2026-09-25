import test from 'node:test';
import assert from 'node:assert/strict';
import { aiBaseUrlError, aiKeyNameError, privateIp } from '../src/lib/security.ts';
import { extractJson } from '../src/lib/ai/extract-json.ts';
import { getRequestUser, requireRole, runWithContext } from '../src/lib/request-context.ts';

test('AI key names: only *_API_KEY, never app secrets', () => {
  for (const ok of ['LLM_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'LETSUR_API_KEY']) assert.equal(aiKeyNameError(ok), null, ok);
  for (const bad of ['SUPABASE_SECRET_KEY', 'SUPABASE_API_KEY', 'DATABASE_URL', 'DIRECT_API_KEY', 'RENDER_SECRET', 'RENDER_API_KEY', 'MY_SECRET_API_KEY', 'SERVICE_ROLE_API_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'gemini_api_key', 'PATH'])
    assert.notEqual(aiKeyNameError(bad), null, bad);
});

test('private IP literals are detected', () => {
  for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '[::1]', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])
    assert.equal(privateIp(h), true, h);
  for (const h of ['8.8.8.8', '172.32.0.1', 'gw.letsur.ai', '2606:4700::1111']) assert.equal(privateIp(h), false, h);
});

test('AI base URL: https only on web, internal hosts blocked, optional allowlist', () => {
  const web = { web: true, allowedHosts: '' };
  assert.equal(aiBaseUrlError('https://gw.letsur.ai', web), null);
  assert.equal(aiBaseUrlError('https://generativelanguage.googleapis.com/v1beta/openai', web), null);
  for (const bad of ['http://gw.letsur.ai', 'https://localhost:8080', 'https://127.0.0.1', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://metadata.google.internal',
    'https://2130706433/', 'https://0x7f000001/', 'https://10.0.0.5/v1', 'https://user:pw@gw.letsur.ai', 'ftp://x.example', 'not a url'])
    assert.notEqual(aiBaseUrlError(bad, web), null, bad);
  const allow = { web: true, allowedHosts: 'letsur.ai, api.openai.com' };
  assert.equal(aiBaseUrlError('https://gw.letsur.ai', allow), null);
  assert.equal(aiBaseUrlError('https://api.openai.com/v1', allow), null);
  assert.notEqual(aiBaseUrlError('https://evil.example', allow), null);
  assert.notEqual(aiBaseUrlError('https://notletsur.ai', allow), null);
  // 로컬 모드: localhost http 허용, 그 밖의 http는 거부
  assert.equal(aiBaseUrlError('http://localhost:11434/v1', { web: false }), null);
  assert.equal(aiBaseUrlError('http://127.0.0.1:1234', { web: false }), null);
  assert.notEqual(aiBaseUrlError('http://gw.letsur.ai', { web: false }), null);
});

test('extractJson handles fences, prose, braces in strings and picks the valid object', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('설명입니다.\n```\n{"a":"}{"}\n```\n끝'), { a: '}{' });
  assert.deepEqual(extractJson('앞말 {"a":{"b":"x \\" }"}} 뒷말 {참고}'), { a: { b: 'x " }' } });
  assert.deepEqual(extractJson('{메모} 그리고 {"ok":true}'), { ok: true });
  assert.deepEqual(extractJson('{"x":[1,2,{"y":"{"}]}'), { x: [1, 2, { y: '{' }] });
  assert.throws(() => extractJson('JSON 없음'));
  assert.throws(() => extractJson('{"a":'));
});

test('request context exposes the user and enforces roles', async () => {
  assert.equal(getRequestUser(), null);
  assert.throws(() => requireRole('editor'), { status: 401 });
  runWithContext({ user: { id: 'u1', email: 'e@x', role: 'editor' }, startedAt: Date.now() }, () => {
    assert.equal(getRequestUser().id, 'u1');
    assert.equal(requireRole('editor').id, 'u1');
    assert.throws(() => requireRole('superadmin'), { status: 403 });
  });
  await runWithContext({ user: { id: 'a', email: '', role: 'superadmin' }, startedAt: Date.now() }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(requireRole('superadmin').id, 'a');
  });
  runWithContext({ user: { id: 'render', email: '', role: 'render' }, startedAt: Date.now() }, () => {
    assert.throws(() => requireRole('editor'), { status: 403 });
  });
});

test('render tokens bound to a project open only that book', async () => {
  process.env.RENDER_SECRET = 'test-render-secret';
  const { makeRenderToken, validRenderToken, RENDER_HEADER } = await import('../src/lib/render-token.ts');
  const h = { [RENDER_HEADER]: makeRenderToken(60_000, 'proj1') };
  assert.equal(validRenderToken(new Request('https://w.example/book/proj1', { headers: h })), true);
  assert.equal(validRenderToken(new Request('https://w.example/book/proj2', { headers: h })), false);
  assert.equal(validRenderToken(new Request('https://w.example/api/assets/abc', { headers: h })), true);
  assert.equal(validRenderToken(new Request('https://w.example/pagedjs', { headers: h })), true);
  // 프로젝트를 바꿔 끼운 토큰은 서명이 맞지 않는다
  const [exp, , sig] = h[RENDER_HEADER].split('.');
  assert.equal(validRenderToken(new Request('https://w.example/book/proj2', { headers: { [RENDER_HEADER]: `${exp}.proj2.${sig}` } })), false);
  assert.equal(validRenderToken(new Request('https://w.example/book/proj1', { headers: { [RENDER_HEADER]: `${exp}.${sig}` } })), false);
});
