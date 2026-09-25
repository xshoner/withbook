import { handle, ok } from "@/lib/api";
import { projectEditStats } from "@/lib/ai/tasks";

/** 작가 수정률 — 절마다 가장 최근 AI 초안 원본 대비 지금 본문이 얼마나 바뀌었는지 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/edit-stats">) => {
  const { id } = await ctx.params;
  const s = await projectEditStats(id);
  return ok({ overall: s.overall, sections: s.rows.map(({ pairs, ...r }) => ({ ...r, changedSpans: pairs.length })) });
});
