import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { listReviseRuns } from "@/lib/revise-log";

/** 이 장의 퇴고 기록 (새것부터, 최근 20번) — 한 번 적용할 때 장 안의 여러 절에서 바뀐 문단 전부 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/chapters/[id]/revise/history">) => {
  const { id } = await ctx.params;
  const chapter = await prisma.chapter.findUnique({ where: { id }, select: { projectId: true } });
  if (!chapter) return fail("장을 찾을 수 없습니다.", 404);
  return ok(await listReviseRuns(chapter.projectId, id));
});
