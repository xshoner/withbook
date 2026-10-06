import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spineWidth, coverLayout, regionBox, placeImage, requestSize, pxAt300, normalizeCover, defaultCover,
  buildImagePrompt, coverIssues, reflowSpine, panelAt, elAbs, titleElements, DEFAULT_SYSTEM_PROMPT, effectivePrompt,
} from '../src/lib/cover/spec.ts';

const book = { title: '새벽의 기록', subtitle: '', author: '홍길동', topic: '에세이', keyMessage: '', audience: '', tone: '', chapters: ['1장', '2장'] };

test('spine follows the 미색모조 100g formula {(pages/2) x 0.11} + 1.6mm', () => {
  assert.equal(spineWidth(200), 12.6);
  assert.equal(spineWidth(100), 7.1);
  assert.equal(spineWidth(249), 15.3); // 올림 없이 0.1mm 반올림 (124.5 × 0.11 + 1.6 = 15.295)
  assert.equal(spineWidth(0), 1.6);
});

test('spread layout matches the bookk guide total; covers 151mm, flaps 97mm, bleed only on flap ends and top/bottom', () => {
  // cover guide.jpg: 책등 15.3mm → 전체 517.3 × 216.0
  const l = coverLayout({ size: 'A5', pages: 2, paper: 'ivory100', spineOverride: 15.3, flaps: true });
  assert.equal(l.sheetW, 517.3);
  assert.equal(l.sheetH, 216);
  assert.deepEqual([l.panels.backFlap.x, l.panels.back.x, l.panels.spine.x, l.panels.front.x, l.panels.frontFlap.x], [3, 100, 251, 266.3, 417.3]);
  assert.equal(l.panels.front.w, 151);
  assert.equal(l.panels.back.w, 151);
  assert.equal(l.panels.frontFlap.w, 97);
  assert.equal(l.folds.length, 4);
  const noFlap = coverLayout({ size: 'A5', pages: 200, paper: 'ivory100', spineOverride: null, flaps: false });
  assert.equal(noFlap.sheetW, 3 + 148 + 12.6 + 148 + 3);
  assert.equal(noFlap.folds.length, 2);
});

test('image regions extend to the bleed on outer edges only', () => {
  const l = coverLayout({ size: 'A5', pages: 200, paper: 'ivory100', spineOverride: null, flaps: true });
  assert.deepEqual(regionBox(l, 'full'), { x: 0, y: 0, w: l.sheetW, h: 216 });
  assert.equal(regionBox(l, 'backFlap').x, 0);
  assert.equal(regionBox(l, 'front').w, 151);
  assert.equal(regionBox(l, 'back').x, l.panels.back.x);
  const ff = regionBox(l, 'frontFlap');
  assert.equal(ff.x + ff.w, l.sheetW);
});

test('image placement covers the region and reports print DPI', () => {
  const box = { x: 0, y: 0, w: 517.3, h: 216 };
  const at = placeImage({ widthPx: pxAt300(517.3), heightPx: pxAt300(216), fit: 'cover', posX: 50, posY: 50, zoom: 1 }, box);
  assert.ok(at.w >= box.w - 0.01 && at.h >= box.h - 0.01);
  assert.ok(at.dpi >= 300);
  const low = placeImage({ widthPx: 1536, heightPx: 1024, fit: 'cover', posX: 50, posY: 50, zoom: 1 }, box);
  assert.ok(low.dpi < 150);
});

test('request size keeps the region ratio within model limits', () => {
  for (const box of [{ w: 523.3, h: 216 }, { w: 151, h: 216 }, { w: 12.6, h: 216 }]) {
    const [w, h] = requestSize(box).split('x').map(Number);
    assert.equal(w % 16, 0);
    assert.equal(h % 16, 0);
    assert.ok(Math.max(w, h) <= 3840 && w * h <= 8_294_400);
    assert.ok(Math.max(w / h, h / w) <= 3.01);
  }
  assert.equal(requestSize({ w: 10, h: 10 }, '1024x1024'), '1024x1024');
});

test('prompt carries designer defaults, layout, vertical spine title and the author instruction', () => {
  const d = defaultCover({ title: book.title, author: book.author, targetPages: 200 });
  d.ai.instruction = '수채화 느낌';
  const p = buildImagePrompt(d, book, 'full');
  assert.ok(p.startsWith(DEFAULT_SYSTEM_PROMPT));
  assert.match(p, /책등에 제목 “새벽의 기록”/);
  assert.match(p, /앞날개/);
  assert.match(p, /\[작가 지시 — 가장 우선\]\n수채화 느낌/);
  d.ai.withTitle = false;
  assert.match(buildImagePrompt(d, book, 'front'), /글자를 전혀 넣지 않는다/);
});

test('normalize drops unknown values and foreign-looking ids', () => {
  const d = normalizeCover({ size: 'B9', pages: -3, images: { full: { assetId: '../x' }, front: { assetId: 'abc123', widthPx: 10, heightPx: 10 } }, elements: [{ id: 'e1', kind: 'text', panel: 'nope', font: 'Comic', color: 'red', text: 'hi' }, { id: '<bad>' }] });
  assert.equal(d.size, 'A5');
  assert.equal(d.pages, 2);
  assert.equal(d.images.full, undefined);
  assert.equal(d.images.front.assetId, 'abc123');
  assert.equal(d.elements.length, 1);
  assert.equal(d.elements[0].panel, 'front');
  assert.equal(d.elements[0].font, 'notoSans');
  assert.equal(d.elements[0].color, '#1c1917');
});

test('elements follow their panel when the spine changes', () => {
  const d = defaultCover({ title: 'T', targetPages: 200 });
  d.elements = titleElements(d, { title: 'T', author: 'A' });
  const spineEl = d.elements.find((e) => e.panel === 'spine');
  const l1 = coverLayout(d);
  const moved = reflowSpine(d.elements, l1.spine, l1.spine + 4);
  assert.equal(moved.find((e) => e.id === spineEl.id).x, Math.round((spineEl.x + 2) * 10) / 10);
  const front = d.elements.find((e) => e.panel === 'front');
  const l2 = coverLayout({ ...d, pages: 400 });
  assert.ok(Math.abs(elAbs(l2, front).x - elAbs(l1, front).x - (l2.spine - l1.spine)) < 1e-9);
  assert.equal(panelAt(l1, l1.panels.spine.x + 1), 'spine');
});

test('print check flags low resolution and text outside the safe area', () => {
  const d = defaultCover({ targetPages: 200 });
  d.images.full = { assetId: 'a1', widthPx: 1536, heightPx: 1024, fit: 'cover', posX: 50, posY: 50, zoom: 1 };
  d.elements = [{ ...titleElements(d, { title: 'T' })[0], x: 1, align: 'left' }];
  const issues = coverIssues(d);
  assert.ok(issues.some((i) => i.level === 'error' && /DPI/.test(i.message)));
  assert.ok(issues.some((i) => /안전 영역/.test(i.message)));
});

test('safe-area check follows where centered text actually sits, not the whole box', () => {
  const d = defaultCover({ targetPages: 200 });
  const l = coverLayout(d);
  const author = titleElements(d, { title: '제목', author: '지병석 지음' }).find((e) => e.text === '지병석 지음');
  // 가운데 맞춘 짧은 글을 오른쪽 아래로 옮겨 상자는 패널 밖으로 넘치지만 글자는 안전 영역 안
  const moved = { ...author, x: l.panels.front.w - author.w / 2 - 20, y: l.panels.front.h - 20 };
  assert.ok(!coverIssues({ ...d, elements: [moved] }).some((i) => /안전 영역/.test(i.message)));
  // 글자까지 재단선 쪽으로 넘기면 알린다
  const out = { ...author, x: l.panels.front.w - author.w / 2 - 2 };
  assert.ok(coverIssues({ ...d, elements: [out] }).some((i) => /안전 영역.*오른쪽/.test(i.message)));
  // 편집기가 잰 값이 있으면 그것을 쓴다
  assert.ok(!coverIssues({ ...d, elements: [out] }, { measured: { [out.id]: { x: 0, y: 0, w: 1, h: 1 } } }).some((i) => /안전 영역/.test(i.message)));
  // 빈 글 상자는 인쇄되지 않으므로 문제 삼지 않는다
  assert.ok(!coverIssues({ ...d, elements: [{ ...author, text: '  ', x: -3 }] }).some((i) => /안전 영역/.test(i.message)));
});

test('edit mask maps the canvas rectangle into image fractions', async () => {
  const { maskFraction } = await import('../src/lib/cover/spec.ts');
  const box = { x: 0, y: 0, w: 200, h: 100 };
  const img = { widthPx: 2000, heightPx: 1000, fit: 'cover', posX: 50, posY: 50, zoom: 1 };
  assert.deepEqual(maskFraction(img, box, { x: 50, y: 25, w: 100, h: 50 }), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  // 확대하면 같은 캔버스 사각형이 그림에서 더 작은 부분이 된다
  const z = maskFraction({ ...img, zoom: 2 }, box, { x: 50, y: 25, w: 100, h: 50 });
  assert.ok(Math.abs(z.w - 0.25) < 1e-9 && Math.abs(z.x - 0.375) < 1e-9);
  assert.equal(maskFraction(img, box, { x: 300, y: 0, w: 10, h: 10 }), null);
});

test('edit frame letterboxes the original ratio inside a different request size', async () => {
  const { editFrame } = await import('../src/lib/cover/spec.ts');
  const f = editFrame('1536x1024', 6078, 2552); // 펼침면(2.38:1)을 3:2 요청에 넣기
  assert.equal(f.cw, 1536);
  assert.ok(Math.abs(f.cw / f.ch - 6078 / 2552) < 0.01);
  assert.equal(f.ox, 0);
  assert.ok(f.oy > 0 && f.oy + f.ch <= 1024);
  const same = editFrame('3840x1600', 3840, 1600);
  assert.deepEqual([same.cw, same.ch, same.ox, same.oy], [3840, 1600, 0, 0]);
});

test('edit prompt keeps everything but the request', async () => {
  const { buildEditPrompt } = await import('../src/lib/cover/spec.ts');
  const d = defaultCover({ targetPages: 200 });
  const whole = buildEditPrompt(d, 'full', '하늘을 노을빛으로', false);
  assert.match(whole, /요청하지 않은 부분.*그대로 유지/);
  assert.match(whole, /책등/);
  assert.match(whole, /\[수정 요청\]\n하늘을 노을빛으로$/);
  const part = buildEditPrompt(d, 'front', '꽃을 노랗게', true);
  assert.match(part, /마스크의 투명한 부분/);
  assert.match(part, /비우거나 단색/);
  assert.match(part, /테두리·선·틀·선택 표시/);
  assert.match(part, /\[수정 요청\]\n꽃을 노랗게$/);
});

test('partial edit crops around the hole and feathers only outward', async () => {
  const { editCrop, featherAlpha } = await import('../src/lib/cover/spec.ts');
  const { hole, crop, feather } = editCrop(1000, 500, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  assert.deepEqual(hole, { left: 400, top: 200, width: 200, height: 100 });
  assert.ok(crop.left < hole.left && crop.left + crop.width > hole.left + hole.width);
  assert.ok(crop.left >= 0 && crop.top >= 0 && crop.left + crop.width <= 1000 && crop.top + crop.height <= 500);
  const a = featherAlpha(1000, 500, hole, feather);
  assert.equal(a[250 * 1000 + 500], 255); // 안쪽
  assert.equal(a[200 * 1000 + 400], 255); // 모서리도 온전히
  assert.ok(a[250 * 1000 + 399] > 0 && a[250 * 1000 + 399] < 255); // 경계 바로 밖은 녹는 띠
  assert.equal(a[250 * 1000 + 400 - feather - 1], 0); // 띠 밖은 원본 그대로
});

test('text background keeps padding and radius within limits', () => {
  const d = normalizeCover({ elements: [{ id: 't1', kind: 'text', panel: 'back', bg: '#000000', bgOpacity: 0.5, bgPad: 99, bgRadius: -3 }] });
  const el = d.elements[0];
  assert.equal(el.bg, '#000000');
  assert.equal(el.bgOpacity, 0.5);
  assert.equal(el.bgPad, 20);
  assert.equal(el.bgRadius, 0);
  assert.equal(normalizeCover({ elements: [{ id: 't2', kind: 'text' }] }).elements[0].bgPad, 1.5);
});

test('text outline: color and width are kept within range, off by default', () => {
  const [a, b, c] = normalizeCover({ elements: [
    { id: 's1', kind: 'text', strokeColor: '#112233', strokeWidth: 0.4 },
    { id: 's2', kind: 'text', strokeColor: 'red', strokeWidth: 99 },
    { id: 's3', kind: 'text' },
  ] }).elements;
  assert.equal(a.strokeColor, '#112233');
  assert.equal(a.strokeWidth, 0.4);
  assert.equal(b.strokeColor, '');
  assert.equal(b.strokeWidth, 3);
  assert.equal(c.strokeColor, '');
  assert.equal(c.strokeWidth, 0.3);
});

test('author-edited prompt is kept per region and sent instead of the automatic one', () => {
  const d = normalizeCover({ ...defaultCover({ targetPages: 200 }), ai: { instruction: '', withTitle: true, requestSize: 'auto', prompts: { front: '  내가 쓴 프롬프트  ', back: '   ', bogus: 'x' }, history: [] } });
  assert.deepEqual(Object.keys(d.ai.prompts), ['front']);
  assert.equal(effectivePrompt(d, book, 'front'), '내가 쓴 프롬프트');
  assert.equal(effectivePrompt(d, book, 'full'), buildImagePrompt(d, book, 'full'));
  // 예전 저장본(prompts 없음)도 읽힌다
  assert.deepEqual(normalizeCover({ ai: { instruction: 'a' } }).ai.prompts, {});
});
