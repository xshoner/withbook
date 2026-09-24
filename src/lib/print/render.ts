import type { JNode } from "../doc/doc";

/** Tiptap JSON → 인쇄용 HTML (서버 렌더링) */

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(n: JNode): string {
  if (n.type === "hardBreak") return "<br>";
  // Paged.js가 float: footnote로 쪽 아래 각주 영역에 옮기고 번호를 매긴다
  if (n.type === "footnote") return n.attrs?.note ? `<span class="fn">${esc(String(n.attrs.note))}</span>` : "";
  if (n.type !== "text") return (n.content ?? []).map(inline).join("");
  let t = esc(n.text ?? "");
  // 작가 확인용 표시는 화면에서 강조
  t = t.replace(/\[(확인 필요|이미지 제안:[^\]]*)\]/g, '<span class="flag">[$1]</span>');
  for (const m of n.marks ?? []) {
    if (m.type === "bold") t = `<strong>${t}</strong>`;
    if (m.type === "italic") t = `<em>${t}</em>`;
  }
  return t;
}

export type FigureCtx = { chapterNo: number; counter: { n: number } };

export function figureHtml(n: JNode, fig: FigureCtx) {
  const a = n.attrs ?? {};
  const layout = ["fit", "mm", "fullpage", "fullbleed"].includes(a.layout) ? a.layout : "fit";
  const src = /^\/api\/assets\/[a-zA-Z0-9_-]+$/.test(String(a.src ?? "")) ? String(a.src) : "";
  fig.counter.n++;
  const label = fig.chapterNo ? `그림 ${fig.chapterNo}-${fig.counter.n}` : `그림 ${fig.counter.n}`;
  const style = layout === "mm" && a.widthMm ? ` style="width:${Number(a.widthMm)}mm"` : "";
  const cap = a.caption ? `<figcaption><b>${label}</b> ${esc(String(a.caption))}</figcaption>` : "";
  if (layout === "fullbleed")
    return `<figure class="fig fullbleed" data-asset="${esc(String(a.assetId ?? ""))}"><img src="${esc(src)}" alt=""></figure>`;
  return `<figure class="fig ${layout}" data-asset="${esc(String(a.assetId ?? ""))}"><img src="${esc(src)}"${style} alt="">${cap}</figure>`;
}

export function docToHtml(doc: JNode, fig: FigureCtx): string {
  const block = (n: JNode): string => {
    switch (n.type) {
      case "paragraph": {
        const inner = (n.content ?? []).map(inline).join("");
        return inner.trim() ? `<p>${inner}</p>` : "";
      }
      case "heading":
        return `<h4 class="sub">${(n.content ?? []).map(inline).join("")}</h4>`;
      case "blockquote":
        return `<blockquote>${(n.content ?? []).map(block).join("")}</blockquote>`;
      case "bulletList":
        return `<ul>${(n.content ?? []).map(block).join("")}</ul>`;
      case "orderedList":
        return `<ol>${(n.content ?? []).map(block).join("")}</ol>`;
      case "listItem":
        return `<li>${(n.content ?? []).map(block).join("")}</li>`;
      case "horizontalRule":
        return `<hr>`;
      case "figure":
        return figureHtml(n, fig);
      default:
        return (n.content ?? []).map(block).join("");
    }
  };
  return (doc.content ?? []).map(block).join("\n");
}
