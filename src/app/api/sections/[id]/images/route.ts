import { fail, handle, ok } from "@/lib/api";
import { suggestImages } from "@/lib/ai/image-suggest";

export const maxDuration = 300;

/** 이미지 추천 — 절 본문(지금 편집 중인 JSON)의 문단마다 맞는 전문 이미지 후보와 캡션 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/images">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  if (typeof b.content !== "string") return fail("본문이 없습니다.");
  if (b.content.length > 2_000_000) return fail("본문이 너무 깁니다.", 413);
  return ok(await suggestImages(id, b.content, { max: Number(b.max) || 6, signal: req.signal }));
});
