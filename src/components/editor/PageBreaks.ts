"use client";

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/**
 * 편집 화면 쪽 나눔 — 실제 조판처럼 본문 영역 높이(160mm)마다 쪽을 끊고, 쪽과 쪽 사이에 빈 공간을 둔다.
 * 각주는 인쇄처럼 그 쪽 아래에 모아 보여 주고, 그만큼 본문 영역을 줄인다.
 * 문서는 건드리지 않고 장식(widget)만 끼워 넣는다. 끊는 자리:
 *  - mid: 문단 중간 — 쪽을 넘는 줄의 맨 앞에 전체 폭 인라인 블록
 *  - start: 블록 첫 줄부터 넘칠 때 — 문단 맨 앞(들여쓰기는 빈칸으로 흉내)
 *  - block: 그림·구분선처럼 글자가 없는 블록 앞
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

/** from 위치 이후에서 본문 영역 끝(bottom)을 처음 넘는 줄·블록을 찾는다 */
function findCrossing(view: EditorView, from: number, pageTop: number, bottom: number, zoom: number): Crossing | null {
  let res: Crossing | null = null;
  let heading: { pos: number; top: number } | null = null; // 쪽 끝에 홀로 남을 소제목
  const EPS = 0.5;
  view.state.doc.descendants((node, pos) => {
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
      if (r.bottom <= bottom + EPS) {
        heading = null;
        return false;
      }
      const mt = parseFloat(getComputedStyle(dom).marginTop) || 0;
      if (heading) res = { pos: heading.pos + 1, kind: "start", top: heading.top, indent: 0, mb: 0 };
      else if (r.top - mt * zoom <= pageTop + 1) {
        // 한 쪽보다 큰 그림 — 뒤에서 끊는다
        const mb = parseFloat(getComputedStyle(dom).marginBottom) || 0;
        res = { pos: pos + node.nodeSize, kind: "block", top: r.bottom + mb * zoom, indent: 0, mb: 0 };
      } else res = { pos, kind: "block", top: r.top - mt * zoom, indent: 0, mb: mt };
      return false;
    }
    return true;
  });
  return res;
}

export type PaginateResult = { pages: number; lastFill: number; lastNotes: PageNote[] };

/** 문서 순서대로 각주 번호 위치(화면 좌표 중심)와 내용 */
function footnoteRefs(view: EditorView) {
  return [...view.dom.querySelectorAll<HTMLElement>(".fn-ref")].map((e, i) => {
    const r = e.getBoundingClientRect();
    return { n: i + 1, text: e.getAttribute("data-note") ?? "", mid: (r.top + r.bottom) / 2 };
  });
}

/**
 * 쪽 나눔을 다시 계산한다. 모든 장식을 걷어낸 뒤 첫 쪽부터 차례로 끊는다(각 끊음마다 실제 배치를 다시 잰다).
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
  },
): PaginateResult {
  const { sheet, geom } = opts;
  apply(view, [], geom);
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
  const breaks: PageBreak[] = [];
  let from = 0;
  let lastNotes: PageNote[] = [];
  try {
    for (let k = 0; k < 400; k++) {
      const top0 = pageTop + (k === 0 ? opts.leadMm * mm : 0);
      // 각주 영역 높이와 끊는 자리가 서로 맞물리므로 몇 번 되풀이해 맞춘다
      const refs = footnoteRefs(view).filter((f) => f.mid >= pageTop - 1);
      let fnH = 0;
      let c: Crossing | null = null;
      let notes: PageNote[] = [];
      for (let it = 0; it < 6; it++) {
        c = findCrossing(view, from, top0, bottom - fnH, zoom);
        const upto = c ? c.top : Infinity;
        notes = refs.filter((f) => f.mid < upto).map(({ n, text }) => ({ n, text }));
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
  return { pages: breaks.length + 1, lastFill, lastNotes };
}
