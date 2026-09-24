/**
 * Tiptap(ProseMirror) JSON 문서 유틸 — 서버·클라이언트 공용 (순수 함수)
 * 본문 스키마: paragraph, heading(level 3 = 소제목), blockquote, bulletList, orderedList,
 * listItem, horizontalRule, hardBreak, figure(이미지), footnote(각주 — 내용 없는 인라인 원자, attrs.note), 마크 bold/italic
 */
export type Mark = { type: string; attrs?: Record<string, unknown> };
export type JNode = {
  type: string;
  attrs?: Record<string, any>;
  content?: JNode[];
  marks?: Mark[];
  text?: string;
};

export const emptyDoc = (): JNode => ({ type: "doc", content: [{ type: "paragraph" }] });

export function parseDoc(raw: string | null | undefined): JNode {
  if (!raw) return emptyDoc();
  try {
    const d = JSON.parse(raw);
    if (d && d.type === "doc") return d;
  } catch {}
  return emptyDoc();
}

const TEXTBLOCKS = new Set(["paragraph", "heading"]);

export function nodeText(n: JNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  return (n.content ?? []).map(nodeText).join("");
}

/** 문서 순서대로 텍스트 블록(문단·소제목) 목록 — 교정 문단 번호의 기준 */
export function textblocks(doc: JNode): { node: JNode; text: string; type: string }[] {
  const out: { node: JNode; text: string; type: string }[] = [];
  const walk = (n: JNode) => {
    if (TEXTBLOCKS.has(n.type)) {
      out.push({ node: n, text: nodeText(n), type: n.type });
      return;
    }
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

export function docPlainText(doc: JNode): string {
  return textblocks(doc)
    .map((b) => b.text)
    .filter((t) => t.trim())
    .join("\n");
}

/** 공백 포함 글자 수(줄바꿈 제외) */
export function charCount(doc: JNode): number {
  return textblocks(doc).reduce((s, b) => s + b.text.replace(/\n/g, "").length, 0);
}

export function charCountNoSpace(doc: JNode): number {
  return textblocks(doc).reduce((s, b) => s + b.text.replace(/\s/g, "").length, 0);
}

export function isDocEmpty(doc: JNode): boolean {
  return charCount(doc) === 0 && findFigures(doc).length === 0;
}

export function findFootnotes(doc: JNode): JNode[] {
  const out: JNode[] = [];
  const walk = (n: JNode) => {
    if (n.type === "footnote") out.push(n);
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

export function findFigures(doc: JNode): JNode[] {
  const out: JNode[] = [];
  const walk = (n: JNode) => {
    if (n.type === "figure") out.push(n);
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

/* ---------------- 마크다운(제한형) ↔ 문서 ---------------- */

/** 각주 토큰: 본문 속 `⟦주:각주 내용⟧` — 바로 앞 단어에 다는 각주 */
export const FOOTNOTE_TOKEN = (note: string) => `⟦주:${note.replace(/[⟦⟧]/g, "")}⟧`;
const FOOTNOTE_RE = /⟦주:\s*([^⟧]*)⟧/g;

/** 각주가 붙은 단어(토큰 바로 앞 어절)를 추정 — 목록 표시용 */
function termBefore(text: string) {
  const m = text.replace(/\*+/g, "").match(/([^\s"'“”‘’()\[\]]+)\s*$/);
  return (m?.[1] ?? "").replace(/[.,!?·:;]+$/, "").slice(0, 40);
}

function marksInline(text: string): JNode[] {
  const out: JNode[] = [];
  const re = /(\*\*([^*]+)\*\*|(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w]))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    if (m[2]) out.push({ type: "text", text: m[2], marks: [{ type: "bold" }] });
    else if (m[3]) out.push({ type: "text", text: m[3], marks: [{ type: "italic" }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out.filter((n) => n.text);
}

function inline(text: string): JNode[] {
  const out: JNode[] = [];
  let last = 0;
  for (const m of text.matchAll(FOOTNOTE_RE)) {
    const before = text.slice(last, m.index);
    out.push(...marksInline(before));
    const note = m[1].trim();
    if (note) out.push({ type: "footnote", attrs: { note, term: termBefore(text.slice(0, m.index)), auto: true } });
    last = m.index! + m[0].length;
  }
  out.push(...marksInline(text.slice(last)));
  return out;
}

const para = (t: string): JNode => {
  const c = inline(t);
  return c.length ? { type: "paragraph", content: c } : { type: "paragraph" };
};

export const IMG_TOKEN = (i: number) => `⟦그림${i}⟧`;
const IMG_TOKEN_RE = /^⟦그림(\d+)⟧$/;

/**
 * AI 출력(제한형 마크다운)을 문서로 변환.
 * 각 줄이 한 문단. `## ` 소제목, `> ` 인용, `- `/`1. ` 목록, `---` 구분선, ⟦그림N⟧ 이미지 토큰.
 */
export function markdownToDoc(md: string, figures: JNode[] = []): JNode {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const content: JNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i++;
      continue;
    }
    const img = line.match(IMG_TOKEN_RE);
    if (img) {
      const f = figures[Number(img[1]) - 1];
      if (f) content.push(f);
      i++;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      const t = line.replace(/^#{1,6}\s+/, "");
      content.push({ type: "heading", attrs: { level: 3 }, content: inline(t) });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line)) {
      content.push({ type: "horizontalRule" });
      i++;
      continue;
    }
    if (line.startsWith(">")) {
      const qs: JNode[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        const t = lines[i].trim().replace(/^>\s?/, "");
        if (t) qs.push(para(t));
        i++;
      }
      content.push({ type: "blockquote", content: qs.length ? qs : [{ type: "paragraph" }] });
      continue;
    }
    if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      const ordered = /^\d+[.)]\s+/.test(line);
      const items: JNode[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        const ok = ordered ? /^\d+[.)]\s+/.test(l) : /^[-*•]\s+/.test(l);
        if (!ok) break;
        items.push({ type: "listItem", content: [para(l.replace(ordered ? /^\d+[.)]\s+/ : /^[-*•]\s+/, ""))] });
        i++;
      }
      content.push({ type: ordered ? "orderedList" : "bulletList", content: items });
      continue;
    }
    content.push(para(line));
    i++;
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function inlineToMd(n: JNode): string {
  if (n.type === "hardBreak") return " ";
  if (n.type === "footnote") return n.attrs?.note ? FOOTNOTE_TOKEN(String(n.attrs.note)) : "";
  if (n.type !== "text") return (n.content ?? []).map(inlineToMd).join("");
  let t = n.text ?? "";
  const marks = (n.marks ?? []).map((m) => m.type);
  if (marks.includes("bold")) t = `**${t}**`;
  else if (marks.includes("italic")) t = `*${t}*`;
  return t;
}

/** 문서 → 제한형 마크다운. 이미지는 ⟦그림N⟧ 토큰으로 바꾸고 원본 노드를 figures로 돌려준다. */
export function docToMarkdown(doc: JNode): { md: string; figures: JNode[] } {
  const figures: JNode[] = [];
  const blocks: string[] = [];
  const block = (n: JNode, prefix = "") => {
    switch (n.type) {
      case "paragraph": {
        const t = (n.content ?? []).map(inlineToMd).join("");
        if (t.trim()) blocks.push(prefix + t);
        break;
      }
      case "heading":
        blocks.push("## " + (n.content ?? []).map(inlineToMd).join(""));
        break;
      case "blockquote":
        (n.content ?? []).forEach((c) => block(c, "> "));
        break;
      case "bulletList":
        (n.content ?? []).forEach((li) => (li.content ?? []).forEach((c) => block(c, "- ")));
        break;
      case "orderedList":
        (n.content ?? []).forEach((li, idx) => (li.content ?? []).forEach((c) => block(c, `${idx + 1}. `)));
        break;
      case "horizontalRule":
        blocks.push("---");
        break;
      case "figure":
        figures.push(n);
        blocks.push(IMG_TOKEN(figures.length));
        break;
      default:
        (n.content ?? []).forEach((c) => block(c, prefix));
    }
  };
  (doc.content ?? []).forEach((c) => block(c));
  return { md: blocks.join("\n\n"), figures };
}

/** 두 문서를 이어 붙인다(이어쓰기) */
export function appendDocs(a: JNode, b: JNode): JNode {
  const ac = (a.content ?? []).filter((n) => !(n.type === "paragraph" && !n.content?.length));
  return { type: "doc", content: [...ac, ...(b.content ?? [])] };
}

/** 문단 단위 비교용 텍스트 배열 */
export function docParagraphs(doc: JNode): string[] {
  return textblocks(doc)
    .map((b) => (b.type === "heading" ? "## " : "") + b.text)
    .filter((t) => t.trim());
}

/** 간단한 FNV 해시 (요약 캐시 무효화용) */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** 문단 단위 LCS diff */
export type DiffRow = { type: "same" | "add" | "del"; text: string };
export function diffParagraphs(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: a[i++] });
    else out.push({ type: "add", text: b[j++] });
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}
