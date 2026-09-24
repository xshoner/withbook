import { handle, ndjson } from "@/lib/api";
import { adjustLength } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";

export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/adjust">) => {
  const { id } = await ctx.params;
  const { targetChars } = await req.json();
  await snapshot(id, "length_adjust");
  const ctrl = new AbortController();
  return ndjson(adjustLength(id, Math.min(42000, Math.max(200, Number(targetChars) || 2100)), AbortSignal.any([req.signal, ctrl.signal])), () => ctrl.abort());
});
