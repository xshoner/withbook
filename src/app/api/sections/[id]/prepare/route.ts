import { handle, ok } from "@/lib/api";
import { prepareSection } from "@/lib/ai/tasks";
import { writeInput } from "@/lib/ai/write-input";

export const maxDuration = 300;
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/prepare">) => {
  const { id } = await ctx.params;
  return ok(await prepareSection(id, writeInput.parse(await req.json())));
});
