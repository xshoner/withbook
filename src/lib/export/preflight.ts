import "server-only";
import type { Book } from "../book";
import { fontAvailable } from "../fonts";
import { findFigures, parseDoc, textblocks } from "../doc/doc";
import { dpiLevel, figureDpi, type FigureLayout } from "../print/figure";
import { validateMargins } from "../print/spec";

export type Issue = { level: "error" | "warn" | "info"; message: string; where?: string };

/** PDF 출력 전 사전 점검 (조판 전 단계) */
export async function preflight(book: Book, size: "bleed" | "trim"): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const f of ["KoPubBatangLight.ttf", "KoPubDotumMedium.ttf"]) {
    if (!(await fontAvailable(f)))
      issues.push({ level: "error", message: `글꼴 파일 ${f}을(를) 찾지 못했습니다(로컬 public/fonts 또는 저장소 fonts 버킷). PDF에 KoPub 글꼴을 넣을 수 없습니다.` });
  }
  for (const e of validateMargins(book.layout.margins)) issues.push({ level: "error", message: e });

  let fullbleed = 0;
  const empty: string[] = [];
  for (const c of book.chapters) {
    for (const s of c.sections) {
      const where = `${c.label || c.title} > ${s.label ? s.label + " " : ""}${s.title}`;
      const doc = parseDoc(s.content);
      const blocks = textblocks(doc);
      if (!s.charCount && !findFigures(doc).length) empty.push(where);
      const flags = blocks.filter((b) => /\[(확인 필요|이미지 제안)/.test(b.text)).length;
      if (flags) issues.push({ level: "warn", message: `[확인 필요]/[이미지 제안] 표시가 ${flags}곳 남아 있습니다.`, where });
      for (const f of findFigures(doc)) {
        const a = f.attrs ?? {};
        const layout = (a.layout ?? "fit") as FigureLayout;
        if (layout === "fullbleed") fullbleed++;
        const dpi = figureDpi(layout, a.widthMm, a.widthPx, a.heightPx);
        const lv = dpiLevel(dpi);
        if (lv !== "ok")
          issues.push({
            level: "warn",
            message: `이미지 해상도 ${dpi} DPI — 인쇄 권장 300 DPI ${lv === "bad" ? "보다 크게 낮아 흐리게 인쇄됩니다" : "미만입니다"} (${a.caption || "캡션 없음"}).`,
            where,
          });
      }
    }
  }
  if (empty.length)
    issues.unshift({
      level: "warn",
      message: `아직 비어 있는 절이 ${empty.length}개 있습니다(제목만 인쇄됩니다).`,
      where: empty.slice(0, 3).join(", ") + (empty.length > 3 ? ` 외 ${empty.length - 3}개` : ""),
    });
  if (fullbleed && size === "trim")
    issues.push({ level: "error", message: "풀블리드 이미지가 있어 148×210 정사이즈로 출력할 수 없습니다. 154×216(재단 여백 포함)을 선택하세요." });
  if (!book.chapters.length) issues.push({ level: "error", message: "목차가 비어 있습니다." });
  if (!book.layout.colophon.isbn) issues.push({ level: "info", message: "판권면 ISBN이 비어 있습니다(부크크 등록 후 입력)." });
  if (!book.layout.colophon.publishDate) issues.push({ level: "info", message: "판권면 발행일이 비어 있습니다." });
  return issues;
}
