import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import JSZip from 'jszip';

const asModule = js => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const image = Buffer.from('png image bytes');
const mock = asModule(`
  export const prisma = { asset: { findMany: async () => [
    { id: 'a', path: 'p/a.png', mime: 'image/png', widthPx: 600, heightPx: 300 },
    { id: 'b', path: 'p/b.jpg', mime: 'image/jpeg', widthPx: 600, heightPx: 300 }
  ] } };
  export const getObject = async () => Buffer.from('png image bytes');
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

/** 아주 작은 XML 검사 — 태그 짝, 엔티티(&amp; 등 5개 + 숫자 참조만), 속성 따옴표 */
function assertWellFormed(xml, name) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/<!DOCTYPE[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
  for (const m of body.matchAll(re)) {
    assert.ok(m[2], `${name}: stray "${m[0]}" at ${m.index}: ${body.slice(Math.max(0, m.index - 40), m.index + 40)}`);
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `${name}: mismatched </${m[2]}>`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

async function build(extra = {}) {
  const { buildEpub } = await import(await moduleUrl(new URL('../src/lib/export/epub.ts', import.meta.url)));
  const { parseLayout } = await import(await moduleUrl(new URL('../src/lib/layout.ts', import.meta.url)));
  const doc = content => JSON.stringify({ type: 'doc', content });
  const book = {
    project: { id: 'proj1', title: 'A < B & "C"', author: '홍길동', subtitle: '부제' }, layout: parseLayout(null),
    chapters: [
      { title: '머리말', kind: 'front', no: 0, label: '', sections: [{ title: '머리말', label: '', content: doc([{ type: 'paragraph', content: [{ type: 'text', text: '처음 & 끝' }] }]) }] },
      { title: '첫 장 <시작>', kind: 'body', no: 1, label: '1장', sections: [
        { title: '절 하나', label: '1.1', content: doc([
          { type: 'paragraph', content: [
            { type: 'text', text: 'x < y && z', marks: [{ type: 'bold' }] },
            { type: 'footnote', attrs: { note: '각주 <하나> & 설명' } },
            { type: 'hardBreak' },
            { type: 'text', text: '둘째 줄' },
            { type: 'footnote', attrs: { note: '각주 둘' } },
          ] },
          { type: 'figure', attrs: { assetId: 'a', layout: 'mm', widthMm: 50, caption: '그림 <설명>' } },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '항목' }] }] }] },
          { type: 'horizontalRule' },
        ]) },
        { title: '절 둘', label: '1.2', content: doc([
          { type: 'figure', attrs: { assetId: 'a', layout: 'fit' } },
          { type: 'figure', attrs: { assetId: 'b', layout: 'fit', caption: 'b' } },
        ]) },
      ] },
      { title: '둘째 장', kind: 'body', no: 2, label: '2장', sections: [{ title: '절', label: '2.1', content: doc([{ type: 'paragraph', content: [{ type: 'text', text: '본문' }, { type: 'footnote', attrs: { note: '다른 장 각주' } }] }]) }] },
      { title: '빈 장', kind: 'body', no: 3, label: '3장', sections: [] },
    ],
  };
  const buf = await buildEpub(book, { biblio: { enabled: true, entries: [{ text: '저자, 「책 & 논문」' }] } }, { modified: new Date('2026-01-02T03:04:05.678Z'), ...extra });
  return { buf, zip: await JSZip.loadAsync(buf, { checkCRC32: true }) };
}

test('EPUB: mimetype is the first entry, stored uncompressed with no extra field', async () => {
  const { buf, zip } = await build();
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt16LE(8), 0, 'compression method must be STORE');
  assert.equal(buf.readUInt16LE(26), 8);
  assert.equal(buf.readUInt16LE(28), 0, 'no extra field');
  assert.equal(buf.subarray(30, 38).toString(), 'mimetype');
  assert.equal(buf.subarray(38, 58).toString(), 'application/epub+zip');
});

test('EPUB: container points at the OPF and manifest/spine are consistent', async () => {
  const { zip } = await build();
  const container = await zip.file('META-INF/container.xml').async('string');
  assert.match(container, /full-path="OEBPS\/content\.opf"/);
  assert.match(container, /media-type="application\/oebps-package\+xml"/);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assertWellFormed(opf, 'content.opf');
  assert.match(opf, /<dc:identifier id="bookid">urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}<\/dc:identifier>/);
  assert.match(opf, /unique-identifier="bookid"/);
  assert.match(opf, /<dc:title>A &lt; B &amp; &quot;C&quot;<\/dc:title>/);
  assert.match(opf, /<dc:creator id="author">홍길동<\/dc:creator>/);
  assert.match(opf, /<dc:language>ko<\/dc:language>/);
  assert.match(opf, /<meta property="dcterms:modified">2026-01-02T03:04:05Z<\/meta>/);
  // 같은 책은 늘 같은 식별자
  const again = await (await build()).zip.file('OEBPS/content.opf').async('string');
  assert.equal(again.match(/urn:uuid:[^<]+/)[0], opf.match(/urn:uuid:[^<]+/)[0]);

  const items = [...opf.matchAll(/<item id="([^"]+)" href="([^"]+)" media-type="([^"]+)"/g)].map(m => ({ id: m[1], href: m[2], type: m[3] }));
  const ids = new Set(items.map(i => i.id));
  assert.equal(ids.size, items.length, 'manifest ids are unique');
  for (const i of items) assert.ok(zip.file('OEBPS/' + i.href), `manifest file exists: ${i.href}`);
  const listed = new Set(items.map(i => 'OEBPS/' + i.href));
  for (const f of Object.keys(zip.files)) if (f.startsWith('OEBPS/') && f !== 'OEBPS/content.opf') assert.ok(listed.has(f), `zip file is in manifest: ${f}`);
  assert.ok(/properties="nav"/.test(opf));
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map(m => m[1]);
  for (const id of spine) assert.ok(ids.has(id), `spine idref in manifest: ${id}`);
  const href = id => items.find(i => i.id === id).href;
  // 읽는 순서: 표제지 · 판권 · 차례 · 앞붙이(머리말) · 본문 · 참고문헌 (빈 장은 뺀다)
  assert.deepEqual(spine.map(href), ['title.xhtml', 'colophon.xhtml', 'nav.xhtml', 'ch001.xhtml', 'ch002.xhtml', 'ch003.xhtml', 'biblio.xhtml']);
  // 같은 그림은 한 번만 담고 미디어 형식을 맞춘다
  assert.deepEqual(items.filter(i => i.href.startsWith('images/')).map(i => [i.href, i.type]), [['images/img1.png', 'image/png'], ['images/img2.jpg', 'image/jpeg']]);
  assert.deepEqual(await zip.file('OEBPS/images/img1.png').async('nodebuffer'), image);
  assert.ok(!Object.keys(zip.files).some(f => /\.(ttf|otf|woff2?)$/i.test(f)), 'no embedded fonts');
});

test('EPUB: XHTML is well-formed, text is escaped and footnotes link both ways per chapter', async () => {
  const { zip } = await build();
  for (const f of Object.keys(zip.files).filter(f => f.endsWith('.xhtml'))) assertWellFormed(await zip.file(f).async('string'), f);
  const ch = await zip.file('OEBPS/ch002.xhtml').async('string');
  assert.ok(ch.includes('<strong>x &lt; y &amp;&amp; z</strong>'));
  assert.ok(ch.includes('첫 장 &lt;시작&gt;'));
  assert.ok(ch.includes('<br/>'));
  assert.ok(ch.includes('<figcaption><b>그림 1-1</b> 그림 &lt;설명&gt;</figcaption>'));
  assert.ok(ch.includes('<figcaption><b>그림 1-3</b> b</figcaption>'));
  assert.equal([...ch.matchAll(/<img src="images\/img1\.png"/g)].length, 2);
  // 각주: 본문 번호 → 장 끝 각주, 각주 → 본문으로 돌아가는 링크
  const refs = [...ch.matchAll(/<a class="noteref" epub:type="noteref" role="doc-noteref" id="(fnref\d+)" href="#(fn\d+)">/g)];
  assert.deepEqual(refs.map(m => [m[1], m[2]]), [['fnref1', 'fn1'], ['fnref2', 'fn2']]);
  for (const [, back, id] of refs) {
    assert.ok(ch.includes(`<aside epub:type="footnote" role="doc-footnote" id="${id}">`));
    assert.ok(ch.includes(`href="#${back}" role="doc-backlink"`));
  }
  assert.ok(ch.includes('각주 &lt;하나&gt; &amp; 설명'));
  // 각주 번호는 장마다 새로
  const ch2 = await zip.file('OEBPS/ch003.xhtml').async('string');
  assert.ok(ch2.includes('id="fnref1" href="#fn1"') && ch2.includes('id="fn1"'));
  assert.ok(!ch2.includes('id="fn2"'));

  const nav = await zip.file('OEBPS/nav.xhtml').async('string');
  assert.match(nav, /<nav epub:type="toc"/);
  assert.ok(nav.includes('<a href="ch002.xhtml">1장 첫 장 &lt;시작&gt;</a>'));
  assert.ok(nav.includes('<a href="ch002.xhtml#s2">1.2 절 둘</a>'));
  assert.ok(nav.includes('<a href="biblio.xhtml">참고문헌</a>'));
  assert.ok(!nav.includes('빈 장'));
  const bib = await zip.file('OEBPS/biblio.xhtml').async('string');
  assert.ok(bib.includes('저자, 「책 &amp; 논문」'));
  const css = await zip.file('OEBPS/style.css').async('string');
  assert.match(css, /word-break: keep-all/);
  assert.ok(!/@font-face/.test(css));
});
