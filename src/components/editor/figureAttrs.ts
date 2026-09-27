/** 그림(figure) 노드 속성 ↔ HTML — 잘라내기·복사·붙여넣기(클립보드 HTML)에서 속성을 잃지 않게 */

type El = { getAttribute(name: string): string | null; querySelector(sel: string): { getAttribute(name: string): string | null } | null };

/** 그림 속성 → figure 요소의 data-* (renderHTML) */
export function figureDataAttrs(a: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = { "data-asset": a.assetId ?? "", "data-src": a.src ?? "", "data-layout": a.layout ?? "fit" };
  if (a.widthPx) out["data-width-px"] = String(a.widthPx);
  if (a.heightPx) out["data-height-px"] = String(a.heightPx);
  if (a.widthMm != null) out["data-width-mm"] = String(a.widthMm);
  if (a.caption) out["data-caption"] = a.caption;
  return out;
}

/** figure 요소 → 그림 속성 (parseHTML). 예전 형식(data-asset + img만)은 img 주소로 채운다 */
export function figureAttrsFromDom(el: El) {
  const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : null);
  const img = el.querySelector("img");
  return {
    assetId: el.getAttribute("data-asset") || null,
    src: el.getAttribute("data-src") || img?.getAttribute("src") || "",
    widthPx: num(el.getAttribute("data-width-px")) ?? (Number(img?.getAttribute("width")) || 0),
    heightPx: num(el.getAttribute("data-height-px")) ?? (Number(img?.getAttribute("height")) || 0),
    layout: el.getAttribute("data-layout") || "fit",
    widthMm: num(el.getAttribute("data-width-mm")),
    caption: el.getAttribute("data-caption") ?? "",
  };
}

