"use client";

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * 편집 화면 쪽 나눔 — 실제 조판처럼 본문 영역 높이(160mm)마다 쪽을 끊고, 쪽과 쪽 사이에 빈 공간을 둔다.
 * 각주는 인쇄처럼 그 쪽 아래에 모아 보여 주고, 그만큼 본문 영역을 줄인다.
 * 문서는 건드리지 않고 장식(widget)만 끼워 넣는다. 끊는 자리:
 *  - mid: 문단 중간 — 쪽을 넘는 줄의 맨 앞에 전체 폭 인라인 블록
 *  - start: 블록 첫 줄부터 넘칠 때 — 문단 맨 앞(들여쓰기는 빈칸으로 흉내)
 *  - block: 그림·구분선처럼 글자가 없는 블록 앞
 * 실제 조판(Paginator가 잰 Paged.js 결과)이 지금 원고와 맞으면 그 끊음 자리(블록 앞·문단 속 글자 자리)를 그대로 따른다(hints) — PDF와 같은 쪽 나눔.
 */

export type PageGeom = {
  top: number; // 위 여백(문서 가장자리 → 본문) mm
  bottom: number; // 아래 여백 mm
  body: number; // 본문 영역 높이 mm
  padX: number; // 편집 지면의 좌우 여백 mm
  gap: number; // 쪽 사이 빈 공간 mm
};

export type PageNote = { n: number; text: string };

export type PageBreak = {
  id: string;
  pos: number;
  kind: "mid" | "start" | "block";
  fill: number; // 끊는 자리 → 본문 영역 끝 mm (각주 영역 포함)
  indent: number; // start: 들여쓰기 흉내 폭 (CSS px)
  mb: number; // block: 뒤 블록의 위 여백 상쇄 (CSS px)
  foot: string; // 앞 쪽 아래 쪽 번호
  head: string; // 다음 쪽 위 표시
  notes: PageNote[]; // 앞 쪽 아래 각주
};

type PgState = { set: DecorationSet; geom: PageGeom | null };
const key = new PluginKey<PgState>("pageBreaks");

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** 쪽 아래 각주 영역 (편집 화면 표시·높이 측정 공용) */
export function notesDom(notes: PageNote[]) {
  const box = el("span", "pg-notes");
  for (const n of notes) {
    const row = el("span", "pg-note");
    row.appendChild(el("span", "pg-note-no", `${n.n})`));
    row.appendChild(el("span", "pg-note-text", n.text || "(내용 없음)"));
    box.appendChild(row);
  }
  return box;
}

function gapDom(b: PageBreak, g: PageGeom) {
  const h = b.fill + g.bottom + g.gap + g.top;
  const outer = el("span", `pg-gap pg-${b.kind}`);
  outer.contentEditable = "false";
  outer.setAttribute("data-pg", b.id);
  if (b.kind === "block") {
    outer.style.display = "block";
    outer.style.marginBottom = `${-b.mb}px`;
  }
  const box = el("span", "pg-box");
  box.style.height = `${h}mm`;
  const band = el("span", "pg-band");
  band.style.left = `${-g.padX}mm`;
  band.style.right = `${-g.padX}mm`;
  band.style.height = `${h}mm`;
  const fill = el("span", "pg-fill");
  fill.style.height = `${b.fill}mm`;
  fill.style.padding = `0 ${g.padX}mm`;
  if (b.notes.length) fill.appendChild(notesDom(b.notes));
  const foot = el("span", "pg-foot");
  foot.style.height = `${g.bottom}mm`;
  foot.appendChild(el("span", "", b.foot));
  const space = el("span", "pg-space");
  space.style.height = `${g.gap}mm`;
  const head = el("span", "pg-head");
  head.style.height = `${g.top}mm`;
  head.appendChild(el("span", "", b.head));
  band.append(fill, foot, space, head);
  box.appendChild(band);
  outer.appendChild(box);
  if (b.kind === "start" && b.indent > 0) {
    const ind = el("span", "pg-indent");
    ind.style.width = `${b.indent}px`;
    outer.appendChild(ind);
  }
  return outer;
}

const noteKey = (notes: PageNote[]) => notes.map((n) => `${n.n}=${n.text}`).join("|");

export const PageBreaks = Extension.create({
  name: "pageBreaks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (): PgState => ({ set: DecorationSet.empty, geom: null }),
          apply(tr, v: PgState): PgState {
            const m = tr.getMeta(key) as { breaks: PageBreak[]; geom: PageGeom } | undefined;
            if (m) {
              const decos = m.breaks.map((b) =>
                Decoration.widget(b.pos, () => gapDom(b, m.geom), {
                  side: -1,
                  ignoreSelection: true,
                  brk: b,
                  key: `${b.id}:${b.kind}:${b.fill.toFixed(2)}:${b.indent}:${b.mb}:${b.foot}:${b.head}:${noteKey(b.notes)}`,
                }),
              );
              return { set: DecorationSet.create(tr.doc, decos), geom: m.geom };
            }
            return tr.docChanged ? { set: v.set.map(tr.mapping, tr.doc), geom: v.geom } : v;
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.set,
        },
      }),
    ];
  },
});

function apply(view: EditorView, breaks: PageBreak[], geom: PageGeom) {
  view.dispatch(view.state.tr.setMeta(key, { breaks, geom }).setMeta("addToHistory", false));
}

/** 지금 붙어 있는 끊음 (편집으로 옮겨진 위치 반영, 문서 순서) */
function currentBreaks(view: EditorView): PageBreak[] {
  const set = key.getState(view.state)?.set;
  if (!set) return [];
  return set
    .find()
    .map((d) => ({ ...(d.spec.brk as PageBreak), pos: d.from }))
    .sort((a, b) => a.pos - b.pos);
}

type Line = { top: number; bottom: number; mid: number };

/** 문단 안 줄 상자 목록 (화면 좌표). 글자 상자 중심 ± 줄 높이/2 */
function lineBoxes(dom: HTMLElement, zoom: number): Line[] {
  const cs = getComputedStyle(dom);
  let lh = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.6;
  lh *= zoom;
  const out: Line[] = [];
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(".pg-gap") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (!r.height) continue;
      const mid = (r.top + r.bottom) / 2;
      if (!out.some((l) => Math.abs(l.mid - mid) < lh / 2)) out.push({ mid, top: mid - lh / 2, bottom: mid + lh / 2 });
    }
  }
  out.sort((a, b) => a.mid - b.mid);
  return out;
}

type Crossing = { pos: number; kind: PageBreak["kind"]; top: number; indent: number; mb: number };

/**
 * 실제 조판에서 최상위 블록마다 놓인 쪽(이 절 첫 쪽 = 0) — pageMap.matchPrintLayout 결과. null이면 화면 계산만 쓴다.
 * 인쇄되지 않는 블록(빈 문단)은 null.
 */
export type PrintHints = ({ start: number; end: number; cuts?: number[] } | null)[] | null;

type Planned = { pos: number; kind: PageBreak["kind"] };

/** 블록 앞에서 끊는 자리 — 글 블록은 첫 글자 앞, 그림·구분선은 블록 앞, 목록·인용은 첫 글 블록 앞 */
function beforeBlock(node: PMNode, pos: number): Planned | null {
  if (node.isTextblock) return { pos: pos + 1, kind: "start" };
  if (node.isAtom || node.isLeaf) return { pos, kind: "block" };
  let at = -1;
  node.descendants((n, p) => {
    if (at >= 0) return false;
    if (n.isTextblock) at = pos + 1 + p + 1;
    return at < 0;
  });
  return at >= 0 ? { pos: at, kind: "start" } : null;
}

/** 블록 안에서 공백을 뺀 n번째 글자 바로 뒤(다음 쪽 첫 글자 앞) — 글 블록 끝이면 다음 글 블록 앞 */
function afterChars(node: PMNode, pos: number, n: number): Planned | null {
  let count = 0;
  let hit = -1;
  let tbEnd = -1;
  let nextStart = -1;
  node.descendants((child, p) => {
    if (nextStart >= 0) return false;
    const abs = pos + 1 + p;
    if (hit >= 0 && child.isTextblock) {
      nextStart = abs + 1;
      return false;
    }
    if (child.isTextblock) tbEnd = abs + child.nodeSize - 1;
    if (hit >= 0 || !child.isText) return hit < 0;
    const t = child.text ?? "";
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue;
      if (++count === n) {
        let j = i + 1;
        while (j < t.length && /\s/.test(t[j])) j++;
        hit = abs + j;
        break;
      }
    }
    return false;
  });
  if (hit < 0) return null;
  if (hit < tbEnd) return { pos: hit, kind: "mid" };
  return nextStart >= 0 ? { pos: nextStart, kind: "start" } : null;
}

/**
 * 실제 조판과 똑같이 끊을 자리 — 조판에서 새 쪽에 놓인 블록 앞, 쪽을 넘은 블록은 조판이 끊은 글자 자리.
 * 화면 높이 계산과 상관없이 이 자리에서만 끊어 편집 화면 쪽 나눔이 PDF와 같게 한다.
 */
function plannedBreaks(doc: PMNode, hints: NonNullable<PrintHints>): Planned[] {
  const out: Planned[] = [];
  let prevEnd = 0;
  doc.forEach((node, pos, index) => {
    const h = hints[index];
    if (!h) return;
    if (h.start > prevEnd) {
      const b = beforeBlock(node, pos);
      if (b && b.pos > 1) out.push(b);
    }
    for (const n of h.cuts ?? []) {
      const b = afterChars(node, pos, n);
      if (b) out.push(b);
    }
    prevEnd = Math.max(prevEnd, h.end);
  });
  return out.sort((a, b) => a.pos - b.pos);
}

/** 정해 둔 자리 중 from 다음 끊음 — 화면 위치(채움 높이 계산용)를 잰다 */
function nextPlanned(view: EditorView, plan: Planned[], from: number, zoom: number): Crossing | null {
  const b = plan.find((p) => p.pos > from);
  if (!b) return null;
  if (b.kind === "block") {
    const dom = view.nodeDOM(b.pos) as HTMLElement | null;
    if (!dom?.getBoundingClientRect) return null;
    const mt = parseFloat(getComputedStyle(dom).marginTop) || 0;
    return { pos: b.pos, kind: "block", top: dom.getBoundingClientRect().top - mt * zoom, indent: 0, mb: mt };
  }
  if (b.kind === "start") {
    const dom = view.nodeDOM(b.pos - 1) as HTMLElement | null;
    if (!dom?.getBoundingClientRect) return null;
    return { pos: b.pos, kind: "start", top: dom.getBoundingClientRect().top, indent: parseFloat(getComputedStyle(dom).textIndent) || 0, mb: 0 };
  }
  return { pos: b.pos, kind: "mid", top: view.coordsAtPos(b.pos, 1).top, indent: 0, mb: 0 };
}

/**
 * from 위치 이후에서 본문 영역 끝(bottom)을 처음 넘는 줄·블록을 찾는다 (실제 조판 결과가 없을 때의 화면 계산).
 * 풀페이지·풀블리드 그림은 인쇄처럼 한 쪽을 혼자 쓴다(앞뒤에서 끊는다).
 */
function findCrossing(view: EditorView, from: number, pageTop: number, bottom: number, zoom: number): Crossing | null {
  let res: Crossing | null = null;
  let heading: { pos: number; top: number } | null = null; // 쪽 끝에 홀로 남을 소제목
  const EPS = 0.5;
  const doc = view.state.doc;
  doc.nodesBetween(Math.min(from, doc.content.size), doc.content.size, (node, pos) => {
    if (res) return false;
    if (pos + node.nodeSize <= from) return false;
    if (node.isTextblock) {
      const dom = view.nodeDOM(pos) as HTMLElement | null;
      if (!dom?.getBoundingClientRect) return false;
      const r = dom.getBoundingClientRect();
      if (r.bottom <= bottom + EPS) {
        heading = node.type.name === "heading" && r.top > pageTop + 1 ? { pos, top: r.top } : null;
        return false;
      }
      const lines = lineBoxes(dom, zoom);
      if (!lines.length) lines.push({ top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 });
      const i = lines.findIndex((l) => l.top >= pageTop - 1 && l.bottom > bottom + EPS);
      if (i < 0) {
        heading = null;
        return false;
      }
      if (i === 0) {
        // 블록 첫 줄부터 넘친다 → 블록째 다음 쪽으로 (바로 앞 소제목도 함께)
        if (heading) res = { pos: heading.pos + 1, kind: "start", top: heading.top, indent: 0, mb: 0 };
        else if (r.top > pageTop + 1) {
          const indent = parseFloat(getComputedStyle(dom).textIndent) || 0;
          res = { pos: pos + 1, kind: "start", top: r.top, indent, mb: 0 };
        }
        return false;
      }
      const line = lines[i];
      if (line.top <= pageTop + 1) return false; // 한 줄도 못 넣는 쪽 — 건너뛴다
      const hit = view.posAtCoords({ left: r.left + 1, top: line.mid });
      const p = hit?.pos ?? -1;
      if (p > pos + 1 && p < pos + node.nodeSize - 1) res = { pos: p, kind: "mid", top: line.top, indent: 0, mb: 0 };
      else res = { pos: pos + 1, kind: "start", top: r.top, indent: parseFloat(getComputedStyle(dom).textIndent) || 0, mb: 0 };
      return false;
    }
    if (node.isLeaf || node.isAtom) {
      const dom = view.nodeDOM(pos) as HTMLElement | null;
      if (!dom?.getBoundingClientRect) return false;
      const r = dom.getBoundingClientRect();
      const cs = getComputedStyle(dom);
      const mt = parseFloat(cs.marginTop) || 0;
      const mb = parseFloat(cs.marginBottom) || 0;
      const atTop = r.top - mt * zoom <= pageTop + 1;
      const whole = node.type.name === "figure" && (node.attrs.layout === "fullpage" || node.attrs.layout === "fullbleed");
      if (whole) {
        // 한 쪽을 혼자 쓰는 그림 — 쪽 맨 위가 아니면 앞에서, 맨 위면 뒤에서 끊는다
        if (!atTop) res = { pos, kind: "block", top: r.top - mt * zoom, indent: 0, mb: mt };
        else if (pos + node.nodeSize < doc.content.size) res = { pos: pos + node.nodeSize, kind: "block", top: r.bottom + mb * zoom, indent: 0, mb: 0 };
        return false;
      }
      if (r.bottom <= bottom + EPS) {
        heading = null;
        return false;
      }
      if (heading) res = { pos: heading.pos + 1, kind: "start", top: heading.top, indent: 0, mb: 0 };
      else if (atTop) {
        // 한 쪽보다 큰 그림 — 뒤에서 끊는다
        res = { pos: pos + node.nodeSize, kind: "block", top: r.bottom + mb * zoom, indent: 0, mb: 0 };
      } else res = { pos, kind: "block", top: r.top - mt * zoom, indent: 0, mb: mt };
      return false;
    }
    return true;
  });
  return res;
}

export type PaginateResult = { pages: number; lastFill: number; lastNotes: PageNote[]; /** 실제 조판 결과에 맞춰 끊었나 */ synced: boolean };

/**
 * 문서 순서대로 각주 번호·내용·문서 위치 — 계산 한 번에 한 번만 읽는다.
 * 어느 쪽에 드는지는 화면 좌표 대신 문서 위치로 가른다(끊는 자리보다 앞이면 그 쪽) — 쪽마다 모든 각주의 위치를 다시 재지 않게
 */
function footnoteRefs(view: EditorView) {
  const out: { n: number; text: string; pos: number }[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "footnote") out.push({ n: out.length + 1, text: String(node.attrs.note ?? ""), pos });
  });
  return out;
}

/**
 * 쪽 나눔을 다시 계산한다. 첫 쪽부터 차례로 끊는다(각 끊음마다 실제 배치를 다시 잰다).
 * dirtyFrom을 주면 그 자리가 든 블록보다 앞의 끊음은 그대로 두고(한 쪽 여유), 그 뒤부터만 다시 끊는다 — 긴 절에서 입력이 무거워지지 않게.
 * 쪽마다 그 쪽에 번호가 있는 각주의 높이만큼 본문 영역을 줄인다.
 * leadMm: 첫 쪽에서 앞 내용이 차지하는 높이, measureHost: 각주 높이를 잴 본문 폭 요소
 */
export function paginate(
  view: EditorView,
  opts: {
    sheet: HTMLElement;
    measureHost: HTMLElement;
    geom: PageGeom;
    docWidthMm: number;
    leadMm: number;
    label: (k: number) => { foot: string; head: string };
    /** 이 위치부터 바뀌었다 (없으면 처음부터) */
    dirtyFrom?: number | null;
    /** 실제 조판의 블록별 쪽 — 지금 원고와 맞을 때만 (pageMap.matchPrintLayout) */
    hints?: PrintHints;
  },
): PaginateResult {
  const { sheet, geom } = opts;
  let kept: PageBreak[] = [];
  if (opts.dirtyFrom != null && opts.dirtyFrom > 0) {
    const doc = view.state.doc;
    const $p = doc.resolve(Math.min(opts.dirtyFrom, doc.content.size));
    const blockStart = $p.depth > 0 ? $p.before(1) : $p.pos;
    kept = currentBreaks(view).filter((b) => b.pos < blockStart);
    kept = kept.slice(0, Math.max(0, kept.length - 1));
  }
  apply(view, kept, geom);
  const sr = sheet.getBoundingClientRect();
  const mm = sr.width / opts.docWidthMm; // 화면 px / mm
  const zoom = mm / (96 / 25.4);

  const probe = el("div", "pg-measure");
  opts.measureHost.appendChild(probe);
  const notesHeight = (notes: PageNote[]) => {
    if (!notes.length) return 0;
    probe.replaceChildren(notesDom(notes));
    return probe.getBoundingClientRect().height;
  };

  let pageTop = sr.top + geom.top * mm;
  let bottom = pageTop + geom.body * mm;
  const breaks: PageBreak[] = [...kept];
  let from = 0;
  const last = kept[kept.length - 1];
  if (last) {
    const box = view.dom.querySelector(`[data-pg="${last.id}"] .pg-box`) as HTMLElement | null;
    if (box) {
      pageTop = box.getBoundingClientRect().top + (last.fill + geom.bottom + geom.gap + geom.top) * mm;
      bottom = pageTop + geom.body * mm;
      from = last.pos;
    } else {
      breaks.length = 0; // 장식을 찾지 못하면 처음부터
      apply(view, [], geom);
    }
  }
  let lastNotes: PageNote[] = [];
  const allRefs = footnoteRefs(view);
  // 조판 결과가 지금 원고와 맞으면 그 끊음 자리를 그대로 따른다
  const plan = opts.hints ? plannedBreaks(view.state.doc, opts.hints) : null;
  try {
    for (let k = breaks.length; k < 400; k++) {
      const top0 = pageTop + (k === 0 ? opts.leadMm * mm : 0);
      // 각주 영역 높이와 끊는 자리가 서로 맞물리므로 몇 번 되풀이해 맞춘다
      const refs = allRefs.filter((f) => f.pos >= from);
      let fnH = 0;
      let c: Crossing | null = null;
      let notes: PageNote[] = [];
      for (let it = 0; it < 6; it++) {
        c = plan ? nextPlanned(view, plan, from, zoom) : findCrossing(view, from, top0, bottom - fnH, zoom);
        const upto = c ? c.pos : Infinity;
        notes = refs.filter((f) => f.pos < upto).map(({ n, text }) => ({ n, text }));
        if (plan) break;
        const h = notesHeight(notes);
        if (h <= fnH + 0.5) break;
        fnH = h;
      }
      if (!c) {
        lastNotes = notes;
        break;
      }
      const lab = opts.label(k);
      const b: PageBreak = {
        id: `pg${k}`,
        pos: c.pos,
        kind: c.kind,
        fill: Math.max(0, (bottom - c.top) / mm),
        indent: c.indent,
        mb: c.mb,
        foot: lab.foot,
        head: lab.head,
        notes,
      };
      breaks.push(b);
      apply(view, breaks, geom);
      const box = view.dom.querySelector(`[data-pg="${b.id}"] .pg-box`) as HTMLElement | null;
      if (!box) break;
      let top = box.getBoundingClientRect().top;
      if (Math.abs(top - c.top) > 1.5) {
        // 예상과 다른 자리에 놓였다(여백 겹침 등) → 실제 위치로 채움 높이를 고친다
        b.fill = Math.max(0, (bottom - top) / mm);
        apply(view, breaks, geom);
        const again = view.dom.querySelector(`[data-pg="${b.id}"] .pg-box`) as HTMLElement | null;
        top = again?.getBoundingClientRect().top ?? top;
      }
      pageTop = top + (b.fill + geom.bottom + geom.gap + geom.top) * mm;
      bottom = pageTop + geom.body * mm;
      from = c.pos;
    }
  } finally {
    probe.remove();
  }
  const end = view.dom.getBoundingClientRect().bottom;
  const lastFill = Math.max(0, (bottom - end) / mm);
  return { pages: breaks.length + 1, lastFill, lastNotes, synced: !!opts.hints };
}
