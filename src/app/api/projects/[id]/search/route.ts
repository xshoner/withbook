import { fail, handle, ok } from "@/lib/api";
import { flatSections, loadBook } from "@/lib/book";
import { parseDoc } from "@/lib/doc/doc";
import { searchDoc } from "@/lib/doc/edit";

/** 책 전체 찾기 — ?q=검색어. 절마다 일치 목록(문단 번호·앞뒤 문맥) */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/search">) => {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (!q.trim()) return ok({ total: 0, sections: [] });
  if (q.length > 200) return fail("검색어는 200자 이하로 입력하세요.");
  const book = await loadBook(id);
  if (!book) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const sections = flatSections(book)
    .map(({ chapter, section }) => ({
      sectionId: section.id,
      label: section.label,
      title: section.title,
      chapterTitle: chapter.title,
      hits: searchDoc(parseDoc(section.content), q).slice(0, 200),
    }))
    .filter((s) => s.hits.length);
  return ok({ total: sections.reduce((a, s) => a + s.hits.length, 0), sections });
});
