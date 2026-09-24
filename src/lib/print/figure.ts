import { DOC, LOW_DPI, MIN_DPI, bodyBox } from "./spec";

export type FigureLayout = "fit" | "mm" | "fullpage" | "fullbleed";

/** 이미지가 실제 인쇄될 폭(mm) — 조판 CSS(bookHtml)와 같은 규칙 */
export function printWidthMm(layout: FigureLayout, widthMm: number | undefined, wPx: number, hPx: number) {
  const box = bodyBox();
  const aspect = wPx && hPx ? wPx / hPx : 1;
  switch (layout) {
    case "mm":
      return Math.min(widthMm || box.width, box.width, 150 * aspect);
    case "fullpage":
      return Math.min(box.width, 145 * aspect);
    case "fullbleed": {
      // object-fit: cover — 짧은 쪽 기준으로 확대
      const scale = Math.max(DOC.width / wPx, DOC.height / hPx); // mm/px
      return wPx * scale;
    }
    default:
      return Math.min(box.width, 150 * aspect);
  }
}

export function figureDpi(layout: FigureLayout, widthMm: number | undefined, wPx: number, hPx: number) {
  const mm = printWidthMm(layout, widthMm, wPx, hPx);
  return mm ? Math.round(wPx / (mm / 25.4)) : 0;
}

export function dpiLevel(dpi: number): "ok" | "warn" | "bad" {
  return dpi >= MIN_DPI ? "ok" : dpi >= LOW_DPI ? "warn" : "bad";
}
