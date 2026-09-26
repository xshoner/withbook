import { handle, ok } from "@/lib/api";
import { proofread } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";

export const maxDuration = 300;

/**
 * from·to(문단 번호, 1부터)를 주면 그 범위만 교정한다 — 긴 절을 나눠 부를 때.
 * snapshot=false: 같은 교정의 두 번째 이후 요청(교정 전 원고는 첫 요청이 버전으로 남겼다)
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/proofread">) => {
  const { id } = await ctx.params;
  const { content, level, from, to, snapshot: snap } = await req.json();
  if (snap !== false) await snapshot(id, "proofread", content);
  const range = Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from ? { from, to } : undefined;
  return ok(await proofread(id, content, level === "light" ? "light" : "proof", range));
});
