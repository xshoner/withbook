import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import JSZip from 'jszip';
import sharp from 'sharp';
import { withPartialSave, parsePartial, partialKey } from '../src/lib/ai/partial.ts';
import { coverIssues, defaultCover, normalizeCover, syncActualPages, spineWidth, coverLayout, titleElements } from '../src/lib/cover/spec.ts';
import { buildBackupZip } from '../src/lib/export/backup-zip.ts';
import { prepareImage, MAX_EDGE_PX } from '../src/lib/imageSize.ts';
import { figureHtml } from '../src/lib/print/render.ts';

/* 확장자 없는 상대 경로를 쓰는 파일은 변환해서 읽는다 (hwpx.test와 같은 방식) */
const asModule = js => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const stub = asModule(`
  export const RENDER_HEADER = 'x-render'; export const makeRenderToken = () => 't';
  export const getRequestContext = () => null;
`);
const cache = new Map();
async function moduleUrl(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let js = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('import "server-only";', '');
  for (const match of [...js.matchAll(/from "([^"]+)"/g)]) {
    const spec = match[1];
    const resolved = ['../render-token', '../request-context'].includes(spec) ? stub
      : spec.startsWith('.') ? await moduleUrl(new URL(spec + '.ts', url))
      : spec.startsWith('node:') ? spec : import.meta.resolve(spec);
    js = js.replace(match[0], `from ${JSON.stringify(resolved)}`);
  }
  const out = asModule(js);
  cache.set(url.href, out);
  return out;
}
const load = path => moduleUrl(new URL(path, import.meta.url)).then(u => import(u));

/* ---------- AI 집필 부분 원고 ---------- */

async function* events(list, fail) {
  for (const e of list) yield e;
  if (fail) throw new Error('끊김');
}
const memoryStore = () => {
  const s = { saved: [], cleared: 0 };
  s.save = async p => { s.saved.push(p); };
  s.clear = async () => { s.cleared++; };
  return s;
};

test('partial draft is saved every few seconds, and the finished text is kept (marked complete) before done is sent', async () => {
  let now = 0;
  const store = memoryStore();
  const gen = (async function* () {
    yield { t: 'status', v: '구상 중' };
    yield { t: 'delta', v: '첫 ' }; now = 3000;
    yield { t: 'delta', v: '문단' }; now = 6000;
    yield { t: 'delta', v: ' 계속' };
    yield { t: 'done', chars: 7 };
  })();
  const seen = [];
  for await (const e of withPartialSave(gen, store, { mode: 'overwrite', now: () => now })) seen.push(e.t);
  assert.deepEqual(seen, ['status', 'delta', 'delta', 'delta', 'done']);
  // 5초 저장 한 번 + 끝날 때 다 쓴 글 한 번 (지우는 것은 브라우저가 본문 저장을 마친 뒤)
  assert.equal(store.saved.length, 2);
  assert.equal(store.saved[0].complete, undefined);
  assert.equal(store.saved[1].text, '첫 문단 계속');
  assert.equal(store.saved[1].mode, 'overwrite');
  assert.equal(store.saved[1].chars, 7);
  assert.equal(store.saved[1].complete, true);
  assert.equal(store.cleared, 0);
});

test('partial draft is kept with the latest text when the stream breaks or needs resuming', async () => {
  const broken = memoryStore();
  await assert.rejects(async () => {
    for await (const _ of withPartialSave(events([{ t: 'delta', v: '받은 글' }], true), broken, { mode: 'continue' }));
  });
  assert.equal(broken.cleared, 0);
  assert.equal(broken.saved.at(-1).text, '받은 글');

  const resumed = memoryStore();
  for await (const _ of withPartialSave(events([{ t: 'delta', v: ' 다음 파트' }, { t: 'status', v: 'partial' }, { t: 'done', chars: 5 }]), resumed, { mode: 'overwrite', initialText: '앞 파트', startedAt: '2026-09-27T00:00:00.000Z' }));
  assert.equal(resumed.cleared, 0);
  assert.equal(resumed.saved.at(-1).text, '앞 파트 다음 파트');
  assert.equal(resumed.saved.at(-1).startedAt, '2026-09-27T00:00:00.000Z');

  // 소비자가 중간에 그만 읽어도(연결 끊김) 마지막으로 한 번 저장한다
  const cancelled = memoryStore();
  for await (const e of withPartialSave(events([{ t: 'delta', v: '반쯤' }, { t: 'delta', v: '더' }]), cancelled, { mode: 'overwrite' })) if (e.t === 'delta') break;
  assert.equal(cancelled.saved.at(-1).text, '반쯤');
});

test('stored partial drafts expire after 7 days', () => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  const p = { text: '글', mode: 'overwrite', chars: 1, startedAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z' };
  assert.deepEqual(parsePartial(JSON.stringify(p), now), p);
  assert.equal(parsePartial(JSON.stringify({ ...p, updatedAt: '2026-09-19T00:00:00Z' }), now), null);
  assert.equal(parsePartial('{broken', now), null);
  assert.equal(partialKey('s1'), 'ai-partial:s1');
});

/* ---------- 표지 쪽수 ---------- */

test('cover spine follows the actual page count unless the pages were edited by hand', () => {
  const d = defaultCover({ targetPages: 200 }, 248);
  assert.equal(d.pages, 248);
  assert.equal(d.pagesManual, false);
  assert.equal(defaultCover({ targetPages: 180 }, null).pages, 180);

  const withSpineTitle = { ...d, pages: 200, elements: titleElements({ ...d, pages: 200 }, { title: '제목' }) };
  const spineEl = withSpineTitle.elements.find(e => e.panel === 'spine');
  const synced = syncActualPages(withSpineTitle, 300);
  assert.equal(synced.pages, 300);
  assert.equal(coverLayout(synced).spine, spineWidth(300));
  // 책등 글은 가운데 기준으로 따라 옮긴다
  const moved = synced.elements.find(e => e.id === spineEl.id);
  assert.equal(moved.x, Math.round((spineEl.x + (spineWidth(300) - spineWidth(200)) / 2) * 10) / 10);

  const manual = { ...withSpineTitle, pagesManual: true };
  assert.equal(syncActualPages(manual, 300), manual);
  assert.equal(syncActualPages(withSpineTitle, null), withSpineTitle);
});

test('pagesManual survives normalize and coverIssues warns when pages differ from the actual count', () => {
  assert.equal(normalizeCover({ pages: 120, pagesManual: true }).pagesManual, true);
  assert.equal(normalizeCover({ pages: 120 }).pagesManual, false);
  const d = { ...defaultCover(), pages: 120, pagesManual: true, bgColor: '#000000' };
  const warn = coverIssues(d, { actualPages: 160 }).find(i => i.message.includes('실제 조판 쪽수'));
  assert.ok(warn && warn.level === 'warn' && warn.message.includes('160쪽'));
  assert.equal(coverIssues({ ...d, pages: 160 }, { actualPages: 160 }).some(i => i.message.includes('실제')), false);
  assert.ok(coverIssues({ ...d, pagesManual: false }, { actualPages: null }).some(i => i.message.includes('아직 재지 않아')));
  // 예전 호출(쪽수 정보 없음)은 쪽수 점검을 하지 않는다
  assert.equal(coverIssues(d).some(i => i.message.includes('쪽수')), false);
});

/* ---------- 그림 높이·여백 ---------- */

test('figure max height fits the body height of the book margins (with caption room)', async () => {
  const { figureMaxHeightMm, figureDpi, CAPTION_RESERVE_MM, FIG_MARGIN_MM } = await load('../src/lib/print/figure.ts');
  const { MARGIN, bodyBox } = await load('../src/lib/print/spec.ts');
  const body = bodyBox(MARGIN).height; // 160
  assert.equal(figureMaxHeightMm('fit', {}), 150);
  const withCap = figureMaxHeightMm('fit', { caption: true });
  assert.ok(withCap + FIG_MARGIN_MM + CAPTION_RESERVE_MM <= body, `${withCap}mm + 여백·캡션이 본문 ${body}mm를 넘는다`);
  // 여백을 넓히면 그만큼 줄어든다
  const wide = { ...MARGIN, top: 30, bottom: 30 };
  assert.equal(figureMaxHeightMm('fit', { margins: wide }), 150 - 24);
  // 세로로 긴 그림은 높이 한도가 인쇄 폭을 정한다 → DPI도 같은 값으로 계산
  const tall = figureDpi('fit', undefined, 1000, 3000, { margins: wide, caption: true });
  const mm = figureMaxHeightMm('fit', { margins: wide, caption: true }) / 3;
  assert.equal(tall, Math.round(1000 / (mm / 25.4)));
});

test('layout margins are type-checked and clamped so the body box never goes negative', async () => {
  const { parseLayout, cleanMargins } = await load('../src/lib/layout.ts');
  const { MARGIN } = await load('../src/lib/print/spec.ts');
  assert.deepEqual(parseLayout(null).margins, { ...MARGIN });
  assert.deepEqual(cleanMargins({ top: '20', inner: 'abc', outer: -5 }), { ...MARGIN, top: 20, outer: 5 });
  // 본문 높이가 사라질 만큼 큰 여백은 기본값으로
  assert.deepEqual(cleanMargins({ top: 60, bottom: 60, header: 30, footer: 30 }), { ...MARGIN });
  const m = parseLayout(JSON.stringify({ margins: { top: 1e9, header: null } })).margins;
  assert.equal(m.top, 60);
  assert.equal(m.header, MARGIN.header);
});

test('captioned figures get the smaller max-height class', () => {
  const ctx = { chapterNo: 1, counter: { n: 0 } };
  assert.match(figureHtml({ type: 'figure', attrs: { src: '/api/assets/a1', caption: '설명' } }, ctx), /class="fig fit cap"/);
  assert.match(figureHtml({ type: 'figure', attrs: { src: '/api/assets/a1' } }, ctx), /class="fig fit"/);
});

/* ---------- PDF 시간 예산 ---------- */

test('PDF deadlines count from the request start and leave time for printing and upload', async () => {
  const { pdfDeadlines, REQUEST_LIMIT_MS, POST_RESERVE_MS } = await load('../src/lib/export/pdf.ts');
  const d = pdfDeadlines(1_000_000);
  assert.equal(d.layout, 1_000_000 + REQUEST_LIMIT_MS - POST_RESERVE_MS);
  assert.ok(d.print > d.layout && d.print < 1_000_000 + 300_000);
  assert.ok(POST_RESERVE_MS >= 45_000);
});

/* ---------- 백업 ZIP ---------- */

test('backup zip streams chapters one by one and restores with or without versions', async () => {
  const loaded = [];
  const chapters = {
    c1: { id: 'c1', title: '1장', sections: [{ id: 's1', content: '{"type":"doc"}', versions: [{ id: 'v1', content: '{"type":"doc"}' }] }] },
    c2: { id: 'c2', title: '2장', sections: [{ id: 's2', content: '{"type":"doc"}' }] },
  };
  const out = await buildBackupZip({
    head: { id: 'p', title: '책 "제목"', glossary: [], assets: [{ id: 'a1', path: 'x.png' }] },
    chapterIds: ['c1', 'missing', 'c2'],
    loadChapter: async id => { loaded.push(id); return chapters[id] ?? null; },
    assets: [{ name: 'assets/a1.png', load: async () => Buffer.from('png-bytes') }],
  });
  const zip = await JSZip.loadAsync(out, { checkCRC32: true });
  const meta = JSON.parse(await zip.file('project.json').async('string'));
  assert.equal(meta.format, 'bookk-writer-backup');
  assert.equal(meta.project.title, '책 "제목"');
  assert.deepEqual(meta.project.chapters.map(c => c.id), ['c1', 'c2']);
  assert.equal(meta.project.chapters[0].sections[0].versions.length, 1);
  assert.equal(meta.project.chapters[1].sections[0].versions, undefined);
  assert.equal((await zip.file('assets/a1.png').async('nodebuffer')).toString(), 'png-bytes');
  assert.deepEqual(loaded, ['c1', 'missing', 'c2']);
});

/* ---------- 이미지 올리기 ---------- */

test('uploaded photos are rotated by EXIF and only downscaled above the long-edge limit', async () => {
  // 4000×1000으로 저장되어 있고 EXIF 6(90도 회전)인 휴대폰 사진 → 보이는 모양은 1000×4000
  const raw = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#888' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const r = await prepareImage(raw);
  assert.equal(r.mime, 'image/jpeg');
  assert.deepEqual([r.width, r.height], [800, MAX_EDGE_PX]);
  const meta = await sharp(r.buffer).metadata();
  assert.deepEqual([meta.width, meta.height], [r.width, r.height]);
  assert.ok(!meta.orientation || meta.orientation === 1);

  // 작은 PNG는 그대로
  const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: '#0000' } }).png().toBuffer();
  const same = await prepareImage(png);
  assert.equal(same.buffer, png);
  assert.deepEqual([same.width, same.height, same.mime], [300, 200, 'image/png']);

  // WEBP는 HWPX 호환을 위해 PNG(투명)·JPEG로
  const webpAlpha = await sharp({ create: { width: 50, height: 40, channels: 4, background: '#f000' } }).webp().toBuffer();
  assert.equal((await prepareImage(webpAlpha)).mime, 'image/png');
  const webp = await sharp({ create: { width: 50, height: 40, channels: 3, background: '#f00' } }).webp().toBuffer();
  assert.equal((await prepareImage(webp)).mime, 'image/jpeg');
  assert.equal(await prepareImage(Buffer.from('not an image at all, just text')), null);
});
