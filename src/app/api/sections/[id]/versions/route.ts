import { prisma } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { snapshot } from "@/lib/sections";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/versions">) => {
  const { id } = await ctx.params;
  const vs = await prisma.version.findMany({
    where: { sectionId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, reason: true, charCount: true, createdAt: true },
  });
  return ok(vs);
});

/** 스냅샷 {content, reason?} — reason: manual(수동) | ai_output(AI가 쓴 초안 원본 — 작가 수정률·문체 학습의 기준) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/versions">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const reason = b.reason === "ai_output" ? "ai_output" : "manual";
  const v = await snapshot(id, reason, typeof b.content === "string" ? b.content : undefined);
  return ok({ id: v?.id });
});
