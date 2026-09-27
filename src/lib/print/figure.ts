import { DOC, LOW_DPI, MARGIN, MIN_DPI, bodyBox, type Margins } from "./spec";

export type FigureLayout = "fit" | "mm" | "fullpage" | "fullbleed";

/** 그림 위아래 여백(.fig margin 4mm × 2) */
export const FIG_MARGIN_MM = 8;
/** 캡션 자리 — 8.5pt × 줄 간격 1.4 ≈ 4.2mm × 2줄 + 위 간격 2mm */
export const CAPTION_RESERVE_MM = 10.4;
/** 조판 반올림 오차로 한 쪽을 넘지 않게 두는 여유 */
const FIG_SLACK_MM = 2;

export type FigureOpts = { margins?: Margins; caption?: boolean };

/**
 * 그림이 차지할 수 있는 최대 높이(mm) — 본문 높이(여백으로 계산)에서 그림 여백·캡션 자리를 뺀다.
 * 조판 CSS(bookHtml)와 DPI 계산이 같은 값을 쓴다. 기본 여백이면 캡션 없이 150mm, 캡션 있으면 139.6mm.
 */
export function figureMaxHeightMm(layout: FigureLayout, o: FigureOpts = {}) {
  const box = bodyBox(o.margins ?? MARGIN);
  const cap = o.caption ? CAPTION_RESERVE_MM : 0;
  const h = layout === "fullpage" ? box.height - cap - FIG_SLACK_MM * 2 : box.height - FIG_MARGIN_MM - cap - FIG_SLACK_MM;
  return Math.max(20, Math.round(h * 10) / 10);
}

/** 이미지가 실제 인쇄될 폭(mm) — 조판 CSS(bookHtml)와 같은 규칙 */
export function printWidthMm(layout: FigureLayout, widthMm: number | undefined, wPx: number, hPx: number, o: FigureOpts = {}) {
  const box = bodyBox(o.margins ?? MARGIN);
  const aspect = wPx && hPx ? wPx / hPx : 1;
  const maxH = figureMaxHeightMm(layout, o);
  switch (layout) {
    case "mm":
      return Math.min(widthMm || box.width, box.width, maxH * aspect);
    case "fullpage":
      return Math.min(box.width, maxH * aspect);
    case "fullbleed": {
      // object-fit: cover — 짧은 쪽 기준으로 확대
      const scale = Math.max(DOC.width / wPx, DOC.height / hPx); // mm/px
      return wPx * scale;
    }
    default:
      return Math.min(box.width, maxH * aspect);
  }
}

export function figureDpi(layout: FigureLayout, widthMm: number | undefined, wPx: number, hPx: number, o: FigureOpts = {}) {
  const mm = printWidthMm(layout, widthMm, wPx, hPx, o);
  return mm ? Math.round(wPx / (mm / 25.4)) : 0;
}

export function dpiLevel(dpi: number): "ok" | "warn" | "bad" {
  return dpi >= MIN_DPI ? "ok" : dpi >= LOW_DPI ? "warn" : "bad";
}
