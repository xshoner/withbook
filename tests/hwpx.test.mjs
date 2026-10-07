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

test('HWPX starts chapters/sections on the PDF pages with TOC page numbers, lets body text flow, numbers the body from 1, colophon at the bottom', async () => {
  const { buildHwpx, colophonTopMm } = await import(await moduleUrl(new URL('../src/lib/export/hwpx.ts', import.meta.url)));
  const { parseLayout } = await import(await moduleUrl(new URL('../src/lib/layout.ts', import.meta.url)));
  const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const book = {
    project: { title: '책', author: '지은이', subtitle: '' }, layout: parseLayout(null),
    chapters: [{ id: 'c1', title: '첫 장', label: '1장', kind: 'body', no: 1, sections: [{ id: 's1', title: '첫 절', label: '1', content: JSON.stringify({ type: 'doc', content: [p('가'), p('나'), p('다')] }) }] }],
  };
  // PDF: 0 표제지, 1 판권면, 2 속표지, 3 차례, 4 장 제목(1쪽), 5 절(2쪽) — 셋째 문단은 PDF에서 6쪽으로 넘어갔다
  const paging = {
    info: { sections: { s1: { start: 2, startIdx: 6, endIdx: 7 } }, chapters: { c1: { start: 1 } } },
    chapters: { c1: 4 }, toc: [3, 3], colophon: 1, inner: 2,
  };
  const zip = await JSZip.loadAsync(await buildHwpx(book, { paging }));
  const xml = await zip.file('Contents/section0.xml').async('string');
  // 차례 쪽 번호: 한글이 장·절 책갈피 쪽을 계산하는 상호 참조, 처음 값은 PDF 번호
  assert.match(xml, /첫 절<\/hp:t><\/hp:run><hp:run charPrIDRef="0"><hp:t><hp:tab\/><\/hp:t><\/hp:run><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin [^>]*type="CROSSREF"[^]*?Command">\?toc_s1;6;0;0<[^]*?<\/hp:fieldBegin><\/hp:ctrl><hp:t>2<\/hp:t>/);
  assert.match(xml, /첫 장<\/hp:t><\/hp:run><hp:run charPrIDRef="4"><hp:t><hp:tab\/><\/hp:t><\/hp:run><hp:run charPrIDRef="4"><hp:ctrl><hp:fieldBegin [^]*?Command">\?toc_c1;6;0;0<[^]*?<hp:t>1<\/hp:t>/);
  assert.match(xml, /<hp:bookmark name="toc_c1"\/>[^]*<hp:bookmark name="toc_s1"\/><\/hp:ctrl><\/hp:run><hp:run charPrIDRef="3"><hp:t>1 첫 절/);
  assert.equal([...xml.matchAll(/<hp:newNum /g)].length, 1); // 본문 첫 장에서만 1로 — 쪽 번호는 건너뛰지 않는다
  // 새 쪽: 판권면·속표지·차례·장·절 — 절 안의 글은 PDF가 쪽을 넘긴 자리와 상관없이 한글이 흘린다
  assert.equal([...xml.matchAll(/pageBreak="1"/g)].length, 5);
  const paras = [...xml.matchAll(/<hp:p [^>]*pageBreak="(\d)"[^>]*>(.*?)<\/hp:p>/g)];
  for (const t of ['가', '나', '다']) assert.equal(paras.find((m) => m[2].includes(`>${t}<`))[1], '0');
  assert.match(xml, /paraPrIDRef="9"[^>]*pageBreak="1"/); // 판권면 첫 줄
  const header = await zip.file('Contents/header.xml').async('string');
  assert.match(header, /autoTabRight="1"/);
  assert.match(header, /<hh:paraPr id="0".*?<hh:lineSpacing type="PERCENT" value="160"/); // 책 줄 간격 그대로
  assert.doesNotMatch(header, /<hh:ratio hangul="(?!100")/); // 장평 100%
  assert.ok(colophonTopMm(book) > 60 && colophonTopMm(book) < 160);
  // 조판을 재지 못해도 차례는 들어간다
  const plain = await (await JSZip.loadAsync(await buildHwpx(book))).file('Contents/section0.xml').async('string');
  assert.match(plain, />차례</);
});
