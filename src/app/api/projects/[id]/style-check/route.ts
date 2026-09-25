import { fail, handle, ok } from "@/lib/api";
import { flatSections, loadBook } from "@/lib/book";
import { parseDoc, textblocks } from "@/lib/doc/doc";
import { checkStyle } from "@/lib/style/check";

/** 책 전체 문체 점검 — 종결어미 체계·반복 표현·접속부사·문단 안 반복 단어 (규칙 기반) */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/style-check">) => {
  const { id } = await ctx.params;
  const book = await loadBook(id);
  if (!book) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const input = flatSections(book).map(({ section }) => ({
    sectionId: section.id,
    label: section.label,
    title: section.title,
    // 문단 번호를 편집기와 맞추려 제목 블록은 빈 문자열로 자리만 둔다
    paragraphs: textblocks(parseDoc(section.content)).map((b) => (b.type === "heading" ? "" : b.text)),
  }));
  return ok(checkStyle(input));
});
