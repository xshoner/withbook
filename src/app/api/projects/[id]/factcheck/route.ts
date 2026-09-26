import { z } from "zod";
import { handle, ok } from "@/lib/api";
import { factCheckMarker } from "@/lib/ai/factcheck";

export const maxDuration = 300;

const body = z.object({
  sectionId: z.string(),
  paragraph: z.number().int().positive(),
  offset: z.number().int(),
  footnote: z.number().int().nonnegative().optional(),
  marker: z.string().min(3).max(320),
  before: z.string().max(400).default(""),
});

/** [확인 필요] 표시 하나를 AI로 판정 — 통과면 표시를 지우고, 보완이면 문장을 최신 근거에 맞게 바꾼다 (화면이 하나씩 차례로 부른다) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/factcheck">) => {
  const { id } = await ctx.params;
  const { sectionId, ...target } = body.parse(await req.json());
  return ok(await factCheckMarker(id, sectionId, target));
});
