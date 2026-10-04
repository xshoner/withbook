import { loadBook } from "@/lib/book";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { BIBLIO_PAGE_KEY, buildHwpx, type HwpxPages } from "@/lib/export/hwpx";
import { readBackMatter } from "@/lib/back-matter-store";

export const maxDuration = 300;

/**
 * HWPX 내보내기. 본문 { pages?: { [장·절 id | "bm-biblio"]: 쪽 번호 } } — 편집 화면이 잰 조판 쪽 번호.
 * 있으면 차례에 쪽 번호를 싣는다(이 책의 장·절 id와 1~3000 정수만 받는다). 없거나 비어 있으면 차례는 제목만.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/export/hwpx">) => {
  const { id } = await ctx.params;
  const book = await loadBook(id);
  if (!book) return fail("책을 찾을 수 없습니다.", 404);
  const body = await req.json().catch(() => ({}));
  const ids = new Set([BIBLIO_PAGE_KEY, ...book.chapters.flatMap((c) => [c.id, ...c.sections.map((s) => s.id)])]);
  const pages: HwpxPages = {};
  if (body?.pages && typeof body.pages === "object")
    for (const [k, v] of Object.entries(body.pages as Record<string, unknown>))
      if (ids.has(k) && Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3000) pages[k] = v as number;
  const buf = await buildHwpx(book, { biblio: (await readBackMatter(id)).biblio }, pages);
  return deliverFile(buf, `${book.project.title}.hwpx`, "application/hwp+zip");
});
