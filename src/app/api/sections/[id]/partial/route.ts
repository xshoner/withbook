import { handle, ok } from "@/lib/api";
import { loadPartial, partialStore } from "@/lib/ai/partial";

/**
 * AI 집필 부분 원고 — 스트림이 끊겼을 때 서버에 남은 글(AppSetting ai-partial:{절 id}, 7일)
 * GET → { partial: { text, mode, chars, startedAt, updatedAt } | null } · DELETE → { ok: true }
 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/partial">) => {
  const { id } = await ctx.params;
  return ok({ partial: await loadPartial(id) });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/partial">) => {
  const { id } = await ctx.params;
  await partialStore(id).clear();
  return ok({ ok: true });
});
