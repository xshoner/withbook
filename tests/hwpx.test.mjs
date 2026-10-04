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

test('HWPX: author right, colophon pushed to page bottom, page numbers start at the preface', async () => {
  const { buildHwpx } = await import(await moduleUrl(new URL('../src/lib/export/hwpx.ts', import.meta.url)));
  const { parseLayout } = await import(await moduleUrl(new URL('../src/lib/layout.ts', import.meta.url)));
  const doc = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] });
  const book = {
    project: { title: 'BookTitle', author: 'AuthorName', subtitle: '' }, layout: parseLayout(null),
    chapters: [
      { title: '머리말', kind: 'front', no: 0, label: '', sections: [{ title: '머리말', label: '', content: doc }] },
      { title: 'First', kind: 'body', no: 1, label: '1장', sections: [{ title: 'sec', label: '1.1', content: doc }] },
    ],
  };
  const zip = await JSZip.loadAsync(await buildHwpx(book));
  const xml = await zip.file('Contents/section0.xml').async('string');
  const head = await zip.file('Contents/header.xml').async('string');
  const paras = [...xml.matchAll(/<hp:p id="\d+" paraPrIDRef="(\d+)"[^>]*>(.*?)<\/hp:p>/g)].map(m => ({ pr: m[1], body: m[2] }));
  const prOf = id => head.match(new RegExp(`<hh:paraPr id="${id}"[^>]*><hh:align horizontal="([A-Z]+)"`))[1];
  // 표제지 지은이: 오른쪽 정렬
  const author = paras.find(p => p.body.includes('<hp:t>AuthorName</hp:t>'));
  assert.equal(prOf(author.pr), 'RIGHT');
  // 판권면은 빈 줄(8.5pt × 100% ≈ 3mm, 문단 간격 없음)로 쪽 아래로 밀린다
  const spacers = paras.filter(p => p.pr === '8');
  assert.ok(spacers.length * 3 > 80, `colophon pushed by ${spacers.length} lines`);
  assert.equal(head.match(/<hh:paraPr id="8".*?<hc:prev value="(\d+)"/)[1], '0');
  const cpTitle = paras[paras.indexOf(spacers.at(-1)) + 1];
  assert.ok(cpTitle.body.includes('BookTitle'));
  // 쪽 번호 컨트롤은 머리말 제목 문단에 한 번, 본문 장 제목 쪽은 번호를 감춘다
  assert.equal([...xml.matchAll(/<hp:pageNum /g)].length, 1);
  const pn = paras.findIndex(p => p.body.includes('<hp:pageNum '));
  assert.ok(paras[pn].body.includes('<hp:t>머리말</hp:t>'));
  const hide = paras.find(p => p.body.includes('hidePageNum="1"'));
  assert.ok(hide.body.includes('<hp:t>First</hp:t>'));
});

test('HWPX contents carry page numbers and each chapter/section restarts at that number', async () => {
  const { buildHwpx } = await import(await moduleUrl(new URL('../src/lib/export/hwpx.ts', import.meta.url)));
  const { parseLayout } = await import(await moduleUrl(new URL('../src/lib/layout.ts', import.meta.url)));
  const doc = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] });
  const book = {
    project: { title: 'T', author: 'A', subtitle: '' }, layout: parseLayout(null),
    chapters: [
      { id: 'f', title: 'Preface', kind: 'front', no: 0, label: '', sections: [{ id: 'fs', title: 'Preface', label: '', content: doc }] },
      { id: 'c1', title: 'First', kind: 'body', no: 1, label: '1장', sections: [{ id: 's1', title: 'One', label: '1.1', content: doc }, { id: 's2', title: 'Two', label: '1.2', content: doc }] },
    ],
  };
  const sectionXml = async (pages) => (await JSZip.loadAsync(await buildHwpx(book, {}, pages))).file('Contents/section0.xml').async('string');
  const xml = await sectionXml({ f: 5, c1: 7, s1: 8, s2: 11 });
  for (const [title, n] of [['Preface', 5], ['1장 First', 7], ['    1.1 One', 8], ['    1.2 Two', 11]])
    assert.ok(xml.includes(`<hp:t>${title}<hp:tab width="0" leader="DOT" type="RIGHT"/>${n}</hp:t>`), title);
  assert.deepEqual([...xml.matchAll(/<hp:newNum num="(\d+)"/g)].map(m => Number(m[1])), [5, 7, 8, 11]);
  const head = await (await JSZip.loadAsync(await buildHwpx(book, {}, {}))).file('Contents/header.xml').async('string');
  assert.ok(/<hh:tabPr id="1"[^>]*><hh:tabItem pos="\d+" type="RIGHT" leader="DOT"\/>/.test(head));
  // 쪽 번호를 모르면 차례는 제목만, 번호를 새로 시작하지 않는다
  const plain = await sectionXml({});
  assert.ok(!plain.includes('<hp:tab ') && !plain.includes('<hp:newNum'));
  assert.ok(plain.includes('<hp:t>1장 First</hp:t>'));
});
