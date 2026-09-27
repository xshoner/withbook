import { handle, ok } from "@/lib/api";
import { loadConsistency, runConsistency } from "@/lib/ai/review";

export const maxDuration = 300;

/**
 * 책 전체 일관성 점검 (장 요약 + 용어집으로 장 사이의 어긋남·사례 반복·지키지 않은 약속·용어 흔들림을 찾는다)
 *   GET          → { result | null, at, stale }   (저장된 결과만, AI를 부르지 않는다)
 *   POST {force?} → { result, at, stale:false, cached } — 원고·모델이 그대로면 저장된 결과를 돌려준다(다시 청구하지 않음)
 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/consistency">) => {
  const { id } = await ctx.params;
  return ok(await loadConsistency(id));
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/consistency">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  return ok(await runConsistency(id, { force: b.force === true, signal: req.signal }));
});
