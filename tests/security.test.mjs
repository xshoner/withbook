import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAccess } from '../src/lib/security.ts';
import { sectionInput, validDocument } from '../src/lib/section-input.ts';
import { figureHtml } from '../src/lib/print/render.ts';
import { readZipEntry } from '../src/lib/zip-limits.ts';
import JSZip from 'jszip';

test('local requests work; external hosts and cross-origin writes fail', () => {
  process.env.APP_ACCESS_MODE = 'local'; delete process.env.APP_ORIGIN;
  assert.equal(checkAccess(new Request('http://localhost:3100/api/projects')), null);
  assert.equal(checkAccess(new Request('http://localhost:3100/api/projects', { method: 'PUT', headers: { host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100' } })), null);
  assert.equal(checkAccess(new Request('http://evil.example/api/projects')).status, 403);
  assert.equal(checkAccess(new Request('http://localhost:3100/api/projects', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
});

test('web mode allows remote hosts but still blocks cross-site writes', () => {
  process.env.APP_ACCESS_MODE = 'web';
  const url = 'https://writer.example/api/projects';
  assert.equal(checkAccess(new Request(url)), null);
  assert.equal(checkAccess(new Request(url, { method: 'POST', headers: { host: 'writer.example', origin: 'https://writer.example' } })), null);
  assert.equal(checkAccess(new Request(url, { method: 'POST', headers: { host: 'writer.example', origin: 'https://evil.example' } })).status, 403);
  process.env.APP_ACCESS_MODE = 'local';
});

test('render tokens only open print resources and expire', async () => {
  process.env.RENDER_SECRET = 'test-render-secret';
  const { makeRenderToken, validRenderToken, RENDER_HEADER } = await import('../src/lib/render-token.ts');
  const h = { [RENDER_HEADER]: makeRenderToken() };
  assert.equal(validRenderToken(new Request('https://w.example/book/abc', { headers: h })), true);
  assert.equal(validRenderToken(new Request('https://w.example/api/projects', { headers: h })), false);
  assert.equal(validRenderToken(new Request('https://w.example/book/abc', { method: 'POST', headers: h })), false);
  assert.equal(validRenderToken(new Request('https://w.example/book/abc', { headers: { [RENDER_HEADER]: makeRenderToken(-1000) } })), false);
  assert.equal(validRenderToken(new Request('https://w.example/book/abc', { headers: { [RENDER_HEADER]: '9999999999999.bad' } })), false);
});

test('malformed, oversized and deeply nested documents are rejected', () => {
  assert.equal(validDocument('{'), false);
  assert.equal(validDocument('{"type":"doc","content":"oops"}'), false);
  let doc = { type: 'paragraph' };
  for (let i = 0; i < 40; i++) doc = { type: 'blockquote', content: [doc] };
  assert.equal(validDocument(JSON.stringify({ type: 'doc', content: [doc] })), false);
  assert.equal(sectionInput.safeParse({ content: 'x'.repeat(2000001) }).success, false);
  assert.equal(sectionInput.safeParse({ status: 'invented' }).success, false);
  assert.equal(sectionInput.safeParse({ content: '{"type":"doc","content":[{"type":"paragraph"}]}' }).success, true);
});

test('print figures cannot inject HTML or request remote resources', () => {
  const html = figureHtml({ type: 'figure', attrs: { layout: '\" onclick=\"alert(1)', src: 'http://169.254.169.254/secret', caption: '<script>' } }, { chapterNo: 1, counter: { n: 0 } });
  assert.equal(html.includes('onclick'), false); assert.equal(html.includes('169.254'), false);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('zip entries are stopped at their expanded size limit', async () => {
  const zip = new JSZip(); zip.file('large.txt', 'x'.repeat(100000));
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  await assert.rejects(readZipEntry(loaded.file('large.txt'), 1024), { status: 413 });
  assert.equal((await readZipEntry(loaded.file('large.txt'), 100000)).length, 100000);
});
