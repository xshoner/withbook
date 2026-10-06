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

test('HWPX follows the PDF layout: TOC page numbers, PDF page breaks/blank pages, body numbering from 1, colophon at the bottom', async () => {
  const { buildHwpx, colophonTopMm } = await import(await moduleUrl(new URL('../src/lib/export/hwpx.ts', import.meta.url)));
  const { parseLayout } = await import(await moduleUrl(new URL('../src/lib/layout.ts', import.meta.url)));
  const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const book = {
    project: { title: '책', author: '지은이', subtitle: '' }, layout: parseLayout(null),
    chapters: [{ id: 'c1', title: '첫 장', label: '1장', kind: 'body', no: 1, sections: [{ id: 's1', title: '첫 절', label: '1', content: JSON.stringify({ type: 'doc', content: [p('가'), p('나'), p('다')] }) }] }],
  };
  // PDF: 0 표제지, 1 판권면, 2 속표지, 3 차례, 4 장 제목(1쪽), 5 절(2쪽) — 셋째 문단은 6쪽
  const frag = (ref, page) => ({ sid: 's1', ref, tag: 'P', cls: '', page, len: 1 });
  const paging = {
    info: { sections: { s1: { start: 2, startIdx: 6, endIdx: 7 } }, chapters: { c1: { start: 1 } } },
    frags: [{ sid: 's1', ref: '', tag: 'SECTION', cls: '', page: 5, len: 0 }, frag('a', 5), frag('b', 5), frag('c', 6)],
    chapters: { c1: 4 }, toc: [3, 3], colophon: 1, inner: 2,
  };
  const zip = await JSZip.loadAsync(await buildHwpx(book, { paging }));
  const xml = await zip.file('Contents/section0.xml').async('string');
  assert.match(xml, /첫 절<\/hp:t><\/hp:run><hp:run charPrIDRef="0"><hp:t><hp:tab\/>2<\/hp:t>/); // 차례: 절 2쪽
  assert.match(xml, /첫 장<\/hp:t><\/hp:run><hp:run charPrIDRef="4"><hp:t><hp:tab\/>1<\/hp:t>/);
  assert.equal([...xml.matchAll(/<hp:newNum num="1" numType="PAGE"\/>/g)].length, 1);
  // 쪽 수: 표제지 + 새 쪽 6번 = 7쪽 (PDF와 같다)
  assert.equal([...xml.matchAll(/pageBreak="1"/g)].length, 6);
  const paras = [...xml.matchAll(/<hp:p [^>]*pageBreak="(\d)"[^>]*>(.*?)<\/hp:p>/g)];
  const third = paras.findIndex((m) => m[2].includes('>다<'));
  assert.equal(paras[third][1], '1'); // PDF에서 새 쪽에 놓인 문단
  assert.equal(paras.find((m) => m[2].includes('>나<'))[1], '0');
  assert.match(xml, /paraPrIDRef="9"[^>]*pageBreak="1"/); // 판권면 첫 줄
  const header = await zip.file('Contents/header.xml').async('string');
  assert.match(header, /autoTabRight="1"/);
  assert.ok(colophonTopMm(book) > 60 && colophonTopMm(book) < 160);
  // 조판을 재지 못해도 차례는 들어간다
  const plain = await (await JSZip.loadAsync(await buildHwpx(book))).file('Contents/section0.xml').async('string');
  assert.match(plain, />차례</);
});

test('a paragraph the PDF split across pages is split at the same character (spaces not counted, footnotes kept)', async () => {
  const { splitInline } = await import(await moduleUrl(new URL('../src/lib/export/hwpx.ts', import.meta.url)));
  const para = { type: 'paragraph', content: [{ type: 'text', text: '가나 다라' }, { type: 'footnote', attrs: { note: '주' } }, { type: 'text', text: ' 마바 사아', marks: [{ type: 'bold' }] }] };
  const [a, b, c] = splitInline(para, [3, 5]);
  assert.deepEqual(a.content.map((n) => n.text ?? n.type), ['가나 다']);
  assert.deepEqual(b.content.map((n) => n.text ?? n.type), ['라', 'footnote', ' 마']);
  assert.deepEqual(c.content.map((n) => n.text ?? n.type), ['바 사아']);
  assert.deepEqual(c.content[0].marks, [{ type: 'bold' }]);
});

test('a footnote right after the sentence end stays with the earlier piece', async () => {
  const { splitInline } = await import(await moduleUrl(new URL('../src/lib/export/hwpx.ts', import.meta.url)));
  const para = { type: 'paragraph', content: [{ type: 'text', text: '가나다.' }, { type: 'footnote', attrs: { note: '주' } }, { type: 'text', text: ' 라마바' }] };
  const [a, b] = splitInline(para, [4]);
  assert.deepEqual(a.content.map((n) => n.text ?? n.type), ['가나다.', 'footnote']);
  assert.deepEqual(b.content.map((n) => n.text ?? n.type), ['라마바']);
});
