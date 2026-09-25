import { handle, ok } from "@/lib/api";
import { learnFromEdits } from "@/lib/ai/tasks";

export const maxDuration = 300;

/** 작가가 고친 AI 초안에서 문체 규칙 제안 — 프로필 반영은 화면에서 작가가 고른 뒤 PATCH로 */
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/style/learn">) => {
  const { id } = await ctx.params;
  return ok(await learnFromEdits(id));
});
