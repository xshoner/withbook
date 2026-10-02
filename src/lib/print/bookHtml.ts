import "server-only";
import type { Book } from "../book";
import { findFigures, parseDoc } from "../doc/doc";
import { BLEED, DOC, TRIM, TYPO } from "./spec";
import { docToHtml, esc, type FigureCtx } from "./render";
import { figureMaxHeightMm } from "./figure";
import { type BiblioConfig, type IndexConfig, groupIndex } from "../back-matter";

export type BookHtmlOptions = {
  mode: "preview" | "print" | "measure";
  size: "bleed" | "trim";
  scope?: { kind: "all" } | { kind: "chapter"; id: string } | { kind: "section"; id: string };
  focus?: string;
  padEven?: boolean;
  guides?: { trim?: boolean; safe?: boolean; body?: boolean };
  view?: "spread" | "single";
  /** 뒷붙이 — 참고문헌·찾아보기 (켠 것만, 책 전체 조판일 때만 들어간다) */
  backMatter?: { index?: IndexConfig | null; biblio?: BiblioConfig | null };
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
  // 그림 최대 높이 — 이 책의 여백으로 계산한 본문 높이에서 그림 여백·캡션 자리를 뺀다 (DPI 계산과 같은 값)
  const figH = (l: "fit" | "fullpage", caption: boolean) => figureMaxHeightMm(l, { margins: m, caption });

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

  /* ---------- 앞붙이: 표제지(1쪽) · 판권면(2쪽) · 속표지(3쪽) · 차례(4쪽~) · 머리말 등 ---------- */
  const titlePage = `<div class="title-page no-num"><div class="tp-title">${esc(project.title)}</div>${
    project.subtitle ? `<div class="tp-sub">${esc(project.subtitle)}</div>` : ""
  }<div class="tp-author">${esc(project.author)}</div></div>`;
  // 속표지 — 제목만, 표제지와 다른 모양(가운데·작게)
  const innerTitle = `<div class="title-page inner no-num"><div class="tp-title">${esc(project.title)}</div>${
    project.subtitle ? `<div class="tp-sub">${esc(project.subtitle)}</div>` : ""
  }</div>`;

  const cp = layout.colophon;
  const row = (k: string, v: string) => (v ? `<tr><th>${k}</th><td>${esc(v)}</td></tr>` : "");
  const colophon = `<div class="colophon no-num">
    <div class="cp-title">${esc(project.title)}</div>
    <table>${row("지은이", project.author)}</table>
    <table>${row("발　행", cp.publishDate)}${row("펴낸이", cp.publisher)}${row("펴낸곳", cp.publisherName)}${row("출판사등록", cp.registration)}${row("주　소", cp.address)}${row("전　화", cp.phone)}${row("이메일", cp.email)}</table>
    <table>${row("ISBN", cp.isbn)}</table>
    <div class="cp-web">${esc(cp.website)}</div>
    <div class="cp-copy">ⓒ ${esc(project.author)} ${esc(cp.copyrightYear)}<br>${esc(cp.notice)}</div>
  </div>`;

  /* ---------- 뒷붙이: 참고문헌 · 찾아보기 ---------- */
  // 찾아보기 쪽 번호는 조판이 끝난 뒤(AFTER_SCRIPT) 쪽마다 글에서 용어를 찾아 채운다 — 원고에는 표시를 넣지 않는다
  const bib = o.backMatter?.biblio?.enabled && o.backMatter.biblio.entries.length ? o.backMatter.biblio : null;
  const ix = o.backMatter?.index?.enabled && o.backMatter.index.terms.length ? o.backMatter.index : null;
  const biblioHtml = bib
    ? `<div class="chapter back backmatter" data-cid="bm-biblio"><header class="ch-head"><h1 class="ch-title">참고문헌</h1></header><ul class="biblio-list">${bib.entries.map((e) => `<li>${esc(e.text)}</li>`).join("")}</ul></div>`
    : "";
  const indexHtml = ix
    ? `<div class="chapter back backmatter index-page" data-cid="bm-index"><header class="ch-head"><h1 class="ch-title">찾아보기</h1></header>${groupIndex(ix.terms)
        .map(
          (g) =>
            `<div class="ix-group"><h3 class="ix-head">${esc(g.head)}</h3>${g.terms
              .map((t) =>
                t.see
                  ? `<div class="ix"><span class="t">${esc(t.term)} <span class="ix-see">→ ${esc(t.see)}</span></span></div>`
                  : `<div class="ix" data-terms="${esc(JSON.stringify([t.term, ...t.aliases]))}"><span class="t">${esc(t.term)}</span><span class="lead"></span><span class="pn"></span></div>`,
              )
              .join("")}</div>`,
        )
        .join("")}</div>`
    : "";
  const backMatterToc = [bib && ["bm-biblio", "참고문헌"], ix && ["bm-index", "찾아보기"]]
    .filter((x): x is string[] => !!x)
    .map(([t, name]) => `<div class="toc-ch" data-target="${t}"><span class="t">${name}</span><span class="pn"></span></div>`)
    .join("");

  const bodyChapters = book.chapters.filter((c) => c.kind === "body");
  // 차례에는 머리말 같은 앞붙이도 넣는다(차례 뒤에 오므로) — 앞붙이는 쪽 번호가 없어 번호 칸은 비워 둔다
  const tocEntries = book.chapters
    .map((c) => {
      const chRow = `<div class="toc-ch" data-target="${c.id}"><span class="t">${c.label ? `<b>${esc(c.label)}</b> ` : ""}${esc(c.title)}</span><span class="pn"></span></div>`;
      if (c.kind !== "body") return chRow;
      const secs = c.sections
        .map((s) => `<div class="toc-sec" data-target="${s.id}"><span class="t">${esc(s.label)} ${esc(s.title)}</span><span class="pn"></span></div>`)
        .join("");
      return chRow + secs;
    })
    .join("");
  const toc = bodyChapters.length ? `<div class="toc no-num"><h1 class="toc-title">차례</h1>${tocEntries}${backMatterToc}</div>` : "";

  const front = book.chapters.filter((c) => c.kind === "front");
  const html = full
    ? [titlePage, colophon, innerTitle, toc, ...parts.filter((_, i) => i < front.length), ...parts.filter((_, i) => i >= front.length), biblioHtml, indexHtml].join("\n")
    : parts.join("\n");

  /* ---------- CSS ---------- */
  const css = `
@font-face { font-family: ${TYPO.bodyFontCss}; src: url(/api/fonts/KoPubBatangLight.woff2) format("woff2"), url(/api/fonts/KoPubBatangLight.ttf) format("truetype"); font-weight: 400; }
@font-face { font-family: ${TYPO.bodyFontCss}; src: url(/api/fonts/KoPubBatangBold.woff2) format("woff2"), url(/api/fonts/KoPubBatangBold.ttf) format("truetype"); font-weight: 700; }
@font-face { font-family: ${TYPO.headingFontCss}; src: url(/api/fonts/KoPubDotumMedium.woff2) format("woff2"), url(/api/fonts/KoPubDotumMedium.ttf) format("truetype"); }
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
.biblio-list { list-style: none; margin: 0; padding: 0; font-size: 9pt; line-height: 1.65; }
.biblio-list li { padding-left: 6mm; text-indent: -6mm; margin-bottom: 1.4mm; text-align: left; word-break: normal; overflow-wrap: anywhere; }
.ix-group { break-inside: auto; }
.ix-head { font-family: ${TYPO.headingFontCss}, sans-serif; font-weight: 500; font-size: 10.5pt; margin: 4mm 0 1mm; break-after: avoid; }
.ix { display: flex; align-items: baseline; gap: 2mm; font-size: 9pt; line-height: 1.55; text-align: left; }
.ix .t { flex: none; max-width: 75%; }
.ix .lead { flex: 1; min-width: 4mm; border-bottom: 0.25mm dotted #888; transform: translateY(-0.8mm); }
.ix.ix-none .lead { visibility: hidden; }
.ix .pn { white-space: nowrap; }
.ix-see { color: #444; }
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
.fig img { max-width: 100%; max-height: ${figH("fit", false)}mm; display: block; margin: 0 auto; object-fit: contain; }
.fig.cap img { max-height: ${figH("fit", true)}mm; }
.fig.fit img { width: 100%; }
.fig figcaption { font-size: 8.5pt; line-height: 1.4; margin-top: 2mm; text-align: center; }
.fig.fullpage { break-before: page; break-after: page; margin: 0; height: 100%; display: flex; flex-direction: column; justify-content: center; }
.fig.fullpage img { width: 100%; max-height: ${figH("fullpage", false)}mm; object-fit: contain; }
.fig.fullpage.cap img { max-height: ${figH("fullpage", true)}mm; }
.fig.fullbleed { page: fullbleed; break-before: page; break-after: page; margin: 0; width: ${W}mm; height: ${H}mm; }
.fig.fullbleed img { width: ${W}mm; height: ${H}mm; max-width: none; max-height: none; object-fit: cover; }
.title-page { break-after: page; padding-top: 42mm; text-align: left; }
.tp-title { font-family: ${TYPO.headingFontCss}, sans-serif; font-size: 22pt; line-height: 1.35; }
.tp-sub { font-size: 11pt; margin-top: 5mm; }
.tp-author { margin-top: 30mm; font-size: 11pt; }
.title-page.inner { break-before: right; padding-top: 60mm; text-align: center; }
.title-page.inner .tp-title { font-size: 15pt; letter-spacing: .02em; }
.title-page.inner .tp-sub { font-size: 10pt; margin-top: 4mm; }
.toc { break-before: page; }
.toc-title { font-family: ${TYPO.headingFontCss}, sans-serif; font-weight: 500; font-size: 16pt; margin: 18mm 0 10mm; }
.toc-ch, .toc-sec { display: flex; align-items: baseline; gap: 2mm; line-height: 1.55; }
.toc-ch { font-family: ${TYPO.headingFontCss}, sans-serif; margin-top: 4mm; }
.toc-sec { padding-left: 5mm; font-size: 9.5pt; }
.toc-ch .t, .toc-sec .t { flex: 1; overflow: hidden; }
.toc-ch .t::after, .toc-sec .t::after { content: ""; }
.pn { min-width: 8mm; text-align: right; }
.colophon { break-before: page; padding-top: 70mm; font-size: 8.5pt; line-height: 1.7; text-align: left; }
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
    // KoPub 세 글꼴(바탕 Light·Bold, 돋움)을 하나씩 받아 실패한 것을 적어 둔다 → 조판 후 PDF면 오류로 멈춘다
    const faces = [['10pt ${TYPO.bodyFontCss}', 'KoPub바탕 Light'], ['bold 10pt ${TYPO.bodyFontCss}', 'KoPub바탕 Bold'], ['10pt ${TYPO.headingFontCss}', 'KoPub돋움 Medium']];
    window.__FONT_FAIL = [];
    await Promise.all(faces.map(([q, name]) => document.fonts.load(q).then((got) => { if (!got.length) window.__FONT_FAIL.push(name); }, () => window.__FONT_FAIL.push(name))));
    // 이미지가 모두 받아졌는지(깨졌거나 주소가 빈 그림 포함) 적어 둔다
    const imgs = [...document.images];
    await Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })));
    window.__IMG_FAIL = imgs.filter((i) => !i.getAttribute('src') || !i.naturalWidth).map((i) => {
      const f = i.closest('figure'), sec = i.closest('[data-sid]');
      const cap = f && f.querySelector('figcaption b');
      const st = sec && sec.querySelector('.sec-title');
      return (cap ? cap.textContent : '캡션 없는 그림') + (st ? ' (' + st.textContent.trim() + ')' : '');
    });
  },
  after: () => { try { window.__afterPaged(); } catch (e) { console.error(e); window.__PAGED_ERROR = String(e); window.__PAGED_DONE = true; } },
};
</script>
<script src="/pagedjs?v=0.4.3"></script>
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
  // 글꼴: 불러오기 실패 + 글꼴 목록의 KoPub 얼굴 상태(loaded가 아니면 대체 글꼴로 조판된 것)
  const fontFail = (window.__FONT_FAIL || []).slice();
  const kopub = [...document.fonts].filter((f) => /BookBody|BookHeading/.test(f.family));
  if (kopub.length < 3 || kopub.some((f) => f.status === 'error')) fontFail.push('KoPub 글꼴 파일');
  const fontOk = !fontFail.length;
  const imgFail = window.__IMG_FAIL || [];
  if (C.mode === 'print') {
    const errs = [];
    if (!fontOk) errs.push('KoPub 글꼴(' + [...new Set(fontFail)].join(', ') + ')을 불러오지 못해 대체 글꼴로 조판되었습니다. 잠시 후 다시 출력하고, 계속되면 관리자에게 글꼴 저장소(fonts) 설정을 확인해 달라고 요청하세요.');
    if (imgFail.length) errs.push('이미지 ' + imgFail.length + '개를 불러오지 못했습니다: ' + imgFail.slice(0, 5).join(', ') + (imgFail.length > 5 ? ' 외' : '') + '. 원고에서 그 그림을 다시 넣거나 지운 뒤 다시 출력하세요.');
    if (errs.length) window.__PAGED_ERROR = errs.join(' ');
  }

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
  const info = { total: pages.length, bodyStart: B + 1, fontOk, missingImages: imgFail.length, sections: {}, chapters: {}, pages: [] };

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
  // 찾아보기 쪽 번호 — 본문 쪽(차례·뒷붙이·표제지·판권면 빼고)의 글에서 용어·다른 표기를 찾는다
  // (정규식을 쓰지 않는다 — 이 스크립트는 템플릿 문자열 안에 있어 역슬래시가 사라진다)
  const ixRows = document.querySelectorAll('.ix[data-terms]');
  if (ixRows.length) {
    const norm = (s) => s.split('').map((c) => (c.charCodeAt(0) <= 32 ? ' ' : c)).join('').split(' ').filter(Boolean).join(' ');
    const texts = pages.map((pg, i) => {
      if (numOf(i) <= 0 || pg.querySelector('.backmatter, .toc, .title-page, .colophon')) return '';
      const area = pg.querySelector('.pagedjs_area');
      return area ? norm(area.textContent || '') : '';
    });
    const ranges = (ps) => {
      const out = [];
      for (let i = 0; i < ps.length; ) {
        let j = i;
        while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++;
        out.push(j - i >= 2 ? ps[i] + '–' + ps[j] : j > i ? ps[i] + ', ' + ps[j] : String(ps[i]));
        i = j + 1;
      }
      return out.join(', ');
    };
    let missing = 0;
    ixRows.forEach((row) => {
      let terms = [];
      try { terms = JSON.parse(row.getAttribute('data-terms') || '[]').map(norm).filter(Boolean); } catch (e) {}
      const ps = [];
      texts.forEach((t, i) => { if (t && terms.some((w) => t.includes(w))) ps.push(numOf(i)); });
      const pn = row.querySelector('.pn');
      if (pn) pn.textContent = ps.length ? ranges(ps) : '';
      if (!ps.length) { missing++; row.classList.add('ix-none'); }
    });
    info.indexMissing = missing;
  }

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
