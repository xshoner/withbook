import { fail, handle, ok } from "@/lib/api";
import { autoFootnotes, writeFootnote } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";

export const maxDuration = 300;

/** 각주 AI — action "note": 고른 단어 하나의 각주 / "auto": 절 전체에서 중요 키워드를 골라 각주 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/footnote">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  if (b.action === "note") {
    const term = typeof b.term === "string" ? b.term.trim() : "";
    if (!term) return fail("각주를 달 단어를 선택하세요.");
    const note = await writeFootnote(id, { term, context: String(b.context ?? ""), current: typeof b.current === "string" ? b.current : "" });
    return ok({ note });
  }
  if (b.action === "auto") {
    if (typeof b.content !== "string") return fail("본문이 없습니다.");
    await snapshot(id, "footnote", b.content);
    return ok({ items: await autoFootnotes(id, b.content) });
  }
  return fail("알 수 없는 작업입니다.");
});
