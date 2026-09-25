import "server-only";
import type { Book } from "../book";
import { findFigures, parseDoc } from "../doc/doc";
import { BLEED, DOC, TRIM, TYPO } from "./spec";
import { docToHtml, esc, type FigureCtx } from "./render";

export type BookHtmlOptions = {
  mode: "preview" | "print" | "measure";
  size: "bleed" | "trim";
  scope?: { kind: "all" } | { kind: "chapter"; id: string } | { kind: "section"; id: string };
  focus?: string;
  padEven?: boolean;
  guides?: { trim?: boolean; safe?: boolean; body?: boolean };
  view?: "spread" | "single";
};

/**
 * 책 전체(또는 일부)를 Paged.js가 조판할 HTML 문서로 만든다.
 * 미리보기·쪽 번호 측정·PDF가 모두 이 한 문서를 쓴다 → 화면과 인쇄가 같다.
 */
export function bookHtml(book: Book, o: BookHtmlOptions): string {
  const { project, layout } = book;
  const m = layout.margins;
  const trim = o.size === "trim";
  const W = trim ? TRIM.width : DOC.width;
  const H = trim ? TRIM.height : DOC.height;
  const d = trim ? BLEED : 0;
  const top = m.top + m.header - d;
  const bottom = m.bottom + m.footer - d;
  const inner = m.inner - d;
  const outer = m.outer - d;
  const footerBottom = m.bottom - d + 2.5; // 꼬리말 영역 안 쪽 번호 위치
  const scope = o.scope ?? { kind: "all" };
  const full = scope.kind === "all";
  const breakChapter = layout.chapterStartRight ? "right" : "page";

  /* ---------- 본문 ---------- */
  const parts: string[] = [];
  let bodyStarted = false;
  for (const c of book.chapters) {
    if (scope.kind === "chapter" && scope.id !== c.id) continue;
    const secs = scope.kind === "section" ? c.sections.filter((s) => s.id === scope.id) : c.sections;
    if (!secs.length) continue;
    const fig: FigureCtx = { chapterNo: c.no, counter: { n: 0 } };
    const isBody = c.kind === "body";
    const startCls = isBody && !bodyStarted && full ? " body-start" : "";
    if (isBody) bodyStarted = true;
    const single = c.kind !== "body" && secs.length === 1 && secs[0].title === c.title;
    const secHtml = secs
      .map((s) => {
        const doc = parseDoc(s.content);
        const html = docToHtml(doc, fig);
        const head = single ? "" : `<h2 class="sec-title">${s.label ? `<span class="sec-no">${esc(s.label)}</span>` : ""}${esc(s.title)}</h2>`;
        const empty = !html.trim() ? `<p class="empty-note">(아직 작성되지 않은 절)</p>` : "";
        return `<section class="sec" data-sid="${s.id}" data-chars="${s.charCount}" data-fig="${findFigures(doc).length}">${head}${html}${empty}<span class="sec-end" data-sid-end="${s.id}"></span></section>`;
      })
      .join("\n");
    parts.push(
      `<div class="chapter ${c.kind}${startCls}" data-cid="${c.id}">
        ${isBody
          ? `<header class="ch-head ch-page no-num"><h1 class="ch-title">${esc(c.title)}</h1></header>`
          : `<header class="ch-head"><h1 class="ch-title">${esc(c.title)}</h1></header>`}
        ${secHtml}
      </div>`,
    );
  }

  /* ---------- 앞붙이: 표제지 · 목차 / 뒷붙이: 판권면 ---------- */
  const titlePage = `<div class="title-page no-num"><div class="tp-title">${esc(project.title)}</div>${
    project.subtitle ? `<div class="tp-sub">${esc(project.subtitle)}</div>` : ""
  }<div class="tp-author">${esc(project.author)}</div></div>`;

  const cp = layout.colophon;
  const row = (k: string, v: string) => (v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : "");
  const colophon = `<div class="colophon no-num ${cp.position}">
    <div class="cp-title">${esc(project.title)}</div>
    <table>${row("지은이", project.author)}</table>
    <table>${row("발　행", cp.publishDate)}${row("펴낸이", cp.publisher)}${row("펴낸곳", cp.publisherName)}${row("출판사등록", cp.registration)}${row("주　소", cp.address)}${row("전　화", cp.phone)}${row("이메일", cp.email)}</table>
    <table>${row("ISBN", cp.isbn)}</table>
    <div class="cp-web">${esc(cp.website)}</div>
    <div class="cp-copy">ⓒ ${esc(project.author)} ${esc(cp.copyrightYear)}<br>${esc(cp.notice)}</div>
  </div>`;

  const bodyChapters = book.chapters.filter((c) => c.kind === "body");
  const tocEntries = book.chapters
    .filter((c) => c.kind !== "front")
    .map((c) => {
      const chRow = `<div class="toc-ch" data-target="${c.id}"><span class="t">${c.label ? `<b>${esc(c.label)}</b> ` : ""}${esc(c.title)}</span><span class="pn"></span></div>`;
      if (c.kind !== "body") return chRow;
      const secs = c.sections
        .map((s) => `<div class="toc-sec" data-target="${s.id}"><span class="t">${esc(s.label)} ${esc(s.title)}</span><span class="pn"></span></div>`)
        .join("");
      return chRow + secs;
    })
    .join("");
  const toc = bodyChapters.length ? `<div class="toc no-num"><h1 class="toc-title">차례</h1>${tocEntries}</div>` : "";

  const front = book.chapters.filter((c) => c.kind === "front");
  const html = full
    ? [
        titlePage,
        cp.position === "afterTitle" ? colophon : `<div class="blank-verso no-num"></div>`,
        ...parts.filter((_, i) => i < front.length),
        toc,
        ...parts.filter((_, i) => i >= front.length),
        cp.position === "end" ? colophon : "",
      ].join("\n")
    : parts.join("\n");

  /* ---------- CSS ---------- */
  const css = `
@font-face { font-family: ${TYPO.bodyFontCss}; src: url(/api/fonts/KoPubBatangLight.ttf) format("truetype"); font-weight: 400; }
@font-face { font-family: ${TYPO.bodyFontCss}; src: url(/api/fonts/KoPubBatangBold.ttf) format("truetype"); font-weight: 700; }
@font-face { font-family: ${TYPO.headingFontCss}; src: url(/api/fonts/KoPubDotumMedium.ttf) format("truetype"); }
@page { size: ${W}mm ${H}mm; margin: ${top}mm ${outer}mm ${bottom}mm ${inner}mm; }
@page :left { margin-left: ${outer}mm; margin-right: ${inner}mm; }
@page :right { margin-left: ${inner}mm; margin-right: ${outer}mm; }
@page fullbleed { margin: 0; }
html, body { margin: 0; padding: 0; }
body { font-family: ${TYPO.bodyFontCss}, serif; font-size: ${layout.bodySizePt}pt; line-height: ${layout.lineHeight};
  text-align: justify; word-break: keep-all; overflow-wrap: break-word; color: #000; orphans: 2; widows: 2;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
p { margin: 0; text-indent: ${TYPO.indentEm}em; }
p + p { margin-top: ${layout.paraSpacingMm}mm; }
/* Paged.js가 쪽을 넘어가는 요소에 주는 text-align-last:justify가 제목 등에 상속되지 않게 */
p:not([data-split-to]), h1, h2, h3, h4, li, figure, figcaption, th, td, .toc-ch, .toc-sec { text-align-last: auto !important; }
strong { font-weight: 700; }
.chapter { break-before: ${breakChapter}; }
.chapter.front, .chapter.back { break-before: ${breakChapter}; }
.body-start { break-before: right; }
.ch-head { padding-top: 0; margin-bottom: 8mm; break-after: avoid; } /* 앞붙이·뒷붙이: 제목은 쪽 첫 줄, 본문이 바로 이어진다 */
.ch-no { font-family: ${TYPO.headingFontCss}, sans-serif; font-size: 10.5pt; letter-spacing: .08em; margin-bottom: 3mm; color: #000; }
.ch-title { font-family: ${TYPO.headingFontCss}, sans-serif; font-weight: 500; font-size: 16pt; line-height: 1.35; margin: 0; text-align: left; }
/* 절은 항상 새 쪽에서 시작 (앞붙이·뒷붙이의 첫 절은 장 제목 바로 아래) */
.sec { display: block; break-before: page; }
.chapter:not(.body) > .ch-head + .sec { break-before: auto; }
/* 본문 장 제목은 독립된 한 쪽 — 제목만, 절 제목보다 크게 */
.ch-head.ch-page { break-after: page; height: ${H - top - bottom - 2}mm; margin: 0; padding: 0; display: flex; flex-direction: column; justify-content: center; }
.ch-page .ch-title { font-size: 24pt; line-height: 1.35; text-align: center; margin-bottom: 20mm; }
.sec-title { font-family: ${TYPO.headingFontCss}, sans-serif; font-weight: 500; font-size: 13pt; line-height: 1.4; margin: 0 0 6mm; text-align: left; break-after: avoid; }
.sec-no { margin-right: 2.5mm; }
h4.sub { font-family: ${TYPO.headingFontCss}, sans-serif; font-weight: 500; font-size: 10.5pt; margin: 6mm 0 2.5mm; text-align: left; break-after: avoid; }
blockquote { margin: 3mm 0 3mm 4mm; padding-left: 4mm; border-left: .3mm solid #000; }
blockquote p { text-indent: 0; }
ul, ol { margin: 2mm 0 2mm 5mm; padding-left: 3mm; }
li p { text-indent: 0; }
hr { border: 0; text-align: center; margin: 4mm 0; }
hr::after { content: "* * *"; font-size: 9pt; }
.fig { margin: 4mm 0; text-align: center; break-inside: avoid; }
.fig img { max-width: 100%; max-height: 150mm; display: block; margin: 0 auto; }
.fig.fit img { width: 100%; }
.fig figcaption { font-size: 8.5pt; line-height: 1.4; margin-top: 2mm; text-align: center; }
.fig.fullpage { break-before: page; break-after: page; margin: 0; height: 100%; display: flex; flex-direction: column; justify-content: center; }
.fig.fullpage img { width: 100%; max-height: 145mm; object-fit: contain; }
.fig.fullbleed { page: fullbleed; break-before: page; break-after: page; margin: 0; width: ${W}mm; height: ${H}mm; }
.fig.fullbleed img { width: ${W}mm; height: ${H}mm; max-width: none; max-height: none; object-fit: cover; }
.title-page { break-after: page; padding-top: 42mm; text-align: left; }
.tp-title { font-family: ${TYPO.headingFontCss}, sans-serif; font-size: 22pt; line-height: 1.35; }
.tp-sub { font-size: 11pt; margin-top: 5mm; }
.tp-author { margin-top: 30mm; font-size: 11pt; }
.blank-verso { break-before: page; break-after: page; height: 1px; }
.toc { break-before: right; }
.toc-title { font-family: ${TYPO.headingFontCss}, sans-serif; font-weight: 500; font-size: 16pt; margin: 18mm 0 10mm; }
.toc-ch, .toc-sec { display: flex; align-items: baseline; gap: 2mm; line-height: 1.55; }
.toc-ch { font-family: ${TYPO.headingFontCss}, sans-serif; margin-top: 4mm; }
.toc-sec { padding-left: 5mm; font-size: 9.5pt; }
.toc-ch .t, .toc-sec .t { flex: 1; overflow: hidden; }
.toc-ch .t::after, .toc-sec .t::after { content: ""; }
.pn { min-width: 8mm; text-align: right; }
.colophon { break-before: ${cp.position === "end" ? "left" : "page"}; padding-top: 70mm; font-size: 8.5pt; line-height: 1.7; text-align: left; }
.colophon p { text-indent: 0; }
.cp-title { font-family: ${TYPO.headingFontCss}, sans-serif; font-size: 11pt; margin-bottom: 4mm; }
.colophon table { border-collapse: collapse; margin-bottom: 3mm; }
.colophon th { font-weight: 400; text-align: left; padding-right: 4mm; white-space: nowrap; vertical-align: top; }
.cp-web { margin-top: 3mm; }
.cp-copy { margin-top: 2mm; }
.empty-note { color: #a8a29e; text-indent: 0; }
.fn { float: footnote; font-size: 8pt; line-height: 1.45; text-indent: 0; text-align: justify; font-weight: 400; font-style: normal; }
.fn::footnote-call { font-size: 65%; vertical-align: super; line-height: 0; }
.fn::footnote-marker { font-size: 8pt; }
@page { @footnote { border-top: .2mm solid #000; padding-top: 1.5mm; margin-top: 3mm; } }
`;

  /** Paged.js가 가공하지 않는 스타일: 쪽 번호·가이드(모든 매체) + 화면 미리보기 */
  const overlayCss = `
.pagedjs_page { position: relative; }
.pnum { position: absolute; bottom: ${footerBottom}mm; font-size: ${TYPO.pageNumberSizePt}pt; font-family: ${TYPO.bodyFontCss}, serif; line-height: 1; }
.guide, .side-tag { display: none; }
@media print { .empty-note { display: none !important; } .flag { background: transparent !important; } }
@media screen {
  body { background: #d6d3d1; }
  .flag { background: #fef08a; }
  .pagedjs_pages { display: flex; flex-wrap: wrap; width: calc(var(--pagedjs-width) * 2); margin: 10mm auto; }
  .pagedjs_page { background: #fff; margin-bottom: 8mm; flex: none; }
  .pagedjs_first_page { margin-left: var(--pagedjs-width); }
  .pagedjs_left_page { box-shadow: inset -7px 0 10px -8px rgba(0,0,0,.35); }
  .pagedjs_right_page { box-shadow: inset 7px 0 10px -8px rgba(0,0,0,.35); }
  body.single .pagedjs_pages { flex-direction: column; width: var(--pagedjs-width); }
  body.single .pagedjs_first_page { margin-left: 0; }
  body.gray img { filter: grayscale(1); }
  .guide { position: absolute; pointer-events: none; display: none; box-sizing: border-box; z-index: 5; }
  body.g-trim .guide.trim { display: block; border: 1px dashed #dc2626; }
  body.g-trim .guide.bleed { display: block; border: ${BLEED}mm solid rgba(220,38,38,.13); }
  body.g-safe .guide.safe { display: block; border: 1px solid #2563eb; }
  body.g-body .guide.body { display: block; background: rgba(34,197,94,.07); outline: 1px dotted #16a34a; }
  .pagedjs_page.focus { outline: 2px solid #f59e0b; outline-offset: -2px; }
  .side-tag { display: block; position: absolute; top: 2mm; font: 8px sans-serif; color: #78716c; z-index: 6; }
}`;

  const cfg = {
    mode: o.mode,
    focus: o.focus ?? "",
    padEven: Boolean(o.padEven),
    W,
    H,
    trim,
    bleed: BLEED,
    margins: { top, bottom, inner, outer },
    safeFromTrim: { top: 7, bottom: 7, outer: 7, inner: 12 },
  };

  const bodyCls = [
    o.view === "single" ? "single" : "",
    layout.grayscalePreview ? "gray" : "",
    o.guides?.trim ? "g-trim" : "",
    o.guides?.safe ? "g-safe" : "",
    o.guides?.body ? "g-body" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(project.title)}</title>
<style>${css}</style>
<style data-pagedjs-ignore>${overlayCss}</style>
<script>
window.__CFG = ${JSON.stringify(cfg)};
window.PagedConfig = {
  auto: true,
  before: async () => {
    try {
      await Promise.all([
        document.fonts.load('10pt ${TYPO.bodyFontCss}'),
        document.fonts.load('bold 10pt ${TYPO.bodyFontCss}'),
        document.fonts.load('10pt ${TYPO.headingFontCss}'),
      ]);
    } catch (e) {}
    const imgs = [...document.images];
    await Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })));
  },
  after: () => { try { window.__afterPaged(); } catch (e) { console.error(e); window.__PAGED_ERROR = String(e); window.__PAGED_DONE = true; } },
};
</script>
<script src="/pagedjs"></script>
<script>${AFTER_SCRIPT}</script>
</head><body class="${bodyCls}">
${html}
</body></html>`;
}

/** 조판 후처리: 쪽 번호, 차례 쪽수, 가이드, 측정 결과 보고 */
const AFTER_SCRIPT = `
window.__afterPaged = function () {
  const C = window.__CFG;
  const pages = [...document.querySelectorAll('.pagedjs_page')];
  const pageOf = (el) => pages.indexOf(el.closest('.pagedjs_page'));
  const bs = document.querySelector('.body-start');
  const B = bs ? pageOf(bs) : 0;
  const fontOk = document.fonts.check('10pt BookBody');

  // 짝수 쪽 맞춤: 마지막 쪽을 복제해 빈 쪽 추가
  if (C.padEven && pages.length % 2 === 1) {
    const last = pages[pages.length - 1];
    const blank = last.cloneNode(true);
    blank.querySelectorAll('.pagedjs_area, .pagedjs_margin-content').forEach((n) => (n.innerHTML = ''));
    blank.classList.remove('pagedjs_right_page', 'pagedjs_first_page', 'focus');
    blank.classList.add('pagedjs_left_page', 'pagedjs_blank_page');
    last.parentNode.appendChild(blank);
    pages.push(blank);
  }

  const numOf = (i) => (i >= B ? i - B + 1 : 0);
  const info = { total: pages.length, bodyStart: B + 1, fontOk, sections: {}, chapters: {}, pages: [] };

  pages.forEach((pg, i) => {
    const right = pg.classList.contains('pagedjs_right_page');
    const n = numOf(i);
    const blank = pg.classList.contains('pagedjs_blank_page') || !pg.querySelector('.pagedjs_area *');
    const noNum = blank || pg.querySelector('.no-num, .fig.fullbleed') || i < B;
    info.pages.push({ i: i + 1, n: noNum ? 0 : n, side: right ? 'right' : 'left', blank: !!blank });
    if (!noNum && n > 0) {
      const d = document.createElement('div');
      d.className = 'pnum';
      d.textContent = n;
      d.style[right ? 'right' : 'left'] = C.margins.outer + 'mm';
      pg.appendChild(d);
    }
    if (C.mode === 'preview') {
      const W = C.W, H = C.H, b = C.trim ? 0 : C.bleed;
      const add = (cls, t, r, bt, l) => {
        const g = document.createElement('div');
        g.className = 'guide ' + cls;
        Object.assign(g.style, { top: t + 'mm', right: r + 'mm', bottom: bt + 'mm', left: l + 'mm' });
        pg.appendChild(g);
      };
      const inL = right, S = C.safeFromTrim;
      if (b) add('bleed', 0, 0, 0, 0);
      add('trim', b, b, b, b);
      add('safe', b + S.top, b + (inL ? S.outer : S.inner), b + S.bottom, b + (inL ? S.inner : S.outer));
      const M = C.margins;
      add('body', M.top, inL ? M.outer : M.inner, M.bottom, inL ? M.inner : M.outer);
      const tag = document.createElement('div');
      tag.className = 'side-tag';
      tag.textContent = (right ? '오른쪽(홀수)' : '왼쪽(짝수)') + (n > 0 && !noNum ? ' · ' + n + '쪽' : '');
      tag.style[right ? 'right' : 'left'] = '4mm';
      pg.appendChild(tag);
    }
  });

  // 절별 쪽 범위 (분수 쪽 포함)
  const frac = (el, bottom) => {
    const pg = el.closest('.pagedjs_page');
    const area = pg && pg.querySelector('.pagedjs_area');
    if (!area) return 0;
    const a = area.getBoundingClientRect(), r = el.getBoundingClientRect();
    const y = bottom ? r.bottom : r.top;
    return Math.max(0, Math.min(1, (y - a.top) / (a.height || 1)));
  };
  const seen = {};
  document.querySelectorAll('[data-sid]').forEach((el) => {
    const sid = el.getAttribute('data-sid');
    if (seen[sid]) return;
    seen[sid] = 1;
    const first = el;
    const endMark = document.querySelector('[data-sid-end="' + sid + '"]');
    const si = pageOf(first), ei = endMark ? pageOf(endMark) : si;
    const sf = frac(first, false), ef = endMark ? frac(endMark, true) : 1;
    info.sections[sid] = {
      start: numOf(si), end: numOf(ei), startIdx: si + 1, endIdx: ei + 1,
      side: pages[si] && pages[si].classList.contains('pagedjs_right_page') ? 'right' : 'left',
      pages: Math.max(0, (ei + ef) - (si + sf)), startFrac: sf,
      chars: Number(first.getAttribute('data-chars') || 0), fig: Number(first.getAttribute('data-fig') || 0),
    };
  });
  document.querySelectorAll('[data-cid]').forEach((el) => {
    const cid = el.getAttribute('data-cid');
    if (!info.chapters[cid]) info.chapters[cid] = { start: numOf(pageOf(el)) };
  });
  // 차례 쪽수 채우기
  document.querySelectorAll('[data-target]').forEach((row) => {
    const t = row.getAttribute('data-target');
    const s = info.sections[t] || info.chapters[t];
    const pn = row.querySelector('.pn');
    if (pn && s && s.start > 0) pn.textContent = s.start;
  });

  if (C.focus) setTimeout(() => focusSection(C.focus, false), 50);

  window.__PAGED_INFO = info;
  window.__PAGED_DONE = true;
  if (window.parent !== window) window.parent.postMessage({ type: 'paged', mode: C.mode, info }, location.origin);
};

/** 절 쪽 강조 + 그 절 첫 쪽으로 이동 (다시 조판하지 않고 목차 선택을 따라간다) */
function focusSection(sid, smooth) {
  const s = window.__PAGED_INFO && window.__PAGED_INFO.sections[sid];
  const pages = [...document.querySelectorAll('.pagedjs_page')];
  pages.forEach((p) => p.classList.remove('focus'));
  if (!s) return;
  for (let k = s.startIdx - 1; k <= s.endIdx - 1; k++) pages[k] && pages[k].classList.add('focus');
  pages[s.startIdx - 1] && pages[s.startIdx - 1].scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const m = e.data || {};
  const pages = [...document.querySelectorAll('.pagedjs_page')];
  if (m.type === 'goto' && pages[m.index]) pages[m.index].scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (m.type === 'focus') focusSection(m.sid, true);
  if (m.type === 'guides') ['trim', 'safe', 'body'].forEach((k) => document.body.classList.toggle('g-' + k, !!m[k]));
  if (m.type === 'zoom') document.body.style.zoom = m.z;
  if (m.type === 'view') document.body.classList.toggle('single', m.view === 'single');
  if (m.type === 'gray') document.body.classList.toggle('gray', !!m.on);
});
`;
