import { handle, ok } from "@/lib/api";
import { proofread } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";

export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/proofread">) => {
  const { id } = await ctx.params;
  const { content, level } = await req.json();
  await snapshot(id, "proofread", content);
  return ok(await proofread(id, content, level === "light" ? "light" : "proof"));
});
