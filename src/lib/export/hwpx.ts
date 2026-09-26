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

/**
 * HWPX(OWPML) 생성 — 부크크 A5 서식과 같은 용지·여백.
 * 조판(쪽 나눔)은 한글이 다시 하므로 PDF와 쪽수가 조금 다를 수 있다(편집용 원고).
 */

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
// charPr: 0 본문, 1 본문 굵게, 2 장 제목, 3 절 제목, 4 소제목, 5 장 번호, 6 캡션, 7 판권, 8 표제, 9 기울임, 10 장 제목 쪽
type CharDef = { size: number; font: 0 | 1; bold?: boolean; italic?: boolean };
const chars = (l: LayoutSettings): CharDef[] => [
  { size: l.bodySizePt, font: 0 },
  { size: l.bodySizePt, font: 0, bold: true },
  { size: 18, font: 1 },
  { size: 13, font: 1 },
  { size: 10.5, font: 1 },
  { size: 10.5, font: 1 },
  { size: 8.5, font: 0 },
  { size: 8.5, font: 0 },
  { size: 22, font: 1 },
  { size: l.bodySizePt, font: 0, italic: true },
  { size: 24, font: 1 },
];
// paraPr: 0 본문(양쪽, 들여쓰기 1em, 줄 간격·문단 간격은 책 설정), 1 제목(왼쪽, 들여쓰기 없음), 2 가운데(그림·캡션), 3 인용, 4 판권(왼쪽 130%), 5 각주, 6 장 제목 쪽(가운데, 위 60mm)
type ParaDef = { align: string; indent: number; line: number; left?: number; prev?: number; next?: number; keepNext?: boolean };
const paras = (l: LayoutSettings): ParaDef[] => [
  { align: "JUSTIFY", indent: l.bodySizePt * 100, line: Math.round(l.lineHeight * 100), next: mmToHwp(l.paraSpacingMm) },
  { align: "LEFT", indent: 0, line: 140, prev: 1200, next: 1200, keepNext: true },
  { align: "CENTER", indent: 0, line: 140, prev: 600, next: 600 },
  { align: "JUSTIFY", indent: 0, line: Math.round(l.lineHeight * 100), left: mmToHwp(8) },
  { align: "LEFT", indent: 0, line: 170 },
  { align: "JUSTIFY", indent: 0, line: 145 },
  { align: "CENTER", indent: 0, line: 135, prev: mmToHwp(60) },
];

function charPr(id: number, c: CharDef) {
  const h = Math.round(c.size * 100);
  const f = c.font;
  const seven = (tag: string, v: string | number) =>
    `<hh:${tag} hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"/>`;
  return `<hh:charPr id="${id}" height="${h}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">${seven("fontRef", f)}${seven("ratio", 100)}${seven("spacing", 0)}${seven("relSz", 100)}${seven("offset", 0)}${c.italic ? "<hh:italic/>" : ""}${c.bold ? "<hh:bold/>" : ""}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>`;
}

function paraPr(id: number, p: ParaDef) {
  const u = (tag: string, v: number) => `<hc:${tag} value="${v}" unit="HWPUNIT"/>`;
  const margin = `<hh:margin>${u("intent", p.indent)}${u("left", p.left ?? 0)}${u("right", 0)}${u("prev", p.prev ?? 0)}${u("next", p.next ?? 0)}</hh:margin>`;
  return `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="${p.align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="1" keepWithNext="${p.keepNext ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="${NS.hwpunitchar}">${margin}<hh:lineSpacing type="PERCENT" value="${p.line}" unit="HWPUNIT"/></hp:case><hp:default>${margin}<hh:lineSpacing type="PERCENT" value="${p.line}" unit="HWPUNIT"/></hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
}

function headerXml(l: LayoutSettings) {
  const CHARS = chars(l);
  const PARAS = paras(l);
  const langs = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
  const fontface = (lang: string) =>
    `<hh:fontface lang="${lang}" fontCnt="2"><hh:font id="0" face="${TYPO.bodyFont}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_MYUNGJO" weight="4" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font><hh:font id="1" face="${TYPO.headingFont}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font></hh:fontface>`;
  const border = (id: number) =>
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/><hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>`;
  return `${HEAD}<hh:head ${nsAttrs} version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList><hh:fontfaces itemCnt="7">${langs.map(fontface).join("")}</hh:fontfaces><hh:borderFills itemCnt="2">${border(1)}${border(2)}</hh:borderFills><hh:charProperties itemCnt="${CHARS.length}">${CHARS.map((c, i) => charPr(i, c)).join("")}</hh:charProperties><hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties><hh:numberings itemCnt="1"><hh:numbering id="1" start="0"><hh:paraHead start="1" level="1" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead></hh:numbering></hh:numberings><hh:paraProperties itemCnt="${PARAS.length}">${PARAS.map((p, i) => paraPr(i, p)).join("")}</hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles></hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`;
}

function secPr(book: Book) {
  const m = book.layout.margins;
  const pb = (type: string) =>
    `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  return `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="1" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="${mmToHwp(DOC.width)}" height="${mmToHwp(DOC.height)}" gutterType="LEFT_RIGHT"><hp:margin header="${mmToHwp(m.header)}" footer="${mmToHwp(m.footer)}" gutter="0" left="${mmToHwp(m.inner)}" right="${mmToHwp(m.outer)}" top="${mmToHwp(m.top)}" bottom="${mmToHwp(m.bottom)}"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>${pb("BOTH")}${pb("EVEN")}${pb("ODD")}</hp:secPr>`;
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
      // 첫 문단에 구역 정의 + 쪽 번호(바깥쪽 아래)
      lead = `<hp:run charPrIDRef="0">${secPr(this.book)}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl><hp:ctrl><hp:pageNum pos="OUTSIDE_BOTTOM" formatType="DIGIT" sideChar=""/></hp:ctrl></hp:run>`;
      this.first = false;
    }
    this.paras.push(
      `<hp:p id="${this.pid++}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${lead}${runs || '<hp:run charPrIDRef="0"/>'}</hp:p>`,
    );
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
    const body = `<hp:p id="${this.pid++}" paraPrIDRef="5" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="6">${num}<hp:t> ${x(note.trim())}</hp:t></hp:run></hp:p>`;
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
    const wMm = layout === "fullbleed" ? 103 : printWidthMm(layout, a.widthMm, asset.widthPx, asset.heightPx);
    const W = mmToHwp(wMm);
    const H = Math.round((W * asset.heightPx) / asset.widthPx);
    const pic = `<hp:run charPrIDRef="0"><hp:pic id="${1000 + idx}" zOrder="${idx}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${2000 + idx}" reverse="0"><hp:offset x="0" y="0"/><hp:orgSz width="${W}" height="${H}"/><hp:curSz width="${W}" height="${H}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(W / 2)}" centerY="${Math.round(H / 2)}" rotateimage="1"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hc:img binaryItemIDRef="${img.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${W}" y="0"/><hc:pt2 x="${W}" y="${H}"/><hc:pt3 x="0" y="${H}"/></hp:imgRect><hp:imgClip left="0" right="${asset.widthPx * 75}" top="0" bottom="${asset.heightPx * 75}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${asset.widthPx * 75}" dimheight="${asset.heightPx * 75}"/><hp:effects/><hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${H}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="CENTER" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic></hp:run>`;
    this.p(pic, 2, layout === "fullpage" || layout === "fullbleed");
    if (a.caption) this.p(this.run(`${label} `, 6) + this.run(String(a.caption), 6), 2);
  }
  async blocks(doc: JNode, fig: { ch: number; n: number }) {
    for (const n of doc.content ?? []) await this.block(n, fig);
  }
  async block(n: JNode, fig: { ch: number; n: number }, prefix = ""): Promise<void> {
    switch (n.type) {
      case "paragraph": {
        const runs = this.inlineRuns(n);
        if (runs) this.p((prefix ? this.run(prefix) : "") + runs, prefix ? 3 : 0);
        return;
      }
      case "heading":
        this.p(this.run((n.content ?? []).map((c) => c.text ?? "").join(""), 4), 1);
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

export async function buildHwpx(book: Book): Promise<Buffer> {
  const { project, layout } = book;
  const docs = new Map(book.chapters.flatMap((c) => c.sections.map((s) => [s, parseDoc(s.content)] as const)));
  const w = new Writer(book, await loadAssets([...docs.values()]));
  // 표제지
  w.p(w.run(project.title, 8), 1);
  if (project.subtitle) w.p(w.run(project.subtitle, 4), 1);
  w.p(w.run(project.author, 0), 1);
  // 본문
  for (const c of book.chapters) {
    const fig = { ch: c.no, n: 0 };
    // 본문 장: 제목만 있는 독립된 쪽 / 앞붙이·뒷붙이: 새 쪽 맨 위에 제목
    if (c.kind === "body") w.p(w.run(c.title, 10), 6, true);
    else w.p(w.run(c.title, 2), 1, true);
    const single = c.kind !== "body" && c.sections.length === 1 && c.sections[0].title === c.title;
    for (const [i, s] of c.sections.entries()) {
      // 절은 항상 새 쪽에서 시작 (앞붙이·뒷붙이의 첫 절은 장 제목 바로 아래)
      if (!single) w.p(w.run(`${s.label ? s.label + " " : ""}${s.title}`, 3), 1, c.kind === "body" || i > 0);
      await w.blocks(docs.get(s)!, fig);
    }
  }
  // 판권면
  const cp = layout.colophon;
  const line = (k: string, v: string) => v && w.p(w.run(`${k}  ${v}`, 7), 4);
  w.p(w.run(project.title, 4), 4, true);
  line("지은이", project.author);
  line("발  행", cp.publishDate);
  line("펴낸이", cp.publisher);
  line("펴낸곳", cp.publisherName);
  line("출판사등록", cp.registration);
  line("주  소", cp.address);
  line("전  화", cp.phone);
  line("이메일", cp.email);
  line("ISBN", cp.isbn);
  line("", cp.website);
  w.p(w.run(`ⓒ ${project.author} ${cp.copyrightYear}`, 7), 4);
  w.p(w.run(cp.notice, 7), 4);

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
  zip.file("Contents/header.xml", headerXml(book.layout), opt);
  zip.file("Contents/section0.xml", section, opt);
  zip.file("Preview/PrvText.txt", `${project.title}\r\n${project.author}`, opt);
  for (const i of w.images) zip.file(i.file, i.data, opt);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: "application/hwp+zip" });
}
