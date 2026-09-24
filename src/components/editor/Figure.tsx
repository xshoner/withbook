"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { dpiLevel, figureDpi, printWidthMm, type FigureLayout } from "@/lib/print/figure";

const LAYOUTS: { v: FigureLayout; label: string }[] = [
  { v: "fit", label: "본문 폭 맞춤" },
  { v: "mm", label: "크기 지정(mm)" },
  { v: "fullpage", label: "풀페이지" },
  { v: "fullbleed", label: "풀블리드(재단 여백까지)" },
];

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
      className="mt-1.5 w-full rounded border border-dashed border-stone-300 bg-stone-50 px-2 py-1 text-center font-sans text-[9pt] text-stone-800 outline-none placeholder:text-stone-400 focus:border-amber-500 focus:bg-white"
      placeholder="캡션 입력 (그림 번호는 자동) — Enter로 반영"
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
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function FigureView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const a = node.attrs as any;
  const layout = (a.layout ?? "fit") as FigureLayout;
  const mm = printWidthMm(layout, a.widthMm, a.widthPx, a.heightPx);
  const dpi = figureDpi(layout, a.widthMm, a.widthPx, a.heightPx);
  const lv = dpiLevel(dpi);
  const shownMm = layout === "fullbleed" ? 103 : mm;
  return (
    <NodeViewWrapper as="div" className="my-3">
      <figure className={`relative mx-auto text-center ${selected ? "ring-2 ring-amber-600" : ""}`} style={{ width: `${shownMm}mm`, maxWidth: "103mm" }}>
        <img src={a.src} alt="" className="mx-auto block w-full" style={{ filter: "grayscale(1)" }} data-drag-handle title="끌어서 옮기기" />
        <span
          className={`absolute right-1 top-1 rounded px-1.5 py-0.5 font-sans text-[10px] font-semibold ${
            lv === "ok" ? "bg-emerald-600 text-white" : lv === "warn" ? "bg-amber-500 text-white" : "bg-red-600 text-white"
          }`}
          title="인쇄 크기 기준 유효 해상도 (권장 300 DPI 이상)"
        >
          {dpi} DPI{lv !== "ok" && " ⚠"}
        </span>
        {layout !== "fullbleed" && (
          <CaptionInput value={a.caption ?? ""} onCommit={(caption) => caption !== (a.caption ?? "") && updateAttributes({ caption })} />
        )}
      </figure>
      {lv !== "ok" && (
        <p className="mx-auto mt-1 max-w-[103mm] rounded bg-amber-50 px-2 py-1 text-center font-sans text-[11px] text-amber-800">
          인쇄 권장 300 DPI {lv === "bad" ? "보다 크게 낮습니다 — 흐리게 인쇄됩니다." : "미만입니다."} 더 큰 원본을 쓰거나 크기를 줄이세요.
        </p>
      )}
      <div className="mx-auto mt-1 flex max-w-[103mm] flex-wrap items-center justify-center gap-2 font-sans text-[11px] text-stone-500" contentEditable={false}>
        <select className="rounded border border-stone-300 px-1 py-0.5" value={layout} onChange={(e) => updateAttributes({ layout: e.target.value })}>
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
              max={103}
              onChange={(e) => updateAttributes({ widthMm: Math.min(103, Math.max(20, Number(e.target.value) || 80)) })}
            />
            mm
          </label>
        )}
        <span>
          {a.widthPx}×{a.heightPx}px · 인쇄 폭 {Math.round(mm)}mm
        </span>
        <button className="text-red-600 hover:underline" onClick={() => deleteNode()}>
          삭제
        </button>
      </div>
    </NodeViewWrapper>
  );
}

export const Figure = Node.create({
  name: "figure",
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
  parseHTML() {
    return [{ tag: "figure[data-asset]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes({ "data-asset": HTMLAttributes.assetId }), ["img", { src: HTMLAttributes.src }]];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FigureView);
  },
});
