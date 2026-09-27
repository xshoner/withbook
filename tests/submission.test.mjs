import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionItems } from '../src/lib/export/submission.ts';
import { BARCODE_GUIDE, barcodeRect, coverIssues, coverLayout, defaultCover, textDefaults } from '../src/lib/cover/spec.ts';

const base = () => ({
  projectId: 'p1',
  pdf: { pages: 200, widthMm: 154, heightMm: 216, sizeOk: true, kopubEmbedded: true, fontsEmbedded: ['KoPubBatangLight', 'KoPubDotumMedium'], size: 'bleed', at: '2026-09-27T10:00:00Z' },
  pageCount: { total: 200, source: 'pdf', at: '2026-09-27T10:00:00Z' },
  lastEditAt: '2026-09-27T09:00:00Z',
  cover: { saved: true, size: 'A5', pages: 200, pagesManual: false, issues: [] },
  preflightErrors: [],
  lowDpi: 0,
  missingImages: [],
  marks: 0,
  emptySections: 0,
  isbn: '979-11-000-0000-0',
});
const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

test('a ready book passes every submission item', () => {
  const items = submissionItems(base());
  assert.deepEqual(items.map((i) => i.status), items.map(() => 'pass'));
  assert.deepEqual(items.map((i) => i.id), ['pdf', 'trim', 'fonts', 'even', 'cover-pages', 'images', 'marks', 'cover']);
});

test('stale PDF, odd pages, spine mismatch, missing images and marks are flagged with fixes', () => {
  const x = base();
  x.lastEditAt = '2026-09-27T11:00:00Z';
  x.pdf = { ...x.pdf, pages: 201, kopubEmbedded: false };
  x.cover = { ...x.cover, pages: 180, issues: [{ level: 'warn', message: '바코드 자리와 겹칩니다' }] };
  x.missingImages = ['1장 > 1.1 첫 절'];
  x.marks = 3;
  x.isbn = '';
  const r = byId(submissionItems(x));
  assert.equal(r.pdf.status, 'warn');
  assert.equal(r.pdf.fix.action, 'pdf');
  assert.equal(r.fonts.status, 'fail');
  assert.equal(r.even.status, 'warn');
  assert.equal(r['cover-pages'].status, 'fail');
  assert.equal(r['cover-pages'].fix.href, '/projects/p1/cover');
  assert.equal(r.images.status, 'fail');
  assert.equal(r.marks.fix.action, 'checks');
  assert.equal(r.cover.status, 'warn');
  assert.equal(r.isbn.status, 'warn');
});

test('without a PDF, checks fall back to the measured page count and ask for a PDF', () => {
  const x = base();
  x.pdf = null;
  x.cover = { ...x.cover, size: 'A4' };
  x.preflightErrors = ['글꼴 파일 KoPubBatangLight.ttf을(를) 찾지 못했습니다'];
  const r = byId(submissionItems(x));
  assert.equal(r.pdf.status, 'warn');
  assert.equal(r.trim.status, 'fail');
  assert.equal(r.fonts.status, 'fail');
  assert.equal(r.even.status, 'pass');
  assert.equal(r['cover-pages'].status, 'pass');
});

test('barcode guide sits at the bottom of the back cover next to the spine and warns on overlap', () => {
  const d = defaultCover({ targetPages: 200 });
  const l = coverLayout(d);
  const b = barcodeRect(l);
  assert.equal(b.w, BARCODE_GUIDE.widthMm);
  assert.equal(b.h, BARCODE_GUIDE.heightMm);
  assert.equal(Math.round((b.x + b.w + BARCODE_GUIDE.fromSpineMm) * 100) / 100, l.panels.back.w);
  assert.equal(Math.round((b.y + b.h + BARCODE_GUIDE.fromBottomMm) * 100) / 100, l.panels.back.h);
  const clear = coverIssues({ ...d, elements: [{ ...textDefaults(), id: 't1', kind: 'text', panel: 'back', x: 10, y: 20, w: 60, text: '뒷표지 글' }] });
  assert.ok(!clear.some((i) => /바코드/.test(i.message)));
  const over = coverIssues({ ...d, elements: [{ ...textDefaults(), id: 't2', kind: 'text', panel: 'back', x: b.x - 5, y: b.y + 2, w: 30, text: '추천사' }] });
  assert.ok(over.some((i) => /바코드 자리/.test(i.message)));
  const onFront = coverIssues({ ...d, elements: [{ ...textDefaults(), id: 't3', kind: 'text', panel: 'front', x: b.x, y: b.y + 2, w: 30, text: '앞표지' }] });
  assert.ok(!onFront.some((i) => /바코드/.test(i.message)));
});
