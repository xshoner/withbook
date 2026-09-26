import { handle, ok } from "@/lib/api";
import { loadCover, saveCover } from "@/lib/cover/store";

/** 표지 디자인 불러오기 — 저장한 적 없으면 책 정보로 만든 기본 디자인 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/cover">) => {
  const { id } = await ctx.params;
  return ok(await loadCover(id));
});

/** 표지 디자인 저장 */
export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/cover">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  return ok({ design: await saveCover(id, b.design) });
});
