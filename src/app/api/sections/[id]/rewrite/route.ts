import { fail, handle, ok } from "@/lib/api";
import { rewriteSelection } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";

export const maxDuration = 300;

const ACTIONS = new Set(["polish", "expand", "shorten", "tone", "example"]);

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/rewrite">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  if (!ACTIONS.has(b.action)) return fail("알 수 없는 작업입니다.");
  if (!b.selection?.trim()) return fail("고칠 부분을 선택하세요.");
  await snapshot(id, "rewrite", b.content);
  const text = await rewriteSelection(id, b);
  return ok({ text });
});
