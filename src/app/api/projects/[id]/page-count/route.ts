import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { loadPageCount, savePageCount } from "@/lib/print/page-count";

/**
 * 책의 실제 조판 쪽수 (표지 책등 폭의 기준)
 * GET → { total, source, at } | null
 * POST { total } → { ok } — 집필 화면이 숨은 조판으로 전체 쪽수(PagedInfo.total)를 잴 때마다 보낸다
 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/page-count">) => {
  const { id } = await ctx.params;
  return ok(await loadPageCount(id));
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/page-count">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const p = await prisma.project.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!p) return fail("책을 찾을 수 없습니다.", 404);
  if (!(await savePageCount(id, b?.total, "editor"))) return fail("쪽수가 올바르지 않습니다.");
  return ok({ ok: true });
});
