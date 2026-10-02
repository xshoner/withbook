import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import { getObject, mapLimit } from "../storage";
import { prisma } from "../db";
import type { Book } from "../book";
import { parseDoc, type JNode } from "../doc/doc";
import { DOC } from "../print/spec";

/**
 * EPUB 3 전자책 — PDF·HWPX와 같은 책 내용(표제지·앞붙이·본문·뒷붙이·참고문헌·판권면)과 같은 장·절 번호.
 * 쪽 개념이 없어 찾아보기(쪽 번호 색인)는 넣지 않는다. 글꼴은 넣지 않고 읽는 기기의 글꼴을 쓴다.
 * 각주는 장마다 끝에 모아(미주) 본문 번호와 서로 오가는 링크를 단다.
 */

/** XML 문자 이스케이프 + XML 1.0에서 쓸 수 없는 제어 문자 제거 */
const x = (s: string) =>
  String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

const CSS = `@charset "UTF-8";
html { -epub-line-break: strict; line-break: strict; }
body { margin: 0 4%; line-height: 1.7; word-break: keep-all; overflow-wrap: break-word; -epub-word-break: keep-all; text-align: justify; }
p { margin: 0 0 0.6em; text-indent: 1em; }
h1, h2, h3, h4 { line-height: 1.4; text-align: left; text-indent: 0; page-break-after: avoid; break-after: avoid; }
h1 { font-size: 1.5em; margin: 2.5em 0 1.5em; }
h1 .ch-no { display: block; font-size: 0.65em; font-weight: normal; margin-bottom: 0.4em; }
h2 { font-size: 1.2em; margin: 2em 0 1em; }
h2 .sec-no { margin-right: 0.5em; }
h4 { font-size: 1em; margin: 1.5em 0 0.6em; }
section.sec { page-break-before: always; break-before: page; }
section.sec.first { page-break-before: auto; break-before: auto; }
blockquote { margin: 1em 0 1em 1.5em; }
blockquote p, li p, figcaption, .fn-list p, .center p { text-indent: 0; }
ul, ol { margin: 0.6em 0 0.6em 1.5em; padding: 0; }
hr { border: 0; text-align: center; margin: 1.5em 0; }
hr::after { content: "* * *"; }
figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
figure img { max-width: 100%; height: auto; }
figcaption { font-size: 0.85em; margin-top: 0.4em; text-align: center; }
sup { line-height: 0; font-size: 0.7em; }
a.noteref { text-decoration: none; }
.fn-list { margin-top: 3em; border-top: 1px solid #999; padding-top: 0.6em; font-size: 0.85em; }
.fn-list aside { margin: 0 0 0.5em; }
.fn-list a.back { text-decoration: none; margin-right: 0.4em; }
.title-page { text-align: center; margin-top: 30%; }
.title-page .tp-title { font-size: 1.8em; font-weight: bold; text-indent: 0; margin-bottom: 0.5em; }
.title-page .tp-sub { font-size: 1.1em; text-indent: 0; }
.title-page .tp-author { margin-top: 3em; text-indent: 0; }
.biblio { list-style: none; margin: 0; padding: 0; }
.biblio li { padding-left: 1.5em; text-indent: -1.5em; margin-bottom: 0.4em; text-align: left; }
.colophon { font-size: 0.85em; margin-top: 30%; }
.colophon p { text-indent: 0; margin: 0 0 0.3em; }
.colophon .cp-title { font-weight: bold; margin-bottom: 1em; }
.colophon th { font-weight: normal; text-align: left; padding-right: 1em; vertical-align: top; white-space: nowrap; }
.colophon table { border-collapse: collapse; margin-bottom: 0.8em; }
nav ol { list-style: none; padding-left: 0; }
nav ol ol { padding-left: 1.2em; }
`;

type Loaded = { path: string; mime: string; widthPx: number; heightPx: number; data: Buffer };
type Img = { id: string; file: string; mime: string; data: Buffer };
type BackMatter = { biblio?: { enabled: boolean; entries: { text: string }[] } | null };
type Doc = { id: string; file: string; title: string; xhtml: string; nav?: { label: string; href: string; children: { label: string; href: string }[] } };

/** 원고 속 그림의 이미지 ID 모으기 */
function figureIds(n: JNode, out: Set<string>) {
  if (n.type === "figure" && n.attrs?.assetId) out.add(String(n.attrs.assetId));
  for (const c of n.content ?? []) figureIds(c, out);
}

/** 그림 이미지를 한 번에 조회하고 4개씩 나란히 내려받는다 (HWPX와 같은 방식) */
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

/** 책마다 늘 같은 식별자(urn:uuid) — 다시 내보내도 전자책 서재가 같은 책으로 본다 */
export function epubUuid(seed: string) {
  const h = createHash("sha1").update(`withbook-epub:${seed}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // variant
  const s = h.subarray(0, 16).toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

const page = (title: string, body: string, bodyType = "") =>
  `${HEAD}\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko"><head><meta charset="UTF-8"/><title>${x(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body${bodyType ? ` epub:type="${bodyType}"` : ""}>\n${body}\n</body></html>`;

class Writer {
  images: Img[] = [];
  private imageByAsset = new Map<string, Img>();
  /** 현재 장의 각주 */
  notes: string[] = [];
  private textWidthMm: number;
  constructor(book: Book, private assets: Map<string, Loaded>) {
    const m = book.layout.margins;
    this.textWidthMm = DOC.width - m.inner - m.outer;
  }

  inline(n: JNode): string {
    if (n.type === "hardBreak") return "<br/>";
    if (n.type === "footnote") {
      const note = String(n.attrs?.note ?? "").trim();
      if (!note) return "";
      this.notes.push(note);
      const k = this.notes.length;
      return `<sup><a class="noteref" epub:type="noteref" role="doc-noteref" id="fnref${k}" href="#fn${k}">${k}</a></sup>`;
    }
    if (n.type !== "text") return (n.content ?? []).map((c) => this.inline(c)).join("");
    let t = x(n.text ?? "");
    for (const m of n.marks ?? []) {
      if (m.type === "bold") t = `<strong>${t}</strong>`;
      if (m.type === "italic") t = `<em>${t}</em>`;
    }
    return t;
  }
  inlines(n: JNode) {
    return (n.content ?? []).map((c) => this.inline(c)).join("");
  }

  figure(n: JNode, label: string) {
    const a = n.attrs ?? {};
    const asset = a.assetId ? this.assets.get(String(a.assetId)) : undefined;
    const mime = asset?.mime.toLowerCase() ?? "";
    if (!asset || !mime.startsWith("image/")) return "";
    const assetId = String(a.assetId);
    let img = this.imageByAsset.get(assetId);
    if (!img) {
      const i = this.images.length + 1;
      const ext = EXT[mime] ?? (path.extname(asset.path).slice(1).toLowerCase() || "png");
      img = { id: `img${i}`, file: `images/img${i}.${ext}`, mime, data: asset.data };
      this.images.push(img);
      this.imageByAsset.set(assetId, img);
    }
    // 지정 너비(mm)는 인쇄 본문 폭에 대한 비율로 옮긴다
    const pct = a.layout === "mm" && Number(a.widthMm) > 0 ? Math.min(100, Math.round((Number(a.widthMm) / this.textWidthMm) * 100)) : 0;
    const style = pct && pct < 100 ? ` style="width:${pct}%"` : "";
    const caption = a.caption && a.layout !== "fullbleed" ? String(a.caption) : "";
    const cap = caption ? `<figcaption><b>${x(label)}</b> ${x(caption)}</figcaption>` : "";
    return `<figure><img src="${img.file}" alt="${x(caption)}"${style}/>${cap}</figure>`;
  }

  block(n: JNode, fig: { ch: number; n: number }): string {
    switch (n.type) {
      case "paragraph": {
        const inner = this.inlines(n);
        return inner.trim() ? `<p>${inner}</p>` : "";
      }
      case "heading": {
        const inner = this.inlines(n);
        return inner.trim() ? `<h4>${inner}</h4>` : "";
      }
      case "blockquote":
        return `<blockquote>${this.blocks(n, fig) || "<p></p>"}</blockquote>`;
      case "bulletList":
      case "orderedList": {
        const items = (n.content ?? []).map((li) => `<li>${this.blocks(li, fig)}</li>`).join("");
        const tag = n.type === "bulletList" ? "ul" : "ol";
        return items ? `<${tag}>${items}</${tag}>` : "";
      }
      case "horizontalRule":
        return "<hr/>";
      case "figure":
        fig.n++;
        return this.figure(n, fig.ch ? `그림 ${fig.ch}-${fig.n}` : `그림 ${fig.n}`);
      default:
        return this.blocks(n, fig);
    }
  }
  blocks(n: JNode, fig: { ch: number; n: number }): string {
    return (n.content ?? []).map((c) => this.block(c, fig)).join("\n");
  }

  /** 이 장의 각주를 장 끝에 모으고 비운다 */
  flushNotes() {
    if (!this.notes.length) return "";
    const items = this.notes
      .map((t, i) => `<aside epub:type="footnote" role="doc-footnote" id="fn${i + 1}"><p><a class="back" href="#fnref${i + 1}" role="doc-backlink">${i + 1}</a> ${x(t)}</p></aside>`)
      .join("\n");
    this.notes = [];
    return `<section class="fn-list" epub:type="endnotes" role="doc-endnotes"><h2 class="fn-head">주</h2>\n${items}\n</section>`;
  }
}

/** biblio: 켠 참고문헌은 판권면 앞에 넣는다(PDF와 같은 순서) */
export async function buildEpub(book: Book, back: BackMatter = {}, opts: { modified?: Date } = {}): Promise<Buffer> {
  const { project, layout } = book;
  const chapters = book.chapters.filter((c) => c.sections.length);
  const parsed = new Map(chapters.flatMap((c) => c.sections.map((s) => [s, parseDoc(s.content)] as const)));
  const w = new Writer(book, await loadAssets([...parsed.values()]));

  // 표제지
  const titleDoc: Doc = {
    id: "titlepage",
    file: "title.xhtml",
    title: project.title,
    xhtml: page(
      project.title,
      `<section class="title-page" epub:type="titlepage"><p class="tp-title">${x(project.title)}</p>${project.subtitle ? `<p class="tp-sub">${x(project.subtitle)}</p>` : ""}${project.author ? `<p class="tp-author">${x(project.author)}</p>` : ""}</section>`,
      "frontmatter",
    ),
  };

  // 판권면
  const cp = layout.colophon;
  const row = (k: string, v: string) => (v ? `<tr><th>${x(k)}</th><td>${x(v)}</td></tr>` : "");
  const table = (rows: string) => (rows ? `<table>${rows}</table>` : "");
  const colophonDoc: Doc = {
    id: "colophon",
    file: "colophon.xhtml",
    title: "판권",
    xhtml: page(
      "판권",
      `<section class="colophon" epub:type="colophon"><p class="cp-title">${x(project.title)}</p>${table(row("지은이", project.author))}${table(
        row("발행", cp.publishDate) + row("펴낸이", cp.publisher) + row("펴낸곳", cp.publisherName) + row("출판사등록", cp.registration) + row("주소", cp.address) + row("전화", cp.phone) + row("이메일", cp.email),
      )}${table(row("ISBN", cp.isbn))}${cp.website ? `<p>${x(cp.website)}</p>` : ""}<p>ⓒ ${x(project.author)} ${x(cp.copyrightYear)}</p>${cp.notice ? `<p>${x(cp.notice)}</p>` : ""}</section>`,
      "frontmatter",
    ),
    nav: { label: "판권", href: "colophon.xhtml", children: [] },
  };

  // 장마다 XHTML 하나
  const chapterDocs: (Doc & { kind: string })[] = chapters.map((c, ci) => {
    const fig = { ch: c.no, n: 0 };
    const file = `ch${String(ci + 1).padStart(3, "0")}.xhtml`;
    const single = c.kind !== "body" && c.sections.length === 1 && c.sections[0].title === c.title;
    const children: { label: string; href: string }[] = [];
    const secs = c.sections
      .map((s, si) => {
        const sid = `s${si + 1}`;
        const head = single ? "" : `<h2>${s.label ? `<span class="sec-no">${x(s.label)}</span>` : ""}${x(s.title)}</h2>`;
        if (!single) children.push({ label: `${s.label ? s.label + " " : ""}${s.title}`, href: `${file}#${sid}` });
        return `<section class="sec${si === 0 ? " first" : ""}" id="${sid}">${head}\n${w.blocks(parsed.get(s)!, fig)}</section>`;
      })
      .join("\n");
    const h1 = `<h1>${c.label ? `<span class="ch-no">${x(c.label)}</span>` : ""}${x(c.title)}</h1>`;
    const kind = c.kind === "body" ? "bodymatter" : c.kind === "front" ? "frontmatter" : "backmatter";
    return {
      id: `ch${ci + 1}`,
      file,
      kind: c.kind,
      title: c.title,
      xhtml: page(c.title, `<section epub:type="chapter" role="doc-chapter" id="top">${h1}\n${secs}\n${w.flushNotes()}</section>`, kind),
      nav: { label: `${c.label ? c.label + " " : ""}${c.title}`, href: file, children },
    };
  });

  // 참고문헌
  const bib = back.biblio?.enabled && back.biblio.entries.length ? back.biblio : null;
  const biblioDoc: Doc | null = bib
    ? {
        id: "biblio",
        file: "biblio.xhtml",
        title: "참고문헌",
        xhtml: page("참고문헌", `<section epub:type="bibliography" role="doc-bibliography"><h1>참고문헌</h1><ul class="biblio">${bib.entries.map((e) => `<li>${x(e.text)}</li>`).join("")}</ul></section>`, "backmatter"),
        nav: { label: "참고문헌", href: "biblio.xhtml", children: [] },
      }
    : null;

  // 읽는 순서 — PDF와 같다: 표제지 · 판권 · 차례 · 앞붙이(머리말) · 본문 · 뒷붙이 · 참고문헌 (속표지는 전자책에서 뺀다)
  const front = chapterDocs.filter((d) => d.kind === "front");
  const rest = chapterDocs.filter((d) => d.kind !== "front");
  const navEntries = [colophonDoc, ...front, ...rest, ...(biblioDoc ? [biblioDoc] : [])];
  const li = (e: { label: string; href: string; children: { label: string; href: string }[] }): string =>
    `<li><a href="${x(e.href)}">${x(e.label)}</a>${e.children.length ? `<ol>${e.children.map((c) => li({ ...c, children: [] })).join("")}</ol>` : ""}</li>`;
  const firstBody = chapterDocs.find((d) => d.kind === "body") ?? chapterDocs[0];
  const navDoc: Doc = {
    id: "nav",
    file: "nav.xhtml",
    title: "차례",
    xhtml: page(
      "차례",
      `<nav epub:type="toc" role="doc-toc" id="toc"><h1>차례</h1><ol>${navEntries.map((d) => li(d.nav!)).join("")}</ol></nav>\n<nav epub:type="landmarks" hidden="hidden"><ol><li><a epub:type="titlepage" href="title.xhtml">표제지</a></li><li><a epub:type="toc" href="nav.xhtml#toc">차례</a></li>${firstBody ? `<li><a epub:type="bodymatter" href="${firstBody.file}">본문</a></li>` : ""}</ol></nav>`,
      "frontmatter",
    ),
  };
  const spine: Doc[] = [titleDoc, colophonDoc, navDoc, ...front, ...rest, ...(biblioDoc ? [biblioDoc] : [])];

  // 패키지 문서
  const uuid = epubUuid(String((project as { id?: string }).id ?? project.title));
  const updated = opts.modified ?? ((project as { updatedAt?: Date }).updatedAt instanceof Date ? (project as { updatedAt: Date }).updatedAt : new Date());
  const modified = updated.toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...spine.filter((d) => d.id !== "nav").map((d) => `<item id="${d.id}" href="${d.file}" media-type="application/xhtml+xml"/>`),
    ...w.images.map((i) => `<item id="${i.id}" href="${i.file}" media-type="${x(i.mime)}"/>`),
  ].join("\n    ");
  const meta = [
    `<dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>`,
    `<dc:title>${x(project.title)}</dc:title>`,
    project.author ? `<dc:creator id="author">${x(project.author)}</dc:creator>` : "",
    `<dc:language>ko</dc:language>`,
    cp.publisherName ? `<dc:publisher>${x(cp.publisherName)}</dc:publisher>` : "",
    project.subtitle ? `<dc:description>${x(project.subtitle)}</dc:description>` : "",
    project.author ? `<dc:rights>ⓒ ${x(project.author)} ${x(cp.copyrightYear)}</dc:rights>` : "",
    `<meta property="dcterms:modified">${modified}</meta>`,
  ]
    .filter(Boolean)
    .join("\n    ");
  const opf = `${HEAD}
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ko" dir="ltr">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${meta}
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine.map((d) => `<itemref idref="${d.id}"/>`).join("\n    ")}
  </spine>
</package>`;

  const zip = new JSZip();
  const opt = { createFolders: false } as const;
  // mimetype은 맨 앞, 압축하지 않음 (EPUB OCF 규칙)
  zip.file("mimetype", "application/epub+zip", { compression: "STORE", createFolders: false });
  zip.file(
    "META-INF/container.xml",
    `${HEAD}\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    opt,
  );
  zip.file("OEBPS/content.opf", opf, opt);
  zip.file("OEBPS/style.css", CSS, opt);
  for (const d of spine) zip.file(`OEBPS/${d.file}`, d.xhtml, opt);
  for (const i of w.images) zip.file(`OEBPS/${i.file}`, i.data, opt);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: "application/epub+zip" });
}
