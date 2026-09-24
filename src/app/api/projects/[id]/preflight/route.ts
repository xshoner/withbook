import { loadBook } from "@/lib/book";
import { fail, handle, ok } from "@/lib/api";
import { preflight } from "@/lib/export/preflight";

export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/preflight">) => {
  const { id } = await ctx.params;
  const book = await loadBook(id);
  if (!book) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const size = new URL(req.url).searchParams.get("size") === "trim" ? "trim" : "bleed";
  return ok({ issues: await preflight(book, size) });
});
