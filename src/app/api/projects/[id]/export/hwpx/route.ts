import { loadBook } from "@/lib/book";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { buildHwpx } from "@/lib/export/hwpx";
import { readBackMatter } from "@/lib/back-matter-store";
import { measureBook } from "@/lib/export/pdf";

export const maxDuration = 300;

/**
 * HWPX — PDF와 같은 조판(Paged.js)을 먼저 재서 차례 쪽 번호와 새 쪽 자리를 PDF에 맞춘다.
 * 재지 못하면(시간 초과 등) 쪽 번호 없는 차례로라도 만든다.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/export/hwpx">) => {
  const { id } = await ctx.params;
  const book = await loadBook(id);
  if (!book) return fail("책을 찾을 수 없습니다.", 404);
  const origin = new URL(process.env.INTERNAL_APP_URL || process.env.APP_ORIGIN || new URL(req.url).origin).origin;
  const paging = await measureBook(`${origin}/book/${id}?mode=measure&size=bleed`, { projectId: id }).catch((e) => {
    console.warn("[hwpx] 조판 측정 실패 — 차례 쪽 번호 없이 만든다", e?.message);
    return null;
  });
  const buf = await buildHwpx(book, { paging, biblio: (await readBackMatter(id)).biblio });
  return deliverFile(buf, `${book.project.title}.hwpx`, "application/hwp+zip");
});
