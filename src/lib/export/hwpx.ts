import "server-only";
import path from "node:path";
import { getObject, mapLimit } from "../storage";
import JSZip from "jszip";
import { prisma } from "../db";
import type { Book } from "../book";
import type { LayoutSettings } from "../layout";
import { parseDoc, type JNode } from "../doc/doc";
import { printWidthMm, type FigureLayout } from "../print/figure";
import { DOC, TYPO, mmToHwp } from "../print/spec";
import { buildPrintLayouts, editorBlocks, type RawFragment } from "../../components/editor/pageMap";

/**
 * HWPX(OWPML) 생성 — 부크크 A5 서식과 같은 용지·여백, PDF와 같은 순서(표제지 → 판권면/빈 쪽 → 앞붙이 → 차례 → 본문 → 판권면).
 * paging(PDF와 같은 조판을 잰 결과)이 있으면 PDF가 새 쪽을 시작한 자리에서 쪽을 넘기고(빈 쪽 포함),
 * 차례에 PDF와 같은 쪽 번호를 넣는다. 쪽 번호는 PDF처럼 본문 첫 장부터 1로 센다.
 * 문단 속 줄 나눔은 한글이 다시 하므로 쪽 안의 줄 위치는 조금 다를 수 있다.
 */

/** PDF 조판에서 잰 쪽 배치 (export/pdf.ts measureBook) — 쪽 번호는 0부터 센 물리 쪽 */
export type HwpxPaging = {
  info: { sections: Record<string, { start: number; startIdx: number; endIdx: number }>; chapters: Record<string, { start: number }> };
  frags: RawFragment[];
  chapters: Record<string, number>;
  toc: [number, number];
  colophon: number;
  /** 속표지 쪽 */
  inner: number;
};

const NS = {
  ha: "http://www.hancom.co.kr/hwpml/2011/app",
  hp: "http://www.hancom.co.kr/hwpml/2011/paragraph",
  hp10: "http://www.hancom.co.kr/hwpml/2016/paragraph",
  hs: "http://www.hancom.co.kr/hwpml/2011/section",
  hc: "http://www.hancom.co.kr/hwpml/2011/core",
  hh: "http://www.hancom.co.kr/hwpml/2011/head",
  hhs: "http://www.hancom.co.kr/hwpml/2011/history",
  hm: "http://www.hancom.co.kr/hwpml/2011/master-page",
  hpf: "http://www.hancom.co.kr/schema/2011/hpf",
  dc: "http://purl.org/dc/elements/1.1/",
  opf: "http://www.idpf.org/2007/opf/",
  ooxmlchart: "http://www.hancom.co.kr/hwpml/2016/ooxmlchart",
  hwpunitchar: "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar",
  epub: "http://www.idpf.org/2007/ops",
  config: "urn:oasis:names:tc:opendocument:xmlns:config:1.0",
};
const nsAttrs = Object.entries(NS)
  .map(([k, v]) => `xmlns:${k}="${v}"`)
  .join(" ");

const x = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

/* ---------- 글자 모양 / 문단 모양 표 ---------- */
// charPr: 0 본문, 1 본문 굵게, 2 장 제목, 3 절 제목, 4 소제목, 5 장 번호, 6 캡션, 7 판권, 8 표제, 9 기울임, 10 장 제목 쪽, 11 각주(PDF와 같은 8pt), 12 참고문헌
// 본문·각주는 장평 97% — 한글의 양쪽 정렬 줄 나눔이 Chromium보다 가끔 한 줄 더 늘어나 PDF 쪽에 다 못 담는 일을 막는다(눈으로는 거의 같다)
type CharDef = { size: number; font: 0 | 1; bold?: boolean; italic?: boolean; ratio?: number };
const BODY_RATIO = 97;
const chars = (l: LayoutSettings): CharDef[] => [
  { size: l.bodySizePt, font: 0, ratio: BODY_RATIO },
  { size: l.bodySizePt, font: 0, bold: true, ratio: BODY_RATIO },
  { size: 16, font: 1 },
  { size: 13, font: 1 },
  { size: 10.5, font: 1 },
  { size: 10.5, font: 1 },
  { size: 8.5, font: 0 },
  { size: 8.5, font: 0 },
  { size: 22, font: 1 },
  { size: l.bodySizePt, font: 0, italic: true, ratio: BODY_RATIO },
  { size: 24, font: 1 },
  { size: 8, font: 0, ratio: BODY_RATIO },
  { size: 9, font: 0 },
];
// paraPr: 0 본문(양쪽, 들여쓰기 1em, 줄 간격·문단 간격은 책 설정), 1 제목(왼쪽, 들여쓰기 없음), 2 가운데(그림·캡션), 3 인용, 4 판권(왼쪽 170%), 5 각주, 6 장 제목 쪽(가운데, 위 60mm),
//         7 차례 장(오른쪽 끝 탭에 쪽 번호), 8 차례 절(왼쪽 5mm), 9 판권 첫 줄(위 간격으로 쪽 아래에 붙인다), 10 차례 제목,
//         11 쪽을 넘어 이어지는 본문 문단(들여쓰기 없음), 12 절 제목, 13 소제목, 14 앞붙이·뒷붙이 장 제목,
//         15 캡션 있는 그림, 16 캡션, 17 위 간격 없는 소제목, 18 참고문헌(내어쓰기) — 여백은 PDF(bookHtml.ts)와 같게
// line: 줄 간격 %(그림 문단), css: PDF(bookHtml.ts)의 CSS line-height — 한글의 "글자에 따라 N%"는 CSS line-height와 같은 줄 높이다
//   (한글 2020에서 잰 값: KoPub바탕 10pt 160% → 5.63mm, KoPub돋움 13pt 124% → 5.67mm)
const PT_MM = 25.4 / 72;
const SLACK_LINES = 1;
type ParaDef = { align: string; indent: number; line?: number; css?: number; left?: number; prev?: number; next?: number; keepNext?: boolean; tab?: number };
const paras = (l: LayoutSettings, colophonTopMm = 0): ParaDef[] => {
  // 본문은 PDF와 같은 내용을 한 쪽에 담되(PDF 쪽 자리에서 넘긴다) 한글 줄바꿈이 한 줄 더 생겨도 넘치지 않게 한 줄 여유를 둔다
  // ponytail: 한 쪽에 두 줄 이상 더 늘어나는 쪽은 그래도 넘친다 — 그러면 SLACK_LINES를 올린다
  const bodyH = DOC.height - l.margins.top - l.margins.bottom - l.margins.header - l.margins.footer;
  const pitch = l.bodySizePt * PT_MM * l.lineHeight;
  const body = Math.min(l.lineHeight, bodyH / ((Math.floor(bodyH / pitch) + SLACK_LINES) * l.bodySizePt * PT_MM));
  return [
    { align: "JUSTIFY", indent: l.bodySizePt * 100, css: body, next: mmToHwp(l.paraSpacingMm) },
    { align: "LEFT", indent: 0, css: 1.35, prev: 1200, next: 1200, keepNext: true },
    { align: "CENTER", indent: 0, line: 100, prev: mmToHwp(4), next: mmToHwp(4) },
    { align: "JUSTIFY", indent: 0, css: body, left: mmToHwp(8) },
    { align: "LEFT", indent: 0, css: 1.7 },
    { align: "JUSTIFY", indent: 0, css: 1.45 * 0.95 }, // 각주: URL이 많은 긴 각주는 한글이 한두 줄 더 쓰므로 5% 여유
    { align: "CENTER", indent: 0, css: 1.35, prev: mmToHwp(60) },
    { align: "LEFT", indent: 0, css: 1.55, prev: mmToHwp(4), tab: 1 },
    { align: "LEFT", indent: 0, css: 1.55, left: mmToHwp(5), tab: 1 },
    { align: "LEFT", indent: 0, css: 1.7, prev: mmToHwp(colophonTopMm) },
    { align: "LEFT", indent: 0, css: 1.35, prev: mmToHwp(18), next: mmToHwp(10) },
    { align: "JUSTIFY", indent: 0, css: body, next: mmToHwp(l.paraSpacingMm) },
    { align: "LEFT", indent: 0, css: 1.4, next: mmToHwp(6), keepNext: true },
    { align: "LEFT", indent: 0, css: l.lineHeight, prev: mmToHwp(6), next: mmToHwp(2.5), keepNext: true },
    { align: "LEFT", indent: 0, css: 1.35, next: mmToHwp(8), keepNext: true },
    { align: "CENTER", indent: 0, line: 100, prev: mmToHwp(4), next: mmToHwp(2), keepNext: true },
    { align: "CENTER", indent: 0, css: 1.4, next: mmToHwp(4) },
    { align: "LEFT", indent: 0, css: l.lineHeight, next: mmToHwp(2.5), keepNext: true },
    { align: "LEFT", indent: -mmToHwp(6), css: 1.65, left: mmToHwp(6), next: mmToHwp(1.4) },
  ];
};

/** 글자 모양 — 빈칸은 글꼴의 빈칸 폭, 커닝 사용(PDF/Chromium과 같은 글자 폭. 한글 기본 빈칸은 더 넓어 줄마다 2~3자 덜 들어간다) */
function charPr(id: number, c: CharDef) {
  const h = Math.round(c.size * 100);
  const f = c.font;
  const seven = (tag: string, v: string | number) =>
    `<hh:${tag} hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"/>`;
  return `<hh:charPr id="${id}" height="${h}" textColor="#000000" shadeColor="none" useFontSpace="1" useKerning="1" symMark="NONE" borderFillIDRef="2">${seven("fontRef", f)}${seven("ratio", c.ratio ?? 100)}${seven("spacing", 0)}${seven("relSz", 100)}${seven("offset", 0)}${c.italic ? "<hh:italic/>" : ""}${c.bold ? "<hh:bold/>" : ""}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>`;
}

/**
 * 문단 모양. 줄 나눔은 PDF(word-break: keep-all)처럼 한글도 어절 단위 — 한글 2020에서 breakNonLatinWord="BREAK_WORD"가 어절,
 * "KEEP_WORD"는 글자 단위로 나뉜다(잰 값). 쪽 나눔은 PDF 자리를 따르므로 외톨이줄 보호는 끈다.
 */
function paraPr(id: number, p: ParaDef) {
  const u = (tag: string, v: number) => `<hc:${tag} value="${v}" unit="HWPUNIT"/>`;
  const pct = p.css ? Math.floor(p.css * 100) : (p.line ?? 160);
  const ls = `<hh:lineSpacing type="PERCENT" value="${pct}" unit="HWPUNIT"/>`;
  // 문단 여백(들여쓰기·위아래 간격)은 한글이 기본 갈래 값을 절반으로 읽고, 홀수면 다른 단위로 읽는다(한글 2020에서 잰 값: 2000 → 10pt, 1701 → 42.5pt).
  // 그래서 기본 갈래에는 HWPUNIT의 2배(항상 짝수), HwpUnitChar 갈래에는 짝수로 맞춘 HWPUNIT을 쓴다 — 한글이 저장한 파일과 같은 꼴
  const even = (v: number) => 2 * Math.round(v / 2);
  const margin = (k: number) =>
    `<hh:margin>${u("intent", even(p.indent * k))}${u("left", even((p.left ?? 0) * k))}${u("right", 0)}${u("prev", even((p.prev ?? 0) * k))}${u("next", even((p.next ?? 0) * k))}</hh:margin>`;
  return `<hh:paraPr id="${id}" tabPrIDRef="${p.tab ?? 0}" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="${p.align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="${p.keepNext ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="${NS.hwpunitchar}">${margin(1)}${ls}</hp:case><hp:default>${margin(2)}${ls}</hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
}

function headerXml(l: LayoutSettings, colophonTopMm: number) {
  const CHARS = chars(l);
  const PARAS = paras(l, colophonTopMm);
  const langs = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
  const fontface = (lang: string) =>
    `<hh:fontface lang="${lang}" fontCnt="2"><hh:font id="0" face="${TYPO.bodyFont}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_MYUNGJO" weight="4" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font><hh:font id="1" face="${TYPO.headingFont}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font></hh:fontface>`;
  const border = (id: number) =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/><hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>`;
  return `${HEAD}<hh:head ${nsAttrs} version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="7">${langs.map(fontface).join("")}</hh:fontfaces><hh:borderFills itemCnt="2">${border(1)}${border(2)}</hh:borderFills><hh:charProperties itemCnt="${CHARS.length}">${CHARS.map((c, i) => charPr(i, c)).join("")}</hh:charProperties><hh:tabProperties itemCnt="2"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="0" autoTabRight="1"/></hh:tabProperties><hh:numberings itemCnt="1"><hh:numbering id="1" start="0"><hh:paraHead start="1" level="1" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead></hh:numbering></hh:numberings><hh:paraProperties itemCnt="${PARAS.length}">${PARAS.map((p, i) => paraPr(i, p)).join("")}</hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles></hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`;
}

function secPr(book: Book) {
  const m = book.layout.margins;
  const pb = (type: string) =>
    `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="1" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="${mmToHwp(DOC.width)}" height="${mmToHwp(DOC.height)}" gutterType="LEFT_RIGHT"><hp:margin header="${mmToHwp(m.header)}" footer="${mmToHwp(m.footer)}" gutter="0" left="${mmToHwp(m.inner)}" right="${mmToHwp(m.outer)}" top="${mmToHwp(m.top)}" bottom="${mmToHwp(m.bottom)}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="1"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="${2 * Math.round(mmToHwp(1.5) / 2)}" aboveLine="${2 * Math.round(mmToHwp(3) / 2)}"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>${pb("BOTH")}${pb("EVEN")}${pb("ODD")}</hp:secPr>`;
}

/* ---------- 본문 문단 ---------- */

type Img = { id: string; file: string; mime: string; data: Buffer; w: number; h: number };
type Loaded = { path: string; mime: string; widthPx: number; heightPx: number; data: Buffer };

/** 원고 속 그림의 이미지 ID 모으기 */
function figureIds(n: JNode, out: Set<string>) {
  if (n.type === "figure" && n.attrs?.assetId) out.add(String(n.attrs.assetId));
  for (const c of n.content ?? []) figureIds(c, out);
}

/** 그림 이미지를 한 번에 조회하고 4개씩 나란히 내려받는다 */
async function loadAssets(docs: JNode[]) {
  const ids = new Set<string>();
  for (const d of docs) figureIds(d, ids);
  const map = new Map<string, Loaded>();
  if (!ids.size) return map;
  const rows = await prisma.asset.findMany({ where: { id: { in: [...ids] } }, select: { id: true, path: true, mime: true, widthPx: true, heightPx: true } });
  await mapLimit(rows, 4, async (r) => {
    const data = await getObject("assets", r.path);
    if (data) map.set(r.id, { ...r, data });
  });
  return map;
}

/**
 * 문단을 글자 자리(공백 뺀 누적 글자 수)에서 나눈다 — 나뉜 뒤 조각 앞 공백은 지운다. 각주·줄바꿈은 그 자리 조각에 둔다.
 */
export function splitInline(n: JNode, cuts: number[]): JNode[] {
  const pieces: JNode[][] = [[]];
  let count = 0;
  let c = 0;
  for (const node of n.content ?? []) {
    if (node.type !== "text") {
      pieces[pieces.length - 1].push(node);
      continue;
    }
    const text = node.text ?? "";
    let from = 0;
    for (let i = 0; i < text.length && c < cuts.length; i++) {
      if (/\s/.test(text[i])) continue;
      if (++count === cuts[c]) {
        if (i + 1 > from) pieces[pieces.length - 1].push({ ...node, text: text.slice(from, i + 1) });
        pieces.push([]);
        from = i + 1;
        c++;
      }
    }
    const rest = text.slice(from);
    if (rest) pieces[pieces.length - 1].push({ ...node, text: rest });
  }
  return pieces.map((content) => {
    const first = content[0];
    if (first?.type === "text") content[0] = { ...first, text: (first.text ?? "").replace(/^\s+/, "") };
    return { ...n, content };
  });
}

class Writer {
  paras: string[] = [];
  pid = 0;
  images: Img[] = [];
  private imageByAsset = new Map<string, Img>();
  private pictureCount = 0;
  first = true;
  notes = 0;
  constructor(private book: Book, private assets: Map<string, Loaded> = new Map()) {}

  p(runs: string, paraPrId = 0, pageBreak = false) {
    let lead = "";
    if (this.first) {
      // 첫 문단에 구역 정의 (쪽 번호는 본문 첫 장에서 켠다 — numberFromHere)
      lead = `<hp:run charPrIDRef="0">${secPr(this.book)}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`;
      this.first = false;
    }
    const brk = pageBreak || this.pending;
    this.pending = false;
    // CSS처럼 위아래 여백을 겹친다: 제목 바로 뒤·쪽 맨 위의 소제목은 위 간격 없이 (한글은 두 간격을 더한다)
    if (paraPrId === 13 && (brk || this.lastPara === 12 || this.lastPara === 14)) paraPrId = 17;
    this.lastPara = paraPrId;
    this.paras.push(
      `<hp:p id="${this.pid++}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="${brk ? 1 : 0}" columnBreak="0" merged="0">${lead}${runs || '<hp:run charPrIDRef="0"/>'}</hp:p>`,
    );
  }

  /* ---------- 쪽 배치 (PDF 조판을 따른다) ---------- */
  /** 지금까지 쓴 내용이 PDF에서 끝난 쪽(0부터) */
  cur = 0;
  /** 다음 문단을 새 쪽에서 시작 */
  pending = false;
  /** 바로 앞 문단 모양 (여백 겹치기용) */
  lastPara = -1;
  /** 이 쪽 번호 감추기 (PDF가 번호를 넣지 않는 쪽: 장 제목 쪽·빈 쪽·판권면·풀블리드 그림) */
  hide = '<hp:run charPrIDRef="0"><hp:ctrl><hp:pageHiding hideHeader="0" hideFooter="0" hideMasterPage="0" hideBorder="0" hideFill="0" hidePageNum="1"/></hp:ctrl></hp:run>';
  /** 여기서부터 쪽 번호를 1로 다시 세고 바깥쪽 아래에 넣는다 (PDF처럼 본문 첫 장 = 1쪽) */
  numberFromHere = '<hp:run charPrIDRef="0"><hp:ctrl><hp:newNum num="1" numType="PAGE"/></hp:ctrl><hp:ctrl><hp:pageNum pos="OUTSIDE_BOTTOM" formatType="DIGIT" sideChar=""/></hp:ctrl></hp:run>';
  /**
   * 다음 문단을 PDF의 target쪽에서 시작하게 한다 — 사이에 PDF의 빈 쪽이 있으면 빈 쪽도 만든다.
   * target을 모르면(조판을 재지 못함) force일 때만 새 쪽. 이미 그 쪽이면 넘기지 않는다.
   */
  startAt(target: number | undefined, force: boolean) {
    if (target == null || target < 0) {
      if (force) this.pending = true;
      return;
    }
    if (target <= this.cur) return;
    for (let k = this.cur + 1; k < target; k++) this.p(this.hide, 0, true);
    this.cur = target;
    this.pending = true;
  }
  /** 내용이 PDF에서 이 쪽까지 이어졌다 */
  reach(page: number | undefined) {
    if (page != null && page > this.cur) this.cur = page;
  }
  run(text: string, charPrId = 0) {
    return text ? `<hp:run charPrIDRef="${charPrId}"><hp:t>${x(text)}</hp:t></hp:run>` : "";
  }
  inlineRuns(n: JNode): string {
    return (n.content ?? [])
      .map((c) => {
        if (c.type === "hardBreak") return `<hp:run charPrIDRef="0"><hp:t><hp:lineBreak/></hp:t></hp:run>`;
        if (c.type === "footnote") return this.footnote(String(c.attrs?.note ?? ""));
        const marks = (c.marks ?? []).map((m) => m.type);
        return this.run(c.text ?? "", marks.includes("bold") ? 1 : marks.includes("italic") ? 9 : 0);
      })
      .join("");
  }
  /** 한글 각주 컨트롤 — 번호는 한글이 매기고(구역 footNotePr), 내용은 쪽 아래에 놓인다 */
  footnote(note: string) {
    if (!note.trim()) return "";
    const n = ++this.notes;
    const num = `<hp:ctrl><hp:autoNum num="${n}" numType="FOOTNOTE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/></hp:autoNum></hp:ctrl>`;
    const body = `<hp:p id="${this.pid++}" paraPrIDRef="5" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="11">${num}<hp:t> ${x(note.trim())}</hp:t></hp:run></hp:p>`;
    return `<hp:run charPrIDRef="0"><hp:ctrl><hp:footNote number="${n}" suffixChar="41" instId="${3000 + n}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${body}</hp:subList></hp:footNote></hp:ctrl></hp:run>`;
  }
  async figure(n: JNode, label: string) {
    const a = n.attrs ?? {};
    const asset = a.assetId ? this.assets.get(String(a.assetId)) : undefined;
    if (!asset) return;
    // Repeated figures share original bytes; each placement keeps its own ID and size.
    const idx = ++this.pictureCount;
    const assetId = String(a.assetId);
    let img = this.imageByAsset.get(assetId);
    if (!img) {
      const imageIdx = this.images.length + 1;
      const ext = path.extname(asset.path).slice(1) || "png";
      img = { id: `image${imageIdx}`, file: `BinData/image${imageIdx}.${ext}`, mime: asset.mime, data: asset.data, w: asset.widthPx, h: asset.heightPx };
      this.images.push(img);
      this.imageByAsset.set(assetId, img);
    }
    const layout = (a.layout ?? "fit") as FigureLayout;
    const wMm = layout === "fullbleed" ? 103 : printWidthMm(layout, a.widthMm, asset.widthPx, asset.heightPx, { margins: this.book.layout.margins, caption: Boolean(a.caption) });
    const W = mmToHwp(wMm);
    const H = Math.round((W * asset.heightPx) / asset.widthPx);
    const pic = `<hp:run charPrIDRef="0"><hp:pic id="${1000 + idx}" zOrder="${idx}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${2000 + idx}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${W}" height="${H}"/><hp:curSz width="${W}" height="${H}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(W / 2)}" centerY="${Math.round(H / 2)}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hc:img binaryItemIDRef="${img.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${W}" y="0"/><hc:pt2 x="${W}" y="${H}"/><hc:pt3 x="0" y="${H}"/></hp:imgRect><hp:imgClip left="0" right="${asset.widthPx * 75}" top="0" bottom="${asset.heightPx * 75}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${asset.widthPx * 75}" dimheight="${asset.heightPx * 75}"/><hp:effects/><hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${H}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="CENTER" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic></hp:run>`;
    this.p((layout === "fullbleed" ? this.hide : "") + pic, a.caption ? 15 : 2, layout === "fullpage" || layout === "fullbleed");
    if (a.caption) this.p(this.run(`${label} `, 6) + this.run(String(a.caption), 6), 16);
  }
  /**
   * spans: 최상위 블록마다 PDF에서 놓인 쪽(시작·끝, 0부터 센 물리 쪽)과 쪽을 넘은 자리(cuts) — 모르면 null.
   * PDF에서 쪽을 넘은 본문 문단은 같은 글자 자리에서 나눠 다음 쪽에 이어 쓴다 → 쪽마다 PDF와 같은 내용.
   */
  async blocks(doc: JNode, fig: { ch: number; n: number }, spans: ({ start: number; end: number; cuts?: number[] } | null)[] | null = null) {
    for (const [i, n] of (doc.content ?? []).entries()) {
      const sp = spans?.[i];
      if (sp) this.startAt(sp.start, false);
      if (sp?.cuts?.length && n.type === "paragraph") {
        splitInline(n, sp.cuts).forEach((piece, k) => {
          if (k) this.startAt(sp.start + k, true);
          const runs = this.inlineRuns(piece);
          if (runs) this.p(runs, k ? 11 : 0);
        });
      } else await this.block(n, fig);
      if (sp) this.reach(sp.end);
    }
  }
  async block(n: JNode, fig: { ch: number; n: number }, prefix = ""): Promise<void> {
    switch (n.type) {
      case "paragraph": {
        const runs = this.inlineRuns(n);
        if (runs) this.p((prefix ? this.run(prefix) : "") + runs, prefix ? 3 : 0);
        return;
      }
      case "heading":
        this.p(this.run((n.content ?? []).map((c) => c.text ?? "").join(""), 4), 13);
        return;
      case "blockquote":
        for (const c of n.content ?? []) {
          const runs = this.inlineRuns(c);
          if (runs) this.p(runs, 3);
        }
        return;
      case "bulletList":
      case "orderedList":
        for (const [i, li] of (n.content ?? []).entries())
          for (const c of li.content ?? []) await this.block(c, fig, n.type === "bulletList" ? "• " : `${i + 1}. `);
        return;
      case "horizontalRule":
        this.p(this.run("* * *"), 2);
        return;
      case "figure":
        fig.n++;
        await this.figure(n, fig.ch ? `그림 ${fig.ch}-${fig.n}` : `그림 ${fig.n}`);
        return;
      default:
        for (const c of n.content ?? []) await this.block(c, fig, prefix);
    }
  }
}

/** 판권면 줄 (항목, 값) — 빈 값은 뺀다 */
function colophonLines(book: Book) {
  const { project, layout } = book;
  const cp = layout.colophon;
  const rows: [string, string][] = [
    ["지은이", project.author],
    ["발  행", cp.publishDate],
    ["펴낸이", cp.publisher],
    ["펴낸곳", cp.publisherName],
    ["출판사등록", cp.registration],
    ["주  소", cp.address],
    ["전  화", cp.phone],
    ["이메일", cp.email],
    ["ISBN", cp.isbn],
    ["", cp.website],
  ];
  return [...rows.filter(([, v]) => v).map(([k, v]) => (k ? `${k}  ${v}` : v)), `ⓒ ${project.author} ${cp.copyrightYear}`, cp.notice].filter(Boolean);
}

/**
 * 판권면을 쪽 아래에 붙일 첫 줄 위 간격(mm) — 본문 영역 높이에서 판권 높이(줄 수 × 줄 높이)를 뺀다.
 * ponytail: 줄 수는 글자 수로 어림(한 줄 약 34자) — 긴 주소·안내문이 더 많이 줄바꿈되면 몇 mm 위로 올라갈 뿐 넘치지 않게 여유 6mm
 */
export function colophonTopMm(book: Book) {
  const m = book.layout.margins;
  const bodyH = DOC.height - m.top - m.bottom - m.header - m.footer;
  const pt = 0.3528;
  const lineMm = 8.5 * pt * 1.7;
  const lines = colophonLines(book).reduce((n, t) => n + Math.max(1, Math.ceil(t.length / 34)), 0);
  return Math.max(0, Math.round((bodyH - 10.5 * pt * 1.7 - lines * lineMm - 6) * 10) / 10);
}

type Biblio = { enabled: boolean; entries: { text: string }[] } | null;

/**
 * 순서(PDF와 같다): 표제지 · 판권면 · 속표지 · 차례 · 앞붙이 · 본문 · 뒷붙이 · 참고문헌.
 * 찾아보기는 쪽 번호가 조판(PDF)에서만 정해져 HWPX에는 넣지 않는다.
 * paging(PDF 조판을 잰 결과)이 있으면 PDF와 같은 쪽에서 넘기고 차례에 같은 쪽 번호를 넣는다.
 */
export async function buildHwpx(book: Book, opts: { paging?: HwpxPaging | null; biblio?: Biblio } = {}): Promise<Buffer> {
  const paging = opts.paging ?? null;
  const biblio = opts.biblio?.enabled && opts.biblio.entries.length ? opts.biblio : null;
  const { project, layout } = book;
  const docs = new Map(book.chapters.flatMap((c) => c.sections.map((s) => [s, parseDoc(s.content)] as const)));
  const w = new Writer(book, await loadAssets([...docs.values()]));
  const printed = paging ? buildPrintLayouts(paging.frags) : {};
  const sec = (sid: string) => paging?.info.sections[sid];

  // 판권면 — 쪽 아래에 붙이고 쪽 번호는 감춘다
  const colophon = () => {
    w.startAt(paging ? paging.colophon : undefined, true);
    w.p(w.hide + w.run(project.title, 4), 9);
    for (const t of colophonLines(book)) w.p(w.run(t, 7), 4);
  };

  // 차례 — PDF와 같은 쪽 번호 (오른쪽 끝 탭)
  const bodyChapters = book.chapters.filter((c) => c.kind === "body");
  const toc = () => {
    if (!bodyChapters.length) return;
    w.startAt(paging ? paging.toc[0] : undefined, true);
    w.p(w.run("차례", 2), 10);
    const row = (title: string, n: number | undefined, charPr: number, paraPr: number) =>
      w.p(`${w.run(title, charPr)}<hp:run charPrIDRef="${charPr}"><hp:t><hp:tab/>${n && n > 0 ? n : ""}</hp:t></hp:run>`, paraPr);
    // 머리말 같은 앞붙이도 싣는다(차례 뒤에 오므로) — 앞붙이는 쪽 번호가 없어 번호 칸은 비운다
    for (const c of book.chapters) {
      row(`${c.label ? c.label + " " : ""}${c.title}`, paging?.info.chapters[c.id]?.start, 4, 7);
      if (c.kind === "body") for (const s of c.sections) row(`${s.label} ${s.title}`, sec(s.id)?.start, 0, 8);
    }
    if (biblio) row("참고문헌", paging?.info.chapters["bm-biblio"]?.start, 4, 7);
    if (paging) w.reach(paging.toc[1]);
  };

  // 장 하나 — 본문 장: 제목만 있는 독립된 쪽 / 앞붙이·뒷붙이: 새 쪽 맨 위에 제목
  let bodyStarted = false;
  const chapter = async (c: Book["chapters"][number]) => {
    const fig = { ch: c.no, n: 0 };
    w.startAt(paging?.chapters[c.id], true);
    if (c.kind === "body") {
      // PDF처럼 본문 첫 장 제목 쪽을 1쪽으로 센다
      const num = bodyStarted ? "" : w.numberFromHere;
      bodyStarted = true;
      w.p(num + w.hide + w.run(c.title, 10), 6);
    } else w.p(w.run(c.title, 2), 14);
    const single = c.kind !== "body" && c.sections.length === 1 && c.sections[0].title === c.title;
    for (const [i, s] of c.sections.entries()) {
      const info = sec(s.id);
      // 절은 항상 새 쪽에서 시작 (앞붙이·뒷붙이의 첫 절은 장 제목 바로 아래)
      w.startAt(info ? info.startIdx - 1 : undefined, c.kind === "body" || i > 0);
      if (!single) w.p(w.run(`${s.label ? s.label + " " : ""}${s.title}`, 3), 12);
      const doc = docs.get(s)!;
      const layoutOf = printed[s.id];
      const eb = editorBlocks(doc);
      // 인쇄되는 블록 수가 같을 때만 PDF 쪽을 블록에 맞춘다 (절 시작 쪽 기준 → 물리 쪽)
      const spans =
        info && layoutOf && eb.filter((b) => b.kind).length === layoutOf.blocks.length
          ? (() => {
              let k = 0;
              return eb.map((b) => {
                if (!b.kind) return null;
                const pb = layoutOf.blocks[k++];
                return { start: info.startIdx - 1 + pb.start, end: info.startIdx - 1 + pb.end, cuts: pb.cuts };
              });
            })()
          : null;
      await w.blocks(doc, fig, spans);
      if (info) w.reach(info.endIdx - 1);
    }
  };

  // 표제지(1쪽)
  w.p(w.run(project.title, 8), 1);
  if (project.subtitle) w.p(w.run(project.subtitle, 4), 1);
  w.p(w.run(project.author, 0), 1);
  // 판권면(2쪽)
  colophon();
  // 속표지(3쪽) — 제목만 가운데
  w.startAt(paging ? paging.inner : undefined, true);
  w.p(w.run(project.title, 2), 6);
  if (project.subtitle) w.p(w.run(project.subtitle, 4), 2);
  // 차례 → 머리말 등 앞붙이 → 본문 → 뒷붙이
  toc();
  for (const c of book.chapters) if (c.kind === "front") await chapter(c);
  for (const c of book.chapters) if (c.kind !== "front") await chapter(c);
  // 참고문헌
  if (biblio) {
    w.startAt(paging?.chapters["bm-biblio"], true);
    w.p(w.run("참고문헌", 2), 14);
    for (const e of biblio.entries) w.p(w.run(e.text, 12), 18);
  }

  const section = `${HEAD}<hs:sec ${nsAttrs}>${w.paras.join("")}</hs:sec>`;
  const manifestItems = [
    `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>`,
    `<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>`,
    `<opf:item id="settings" href="settings.xml" media-type="application/xml"/>`,
    ...w.images.map((i) => `<opf:item id="${i.id}" href="${i.file}" media-type="${i.mime}" isEmbeded="1"/>`),
  ].join("");
  const content = `${HEAD}<opf:package ${nsAttrs} version="" unique-identifier="" id=""><opf:metadata><opf:title>${x(project.title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">${x(project.author)}</opf:meta></opf:metadata><opf:manifest>${manifestItems}</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;

  const zip = new JSZip();
  const opt = { createFolders: false } as const;
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE", createFolders: false });
  zip.file(
    "version.xml",
    `${HEAD}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="12, 0, 0, 0"/>`,
    opt,
  );
  zip.file("settings.xml", `${HEAD}<ha:HWPApplicationSetting xmlns:ha="${NS.ha}" xmlns:config="${NS.config}"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`, opt);
  zip.file(
    "META-INF/container.xml",
    `${HEAD}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="${NS.hpf}"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>`,
    opt,
  );
  zip.file("META-INF/manifest.xml", `${HEAD}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`, opt);
  zip.file("META-INF/container.rdf", `${HEAD}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description><rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>`, opt);
  zip.file("Contents/content.hpf", content, opt);
  zip.file("Contents/header.xml", headerXml(book.layout, colophonTopMm(book)), opt);
  zip.file("Contents/section0.xml", section, opt);
  zip.file("Preview/PrvText.txt", `${project.title}\r\n${project.author}`, opt);
  for (const i of w.images) zip.file(i.file, i.data, opt);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: "application/hwp+zip" });
}
