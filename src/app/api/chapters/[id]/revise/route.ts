import { handle, ok } from "@/lib/api";
import { reviseChapter } from "@/lib/ai/tasks";

export const maxDuration = 300;

/** 장 단위 퇴고안 만들기 {focus?} — 적용하지 않고 수정 목록만 돌려준다 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/chapters/[id]/revise">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  return ok(await reviseChapter(id, typeof b.focus === "string" ? b.focus : ""));
});
