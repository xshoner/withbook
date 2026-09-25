import { handle, ndjson } from "@/lib/api";
import { writeSection } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";
import { writeInput } from "@/lib/ai/write-input";

export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/write">) => {
  const { id } = await ctx.params;
  const b = writeInput.parse(await req.json());
  const { mode, targetPages } = b;
  // 이어 쓰기 요청은 같은 집필의 계속이므로 버전을 다시 남기지 않는다
  if (mode !== "newVersion" && !b.resume) await snapshot(id, "ai_write");
  const ctrl = new AbortController();
  return ndjson(
    writeSection(id, { targetPages, mode, extraInstruction: b.extraInstruction, resume: b.resume, signal: AbortSignal.any([req.signal, ctrl.signal]) }),
    () => ctrl.abort(),
  );
});
