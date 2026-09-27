import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// server-only·DB 없이 순수 함수만 불러온다
async function load(rel, replace = []) {
  let source = await readFile(new URL(rel, import.meta.url), 'utf8');
  source = source.replace('import "server-only";', '');
  for (const [a, b] of replace) source = source.replace(a, b);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

test('commons results keep printable images with credit and strip tracking queries', async () => {
  const c = await load('../src/lib/images/commons.ts');
  const page = (title, ii, index) => ({ title, index, imageinfo: [ii] });
  const meta = { Artist: { value: '<a href="x">Jaap Murre</a>' }, LicenseShortName: { value: 'CC BY 4.0' }, ImageDescription: { value: '<p>Forgetting&nbsp;curve</p>' } };
  const out = c.parseCommons({ query: { pages: [
    page('File:Curve.svg', { url: 'https://upload.wikimedia.org/a/Curve.svg?utm_source=x', thumburl: 'https://thumb.wikimedia.org/w/thumb/a/Curve.svg/1920px-Curve.svg.png?utm_source=x', thumbwidth: 1600, thumbheight: 900, width: 800, height: 450, mime: 'image/svg+xml', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Curve.svg', extmetadata: meta }, 2),
    page('File:Photo.jpg', { url: 'https://upload.wikimedia.org/b/Photo.jpg', width: 1200, height: 800, mime: 'image/jpeg', descriptionurl: 'd', extmetadata: {} }, 1),
    page('File:Icon.png', { url: 'https://upload.wikimedia.org/c/Icon.png', width: 64, height: 64, mime: 'image/png', descriptionurl: 'd' }, 3),
    page('File:Clip.webm', { url: 'https://upload.wikimedia.org/d/Clip.webm', width: 1920, height: 1080, mime: 'video/webm', descriptionurl: 'd' }, 4),
    page('File:Evil.png', { url: 'https://evil.example/e.png', width: 1000, height: 800, mime: 'image/png', descriptionurl: 'd' }, 5),
  ] } });
  assert.deepEqual(out.map((x) => x.title), ['Photo', 'Curve']);
  const svg = out[1];
  assert.equal(svg.src, 'https://thumb.wikimedia.org/w/thumb/a/Curve.svg/1920px-Curve.svg.png');
  assert.equal(svg.thumb, 'https://thumb.wikimedia.org/w/thumb/a/Curve.svg/330px-Curve.svg.png');
  assert.equal(svg.artist, 'Jaap Murre');
  assert.equal(svg.description, 'Forgetting curve');
  assert.equal(c.creditLine(svg), '출처: Jaap Murre, CC BY 4.0, Wikimedia Commons');
});

test('image import only downloads from Wikimedia file servers', async () => {
  const c = await load('../src/lib/images/commons.ts');
  for (const ok of ['https://upload.wikimedia.org/a.png', 'https://thumb.wikimedia.org/x/330px-a.png']) assert.equal(c.commonsDownloadAllowed(ok), true);
  for (const bad of ['http://upload.wikimedia.org/a.png', 'https://upload.wikimedia.org.evil.com/a.png', 'https://user:pw@upload.wikimedia.org/a', 'https://upload.wikimedia.org:8443/a', 'https://127.0.0.1/a', 'file:///etc/passwd', 'nonsense'])
    assert.equal(c.commonsDownloadAllowed(bad), false, bad);
});

test('project list pages follow the measured typeset count', async () => {
  const p = await load('../src/lib/print/page-count.ts', [['import { prisma } from "../db";', 'const prisma = {};']]);
  // 잰 적 없음 → 글자 수 어림
  assert.deepEqual(p.listPages(7000, 700, null), { pages: 10, exact: false });
  // 잰 뒤 글자 수 그대로 → 집필 화면과 같은 쪽수 (어림과 달라도)
  assert.deepEqual(p.listPages(7000, 700, { total: 18, source: 'editor', at: '', chars: 7000 }), { pages: 18, exact: true });
  // 조금 바뀜(쪽의 1/4 미만) → 그대로
  assert.deepEqual(p.listPages(7100, 700, { total: 18, source: 'editor', at: '', chars: 7000 }), { pages: 18, exact: true });
  // 편집기 밖에서 1,400자 늘었다 → 2쪽 더해 어림
  assert.deepEqual(p.listPages(8400, 700, { total: 18, source: 'editor', at: '', chars: 7000 }), { pages: 20, exact: false });
  // 옛 기록(글자 수 없음) → 잰 쪽수
  assert.deepEqual(p.listPages(1, 700, { total: 18, source: 'pdf', at: '' }), { pages: 18, exact: false });
  assert.equal(p.parsePageCount('{"total":0}'), null);
  assert.equal(p.parsePageCount('bad'), null);
});

test('made figures: prompt follows the paragraph and text choice, sizes are sane', async () => {
  const f = await load('../src/lib/images/figure-prompt.ts');
  const base = { bookTitle: '기억의 과학', sectionTitle: '망각 곡선', paragraph: '에빙하우스는 망각 곡선을 측정했다.', style: 'diagram', instruction: '', withText: false };
  const p = f.buildFigurePrompt(base);
  assert.ok(p.includes('에빙하우스는 망각 곡선을 측정했다.'));
  assert.ok(p.includes('No text'));
  assert.ok(!p.includes("Author's additional direction"));
  const q = f.buildFigurePrompt({ ...base, style: 'photo', withText: true, instruction: '파란색 계열' });
  assert.ok(q.includes('photograph') && q.includes('Hangul') && q.includes('파란색 계열'));
  assert.equal(f.figureRequestSize('portrait'), '1024x1536');
  assert.equal(f.figureRequestSize('landscape', '2000x1000'), '2000x1008');
  assert.equal(f.figureRequestSize('square', '99999x1'), '1024x1024');
  assert.equal(f.figureFallbackSize('square'), '1024x1024');
});

test('raw SQL prefix filters do not pass a JS number to left() (Postgres has no left(text, bigint))', async () => {
  for (const f of ['../src/lib/section-refs-store.ts', '../src/lib/trash.ts']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.equal(/left\(key,\s*\$\{/.test(src), false, f);
    assert.ok(src.includes('starts_with(key, ${prefix})'), f);
  }
});
