/**
 * 실제 조판(Paged.js) 결과 ↔ 편집기 문서 — 편집 화면 쪽 나눔을 미리보기와 맞추기 위한 순수 계산.
 *
 * Paginator가 숨은 iframe의 조판 DOM에서 절마다 본문 블록(문단·소제목·인용·목록·구분선·그림)이
 * 그 절 첫 쪽에서 몇 번째 쪽에 놓였는지 읽어 온다(PrintedBlock). 편집기는 지금 문서의 최상위 블록을
 * 같은 규칙(render.ts docToHtml)으로 요약해(EditorBlock) 하나하나 맞춰 본다 — 종류·글자 수·그림이 모두 같으면
 * 조판이 지금 원고로 된 것이므로(저장 후 다시 잰 결과) 그 쪽 번호로 끊는 자리를 정한다. 하나라도 다르면 쓰지 않는다.
 */
import type { JNode } from "@/lib/doc/doc";

export type BlockKind = "p" | "h" | "quote" | "ul" | "ol" | "hr" | "fig";

/** 조판 결과의 본문 블록 하나 — start/end: 그 절 첫 쪽을 0으로 센 쪽 (문단이 쪽을 넘으면 end > start) */
export type PrintedBlock = { kind: BlockKind; len: number; asset?: string; start: number; end: number };
export type SectionPrintLayout = { blocks: PrintedBlock[] };
export type PageSpan = { start: number; end: number };

/** 조판 DOM에서 읽은 조각 — 절 요소(.sec) 하나 또는 그 바로 아래 자식 하나. 쪽을 넘은 문단은 같은 ref로 여러 조각 */
export type RawFragment = { sid: string; ref: string; tag: string; cls: string; page: number; len: number; asset?: string };

/** 편집기 문서의 최상위 블록 요약 — kind가 null이면 인쇄되지 않는 블록(빈 문단) */
export type EditorBlock = { kind: BlockKind | null; len: number; asset?: string };

/** 공백을 뺀 글자 수 (조판은 블록 사이·쪽 나눔 자리 공백이 다를 수 있다) */
export const textLen = (s: string) => s.replace(/\s+/g, "").length;

/** 조판 HTML 태그 → 블록 종류. 절 제목(h2)·빈 절 안내·절 끝 표시는 본문 블록이 아니다 */
export function tagKind(tag: string, cls: string): BlockKind | null {
  const t = tag.toUpperCase();
  const c = ` ${cls} `;
  if (t === "P") return c.includes(" empty-note ") ? null : "p";
  if (t === "H4") return "h";
  if (t === "BLOCKQUOTE") return "quote";
  if (t === "UL") return "ul";
  if (t === "OL") return "ol";
  if (t === "HR") return "hr";
  if (t === "FIGURE") return "fig";
  return null;
}

/** 조각 목록 → 절별 블록 목록 (쪽은 그 절 첫 쪽 기준) */
export function buildPrintLayouts(frags: RawFragment[]): Record<string, SectionPrintLayout> {
  const base = new Map<string, number>();
  for (const f of frags) base.set(f.sid, Math.min(base.get(f.sid) ?? Infinity, f.page));
  const out: Record<string, SectionPrintLayout> = {};
  const byRef = new Map<string, PrintedBlock>();
  frags.forEach((f, i) => {
    const kind = tagKind(f.tag, f.cls);
    if (!kind) return;
    const b0 = base.get(f.sid) ?? 0;
    const key = `${f.sid}\u0000${f.ref || `#${i}`}`;
    const seen = byRef.get(key);
    if (seen) {
      // 쪽을 넘어 이어지는 조각 — 글자 수를 더하고 끝 쪽을 늘린다
      seen.len += f.len;
      seen.end = Math.max(seen.end, f.page - b0);
      return;
    }
    const b: PrintedBlock = { kind, len: f.len, start: f.page - b0, end: f.page - b0 };
    if (kind === "fig") b.asset = f.asset ?? "";
    byRef.set(key, b);
    (out[f.sid] ??= { blocks: [] }).blocks.push(b);
  });
  return out;
}

const KIND: Record<string, BlockKind> = { paragraph: "p", heading: "h", blockquote: "quote", bulletList: "ul", orderedList: "ol", horizontalRule: "hr", figure: "fig" };

/** 인쇄 글자 — 텍스트만 (각주는 쪽 아래로 빠지고 줄바꿈은 글자가 아니다) */
function printedText(n: JNode): string {
  if (n.type === "text") return n.text ?? "";
  return (n.content ?? []).map(printedText).join("");
}

/** render.ts와 같은 규칙: 문단은 글자·줄바꿈·내용 있는 각주가 하나라도 있어야 인쇄된다 */
function paragraphPrinted(n: JNode) {
  return (n.content ?? []).some((c) => (c.type === "text" && (c.text ?? "").trim()) || c.type === "hardBreak" || (c.type === "footnote" && c.attrs?.note));
}

/** 편집기 문서(JSON) → 최상위 블록 요약. 그림은 글자 수 대신 캡션 글자 수(번호 제외)와 그림 id */
export function editorBlocks(doc: JNode): EditorBlock[] {
  return (doc.content ?? []).map((n) => {
    const kind = KIND[n.type] ?? null;
    if (!kind) return { kind: null, len: 0 };
    if (kind === "p" && !paragraphPrinted(n)) return { kind: null, len: 0 };
    if (kind === "fig") return { kind, len: textLen(String(n.attrs?.caption ?? "")), asset: String(n.attrs?.assetId ?? "") };
    return { kind, len: textLen(printedText(n)) };
  });
}

/**
 * 편집기 블록과 조판 블록을 차례로 맞춘다. 모두 같으면 편집기 최상위 블록 번호마다 쪽(인쇄되지 않는 블록은 null),
 * 하나라도 다르면(원고가 조판 뒤에 바뀌었다) null.
 */
export function matchPrintLayout(ed: EditorBlock[], layout: SectionPrintLayout | null | undefined): (PageSpan | null)[] | null {
  if (!layout) return null;
  const printed = ed.filter((b) => b.kind);
  if (printed.length !== layout.blocks.length) return null;
  const out: (PageSpan | null)[] = [];
  let k = 0;
  for (const b of ed) {
    if (!b.kind) {
      out.push(null);
      continue;
    }
    const p = layout.blocks[k++];
    if (p.kind !== b.kind || p.len !== b.len || (b.kind === "fig" && (p.asset ?? "") !== (b.asset ?? ""))) return null;
    out.push({ start: p.start, end: p.end });
  }
  return out;
}

/** 조판 결과를 새로 받았을 때 바뀐 절만 새 객체로 (편집기가 쓸데없이 쪽 나눔을 다시 하지 않게) */
export function mergePrintLayouts(prev: Record<string, SectionPrintLayout>, next: Record<string, SectionPrintLayout>): Record<string, SectionPrintLayout> {
  let changed = false;
  const out = { ...prev };
  for (const [sid, l] of Object.entries(next)) {
    if (prev[sid] && JSON.stringify(prev[sid]) === JSON.stringify(l)) continue;
    out[sid] = l;
    changed = true;
  }
  return changed ? out : prev;
}

/** 그림 번호 — 인쇄는 장마다 1부터 센다(앞 절의 그림 포함). 앞붙이·뒷붙이는 장 번호 없이 */
export const figureLabel = (chapterNo: number, n: number) => (chapterNo ? `그림 ${chapterNo}-${n}` : `그림 ${n}`);
