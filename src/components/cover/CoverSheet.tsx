import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  type CoverDesign,
  type CoverEl,
  type CoverLayout,
  FONTS,
  FOLD_EXTEND,
  PANEL_LABEL,
  REGION_ORDER,
  SAFE_INSET,
  type TextEl,
  coverLayout,
  elAbs,
  panelsOf,
  placeImage,
  regionBox,
} from "@/lib/cover/spec";

export type Guides = { bleed: boolean; fold: boolean; safe: boolean; labels: boolean };

type Props = {
  design: CoverDesign;
  assetSrc: (id: string) => string;
  /** 편집기 전용 — 없으면 인쇄용(안내선·선택 표시 없음) */
  guides?: Guides;
  selectedId?: string | null;
  editingId?: string | null;
  onElPointerDown?: (e: ReactPointerEvent, el: CoverEl) => void;
  onResizePointerDown?: (e: ReactPointerEvent, el: CoverEl) => void;
  onElDoubleClick?: (el: CoverEl) => void;
  onBackgroundPointerDown?: (e: ReactPointerEvent) => void;
  renderEditing?: (el: TextEl) => React.ReactNode;
};

const mm = (n: number) => `${Math.round(n * 1000) / 1000}mm`;
/** 편집기 확대율과 상관없이 화면에서 1px인 선 (--z = 확대율) */
const HAIR = "calc(1px / var(--z, 1))";

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function textStyle(el: TextEl): CSSProperties {
  return {
    fontFamily: FONTS[el.font]?.css ?? FONTS.notoSans.css,
    fontSize: `${el.sizePt}pt`,
    color: el.color,
    fontWeight: el.bold ? 700 : 400,
    fontStyle: el.italic ? "italic" : "normal",
    textAlign: el.align,
    lineHeight: el.lineHeight,
    letterSpacing: `${el.letterSpacing}em`,
    whiteSpace: "pre-wrap",
    wordBreak: "keep-all",
    overflowWrap: "break-word",
    ...(el.vertical ? { writingMode: "vertical-rl", textOrientation: "mixed", height: mm(el.w) } : { width: mm(el.w) }),
    ...(el.bg ? { background: rgba(el.bg, el.bgOpacity), boxShadow: `0 0 0 1.5mm ${rgba(el.bg, el.bgOpacity)}` } : {}),
    ...(el.shadow ? { textShadow: "0 0.3mm 1.2mm rgba(0,0,0,.55)" } : {}),
  };
}

/** 표지 펼침면 — 편집기(확대·조작)와 PDF 조판(/cover/[id])이 같은 컴포넌트로 그린다 */
export default function CoverSheet({ design, assetSrc, guides, selectedId, editingId, onElPointerDown, onResizePointerDown, onElDoubleClick, onBackgroundPointerDown, renderEditing }: Props) {
  const l = coverLayout(design);
  const edit = Boolean(guides);
  return (
    <div
      className="cover-sheet"
      style={{ position: "relative", width: mm(l.sheetW), height: mm(l.sheetH), background: design.bgColor, overflow: "hidden" }}
      onPointerDown={onBackgroundPointerDown}
    >
      {REGION_ORDER.map((r) => {
        const img = design.images[r];
        if (!img) return null;
        const box = regionBox(l, r);
        if (box.w <= 0) return null;
        const at = placeImage(img, box);
        return (
          <div key={r} style={{ position: "absolute", left: mm(box.x), top: mm(box.y), width: mm(box.w), height: mm(box.h), overflow: "hidden", pointerEvents: "none" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" src={assetSrc(img.assetId)} draggable={false} style={{ position: "absolute", left: mm(at.x - box.x), top: mm(at.y - box.y), width: mm(at.w), height: mm(at.h), maxWidth: "none" }} />
          </div>
        );
      })}

      {edit && guides && <GuideLayer l={l} g={guides} />}

      {design.elements.map((el) => {
        const p = l.panels[el.panel];
        if (!p || p.w <= 0) return null;
        const at = elAbs(l, el);
        const selected = el.id === selectedId;
        const common: CSSProperties = {
          position: "absolute",
          left: mm(at.x),
          top: mm(at.y),
          cursor: edit ? "move" : undefined,
          outline: selected ? `${HAIR} solid #2563eb` : edit ? `${HAIR} dashed transparent` : undefined,
          outlineOffset: selected ? "0.6mm" : undefined,
          touchAction: "none",
          userSelect: edit ? "none" : undefined,
        };
        const handle =
          edit && selected && onResizePointerDown ? (
            <span
              onPointerDown={(e) => {
                e.stopPropagation();
                onResizePointerDown(e, el);
              }}
              title="크기 조절"
              style={{ position: "absolute", right: "calc(-5px / var(--z, 1))", bottom: "calc(-5px / var(--z, 1))", width: "calc(10px / var(--z, 1))", height: "calc(10px / var(--z, 1))", background: "#2563eb", border: `${HAIR} solid #fff`, cursor: el.kind === "text" && el.vertical ? "ns-resize" : el.kind === "text" ? "ew-resize" : "nwse-resize" }}
            />
          ) : null;
        if (el.kind === "image") {
          return (
            <div
              key={el.id}
              data-el={el.id}
              onPointerDown={onElPointerDown ? (e) => onElPointerDown(e, el) : undefined}
              style={{ ...common, width: mm(el.w), height: mm(el.h) }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="" src={assetSrc(el.assetId)} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: el.round ? "50%" : mm(el.radius) }} />
              {handle}
            </div>
          );
        }
        const editing = el.id === editingId && renderEditing;
        return (
          <div
            key={el.id}
            data-el={el.id}
            onPointerDown={onElPointerDown && !editing ? (e) => onElPointerDown(e, el) : undefined}
            onDoubleClick={onElDoubleClick ? () => onElDoubleClick(el) : undefined}
            style={{ ...common, ...textStyle(el), ...(edit && !el.text.trim() ? { minWidth: "4mm", minHeight: "4mm", outline: selected ? common.outline : `${HAIR} dashed #a8a29e` } : {}) }}
          >
            {editing ? renderEditing(el) : el.text}
            {handle}
          </div>
        );
      })}
    </div>
  );
}

/** 편집기 안내선 — 재단 여백(붉은 띠), 재단선, 접는 선, 안전 영역, 날개 연장 영역, 패널 이름 */
function GuideLayer({ l, g }: { l: CoverLayout; g: Guides }) {
  const b = l.bleed;
  const ids = panelsOf(l);
  const line = (x: number, dashed: boolean, color: string, key: string) => (
    <div key={key} style={{ position: "absolute", left: mm(x), top: 0, height: mm(l.sheetH), borderLeft: `${HAIR} ${dashed ? "dashed" : "solid"} ${color}` }} />
  );
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {g.bleed && (
        <>
          {/* 재단되어 잘리는 바깥 3mm */}
          <div style={{ position: "absolute", inset: 0, boxShadow: `inset 0 0 0 ${mm(b)} rgba(239, 68, 68, .28)` }} />
          <div style={{ position: "absolute", left: mm(b), top: mm(b), width: mm(l.sheetW - 2 * b), height: mm(l.sheetH - 2 * b), border: `${HAIR} solid rgba(220, 38, 38, .9)` }} />
          {l.flap > 0 && (
            <>
              <div style={{ position: "absolute", left: mm(l.panels.back.x - FOLD_EXTEND), top: 0, width: mm(FOLD_EXTEND), height: mm(l.sheetH), background: "rgba(239, 68, 68, .18)" }} />
              <div style={{ position: "absolute", left: mm(l.panels.frontFlap.x), top: 0, width: mm(FOLD_EXTEND), height: mm(l.sheetH), background: "rgba(239, 68, 68, .18)" }} />
            </>
          )}
        </>
      )}
      {g.fold && l.folds.map((x, i) => line(x, true, "rgba(37, 99, 235, .85)", `f${i}`))}
      {g.safe &&
        ids.map((id) => {
          const p = l.panels[id];
          const inset = id === "spine" ? 0.5 : SAFE_INSET;
          if (p.w <= inset * 2) return null;
          return <div key={id} style={{ position: "absolute", left: mm(p.x + inset), top: mm(p.y + SAFE_INSET), width: mm(p.w - inset * 2), height: mm(p.h - SAFE_INSET * 2), border: `${HAIR} dashed rgba(16, 185, 129, .8)` }} />;
        })}
      {g.labels &&
        ids.map((id) => {
          const p = l.panels[id];
          return (
            <div key={id} style={{ position: "absolute", left: mm(p.x), top: mm(b + 1), width: mm(p.w), textAlign: "center", fontSize: "calc(11px / var(--z, 1))", color: "rgba(28, 25, 23, .55)", fontFamily: "sans-serif", whiteSpace: "nowrap", overflow: "hidden" }}>
              {id === "spine" ? `${l.spine}` : PANEL_LABEL[id]}
            </div>
          );
        })}
    </div>
  );
}
