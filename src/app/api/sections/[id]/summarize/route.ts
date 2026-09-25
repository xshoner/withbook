import { handle, ok } from "@/lib/api";
import { summarizeSection } from "@/lib/ai/tasks";

export const maxDuration = 300;

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/summarize">) => {
  const { id } = await ctx.params;
  return ok({ summary: await summarizeSection(id) });
});
