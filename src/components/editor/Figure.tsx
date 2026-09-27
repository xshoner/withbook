"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { dpiLevel, figureDpi, figureMaxHeightMm, printWidthMm, type FigureLayout } from "@/lib/print/figure";
import { DOC, bodyBox, type Margins } from "@/lib/print/spec";
import { figureAttrsFromDom, figureDataAttrs } from "./figureAttrs";
import { figureLabel } from "./pageMap";

const LAYOUTS: { v: FigureLayout; label: string }[] = [
  { v: "fit", label: "본문 폭 맞춤" },
  { v: "mm", label: "크기 지정(mm)" },
  { v: "fullpage", label: "풀페이지" },
  { v: "fullbleed", label: "풀블리드(재단 여백까지)" },
];

/** 조판 CSS(bookHtml .fig)와 같은 값 — 그림 위아래 여백, 캡션 글자 */
const FIG_MARGIN = "4mm 0";
const CAPTION_STYLE: React.CSSProperties = { fontSize: "8.5pt", lineHeight: 1.4, marginTop: "2mm", textAlign: "center", textIndent: 0, textAlignLast: "auto" };

/**
 * 캡션 입력 — 글자마다 문서를 바꾸면 한글 조합이 깨지고 쪽 나눔이 다시 계산되므로,
 * 입력하는 동안은 이 칸에만 두고 칸을 떠나거나 Enter를 누를 때 한 번에 반영한다.
 */
function CaptionInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  return (
    <input
      className="w-full rounded border border-stone-300 bg-white px-2 py-1 text-center font-sans text-[11px] text-stone-800 outline-none placeholder:text-stone-400 focus:border-amber-500"
      placeholder="캡션 입력 (그림 번호는 자동) — Enter로 반영"
      aria-label="그림 캡션"
      value={draft}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        editing.current = false;
        onCommit(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          e.preventDefault(); // 입력 취소 Esc — 집필 중지로 새지 않게
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** 그림 번호 기준 — 편집기 storage(SectionEditor가 조판 결과로 채운다): 장 번호, 이 절 앞 절들의 그림 수 */
type FigureStorage = { chapterNo: number; base: number };

/**
 * 그림 한 장 — 흐름 안의 크기는 인쇄(bookHtml .fig)와 똑같이 맞춘다: 위아래 여백 4mm, 그림 폭·높이는 인쇄 폭 계산(printWidthMm)과
 * 최대 높이(figureMaxHeightMm), 캡션은 8.5pt·줄 간격 1.4·위 2mm·본문 폭에서 줄바꿈. 그래서 편집 화면 쪽 나눔이 이 상자를 재도 인쇄와 같다.
 * 편집용 표시(DPI 배지·설정 칸·선택 테두리)는 모두 흐름 밖(absolute·outline)에 둬 높이에 들어가지 않는다.
 */
function FigureView({ node, updateAttributes, deleteNode, selected, extension, editor, getPos }: NodeViewProps) {
  const a = node.attrs as any;
  const layout = (a.layout ?? "fit") as FigureLayout;
  const margins = (extension.options as FigureOptions).margins;
  // 책 여백·캡션 유무까지 넣어 PDF 조판과 같은 인쇄 폭·DPI를 보여 준다
  const opts = { margins, caption: Boolean(a.caption) };
  const mm = printWidthMm(layout, a.widthMm, a.widthPx, a.heightPx, opts);
  const dpi = figureDpi(layout, a.widthMm, a.widthPx, a.heightPx, opts);
  const lv = dpiLevel(dpi);
  const bw = bodyBox(margins).width;
  const aspect = a.widthPx && a.heightPx ? a.widthPx / a.heightPx : 0;
  // 인쇄 상자 크기(mm) — 그림이 늦게 떠도 쪽 나눔이 흔들리지 않게 미리 정한다
  const box =
    layout === "fullbleed"
      ? { w: bw, h: (bw * DOC.height) / DOC.width, fit: "cover" as const }
      : layout === "fullpage"
        ? { w: bw, h: aspect ? Math.min(bw / aspect, figureMaxHeightMm("fullpage", opts)) : 0, fit: "contain" as const }
        : { w: mm, h: aspect ? mm / aspect : 0, fit: "fill" as const };
  // 그림 번호: 이 절에서 몇 번째 그림인지 + 앞 절들의 그림 수 (인쇄는 장마다 이어서 센다)
  const label = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const st = (e.storage as unknown as { figure?: FigureStorage }).figure ?? { chapterNo: 0, base: 0 };
      const at = typeof getPos === "function" ? getPos() : undefined;
      let n = 0;
      if (at !== undefined) e.state.doc.forEach((c, off) => void (c.type.name === "figure" && off <= at && n++));
      return figureLabel(st.chapterNo, st.base + Math.max(1, n));
    },
  });
  const caption = layout !== "fullbleed" && a.caption ? String(a.caption) : "";
  return (
    <NodeViewWrapper as="div" className="group relative">
      <figure className="relative m-0 text-center" style={{ textIndent: 0 }}>
        <div className="relative mx-auto" style={{ width: `${box.w}mm`, maxWidth: "100%" }}>
          <img
            src={a.src}
            alt=""
            className={`mx-auto block w-full ${selected ? "outline outline-2 outline-amber-600" : ""}`}
            style={{ height: box.h ? `${box.h}mm` : "auto", objectFit: box.fit, filter: "grayscale(1)" }}
            data-drag-handle
            title="눌러서 캡션·크기 설정 · 끌어서 옮기기"
          />
          <span
            className={`pointer-events-none absolute right-1 top-1 rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold ${
              lv === "ok" ? "bg-emerald-600 text-white" : lv === "warn" ? "bg-amber-500 text-white" : "bg-red-600 text-white"
            }`}
            title="인쇄 크기 기준 유효 해상도 (권장 300 DPI 이상)"
          >
            {dpi} DPI{lv !== "ok" && " ⚠"}
          </span>
          {!selected && (
            <span className="pointer-events-none absolute left-1 top-1 hidden rounded bg-stone-900/70 px-1.5 py-0.5 font-sans text-[10px] text-white group-hover:block">
              눌러서 캡션·크기 설정
            </span>
          )}
        </div>
        {caption && (
          <figcaption style={CAPTION_STYLE}>
            <b>{label}</b> {caption}
          </figcaption>
        )}
      </figure>
      {/* 설정 칸 — 그림을 골랐을 때만, 흐름 밖(그림 아래에 겹쳐)에 띄운다 */}
      <div
        contentEditable={false}
        className={`absolute left-1/2 top-full z-20 mt-1 w-[300px] -translate-x-1/2 space-y-1.5 rounded-lg border border-stone-200 bg-white p-2 font-sans text-[11px] text-stone-600 shadow-xl ${
          selected ? "block" : "hidden group-focus-within:block"
        }`}
        style={{ textIndent: 0, textAlign: "left", lineHeight: 1.4 }}
      >
        {layout !== "fullbleed" && <CaptionInput value={a.caption ?? ""} onCommit={(c) => c !== (a.caption ?? "") && updateAttributes({ caption: c })} />}
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="그림 배치" className="rounded border border-stone-300 px-1 py-0.5" value={layout} onChange={(e) => updateAttributes({ layout: e.target.value })}>
            {LAYOUTS.map((l) => (
              <option key={l.v} value={l.v}>
                {l.label}
              </option>
            ))}
          </select>
          {layout === "mm" && (
            <label className="flex items-center gap-1">
              폭
              <input
                type="number"
                className="w-14 rounded border border-stone-300 px-1 py-0.5"
                value={a.widthMm ?? 80}
                min={20}
                max={Math.floor(bw)}
                onChange={(e) => updateAttributes({ widthMm: Math.min(Math.floor(bw), Math.max(20, Number(e.target.value) || 80)) })}
              />
              mm
            </label>
          )}
          <button className="ml-auto text-red-600 hover:underline" onClick={() => deleteNode()}>
            삭제
          </button>
        </div>
        <div className="text-stone-400">
          {a.widthPx}×{a.heightPx}px · 인쇄 폭 {Math.round(mm)}mm
        </div>
        {lv !== "ok" && (
          <p className="rounded bg-amber-50 px-2 py-1 text-amber-800">
            인쇄 권장 300 DPI {lv === "bad" ? "보다 크게 낮습니다 — 흐리게 인쇄됩니다." : "미만입니다."} 더 큰 원본을 쓰거나 크기를 줄이세요.
          </p>
        )}
      </div>
    </NodeViewWrapper>
  );
}

type FigureOptions = { margins?: Margins };

/** Figure.configure({ margins }) — 책 여백 (편집기 그림 크기·DPI 표시를 PDF와 맞춘다) */
export const Figure = Node.create<FigureOptions, FigureStorage>({
  name: "figure",
  addOptions() {
    return { margins: undefined };
  },
  addStorage() {
    return { chapterNo: 0, base: 0 };
  },
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      assetId: { default: null },
      src: { default: "" },
      widthPx: { default: 0 },
      heightPx: { default: 0 },
      layout: { default: "fit" },
      widthMm: { default: null },
      caption: { default: "" },
    };
  },
  // 잘라내기·복사·붙여넣기는 HTML로 오간다 — 모든 속성을 data-*에 적고 그대로 읽어 들여야 빈 그림이 되지 않는다
  parseHTML() {
    return [{ tag: "figure[data-asset]", getAttrs: (el) => figureAttrsFromDom(el) }];
  },
  renderHTML({ node }) {
    return ["figure", mergeAttributes(figureDataAttrs(node.attrs)), ["img", { src: node.attrs.src ?? "" }]];
  },
  addNodeView() {
    // 여백은 노드 바깥 요소에 둔다 — 쪽 나눔(PageBreaks)이 이 요소의 margin을 읽어 끊는 자리를 정한다. 풀페이지·풀블리드는 인쇄처럼 여백 없이
    return ReactNodeViewRenderer(FigureView, {
      attrs: ({ node }) => ({
        style: `margin:${node.attrs.layout === "fullpage" || node.attrs.layout === "fullbleed" ? "0" : FIG_MARGIN}`,
        "data-fig-layout": String(node.attrs.layout ?? "fit"),
      }),
    });
  },
});
