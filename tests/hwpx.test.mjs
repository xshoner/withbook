import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import JSZip from 'jszip';

const asModule = js => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const image = Buffer.from('unchanged original image bytes');
const mock = asModule(`
  export const prisma = { asset: { findMany: async () => [
    { id: 'a', path: 'a.png', mime: 'image/png', widthPx: 600, heightPx: 300 },
    { id: 'b', path: 'b.png', mime: 'image/png', widthPx: 600, heightPx: 300 }
  ] } };
  export const getObject = async () => Buffer.from('unchanged original image bytes');
  export const mapLimit = async (items, limit, fn) => Promise.all(items.map(fn));
`);
const cache = new Map();
async function moduleUrl(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  const source = await readFile(url, 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', '');
  for (const match of [...js.matchAll(/from "([^"]+)"/g)]) {
    const spec = match[1];
    const resolved = ['../storage', '../db'].includes(spec) ? mock
      : spec.startsWith('.') ? await moduleUrl(new URL(spec + '.ts', url))
      : spec.startsWith('node:') ? spec : import.meta.resolve(spec);
    js = js.replace(match[0], `from ${JSON.stringify(resolved)}`);
  }
  const result = asModule(js);
  cache.set(url.href, result);
  return result;
}

test('HWPX reuses image bytes while preserving every figure, size and caption', async () => {
  const { buildHwpx } = await import(await moduleUrl(new URL('../src/lib/export/hwpx.ts', import.meta.url)));
  const { parseLayout } = await import(await moduleUrl(new URL('../src/lib/layout.ts', import.meta.url)));
  const figures = [['a', 40], ['a', 80], ['b', 60], ['a', 50]].map(([assetId, widthMm], i) => ({
    type: 'figure', attrs: { assetId, widthMm, layout: 'mm', caption: `caption ${i}` },
  }));
  const book = {
    project: { title: 'test', author: 'author', subtitle: '' }, layout: parseLayout(null),
    chapters: [{ title: 'chapter', kind: 'body', no: 1, sections: [{ title: 'section', label: '1', content: JSON.stringify({ type: 'doc', content: figures }) }] }],
  };
  const zip = await JSZip.loadAsync(await buildHwpx(book), { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).filter(f => f.startsWith('BinData/')), ['BinData/image1.png', 'BinData/image2.png']);
  for (const file of ['BinData/image1.png', 'BinData/image2.png']) assert.deepEqual(await zip.file(file).async('nodebuffer'), image);
  const xml = await zip.file('Contents/section0.xml').async('string');
  assert.deepEqual([...xml.matchAll(/binaryItemIDRef="([^"]+)"/g)].map(m => m[1]), ['image1', 'image1', 'image2', 'image1']);
  assert.equal(new Set([...xml.matchAll(/<hp:pic id="([^"]+)"/g)].map(m => m[1])).size, 4);
  assert.equal(new Set([...xml.matchAll(/<hp:curSz width="([^"]+)"/g)].map(m => m[1])).size, 4);
  for (let i=0; i<4; i++) assert.ok(xml.includes(`caption ${i}`));
  const manifest = await zip.file('Contents/content.hpf').async('string');
  assert.equal([...manifest.matchAll(/isEmbeded="1"/g)].length, 2);
  assert.equal(await zip.file('mimetype').async('string'), 'application/hwp+zip');
});
