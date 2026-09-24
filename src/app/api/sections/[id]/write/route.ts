import { handle, ndjson } from "@/lib/api";
import { writeSection } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";

export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/write">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const mode = ["overwrite", "continue", "newVersion"].includes(b.mode) ? b.mode : "overwrite";
  const targetPages = Math.max(0.5, Math.min(60, Number(b.targetPages) || 3));
  if (mode !== "newVersion") await snapshot(id, "ai_write");
  const ctrl = new AbortController();
  return ndjson(writeSection(id, { targetPages, mode, extraInstruction: b.extraInstruction, signal: AbortSignal.any([req.signal, ctrl.signal]) }), () => ctrl.abort());
});
