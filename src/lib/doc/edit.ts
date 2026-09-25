/**
 * 문서(JSON)를 편집기 없이 고치는 순수 함수 — 서버(책 전체 바꾸기·장 퇴고·확인 표시 정리)와 테스트가 쓴다.
 * 글자 오프셋은 textblocks()/nodeText()와 같다: 글자 = 1, hardBreak = 1("\n"), 각주 같은 인라인 원자 = 0.
 */
import type { JNode } from "./doc";

// doc.ts의 textblocks()와 같은 규칙 (테스트가 확장자 없이 불러오도록 값 import를 두지 않는다)
const TEXTBLOCKS = new Set(["paragraph", "heading"]);

function nodeText(n: JNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  return (n.content ?? []).map(nodeText).join("");
}

function textblocks(doc: JNode): { text: string }[] {
  const out: { text: string }[] = [];
  const walk = (n: JNode) => {
    if (TEXTBLOCKS.has(n.type)) out.push({ text: nodeText(n) });
    else (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

const inlineLen = (n: JNode) => (n.type === "text" ? (n.text ?? "").length : n.type === "hardBreak" ? 1 : 0);

function sameMarks(a: JNode, b: JNode) {
  return JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);
}

/** 이웃한 같은 서식의 글자 노드를 합치고 빈 글자 노드를 뺀다 */
function normalize(nodes: JNode[]): JNode[] {
  const out: JNode[] = [];
  for (const n of nodes) {
    if (n.type === "text" && !n.text) continue;
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text" && sameMarks(last, n)) last.text = (last.text ?? "") + n.text;
    else out.push({ ...n });
  }
  return out;
}

/**
 * 텍스트 블록의 [start, end) 글자를 text로 바꾼다. 새 글자는 start 자리 글자의 서식을 따른다.
 * 범위 안의 각주 같은 원자는 지우지 않고 새 글자 뒤에 남긴다. atom을 주면 새 글자 뒤에 넣는다.
 */
export function replaceRange(block: JNode, start: number, end: number, text: string, atom?: JNode): JNode {
  const src = block.content ?? [];
  const out: JNode[] = [];
  const kept: JNode[] = [];
  let off = 0;
  let inserted = false;
  const insert = (marks?: JNode["marks"]) => {
    if (inserted) return;
    inserted = true;
    if (text) out.push(marks?.length ? { type: "text", text, marks } : { type: "text", text });
    out.push(...kept.splice(0));
    if (atom) out.push(atom);
  };
  for (const n of src) {
    const len = inlineLen(n);
    const a = off;
    const b = off + len;
    off = b;
    // start 자리의 각주는 앞 단어에 붙은 것이므로 앞에, end 자리의 각주는 뒤에 둔다
    if (b <= start) {
      out.push(n);
      continue;
    }
    if (a >= end) {
      insert(n.type === "text" ? n.marks : undefined);
      out.push(n);
      continue;
    }
    // 범위와 겹치는 노드
    if (n.type === "text") {
      const t = n.text ?? "";
      const head = t.slice(0, Math.max(0, start - a));
      const tail = t.slice(Math.max(0, end - a));
      if (head) out.push({ ...n, text: head });
      insert(n.marks);
      if (tail) out.push({ ...n, text: tail });
    } else if (len === 0) kept.push(n); // 각주 등 원자는 보존
    // hardBreak가 범위 안이면 지운다
  }
  insert();
  return { ...block, content: normalize(out) };
}

/** 앞뒤 공통 부분을 빼고 달라진 가운데만 바꾼다 (서식 보존) */
export function replaceMinimal(block: JNode, start: number, before: string, after: string): JNode {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return replaceRange(block, start + p, start + before.length - s, after.slice(p, after.length - s));
}

/** 문서의 텍스트 블록을 순서대로(1부터) fn으로 바꾼 새 문서 */
export function mapTextblocks(doc: JNode, fn: (block: JNode, index: number, text: string) => JNode): JNode {
  const texts = textblocks(doc).map((b) => b.text);
  let i = 0;
  const walk = (n: JNode): JNode => {
    if (TEXTBLOCKS.has(n.type)) {
      const idx = ++i;
      return fn(n, idx, texts[idx - 1]);
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return walk(doc);
}

/** 모든 일치를 바꾼다. 결과 문서와 바꾼 개수 */
export function replaceAllInDoc(doc: JNode, query: string, replacement: string): { doc: JNode; count: number } {
  if (!query) return { doc, count: 0 };
  let count = 0;
  const next = mapTextblocks(doc, (block, _i, text) => {
    const hits: number[] = [];
    for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length)) hits.push(at);
    if (!hits.length) return block;
    count += hits.length;
    // 뒤에서부터 바꿔야 앞 오프셋이 그대로다
    return hits.reduceRight((b, at) => replaceMinimal(b, at, query, replacement), block);
  });
  return { doc: next, count };
}

export type BlockChange = { paragraph: number; before: string; after: string };

/**
 * 문단 번호 기준 변경 목록 적용. before가 그 문단에 정확히 한 번 있어야 적용한다(교정과 같은 규칙).
 * 같은 문단의 여러 변경은 순서대로 적용한다.
 */
export function applyBlockChanges<C extends BlockChange>(doc: JNode, changes: C[]): { doc: JNode; applied: C[]; failed: C[] } {
  const applied: C[] = [];
  const failed: C[] = [];
  const byBlock = new Map<number, C[]>();
  for (const c of changes) {
    if (!c.before || c.before === c.after) {
      failed.push(c);
      continue;
    }
    byBlock.set(c.paragraph, [...(byBlock.get(c.paragraph) ?? []), c]);
  }
  const touched = new Set<number>();
  const next = mapTextblocks(doc, (block, idx) => {
    const list = byBlock.get(idx);
    if (!list) return block;
    touched.add(idx);
    let b = block;
    for (const c of list) {
      const text = nodeText(b);
      const first = text.indexOf(c.before);
      if (first < 0 || text.indexOf(c.before, first + 1) >= 0) {
        failed.push(c);
        continue;
      }
      b = replaceMinimal(b, first, c.before, c.after);
      applied.push(c);
    }
    return b;
  });
  for (const [idx, list] of byBlock) if (!touched.has(idx)) failed.push(...list);
  return { doc: next, applied, failed };
}

/** 책 전체 검색용 — 문단별 일치 위치와 앞뒤 문맥 */
export function searchDoc(doc: JNode, query: string, context = 30) {
  const out: { paragraph: number; offset: number; before: string; match: string; after: string }[] = [];
  if (!query) return out;
  textblocks(doc).forEach((b, i) => {
    for (let at = b.text.indexOf(query); at >= 0; at = b.text.indexOf(query, at + query.length)) {
      out.push({
        paragraph: i + 1,
        offset: at,
        before: b.text.slice(Math.max(0, at - context), at),
        match: query,
        after: b.text.slice(at + query.length, at + query.length + context),
      });
    }
  });
  return out;
}

/* ---------------- [확인 필요]·[이미지 제안] 표시 ---------------- */

const MARKER_RE = /\[(확인 필요|이미지 제안)[^\]\n]{0,300}\]/g;

export type Marker = {
  paragraph: number;
  /** 본문이면 문단 안 글자 위치, 각주 안이면 -1 */
  offset: number;
  /** 각주 안 표시면 그 문단의 몇 번째 각주(0부터) */
  footnote?: number;
  marker: string;
  kind: "check" | "image";
  before: string;
  after: string;
};

/** 책 원고에 남은 확인 표시 — 본문과 각주 내용 모두 */
export function findMarkers(doc: JNode, context = 40): Marker[] {
  const out: Marker[] = [];
  let p = 0;
  const walk = (n: JNode) => {
    if (!TEXTBLOCKS.has(n.type)) return (n.content ?? []).forEach(walk);
    p++;
    const text = nodeText(n);
    for (const m of text.matchAll(MARKER_RE)) {
      const at = m.index!;
      out.push({
        paragraph: p,
        offset: at,
        marker: m[0],
        kind: m[1] === "확인 필요" ? "check" : "image",
        before: text.slice(Math.max(0, at - context), at),
        after: text.slice(at + m[0].length, at + m[0].length + 20),
      });
    }
    (n.content ?? [])
      .filter((c) => c.type === "footnote")
      .forEach((fn, fi) => {
        const note = String(fn.attrs?.note ?? "");
        for (const m of note.matchAll(MARKER_RE))
          out.push({ paragraph: p, offset: -1, footnote: fi, marker: m[0], kind: m[1] === "확인 필요" ? "check" : "image", before: `(각주) ${note.slice(0, m.index!).slice(-context)}`, after: "" });
      });
  };
  walk(doc);
  return out;
}

/**
 * 표시 하나를 처리한다. remove: 표시만 지운다(작가가 확인함). footnote: 표시 자리에 출처·설명 각주를 단다.
 * 원고가 그사이 바뀌어 같은 자리에 같은 표시가 없으면 null.
 */
export function resolveMarker(doc: JNode, m: Pick<Marker, "paragraph" | "offset" | "footnote" | "marker">, action: "remove" | "footnote", note = ""): JNode | null {
  let ok = false;
  const next = mapTextblocks(doc, (block, idx, text) => {
    if (idx !== m.paragraph) return block;
    if (m.offset < 0) {
      // 각주 안의 표시 — 각주 내용에서 지운다
      let fi = -1;
      const content = (block.content ?? []).map((c) => {
        if (c.type !== "footnote" || ++fi !== m.footnote) return c;
        const cur = String(c.attrs?.note ?? "");
        if (!cur.includes(m.marker)) return c;
        ok = true;
        const cleaned = cur.replace(m.marker, "").replace(/\s{2,}/g, " ").trim();
        return { ...c, attrs: { ...c.attrs, note: action === "footnote" && note ? `${cleaned} ${note}`.trim() : cleaned } };
      });
      return { ...block, content };
    }
    if (text.slice(m.offset, m.offset + m.marker.length) !== m.marker) return block;
    ok = true;
    // "늘었다 [확인 필요]." → 앞 공백도 함께 지운다
    const start = m.offset > 0 && text[m.offset - 1] === " " ? m.offset - 1 : m.offset;
    const end = m.offset + m.marker.length;
    if (action === "footnote" && note.trim()) {
      const term = (text.slice(0, start).match(/([^\s"'“”‘’()[\]]+)\s*$/)?.[1] ?? "").replace(/[.,!?·:;]+$/, "").slice(0, 40);
      return replaceRange(block, start, end, "", { type: "footnote", attrs: { note: note.trim().slice(0, 600), term, auto: false } });
    }
    return replaceRange(block, start, end, "");
  });
  return ok ? next : null;
}
