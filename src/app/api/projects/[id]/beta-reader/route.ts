import { fail, handle, ok } from "@/lib/api";
import { loadBeta, runBeta } from "@/lib/ai/review";

export const maxDuration = 300;

/**
 * AI 베타 리더 — 책 정보의 대상 독자로서 장(또는 절)을 읽고 늘어지는 곳·이해 안 되는 곳·독자 질문·뺄 곳을 알려 준다.
 *   GET ?chapterId= | ?sectionId=              → { result | null, at, stale, audienceMissing }
 *   POST { chapterId | sectionId, force? }      → { result, at, stale:false, cached, audienceMissing }
 * 결과는 읽은 원고·책 정보·모델 설정이 그대로면 다시 청구하지 않고 돌려준다.
 */
const targetOf = (v: { chapterId?: unknown; sectionId?: unknown }) => {
  const sectionId = typeof v.sectionId === "string" && v.sectionId ? v.sectionId : undefined;
  const chapterId = typeof v.chapterId === "string" && v.chapterId ? v.chapterId : undefined;
  return sectionId || chapterId ? { sectionId, chapterId } : null;
};

export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/beta-reader">) => {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const t = targetOf({ chapterId: q.get("chapterId") ?? undefined, sectionId: q.get("sectionId") ?? undefined });
  if (!t) return fail("읽을 장이나 절을 고르세요.");
  return ok(await loadBeta(id, t));
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/beta-reader">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const t = targetOf(b);
  if (!t) return fail("읽을 장이나 절을 고르세요.");
  return ok(await runBeta(id, t, { force: b.force === true, signal: req.signal }));
});
