import { prisma } from "@/lib/db";
import { loadBook } from "@/lib/book";
import { fail, handle, ok } from "@/lib/api";
import { preflight } from "@/lib/export/preflight";
import { findFigures, parseDoc } from "@/lib/doc/doc";
import { loadPageCount, loadPdfCheck } from "@/lib/print/page-count";
import { loadCover } from "@/lib/cover/store";
import { coverIssues } from "@/lib/cover/spec";
import { submissionItems } from "@/lib/export/submission";

export const maxDuration = 60;

/**
 * 부크크 제출 전 한눈 점검 — 본문 PDF(마지막으로 만든 책 전체 PDF의 판형·글꼴·쪽수), 표지 쪽수·판형·인쇄 점검,
 * 빠진 이미지, [확인 필요] 표시, 판권면 ISBN. GET → { items: [{ id, label, status, detail, fix? }], counts }
 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/submission-check">) => {
  const { id } = await ctx.params;
  const book = await loadBook(id);
  if (!book) return fail("책을 찾을 수 없습니다.", 404);
  const [pdf, pageCount, cover, issues, assets] = await Promise.all([
    loadPdfCheck(id),
    loadPageCount(id),
    loadCover(id),
    preflight(book, "bleed"),
    prisma.asset.findMany({ where: { projectId: id }, select: { id: true } }),
  ]);
  const have = new Set(assets.map((a) => a.id));
  const missingImages: string[] = [];
  let marks = 0;
  let lastEdit = 0;
  for (const c of book.chapters) {
    for (const s of c.sections) {
      const where = `${c.label || c.title} > ${s.label ? s.label + " " : ""}${s.title}`;
      const doc = parseDoc(s.content);
      for (const f of findFigures(doc)) {
        const aid = f.attrs?.assetId ? String(f.attrs.assetId) : "";
        if (aid && !have.has(aid)) missingImages.push(where);
      }
      marks += (s.content.match(/\[(확인 필요|이미지 제안)/g) ?? []).length;
      lastEdit = Math.max(lastEdit, new Date(s.updatedAt).getTime());
    }
  }
  const items = submissionItems({
    projectId: id,
    pdf,
    pageCount,
    lastEditAt: lastEdit ? new Date(lastEdit).toISOString() : null,
    cover: {
      saved: cover.saved,
      size: cover.design.size,
      pages: cover.design.pages,
      pagesManual: !!cover.design.pagesManual,
      issues: cover.saved ? coverIssues(cover.design, { actualPages: cover.actualPages }) : [],
    },
    preflightErrors: issues.filter((i) => i.level === "error").map((i) => i.message),
    lowDpi: issues.filter((i) => /DPI/.test(i.message)).length,
    missingImages,
    marks,
    emptySections: book.chapters.reduce((a, c) => a + c.sections.filter((s) => !s.charCount && !findFigures(parseDoc(s.content)).length).length, 0),
    isbn: book.layout.colophon.isbn ?? "",
  });
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const i of items) counts[i.status]++;
  return ok({ items, counts }, { headers: { "Cache-Control": "private, no-store" } });
});
