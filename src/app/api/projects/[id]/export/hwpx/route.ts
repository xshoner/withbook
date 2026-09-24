import { loadBook } from "@/lib/book";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { buildHwpx } from "@/lib/export/hwpx";

export const maxDuration = 300;

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/export/hwpx">) => {
  const { id } = await ctx.params;
  const book = await loadBook(id);
  if (!book) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const buf = await buildHwpx(book);
  return deliverFile(buf, `${book.project.title}.hwpx`, "application/hwp+zip");
});
